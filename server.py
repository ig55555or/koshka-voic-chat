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
import binascii
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
import unicodedata
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
        owner = store.one("SELECT login FROM users WHERE id=?", row["owner_id"]) if row["owner_id"] else None
        self.owner_login = owner["login"] if owner else None
        self.peers: dict[str, "Peer"] = {}


class Peer:
    def __init__(self, ws: web.WebSocketResponse, user):
        self.id = secrets.token_hex(6)
        self.ws = ws
        self.name = display_name(user) if user else ""
        self.login = user["login"] if user else None     # настоящий логин виден всем — ник не подделать
        self.admin = bool(user and user["is_admin"])
        self.renamed_at = 0.0
        self.profile = load_profile(user) if user else dict(EMPTY_PROFILE)
        self.ip = ""
        self.owner = False      # создатель комнаты, в которой сейчас
        self.guest = user is None
        self.room: Room | None = None
        self.state: dict = {}

    def info(self) -> dict:
        return {"id": self.id, "name": self.name, "login": self.login, "admin": self.admin, "guest": self.guest,
                "owner": self.owner, "profile": self.profile}

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
profile_limit = Limiter(20, 60)      # сохранений профиля одним аккаунтом
# выгнанных из комнаты не пускаем обратно какое-то время: {room_id: {ключ: до}}, ключ — логин или IP гостя
room_kicks: dict[int, dict[str, float]] = {}
KICK_COOLDOWN = 10 * 60


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
    return {"login": user["login"], "admin": bool(user["is_admin"]), "nick": display_name(user),
            "profile": load_profile(user)}


# ---------------------------------------------------------------- профиль
PROFILE_COLORS = 12          # градиенты на клиенте; -1 — цвет по нику
PHOTO_MAX = 80_000           # data:-URL аватарки (клиент сжимает до 256×256 JPEG ≈ 20–40 КБ)
JPEG_PREFIX = "data:image/jpeg;base64,"


def _clean_text(raw, limit: int) -> str:
    s = unicodedata.normalize("NFKC", str(raw or ""))
    return " ".join("".join(ch for ch in s if ch.isprintable()).split())[:limit]


def clean_profile(data) -> tuple[dict, str | None]:
    """Проверенный профиль либо ошибка. Всё, что уходит другим участникам, проходит здесь."""
    if not isinstance(data, dict):
        data = {}
    # эмодзи: без управляющих символов и пробелов, но со склейкой (ZWJ) для составных эмодзи
    emoji = "".join(ch for ch in str(data.get("emoji") or "")
                    if ch == "\u200d" or not unicodedata.category(ch).startswith(("C", "Z")))[:16]
    try:
        color = int(data.get("color", -1))
    except (TypeError, ValueError):
        color = -1
    if not -1 <= color < PROFILE_COLORS:
        color = -1
    photo = data.get("photo") or ""
    if photo:
        if not isinstance(photo, str) or len(photo) > PHOTO_MAX or not photo.startswith(JPEG_PREFIX):
            return {}, "Фото слишком большое или не того формата"
        try:
            raw = base64.b64decode(photo[len(JPEG_PREFIX):], validate=True)
        except (binascii.Error, ValueError):
            return {}, "Фото повреждено"
        if not raw.startswith(b"\xff\xd8\xff"):
            return {}, "Фото повреждено"
    return {"emoji": emoji, "color": color, "photo": photo,
            "status": _clean_text(data.get("status"), 60), "about": _clean_text(data.get("about"), 160)}, None


EMPTY_PROFILE = clean_profile({})[0]


def load_profile(user) -> dict:
    try:
        prof, err = clean_profile(json.loads(user["profile"] or "{}"))
    except (ValueError, TypeError):
        return dict(EMPTY_PROFILE)
    return dict(EMPTY_PROFILE) if err else prof


def live_peers_of(login: str) -> list:
    return [p for r in rooms.values() for p in r.peers.values() if p.login == login]


async def push_profile(peers_list, name: str, profile: dict):
    """Новый ник/профиль — сразу всем в комнатах, где сейчас этот человек."""
    for p in peers_list:
        p.name, p.profile = name, profile
        if p.room:
            await broadcast(p.room, {"type": "profile", "id": p.id, "name": name, "profile": profile})


async def save_profile(user, data) -> tuple[str, dict, str | None]:
    name, err = check_nick(data.get("name"), user)
    if err:
        return name, {}, err
    prof, err = clean_profile(data.get("profile"))
    if err:
        return name, {}, err
    if user:
        store.set_profile(user["id"], None if name == user["login"] else name, json.dumps(prof, ensure_ascii=False))
    return name, prof, None


def display_name(user) -> str:
    return user["nick"] or user["login"]


def check_nick(raw, user) -> tuple[str, str | None]:
    """(ник, ошибка). Чужой логин занимать нельзя — иначе можно выдать себя за другого."""
    name = accounts.clean_login(raw).replace("👑", "")
    name = "".join(ch for ch in name if ch.isprintable()).strip()[:MAX_NAME]
    if not name:
        return name, "Введите имя"
    owner = store.user_by_login(name)
    if owner and (not user or owner["id"] != user["id"]):
        return name, "Это имя занято аккаунтом. Войдите в него или выберите другое"
    return name, None


def start_session(request: web.Request, user):
    store.touch_seen(user["id"])
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
    if ban := store.ip_ban(ip):
        return api_error(ban_text(ban["until"], ban["reason"]), 403)
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
    if accounts.ban_active(user["banned_until"]):
        return api_error(ban_text(user["banned_until"], user["ban_reason"]), 403)
    if (ban := store.ip_ban(ip)) and not user["is_admin"]:
        return api_error(ban_text(ban["until"], ban["reason"]), 403)
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


async def api_profile(request: web.Request):
    data = await read_json(request)
    user = current_user(request)
    if not user:
        return api_error("Войдите в аккаунт", 401)
    key = f"u{user['id']}"
    if profile_limit.blocked(key):
        return api_error("Не так часто — подождите минуту", 429)
    profile_limit.hit(key)
    name, prof, err = await save_profile(user, data)
    if err:
        return api_error(err, 400)
    await push_profile(live_peers_of(user["login"]), name, prof)
    return web.json_response({"user": user_json(store.user_by_login(user["login"]))})


# ---------------------------------------------------------------- модерация
BAN_DURATIONS = {3600, 86400, 7 * 86400, 30 * 86400, 0}   # 0 — навсегда


def ban_text(until, reason: str) -> str:
    # оставшееся время, а не дата: у сервера в Docker часовой пояс UTC
    if not until:
        when = "навсегда"
    else:
        left = max(60, int(until - time.time()))
        d, h, m = left // 86400, left % 86400 // 3600, left % 3600 // 60
        when = "ещё на " + (f"{d} д {h} ч" if d else f"{h} ч {m} мин" if h else f"{m} мин")
    return f"Доступ заблокирован {when}" + (f". Причина: {reason}" if reason else "")


def ban_until(seconds) -> float | None:
    try:
        seconds = int(seconds)
    except (TypeError, ValueError):
        return None
    if seconds not in BAN_DURATIONS:
        return None
    return 0 if seconds == 0 else time.time() + seconds


async def drop_peer(p, message: str):
    """Отключить участника: он увидит сообщение, остальные — что он вышел."""
    await p.send({"type": "kicked", "message": message})
    await leave(p)
    await p.ws.close()


async def ban_account(target, until: float, reason: str, by: str):
    store.ban_user(target["id"], until, reason)
    log.info("%s забанил %s (%s)", by, target["login"], ban_text(until, reason))
    for p in live_peers_of(target["login"]):
        await drop_peer(p, ban_text(until, reason))


async def ban_guest_ip(ip: str, until: float, reason: str, by: str):
    store.ban_ip(ip, until, reason, by)
    log.info("%s забанил IP %s (%s)", by, ip, ban_text(until, reason))
    for r in list(rooms.values()):
        for p in list(r.peers.values()):
            if p.guest and p.ip == ip:
                await drop_peer(p, ban_text(until, reason))


def can_moderate(actor, room) -> bool:
    """Выгонять и глушить может администратор и создатель комнаты."""
    return actor.admin or (actor.login is not None and room.owner_login == actor.login)


async def announce(text: str, by: str):
    n = 0
    for r in list(rooms.values()):
        for p in list(r.peers.values()):
            await p.send({"type": "announce", "text": text, "from": by})
            n += 1
    return n


# ---------------------------------------------------------------- админ-панель
def require_admin(request):
    user = current_user(request)
    return user if user and user["is_admin"] else None


def where_online(login: str) -> list[str]:
    return sorted({p.room.name for p in live_peers_of(login) if p.room})


async def api_admin_users(request: web.Request):
    if not require_admin(request):
        return api_error("Только для администратора", 403)
    users = []
    for u in store.list_users():
        users.append({"login": u["login"], "nick": display_name(u), "admin": bool(u["is_admin"]),
                      "profile": load_profile(u), "created": u["created"], "lastSeen": u["last_seen"],
                      "banned": accounts.ban_active(u["banned_until"]), "bannedUntil": u["banned_until"],
                      "banReason": u["ban_reason"], "rooms": u["room_count"], "online": where_online(u["login"])})
    guests = [{"name": p.name, "room": r.name, "ip": p.ip} for r in rooms.values() for p in r.peers.values() if p.guest]
    online = sum(len(r.peers) for r in rooms.values())
    return web.json_response({"users": users, "guests": guests, "bans": [
        {"ip": b["ip"], "until": b["until"], "reason": b["reason"], "by": b["by_login"], "created": b["created"]}
        for b in store.list_ip_bans()],
        "stats": {"users": len(users), "online": online, "rooms": len(rooms), "banned": sum(u["banned"] for u in users)}})


async def api_admin_action(request: web.Request):
    data = await read_json(request)
    admin = require_admin(request)
    if not admin:
        return api_error("Только для администратора", 403)
    action = data.get("action")
    reason = _clean_text(data.get("reason"), 120)

    if action == "announce":
        text = _clean_text(data.get("text"), 300)
        if not text:
            return api_error("Пустое объявление")
        n = await announce(text, display_name(admin))
        log.info("%s: объявление «%s» (%d чел.)", admin["login"], text, n)
        return web.json_response({"delivered": n})

    if action in ("ban-ip", "unban-ip"):
        ip = str(data.get("ip") or "").strip()[:64]
        try:
            ipaddress.ip_address(ip)
        except ValueError:
            return api_error("Неверный IP")
        if action == "unban-ip":
            store.unban_ip(ip)
            return web.json_response({})
        until = ban_until(data.get("seconds"))
        if until is None:
            return api_error("Неверный срок")
        await ban_guest_ip(ip, until, reason, admin["login"])
        return web.json_response({})

    target = store.user_by_login(accounts.clean_login(data.get("login")))
    if not target:
        return api_error("Пользователь не найден", 404)
    if target["id"] == admin["id"] and action in ("ban", "demote", "delete"):
        return api_error("С собой так нельзя")
    if action == "ban":
        until = ban_until(data.get("seconds"))
        if until is None:
            return api_error("Неверный срок")
        await ban_account(target, until, reason, admin["login"])
    elif action == "unban":
        store.unban_user(target["id"])
        log.info("%s разбанил %s", admin["login"], target["login"])
    elif action in ("promote", "demote"):
        store.set_admin(target["id"], action == "promote")
        log.info("%s %s права администратора у %s", admin["login"],
                 "выдал" if action == "promote" else "снял", target["login"])
        for p in live_peers_of(target["login"]):
            await drop_peer(p, "Ваши права изменились — войдите в комнату заново")
    elif action == "delete":
        for p in live_peers_of(target["login"]):
            await drop_peer(p, "Аккаунт удалён")
        for rid in [r["id"] for r in store.list_rooms(target) if r["owner_id"] == target["id"]]:
            live = rooms.pop(rid, None)
            for p in list(live.peers.values()) if live else []:
                await drop_peer(p, "Комнату удалили")
        store.delete_user(target["id"])
        log.info("%s удалил аккаунт %s", admin["login"], target["login"])
    else:
        return api_error("Неизвестное действие")
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
    peer.ip = ip

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
                    peer.name, peer.login = display_name(user), user["login"]
                    peer.admin, peer.guest = bool(user["is_admin"]), False
                    peer.profile = load_profile(user)
                elif not peer.guest or not msg.get("guest"):
                    await peer.send({"type": "error", "message": "Сессия закончилась — войдите в аккаунт заново"})
                    continue
                else:
                    peer.name, err = check_nick(msg.get("name"), None)
                    if err:
                        await peer.send({"type": "error", "message": err})
                        continue
                    prof, perr = clean_profile(msg.get("profile"))   # профиль гостя живёт в его браузере
                    peer.profile = dict(EMPTY_PROFILE) if perr else prof
                if (ban := store.ip_ban(ip)) and not peer.admin:
                    await peer.send({"type": "error", "message": ban_text(ban["until"], ban["reason"])})
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
                kick_key = peer.login or ip
                until = room_kicks.get(row["id"], {}).get(kick_key, 0)
                if until > time.time() and not peer.admin:
                    await peer.send({"type": "error", "message": f"Вас выгнали из этой комнаты. Можно вернуться через {int(until - time.time()) // 60 + 1} мин."})
                    continue
                if room is None:
                    room = rooms[row["id"]] = Room(row)
                peer.owner = peer.login is not None and peer.login == room.owner_login
                if user:
                    store.touch_seen(user["id"])
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

            elif kind == "profile" and peer.room:
                if time.time() - peer.renamed_at < 2:
                    await peer.send({"type": "error", "message": "Не так часто — подождите пару секунд"})
                    continue
                peer.renamed_at = time.time()
                user = None if peer.guest else current_user(request)
                if not peer.guest and not user:
                    await peer.send({"type": "error", "message": "Сессия закончилась — войдите в аккаунт заново"})
                    continue
                name, prof, err = await save_profile(user, msg)
                if err:
                    await peer.send({"type": "error", "message": err})
                    continue
                await push_profile(live_peers_of(user["login"]) if user else [peer], name, prof)

            elif kind in ("kick", "force-mute", "ban") and peer.room:
                target = peer.room.peers.get(str(msg.get("id")))
                if not target or target is peer:
                    continue
                if not can_moderate(peer, peer.room) or (target.admin and not peer.admin) or (target.admin and kind != "force-mute"):
                    await peer.send({"type": "error", "message": "Недостаточно прав"})
                    continue
                room = peer.room
                if kind == "force-mute":
                    await target.send({"type": "force-mute", "by": peer.name})
                    await broadcast(room, {"type": "notice", "text": f"{peer.name} выключил микрофон у {target.name}"})
                    continue
                reason = _clean_text(msg.get("reason"), 120)
                if kind == "ban":
                    if not peer.admin:
                        await peer.send({"type": "error", "message": "Банить может только администратор"})
                        continue
                    until = ban_until(msg.get("seconds"))
                    if until is None:
                        await peer.send({"type": "error", "message": "Неверный срок"})
                        continue
                    await broadcast(room, {"type": "notice", "text": f"⛔ {target.name} забанен"})
                    if target.login:
                        await ban_account(store.user_by_login(target.login), until, reason, peer.login)
                    else:
                        await ban_guest_ip(target.ip, until, reason, peer.login)
                    continue
                room_kicks.setdefault(room.id, {})[target.login or target.ip] = time.time() + KICK_COOLDOWN
                log.info("%s выгнал %s из комнаты %s", peer.name, target.name, room.name)
                await broadcast(room, {"type": "notice", "text": f"🚪 {peer.name} выгнал {target.name}"})
                await drop_peer(target, f"Вас выгнали из комнаты «{room.name}»" + (f". Причина: {reason}" if reason else ""))

            elif kind == "rename" and peer.room:
                if time.time() - peer.renamed_at < 2:
                    await peer.send({"type": "error", "message": "Не так часто"})
                    continue
                peer.renamed_at = time.time()   # любая попытка, иначе можно перебирать чужие логины
                user = None if peer.guest else current_user(request)
                if not peer.guest and not user:
                    await peer.send({"type": "error", "message": "Сессия закончилась — войдите в аккаунт заново"})
                    continue
                name, err = check_nick(msg.get("name"), user)
                if err:
                    await peer.send({"type": "error", "message": err})
                    continue
                if user:   # ник аккаунта запоминается для всех комнат
                    store.set_nick(user["id"], None if name == user["login"] else name)
                if name != peer.name:
                    log.info("%s теперь %s", peer.name, name)
                    peer.name = name
                    await broadcast(peer.room, {"type": "renamed", "id": peer.id, "name": name})

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
    app.router.add_post("/api/profile", api_profile)
    app.router.add_get("/api/admin/users", api_admin_users)
    app.router.add_post("/api/admin/action", api_admin_action)
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
