"""Аккаунты, сессии и комнаты (SQLite)."""

import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import time
import unicodedata
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR") or Path(__file__).resolve().parent / "data")
SESSION_TTL = 30 * 24 * 3600
MIN_PASSWORD = 8
MAX_PASSWORD = 128
MAX_ROOMS_PER_USER = 20
LOGIN_RE = re.compile(r"[A-Za-zА-Яа-яЁё0-9_.\-]{2,24}")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, login TEXT NOT NULL, login_key TEXT NOT NULL UNIQUE,
  pw TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, expires REAL NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, pw TEXT NOT NULL,
  owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- NULL: временная, создана гостем
  created REAL NOT NULL, last_used REAL NOT NULL);
-- в какие чужие комнаты аккаунт уже входил по паролю: туда пускаем без пароля
CREATE TABLE IF NOT EXISTS room_access (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, room_id));
"""


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(password.encode("utf-8", "replace"), salt=salt, n=2**14, r=8, p=1)
    return f"{salt.hex()}${h.hex()}"


def verify_password(password: str, stored: str) -> bool:
    salt, h = stored.split("$")
    got = hashlib.scrypt(password.encode("utf-8", "replace"), salt=bytes.fromhex(salt), n=2**14, r=8, p=1)
    return hmac.compare_digest(got.hex(), h)


# для несуществующих логинов: ответ занимает столько же времени
DUMMY_HASH = hash_password(secrets.token_hex(16))


def clean_login(raw) -> str:
    return unicodedata.normalize("NFKC", str(raw or "")).strip()


def login_key(login: str) -> str:
    return login.casefold()


def check_credentials_format(login: str, password: str) -> str | None:
    if not LOGIN_RE.fullmatch(login):
        return "Логин: 2–24 символа — буквы, цифры, точка, дефис или _"
    if not MIN_PASSWORD <= len(password) <= MAX_PASSWORD:
        return f"Пароль: от {MIN_PASSWORD} до {MAX_PASSWORD} символов"
    return None


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8", "replace")).hexdigest()


class Store:
    def __init__(self, path: Path | None = None):
        path = path or DATA_DIR / "voice.db"
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, isolation_level=None, timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript(SCHEMA)
        # старые базы: ник появился позже (NULL — показывать логин)
        cols = {r[1] for r in self.db.execute("PRAGMA table_info(users)")}
        if "nick" not in cols:
            self.db.execute("ALTER TABLE users ADD COLUMN nick TEXT")
        if "profile" not in cols:   # JSON: аватар, цвет, статус, о себе
            self.db.execute("ALTER TABLE users ADD COLUMN profile TEXT")
        self.db.execute("DELETE FROM sessions WHERE expires < ?", (time.time(),))

    def drop_guest_rooms(self):
        """При старте сервера в гостевых комнатах никого нет."""
        self.db.execute("DELETE FROM rooms WHERE owner_id IS NULL")

    def one(self, sql, *args):
        return self.db.execute(sql, args).fetchone()

    # --- пользователи
    def user_by_login(self, login: str):
        return self.one("SELECT * FROM users WHERE login_key=?", login_key(login))

    def create_user(self, login: str, pw_hash: str) -> int | None:
        """None — логин занят."""
        try:
            return self.db.execute(
                "INSERT INTO users(login, login_key, pw, created) VALUES(?,?,?,?)",
                (login, login_key(login), pw_hash, time.time())).lastrowid
        except sqlite3.IntegrityError:
            return None

    def set_password(self, user_id: int, pw_hash: str):
        self.db.execute("UPDATE users SET pw=? WHERE id=?", (pw_hash, user_id))
        self.db.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))

    def make_admin(self, user_id: int):
        self.db.execute("UPDATE users SET is_admin=1 WHERE id=?", (user_id,))

    # --- сессии (в базе только хэш токена)
    def new_session(self, user_id: int) -> str:
        token = secrets.token_urlsafe(32)
        self.db.execute("INSERT INTO sessions(token_hash, user_id, expires) VALUES(?,?,?)",
                        (_token_hash(token), user_id, time.time() + SESSION_TTL))
        return token

    def session_user(self, token: str):
        if not token:
            return None
        return self.one("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id "
                        "WHERE s.token_hash=? AND s.expires>?", _token_hash(token), time.time())

    def end_session(self, token: str):
        self.db.execute("DELETE FROM sessions WHERE token_hash=?", (_token_hash(token),))

    # --- комнаты
    def room_by_name(self, name: str):
        return self.one("SELECT * FROM rooms WHERE name=?", name)

    def room_by_id(self, room_id: int):
        return self.one("SELECT * FROM rooms WHERE id=?", room_id)

    def room_count(self, owner_id: int) -> int:
        return self.one("SELECT COUNT(*) FROM rooms WHERE owner_id=?", owner_id)[0]

    def create_room(self, name: str, pw_hash: str, owner_id: int | None) -> bool:
        now = time.time()
        try:
            self.db.execute("INSERT INTO rooms(name, pw, owner_id, created, last_used) VALUES(?,?,?,?,?)",
                            (name, pw_hash, owner_id, now, now))
            return True
        except sqlite3.IntegrityError:
            return False

    def touch_room(self, room_id: int):
        self.db.execute("UPDATE rooms SET last_used=? WHERE id=?", (time.time(), room_id))

    def delete_room(self, room_id: int):
        self.db.execute("DELETE FROM rooms WHERE id=?", (room_id,))

    def set_profile(self, user_id: int, nick: str | None, profile: str):
        self.db.execute("UPDATE users SET nick=?, profile=? WHERE id=?", (nick, profile, user_id))

    def set_nick(self, user_id: int, nick: str | None):
        self.db.execute("UPDATE users SET nick=? WHERE id=?", (nick, user_id))

    def grant_access(self, user_id: int, room_id: int):
        self.db.execute("INSERT OR IGNORE INTO room_access (user_id, room_id) VALUES (?, ?)", (user_id, room_id))

    def has_access(self, user_id: int, room_id: int) -> bool:
        return self.one("SELECT 1 FROM room_access WHERE user_id=? AND room_id=?", user_id, room_id) is not None

    def forget_access(self, user_id: int, room_id: int):
        self.db.execute("DELETE FROM room_access WHERE user_id=? AND room_id=?", (user_id, room_id))

    def list_rooms(self, user):
        # все комнаты видны всем аккаунтам; known — аккаунт уже входил сюда по паролю
        return self.db.execute(
            "SELECT r.*, u.login AS owner, a.user_id IS NOT NULL AS known FROM rooms r "
            "LEFT JOIN users u ON u.id=r.owner_id "
            "LEFT JOIN room_access a ON a.room_id=r.id AND a.user_id=? "
            "ORDER BY r.last_used DESC", (user["id"],)).fetchall()
