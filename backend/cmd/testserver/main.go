// testserver starts a test HTTP/WebSocket server for integration testing.
//
// It connects to a test PostgreSQL database, runs migrations, cleans all tables,
// starts an httptest server on a random port, and prints the URL to stdout.
// It shuts down when stdin is closed or SIGTERM is received.
//
// Usage:
//
//	go run ./backend/cmd/testserver
//	# prints: READY http://127.0.0.1:<port>
//
// Environment:
//
//	TEST_DATABASE_URL (default: postgres://postgres:postgres@localhost:5432/localdb?sslmode=disable)
package main

import (
	"context"
	"fmt"
	"log"
	"net/http/httptest"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kyle/recipepwa/backend/internal/db"
	"github.com/kyle/recipepwa/backend/internal/server"
	syncpkg "github.com/kyle/recipepwa/backend/internal/sync"
)

func main() {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://postgres:postgres@localhost:5432/localdb?sslmode=disable"
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatalf("Cannot connect to test DB: %v", err)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		log.Fatalf("Cannot ping test DB: %v", err)
	}

	// Run migrations (execute .up.sql files in order)
	if err := runMigrations(ctx, pool); err != nil {
		log.Fatalf("Migration failed: %v", err)
	}

	// Clean all tables
	if _, err := pool.Exec(ctx, "DELETE FROM blobs; DELETE FROM sync_messages; DELETE FROM vault_members; DELETE FROM vaults; DELETE FROM devices; DELETE FROM users"); err != nil {
		log.Fatalf("Failed to clean tables: %v", err)
	}

	queries := db.New(pool)
	rate := syncpkg.RateConfig{PerSec: 50, Burst: 200}
	// Accept all origins in test mode (Bun's WebSocket may not send a matching Origin header)
	mux := server.NewMux(queries, "*", rate)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	fmt.Printf("READY %s\n", srv.URL)
	os.Stdout.Sync()

	// Wait for SIGTERM or SIGINT
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	<-sig
}

func runMigrations(ctx context.Context, pool *pgxpool.Pool) error {
	// Find migrations directory relative to the binary or working directory
	migrationsDir := findMigrationsDir()
	if migrationsDir == "" {
		return fmt.Errorf("cannot find migrations directory")
	}

	entries, err := os.ReadDir(migrationsDir)
	if err != nil {
		return fmt.Errorf("read migrations dir: %w", err)
	}

	var upFiles []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".up.sql") {
			upFiles = append(upFiles, e.Name())
		}
	}
	sort.Strings(upFiles)

	for _, name := range upFiles {
		sql, err := os.ReadFile(filepath.Join(migrationsDir, name))
		if err != nil {
			return fmt.Errorf("read %s: %w", name, err)
		}
		if _, err := pool.Exec(ctx, string(sql)); err != nil {
			// Ignore "already exists" errors for idempotency
			if !strings.Contains(err.Error(), "already exists") {
				return fmt.Errorf("exec %s: %w", name, err)
			}
		}
	}
	return nil
}

func findMigrationsDir() string {
	candidates := []string{
		"backend/migrations",
		"../backend/migrations",
		"../../backend/migrations",
		"migrations",
		"../migrations",
	}
	for _, c := range candidates {
		if info, err := os.Stat(c); err == nil && info.IsDir() {
			return c
		}
	}
	return ""
}
