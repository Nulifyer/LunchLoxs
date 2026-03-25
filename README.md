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
