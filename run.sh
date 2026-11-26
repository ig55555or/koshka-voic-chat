#!/usr/bin/env bash
# Запуск голосового чата в Docker за Caddy одной командой.
#
#   bash run.sh [домен]     — собрать и запустить (повторный запуск = обновление)
#   bash run.sh logs        — логи
#   bash run.sh stop        — остановить (аккаунты и комнаты сохраняются)
#   bash run.sh admin ЛОГИН  — создать администратора
#   bash run.sh passwd ЛОГИН — сменить пароль аккаунта
#
# Caddy скрипт НЕ трогает: только смотрит, как он запущен, чтобы понять,
# по какому адресу Caddy сможет достучаться до voice-chat.
set -euo pipefail
cd "$(dirname "$0")"

c_ok()   { printf '\033[32m✔ %s\033[0m\n' "$*"; }
c_warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
c_err()  { printf '\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || c_err "Docker не установлен"
if docker compose version >/dev/null 2>&1; then DC=(docker compose)
elif command -v docker-compose >/dev/null; then DC=(docker-compose)
else c_err "Нет docker compose (установите пакет docker-compose-plugin)"; fi

[ -f .env ] || cp .env.example .env
envget() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
envset() {
  if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}

case "${1:-}" in
  logs) exec docker logs -f --tail 100 voice-chat ;;
  turnlogs) exec docker logs -f --tail 100 voice-coturn ;;
  admin|passwd)
    [ -n "${2:-}" ] || c_err "Укажите логин: bash run.sh $1 ЛОГИН"
    flag=--admin; [ "$1" = passwd ] && flag=--set-password
    exec docker exec -it voice-chat python server.py "$flag" "$2" ;;
  stop) "${DC[@]}" --profile turn down; c_ok "Остановлено"; exit 0 ;;
esac
DOMAIN="${1:-$(envget TURN_DOMAIN)}"
DOMAIN="${DOMAIN:-voice.example.com}"

CADDY="$(docker ps --format '{{.Names}} {{.Image}}' | awk 'tolower($0) ~ /caddy/ {print $1; exit}')"

# ---------- TURN/STUN (весь трафик идёт через него)
PROFILES=()
if [ "$(envget TURN_ENABLED)" != 0 ]; then
  if [ -z "$(envget TURN_SECRET)" ]; then
    envset TURN_SECRET "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  IP="$(envget TURN_EXTERNAL_IP)"
  if [ -z "$IP" ]; then
    IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
    case "$IP" in
      ""|10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*)
        c_err "Не удалось определить внешний IP сервера (получил '${IP:-ничего}'). Впишите его в .env: TURN_EXTERNAL_IP=x.x.x.x" ;;
    esac
    envset TURN_EXTERNAL_IP "$IP"
  fi
  URLS="turn:$IP:3478?transport=udp,turn:$IP:3478?transport=tcp"

  # TURN поверх TLS (порт 5349) — нужен настоящий сертификат домена. Берём тот, что уже
  # выпустил Caddy: ищем его папку среди томов контейнера Caddy (только чтение, Caddy не трогаем).
  CERT_DIR=""
  mkdir -p certs
  if [ -n "$CADDY" ] && [ "$DOMAIN" != voice.example.com ]; then
    while IFS= read -r src; do
      [ -d "$src" ] || continue
      found="$(find "$src" -maxdepth 5 -type d -path "*certificates/*/$DOMAIN" 2>/dev/null | head -1)"
      if [ -n "$found" ] && [ -f "$found/$DOMAIN.crt" ] && [ -f "$found/$DOMAIN.key" ]; then CERT_DIR="$found"; break; fi
    done < <(docker inspect -f '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' "$CADDY")
  fi
  if [ -n "$CERT_DIR" ]; then
    envset TURN_CERT_DIR "$CERT_DIR"
    envset TURN_DOMAIN "$DOMAIN"
    URLS="$URLS,turns:$DOMAIN:5349?transport=tcp"
    c_ok "TURN по TLS: $DOMAIN:5349 (сертификат Caddy)"
  else
    mkdir -p certs
    envset TURN_CERT_DIR ""
    c_warn "Не нашёл сертификат $DOMAIN у Caddy — TURN по TLS (для мобильного интернета) выключен."
    c_warn "Запустите с вашим доменом: bash run.sh ваш.домен (сайт должен уже открываться по https)."
  fi

  envset TURN_URL "$URLS"
  PROFILES=(--profile turn)
  c_ok "TURN/STUN: $IP:3478"
fi

PORT="$(envget VOICE_PORT)"; PORT="${PORT:-18080}"

# ---------- как запущен Caddy (только чтение)
FILES=(-f docker-compose.yml)
NET="$(envget CADDY_NETWORK)"
UPSTREAM="127.0.0.1:$PORT"

if [ -n "$NET" ] && docker network inspect "$NET" >/dev/null 2>&1; then
  MODE=net
else
  MODE=host
  if [ -n "$CADDY" ]; then
    NM="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CADDY")"
    if [ "$NM" != host ]; then
      NET="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$CADDY" \
            | grep -vE '^(bridge|host|none)?$' | head -1 || true)"
      [ -n "$NET" ] && MODE=net
    fi
  else
    c_warn "Контейнер Caddy не найден — считаю, что Caddy ходит на 127.0.0.1"
  fi
fi

if [ "$MODE" = net ]; then
  envset CADDY_NETWORK "$NET"
  FILES+=(-f docker-compose.caddy-net.yml)
  UPSTREAM="voice-chat:8080"
  c_ok "Caddy в docker-сети '$NET' — подключаю voice-chat туда же"
else
  c_ok "Caddy в сети хоста — voice-chat будет доступен на 127.0.0.1:$PORT (только локально)"
fi

# ---------- сборка и запуск
export VOICE_PORT="$PORT"
"${DC[@]}" "${FILES[@]}" "${PROFILES[@]}" up -d --build --remove-orphans

printf 'Жду запуска'
st=starting
for _ in $(seq 1 30); do
  st="$(docker inspect -f '{{.State.Health.Status}}' voice-chat 2>/dev/null || echo starting)"
  [ "$st" = healthy ] && break
  [ "$st" = unhealthy ] && { echo; docker logs --tail 30 voice-chat; c_err "Контейнер не поднялся"; }
  printf '.'; sleep 2
done
echo
[ "$st" = healthy ] && c_ok "Сервер работает" || c_warn "Сервер ещё стартует — проверьте: bash run.sh logs"

if [ ${#PROFILES[@]} -gt 0 ]; then
  sleep 1
  if docker ps --format '{{.Names}}' | grep -qx voice-coturn; then c_ok "TURN-сервер запущен"
  else c_warn "TURN-сервер не запустился — смотрите: bash run.sh turnlogs"; fi
  cat <<EOF

Для TURN должны быть открыты порты (в фаерволе сервера и в панели хостера, если там есть фаервол):
  3478/udp, 3478/tcp, 5349/tcp, 49160-49200/udp
EOF
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    echo "У вас включён ufw. Открыть порты можно так:"
    echo "  ufw allow 3478 && ufw allow 5349/tcp && ufw allow 49160:49200/udp"
  fi
  if [ -n "$(envget TURN_CERT_DIR)" ]; then
    cat <<EOF

Caddy сам продлевает сертификат раз в ~2 месяца, а coturn читает его при старте.
Чтобы TLS не протух, добавьте еженедельный перезапуск (crontab -e):
  0 5 * * 1 docker restart voice-coturn
EOF
  fi
fi

cat <<EOF

Блок для Caddyfile:
  $DOMAIN {
  	encode zstd gzip
  	reverse_proxy $UPSTREAM
  }
EOF
