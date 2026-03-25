# LunchLoxs

End-to-end encrypted recipe manager. Your data stays yours.

## Features

- **End-to-end encryption** -- Proton Pass-style key hierarchy: passphrase -> Argon2id -> wrapping key -> master key -> data encryption
- **Vault-based sharing** -- ECDH P-256 key exchange, per-vault encryption keys, role-based access (owner/editor/viewer)
- **Real-time collaboration** -- Automerge CRDTs with WebSocket sync, live cursors, conflict-free editing
- **Payload signing** -- ECDSA P-256 signatures on all sync payloads
- **Offline-first PWA** -- Service worker caching, IndexedDB storage, works without network
- **Markdown instructions** -- CodeMirror editor with live preview via marked + DOMPurify
- **Import/Export** -- Markdown with YAML frontmatter, zip archives for multi-book import
- **Fuzzy search** -- fzf-style scoring across titles, tags, and book names
- **12 themes** -- Dracula, Catppuccin (Latte/Frappe/Macchiato/Mocha), Nord, Tokyo Night, Everforest, Gruvbox, Dark, Light

## Architecture

```
frontend/          TypeScript PWA (Bun build)
  src/
    ui/            Auth, books, recipes, sharing, account
    views/         Recipe list, recipe detail
    sync/          Push, vault helpers
    lib/           Crypto, sync client, search, Automerge, CodeMirror, themes
  public/          Static assets, CSS, HTML

backend/           Go HTTP + WebSocket server
  cmd/server/      Entrypoint
  internal/
    server/        HTTP routes, CORS
    sync/          WebSocket hub, client handling, rate limiting
    db/            PostgreSQL queries (pgx)
  migrations/      SQL migrations (golang-migrate)
```

## Development

### Prerequisites

- [Bun](https://bun.sh/) (frontend build/dev)
- [Go](https://go.dev/) 1.26+ (backend)
- [Podman](https://podman.io/) or Docker (database, reverse proxy)

### Local setup

```sh
# Start postgres, run migrations, and launch Traefik
podman compose up -d

# Backend (connects to local postgres)
cd backend
go run ./cmd/server

# Frontend (live rebuild)
cd frontend
bun install
bun run dev
```

Frontend: `http://localhost:5000` | Backend: `http://localhost:8000` | PgAdmin: `http://localhost:5050`

### Docker/Podman compose (full stack)

```sh
podman compose up --build
```

Traefik handles TLS termination with a self-signed certificate on localhost.

### Production deployment

Pull pre-built images from GHCR and run with your own domain and TLS certificate.

```sh
# 1. Download the prod compose files
curl -LO https://raw.githubusercontent.com/Nulifyer/LunchLoxs/main/docker-compose.prod.yml
curl -LO https://raw.githubusercontent.com/Nulifyer/LunchLoxs/main/.env.example

# 2. Configure environment
cp .env.example .env
# Edit .env: set DOMAIN and POSTGRES_PASSWORD

# 3. Add TLS certificate and Traefik config
mkdir -p certs traefik
cp /path/to/fullchain.pem certs/cert.pem
cp /path/to/privkey.pem certs/key.pem
curl -o traefik/dynamic.yml https://raw.githubusercontent.com/Nulifyer/LunchLoxs/main/traefik-dynamic.yml

# 4. Launch
docker compose -f docker-compose.prod.yml up -d
```

All three images (frontend, backend, migrate) are pulled from GHCR -- no need to clone the repo. This gives you:
- Traefik reverse proxy with HTTPS (port 443) and HTTP->HTTPS redirect (port 80)
- Frontend and backend on a single domain (backend at `/api` and `/ws`)
- PostgreSQL with persistent volume
- Migrations bundled in the migrate image, auto-run on startup

To pin a specific version instead of `latest`:
```sh
# In docker-compose.prod.yml, replace :latest with a tag
image: ghcr.io/nulifyer/lunchloxs-backend:v0.1.0
image: ghcr.io/nulifyer/lunchloxs-frontend:v0.1.0
```

### Generate test data

```sh
cd frontend
bun run dev-data/generate-large.ts [books] [recipes-per-book]
```

### Regenerate icons

```sh
cd frontend
bun add -d @resvg/resvg-js && bun run scripts/gen-icons.ts && bun remove @resvg/resvg-js
```

## Security model

| Layer | Mechanism |
|---|---|
| Authentication | Argon2id hash (server never sees passphrase) |
| Master key | AES-256-GCM wrapped with Argon2id-derived wrapping key |
| Vault keys | AES-256-GCM, exchanged via ECDH P-256 + HKDF |
| Data at rest | AES-256-GCM per document in IndexedDB |
| Data in transit | AES-256-GCM encrypted payloads over WebSocket |
| Payload signing | ECDSA P-256 on all sync messages |
| Key rotation | New vault key generated on member removal |
| Timing attacks | 2-second minimum auth time, constant-time compare |
| Rate limiting | Token bucket (30 msg/sec, burst 50) on WebSocket |

## License

[MIT](LICENSE)
