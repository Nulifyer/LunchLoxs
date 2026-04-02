#!/usr/bin/env bash
#
# Full test suite: type checks, unit tests, integration tests (with DB).
#
# Usage:
#   ./test.sh          # run everything
#   ./test.sh --unit   # skip integration tests (no DB needed)
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
RESET='\033[0m'

SKIP_INTEGRATION=false
if [[ "${1:-}" == "--unit" ]]; then
  SKIP_INTEGRATION=true
fi

step() { echo -e "\n${BOLD}── $1${RESET}"; }
pass() { echo -e "${GREEN}✓ $1${RESET}"; }
fail() { echo -e "${RED}✗ $1${RESET}"; exit 1; }

# ── 1. Frontend type check ──────────────────────────────────────────

step "Frontend: TypeScript type check"
cd "$ROOT/frontend"
./node_modules/.bin/tsc --noEmit || fail "TypeScript type check failed"
pass "Type check passed"

# ── 2. Frontend build ────────────────────────────────────────────────

step "Frontend: Build"
bun run build || fail "Frontend build failed"
pass "Build passed"

# ── 3. Frontend unit tests ───────────────────────────────────────────

step "Frontend: Unit tests"
bun test \
  src/lib/__tests__/automerge-sync.test.ts \
  src/lib/__tests__/catalog-recipe-sync.test.ts \
  src/lib/__tests__/quantity.test.ts \
  src/lib/__tests__/units.test.ts \
  src/lib/__tests__/densities.test.ts \
  src/sync/__tests__/push-queue.test.ts \
  || fail "Unit tests failed"
pass "Unit tests passed"

# ── 4. Backend build + vet ───────────────────────────────────────────

step "Backend: Build & vet"
cd "$ROOT"
go build ./... || fail "Go build failed"
go vet ./... || fail "Go vet failed"
pass "Backend build & vet passed"

if $SKIP_INTEGRATION; then
  echo ""
  pass "Unit-only run complete (skipped integration tests)"
  exit 0
fi

# ── 5. Start test database ──────────────────────────────────────────

step "Starting test database"
podman compose -f docker-compose.test.yml down -v --remove-orphans 2>/dev/null || true
podman compose -f docker-compose.test.yml up -d --wait || fail "Failed to start test database"
pass "Test database is up"

# Ensure DB is torn down on exit (success or failure)
cleanup() {
  step "Tearing down test database"
  cd "$ROOT"
  podman compose -f docker-compose.test.yml down -v --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

# ── 6. Backend integration tests (Go) ───────────────────────────────

step "Backend: Integration tests"
cd "$ROOT"
TEST_DATABASE_URL="postgres://postgres:postgres@localhost:5432/localdb?sslmode=disable" \
  go test ./... -v -timeout 120s || fail "Backend integration tests failed"
pass "Backend integration tests passed"

# ── 7. Frontend integration tests (TS → Go → TS) ────────────────────

step "Frontend: Integration tests"
cd "$ROOT/frontend"
TEST_DATABASE_URL="postgres://postgres:postgres@localhost:5432/localdb?sslmode=disable" \
  bun test src/lib/__tests__/integration.test.ts || fail "Frontend integration tests failed"
pass "Frontend integration tests passed"

# ── Done ─────────────────────────────────────────────────────────────

echo ""
pass "All tests passed"
