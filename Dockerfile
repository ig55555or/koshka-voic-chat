FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    TRUST_PROXY=1

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY server.py accounts.py ./
COPY public ./public

# имя "voice" занято системной группой Debian, поэтому voicechat
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin voicechat
# база аккаунтов и комнат живёт в томе /data
RUN mkdir /data && chown voicechat /data
ENV DATA_DIR=/data
VOLUME /data
USER voicechat

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=3); sys.exit(0)"

# TLS делает Caddy, поэтому внутри — обычный HTTP
CMD ["python", "server.py", "--no-tls", "--port", "8080"]
