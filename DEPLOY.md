# Temporary deployment guide

A short-lived, single-server deployment with Docker Compose. The API and the processor share an invoice volume, so run them on the same host.

## 1. Configure

```bash
cp .env.example .env
```

Set at least `POSTGRES_PASSWORD` (a strong value), `GEMINI_API_KEY`, and `IES_ALLOWED_ORIGINS` (your public URL). Compose passes the database password to the services for you.

## 2. Start

```bash
docker compose up --build -d
docker compose ps          # all services should become healthy
```

The web UI is on `127.0.0.1:8088`. Every port is bound to loopback on purpose; put a reverse proxy in front.

## 3. Put a login in front (required)

The app's own OIDC auth is not wired into the UI, and `IES_AUTH_ENABLED=true` would make every UI request return 401. Leave it `false` and enforce access at the edge, for example with Caddy:

```
your.domain {
  basic_auth {
    youruser <hash from: caddy hash-password>
  }
  reverse_proxy 127.0.0.1:8088
}
```

Alternatives: Cloudflare Tunnel + Cloudflare Access, or Tailscale (private network only). Never expose port 8088 or 8080 directly.

## 4. Before sharing

- Set a spend limit on the Gemini API key.
- Confirm Gemini's data-use terms allow the invoices you will upload.

## 5. Tear down

```bash
docker compose down        # stops, keeps data
docker compose down -v     # stops AND deletes the database and uploaded invoices
```

Rotate or delete the Gemini key afterwards, then destroy the server.
