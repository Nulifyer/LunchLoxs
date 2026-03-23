.PHONY: generate build-backend build-frontend dev-backend dev-frontend migrate-up migrate-down migrate-create

# Generate protobuf code for Go + TypeScript
generate:
	buf generate

# Backend
build-backend:
	go build -o backend/bin/server ./backend/cmd/server

dev-backend:
	go run ./backend/cmd/server

# Frontend
build-frontend:
	cd frontend && bun run build

dev-frontend:
	cd frontend && bun run dev

# Migrations (golang-migrate)
migrate-up:
	migrate -path backend/migrations -database "$$DATABASE_URL" up

migrate-down:
	migrate -path backend/migrations -database "$$DATABASE_URL" down

migrate-create:
	migrate create -ext sql -dir backend/migrations -seq $(NAME)

# Dev: start everything
dev:
	@echo "Starting PostgreSQL, backend, and frontend..."
	docker compose up -d
	$(MAKE) dev-backend &
	$(MAKE) dev-frontend
