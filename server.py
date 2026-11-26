"""
Voice chat — сигнальный сервер.

Хранит аккаунты и комнаты (SQLite) и знакомит браузеры друг с другом (SDP/ICE).
Звук, видео, экран и чат сервер не видит: они зашифрованы между участниками (DTLS-SRTP).

Запуск:
    python server.py                 # HTTPS на порту 8443 (сертификат создаётся сам)
    python server.py --port 9000
    python server.py --no-tls        # HTTP (например, за ngrok / cloudflared / nginx)

Переменные окружения (необязательно, для TURN-сервера):
    TURN_URL=turn:example.com:3478  TURN_USER=user  TURN_PASS=pass
"""

import argparse
import asyncio
import base64
import datetime
import getpass
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import secrets
import socket
import ssl
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

from aiohttp import WSMsgType, web

import accounts

BASE = Path(__file__).resolve().parent
PUBLIC = BASE / "public"
CERTS = BASE / "certs"

MAX_ROOM_SIZE = 8          # mesh P2P: дальше нагрузка на каналы растёт квадратично
MAX_NAME = 32
MAX_ROOM = 48
MAX_MSG = 256 * 1024        # SDP с видео бывает крупным
TRUST_PROXY = os.environ.get("TRUST_PROXY", "").lower() in ("1", "true", "yes")

log = logging.getLogger("voice")


COOKIE = "vc_session"
ALLOW_REGISTRATION = os.environ.get("ALLOW_REGISTRATION", "1").lower() not in ("0", "false", "no")

store: accounts.Store    # создаётся в main()


# ---------------------------------------------------------------- комнаты
class Room:
    """Живая комната: те, кто сейчас внутри. Сама комната хранится в базе."""

    def __init__(self, row):
        self.id = row["id"]
        self.name = row["name"]
        self.temporary = row["owner_id"] is None    # создана гостем: живёт, пока в ней кто-то есть
        self.peers: dict[str, "Peer"] = {}


class Peer:
    def __init__(self, ws: web.WebSocketResponse, user):
        self.id = secrets.token_hex(6)
        self.ws = ws
        self.name = user["login"] if user else ""
        self.admin = bool(user and user["is_admin"])
        self.guest = user is None
        self.room: Room | None = None
        self.state: dict = {}

    def info(self) -> dict:
        return {"id": self.id, "name": self.name, "admin": self.admin, "guest": self.guest}

    async def send(self, msg: dict):
        if not self.ws.closed:
            try:
                await self.ws.send_str(json.dumps(msg))
            except ConnectionError:
                pass


rooms: dict[int, Room] = {}


# ---------------------------------------------------------------- ограничение попыток
class Limiter:
    def __init__(self, limit: int, window: float):
        self.limit, self.window = limit, window
        self.hits: dict[str, list[float]] = {}

    def blocked(self, key: str) -> bool:
        now = time.time()
        fresh = [t for t in self.hits.get(key, []) if now - t < self.window]
        if fresh:
            self.hits[key] = fresh
        else:
            self.hits.pop(key, None)
        return len(fresh) >= self.limit

    def hit(self, key: str):
        self.hits.setdefault(key, []).append(time.time())


login_limit = Limiter(10, 60)        # попыток входа с одного IP
room_limit = Limiter(10, 60)         # попыток пароля комнаты с одного IP
register_limit = Limiter(10, 3600)   # регистраций с одного IP


async def hash_pw(password: str) -> str:
    return await asyncio.to_thread(accounts.hash_password, password)


async def check_pw(password: str, stored: str) -> bool:
    return await asyncio.to_thread(accounts.verify_password, password, stored)


def client_ip(request: web.Request) -> str:
    ip = request.remote or "?"
    if TRUST_PROXY:  # за Caddy/nginx реальный IP клиента приходит в X-Forwarded-For
        ip = request.headers.get("X-Forwarded-For", ip).split(",")[0].strip() or ip
    return ip


def current_user(request: web.Request):
    return store.session_user(request.cookies.get(COOKIE, ""))


def same_origin(request: web.Request) -> bool:
    """Запросы с чужих сайтов отклоняем: иначе они пошли бы с cookie пользователя."""
    origin = request.headers.get("Origin")
    return not origin or urlsplit(origin).netloc == request.host


# ---------------------------------------------------------------- API аккаунтов и комнат
def api_error(message: str, status: int = 400):
    return web.json_response({"error": message}, status=status)


async def read_json(request: web.Request) -> dict:
    if not same_origin(request) or request.content_type != "application/json":
        raise web.HTTPForbidden()
    try:
        data = await request.json()
    except ValueError:
        raise web.HTTPBadRequest()
    if not isinstance(data, dict):
        raise web.HTTPBadRequest()
    return data


def user_json(user) -> dict:
    return {"login": user["login"], "admin": bool(user["is_admin"])}


def start_session(request: web.Request, user):
    resp = web.json_response({"user": user_json(user)})
    https = request.secure or (TRUST_PROXY and request.headers.get("X-Forwarded-Proto") == "https")
    resp.set_cookie(COOKIE, store.new_session(user["id"]), max_age=accounts.SESSION_TTL,
                    httponly=True, samesite="Lax", secure=https, path="/")
    return resp


async def api_me(request: web.Request):
    user = current_user(request)
    return web.json_response({"user": user_json(user) if user else None, "registration": ALLOW_REGISTRATION})


async def api_register(request: web.Request):
    data = await read_json(request)
    if not ALLOW_REGISTRATION:
        return api_error("Регистрация закрыта", 403)
    ip = client_ip(request)
    if register_limit.blocked(ip):
        return api_error("Слишком много регистраций, попробуйте позже", 429)
    login, password = accounts.clean_login(data.get("login")), str(data.get("password") or "")
    problem = accounts.check_credentials_format(login, password)
    if problem:
        return api_error(problem)
    register_limit.hit(ip)
    if store.create_user(login, await hash_pw(password)) is None:
        return api_error("Этот логин уже занят", 409)
    log.info("Новый аккаунт: %s", login)
    return start_session(request, store.user_by_login(login))


async def api_login(request: web.Request):
    data = await read_json(request)
    ip = client_ip(request)
    if login_limit.blocked(ip):
        return api_error("Слишком много попыток, подождите минуту", 429)
    # попытку считаем до проверки, чтобы параллельные запросы не обходили лимит
    login_limit.hit(ip)
    login = accounts.clean_login(data.get("login"))
    password = str(data.get("password") or "")[:accounts.MAX_PASSWORD]
    user = store.user_by_login(login)
    ok = await check_pw(password, user["pw"] if user else accounts.DUMMY_HASH)
    if not user or not ok:
        return api_error("Неверный логин или пароль", 401)
    return start_session(request, user)


async def api_logout(request: web.Request):
    await read_json(request)
    store.end_session(request.cookies.get(COOKIE, ""))
    resp = web.json_response({})
    resp.del_cookie(COOKIE, path="/")
    return resp


async def api_rooms(request: web.Request):
    user = current_user(request)
    if not user:
        return api_error("Войдите в аккаунт", 401)
    out = []
    for r in store.list_rooms(user):
        live = rooms.get(r["id"])
        mine = r["owner_id"] == user["id"]
        out.append({"id": r["id"], "name": r["name"], "owner": r["owner"], "guest": r["owner_id"] is None, "mine": mine,
                    "free": bool(user["is_admin"]) or mine,   # вход без пароля и удаление
                    "known": bool(r["known"]),                  # уже входил по паролю — пароль не нужен
                    "lastUsed": r["last_used"],
                    "online": [p.name for p in live.peers.values()] if live else []})
    return web.json_response({"rooms": out, "all": bool(user["is_admin"])})


async def api_room_delete(request: web.Request):
    await read_json(request)
    user = current_user(request)
    if not user:
        return api_error("Войдите в аккаунт", 401)
    room = store.room_by_id(int(request.match_info["id"]))
    # чужие комнаты неотличимы от несуществующих
    if not room or not (user["is_admin"] or room["owner_id"] == user["id"]):
        return api_error("Комната не найдена", 404)
    store.delete_room(room["id"])
    log.info("%s удалил комнату %s", user["login"], room["name"])
    live = rooms.pop(room["id"], None)
    if live:
        for p in list(live.peers.values()):
            await p.send({"type": "kicked", "message": "Комнату удалили"})
            await p.ws.close()
    return web.json_response({})


async def api_room_forget(request: web.Request):
    """Забыть пароль чужой комнаты: дальше снова спросит пароль."""
    await read_json(request)
    user = current_user(request)
    if not user:
        return api_error("Войдите в аккаунт", 401)
    store.forget_access(user["id"], int(request.match_info["id"]))
    return web.json_response({})


async def broadcast(room: Room, msg: dict, exclude: str | None = None):
    await asyncio.gather(*(p.send(msg) for pid, p in list(room.peers.items()) if pid != exclude))


async def leave(peer: Peer):
    room = peer.room
    if not room:
        return
    room.peers.pop(peer.id, None)
    peer.room = None
    # чистим до рассылки: во время await в комнату мог бы войти кто-то ещё
    if not room.peers and rooms.get(room.id) is room:
        del rooms[room.id]
        if room.temporary:
            store.delete_room(room.id)
    log.info("%s покинул комнату %s", peer.name, room.name)
    await broadcast(room, {"type": "peer-left", "id": peer.id})


async def open_room(user, name: str, password: str, ip: str):
    """Строка комнаты из базы (создаёт новую) либо текст ошибки.
    Владельцу и администратору пароль комнаты не нужен. user=None — гость."""
    if not name:
        return "Укажите название комнаты"
    row = store.room_by_name(name)
    if row is None:
        if not user:
            if room_limit.blocked(ip):
                return "Слишком много попыток, подождите минуту"
            room_limit.hit(ip)
        pw_hash = await hash_pw(password)
        # пока считали хэш, комната могла появиться — create_room тогда вернёт False
        if user and store.room_by_name(name) is None and store.room_count(user["id"]) >= accounts.MAX_ROOMS_PER_USER:
            return f"Можно создать не больше {accounts.MAX_ROOMS_PER_USER} комнат"
        created = store.create_room(name, pw_hash, user["id"] if user else None)
        row = store.room_by_name(name)
        if created:
            log.info("%s создал комнату %s", user["login"] if user else "гость", name)
            return row
    if user and (user["is_admin"] or row["owner_id"] == user["id"] or store.has_access(user["id"], row["id"])):
        return row
    if room_limit.blocked(ip):
        return "Слишком много попыток, подождите минуту"
    room_limit.hit(ip)
    if not await check_pw(password, row["pw"]):
        return "Неверный пароль комнаты"
    row = store.room_by_id(row["id"])
    if not row:
        return "Комнату удалили"
    if user:
        store.grant_access(user["id"], row["id"])   # в следующий раз пароль не спросим
    return row


# ---------------------------------------------------------------- websocket
async def ws_handler(request: web.Request):
    if not same_origin(request):
        raise web.HTTPForbidden()
    user = current_user(request)       # None — гость
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=MAX_MSG)
    await ws.prepare(request)
    peer = Peer(ws, user)
    ip = client_ip(request)

    try:
        async for raw in ws:
            if raw.type != WSMsgType.TEXT:
                continue
            try:
                msg = json.loads(raw.data)
                kind = msg.get("type")
            except (ValueError, AttributeError):
                continue

            if kind == "join" and peer.room is None:
                # имя и права берём из аккаунта, а не из сообщения клиента
                user = current_user(request)
                if user:
                    peer.name, peer.admin, peer.guest = user["login"], bool(user["is_admin"]), False
                elif not peer.guest or not msg.get("guest"):
                    await peer.send({"type": "error", "message": "Сессия закончилась — войдите в аккаунт заново"})
                    continue
                else:
                    peer.name = accounts.clean_login(msg.get("name"))[:MAX_NAME]
                    if not peer.name:
                        await peer.send({"type": "error", "message": "Введите имя"})
                        continue
                    if store.user_by_login(peer.name):
                        await peer.send({"type": "error",
                                         "message": "Это имя занято аккаунтом. Войдите в него или выберите другое"})
                        continue
                row = await open_room(user, str(msg.get("room", "")).strip()[:MAX_ROOM],
                                      str(msg.get("password", ""))[:128], ip)
                if isinstance(row, str):
                    await peer.send({"type": "error", "message": row})
                    continue
                room = rooms.get(row["id"])
                if room and len(room.peers) >= MAX_ROOM_SIZE and not peer.admin:
                    await peer.send({"type": "error", "message": f"Комната заполнена (макс. {MAX_ROOM_SIZE})"})
                    continue
                if room is None:
                    room = rooms[row["id"]] = Room(row)
                existing = [{**p.info(), "state": p.state} for p in room.peers.values()]
                peer.room = room
                room.peers[peer.id] = peer
                store.touch_room(room.id)
                log.info("%s вошёл в комнату %s (%d чел.)", peer.name, room.name, len(room.peers))
                await peer.send({"type": "joined", **peer.info(), "room": room.name, "peers": existing})
                await broadcast(room, {"type": "peer-joined", **peer.info()}, exclude=peer.id)

            elif kind == "signal" and peer.room:
                target = peer.room.peers.get(str(msg.get("to")))
                if target:
                    await target.send({"type": "signal", "from": peer.id, "data": msg.get("data")})

            elif kind == "state" and peer.room:
                st = msg.get("state")
                if isinstance(st, dict):
                    peer.state = {k: bool(v) for k, v in st.items() if k in ("muted", "deafened", "sharing", "camera")}
                    await broadcast(peer.room, {"type": "state", "id": peer.id, "state": peer.state},
                                    exclude=peer.id)

            elif kind == "leave":
                await leave(peer)
    finally:
        await leave(peer)
    return ws


TURN_TTL = 12 * 3600


def turn_credentials() -> tuple[str, str]:
    """Временные логин/пароль для coturn (--use-auth-secret): живут TURN_TTL секунд,
    поэтому утёкший пароль нельзя использовать вечно."""
    secret = os.environ.get("TURN_SECRET", "")
    if secret:
        user = f"{int(time.time()) + TURN_TTL}:voice"
        cred = base64.b64encode(hmac.new(secret.encode(), user.encode(), hashlib.sha1).digest()).decode()
        return user, cred
    return os.environ.get("TURN_USER", ""), os.environ.get("TURN_PASS", "")


async def health_handler(request: web.Request):
    return web.Response(text="ok")


async def config_handler(request: web.Request):
    ice = []
    turn_urls = [u.strip() for u in os.environ.get("TURN_URL", "").split(",") if u.strip()]
    # RELAY_ONLY=1 (по умолчанию): весь трафик идёт через TURN на сервере, прямых P2P-соединений нет.
    # Шифрование остаётся сквозным: TURN пересылает уже зашифрованные DTLS-SRTP пакеты.
    relay_only = bool(turn_urls) and os.environ.get("RELAY_ONLY", "1").lower() not in ("0", "false", "no")
    if turn_urls:
        user, cred = turn_credentials()
        ice.append({"urls": turn_urls, "username": user, "credential": cred})
        if not relay_only:
            hostport = turn_urls[0].split(":", 1)[1].split("?")[0]
            ice.append({"urls": [f"stun:{hostport}"]})
    if not relay_only:
        ice.append({"urls": ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"]})
    return web.json_response({"iceServers": ice, "relayOnly": relay_only, "maxRoomSize": MAX_ROOM_SIZE})


async def index_handler(request: web.Request):
    return web.FileResponse(PUBLIC / "index.html")


@web.middleware
async def security_headers(request, handler):
    resp = await handler(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault("Cache-Control", "no-cache")
    return resp


# ---------------------------------------------------------------- TLS
def local_ips() -> list[str]:
    ips = {"127.0.0.1"}
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(ips)


def ensure_cert() -> tuple[Path, Path]:
    cert, key = CERTS / "cert.pem", CERTS / "key.pem"
    if cert.exists() and key.exists():
        return cert, key

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    CERTS.mkdir(exist_ok=True)
    pk = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "voice-chat")])
    san = [x509.DNSName("localhost")] + [x509.IPAddress(ipaddress.ip_address(i)) for i in local_ips()]
    extra = os.environ.get("CERT_HOSTS", "")  # например: CERT_HOSTS=1.2.3.4,my.domain.com
    for h in filter(None, (x.strip() for x in extra.split(","))):
        try:
            san.append(x509.IPAddress(ipaddress.ip_address(h)))
        except ValueError:
            san.append(x509.DNSName(h))
    now = datetime.datetime.now(datetime.timezone.utc)
    crt = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(pk.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .sign(pk, hashes.SHA256())
    )
    key.write_bytes(pk.private_bytes(serialization.Encoding.PEM,
                                     serialization.PrivateFormat.PKCS8,
                                     serialization.NoEncryption()))
    cert.write_bytes(crt.public_bytes(serialization.Encoding.PEM))
    log.info("Создан самоподписанный сертификат: %s", cert)
    return cert, key


# ---------------------------------------------------------------- команды администратора
def set_account(login: str, admin: bool):
    """Создать администратора / выдать права / сменить пароль. Пароль вводится в терминале."""
    login = accounts.clean_login(login)
    user = store.user_by_login(login)
    if not user and not admin:
        sys.exit(f"Аккаунта «{login}» нет")
    if user and admin:
        print(f"Аккаунт «{login}» уже есть: станет администратором, пароль будет заменён.")
    password = getpass.getpass(f"Новый пароль для {login}: ")
    problem = accounts.check_credentials_format(login, password)
    if problem:
        sys.exit(problem)
    if getpass.getpass("Ещё раз: ") != password:
        sys.exit("Пароли не совпали")
    pw = accounts.hash_password(password)
    if user:
        store.set_password(user["id"], pw)
        user_id = user["id"]
    else:
        user_id = store.create_user(login, pw)
    if admin:
        store.make_admin(user_id)
    print("Готово." + (" Это администратор." if admin else ""))


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="Voice chat signaling server")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8443)
    ap.add_argument("--no-tls", action="store_true", help="HTTP вместо HTTPS")
    ap.add_argument("--admin", metavar="ЛОГИН", help="создать администратора (или выдать права) и выйти")
    ap.add_argument("--set-password", metavar="ЛОГИН", help="сменить пароль аккаунта и выйти")
    args = ap.parse_args()

    global store
    store = accounts.Store()
    if args.admin or args.set_password:
        set_account(args.admin or args.set_password, admin=bool(args.admin))
        return
    store.drop_guest_rooms()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")

    app = web.Application(middlewares=[security_headers])
    app.router.add_get("/", index_handler)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/config", config_handler)
    app.router.add_get("/health", health_handler)
    app.router.add_get("/api/me", api_me)
    app.router.add_post("/api/register", api_register)
    app.router.add_post("/api/login", api_login)
    app.router.add_post("/api/logout", api_logout)
    app.router.add_get("/api/rooms", api_rooms)
    app.router.add_post(r"/api/rooms/{id:\d{1,12}}/delete", api_room_delete)
    app.router.add_post(r"/api/rooms/{id:\d{1,12}}/forget", api_room_forget)
    app.router.add_static("/", PUBLIC)

    ssl_ctx = None
    scheme = "http"
    if not args.no_tls:
        cert, key = ensure_cert()
        ssl_ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        ssl_ctx.load_cert_chain(cert, key)
        scheme = "https"

    print("\n  Голосовой чат запущен. Откройте в браузере:")
    print(f"    {scheme}://localhost:{args.port}")
    for ip in local_ips():
        if ip != "127.0.0.1":
            print(f"    {scheme}://{ip}:{args.port}")
    print()
    web.run_app(app, host=args.host, port=args.port, ssl_context=ssl_ctx, print=None,
                access_log=None)


if __name__ == "__main__":
    main()
