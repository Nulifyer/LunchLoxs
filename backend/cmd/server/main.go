package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kyle/recipepwa/backend/internal/db"
	"github.com/kyle/recipepwa/backend/internal/server"
	syncpkg "github.com/kyle/recipepwa/backend/internal/sync"
)

func main() {
	// Configure structured logging
	logLevel := new(slog.LevelVar)
	switch getEnv("LOG_LEVEL", "info") {
	case "debug":
		logLevel.Set(slog.LevelDebug)
	case "warn":
		logLevel.Set(slog.LevelWarn)
	case "error":
		logLevel.Set(slog.LevelError)
	default:
		logLevel.Set(slog.LevelInfo)
	}
	var handler slog.Handler
	if getEnv("LOG_FORMAT", "text") == "json" {
		handler = slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel})
	} else {
		handler = slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel})
	}
	slog.SetDefault(slog.New(handler))

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	databaseURL := getEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/localdb?sslmode=disable")
	port := getEnv("PORT", "8000")
	bindHost := getEnv("BIND_HOST", "127.0.0.1")
	frontendHost := getEnv("FRONTEND_HOST", "localhost:5000")
	frontendHTTPS := getEnv("FRONTEND_HTTPS", "")
	frontendScheme := "http"
	if frontendHTTPS == "true" {
		frontendScheme = "https"
	}
	frontendURL := frontendScheme + "://" + frontendHost

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		slog.Error("failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		slog.Error("failed to ping database", "error", err)
		os.Exit(1)
	}
	slog.Info("connected to database")

	rateConfig := syncpkg.DefaultRateConfig()
	if v := os.Getenv("RATE_LIMIT_PER_SEC"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			rateConfig.PerSec = n
		}
	}
	if v := os.Getenv("RATE_LIMIT_BURST"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			rateConfig.Burst = n
		}
	}
	slog.Info("rate limiting", "per_sec", rateConfig.PerSec, "burst", rateConfig.Burst)

	queries := db.New(pool)

	var muxOpts []server.MuxOption
	if browserlessEndpoint := os.Getenv("BROWSERLESS_ENDPOINT"); browserlessEndpoint != "" {
		token := os.Getenv("BROWSERLESS_TOKEN")
		slog.Info("Browserless JS rendering enabled", "endpoint", browserlessEndpoint)
		muxOpts = append(muxOpts, server.WithBrowserless(browserlessEndpoint, token))
	}
	mux := server.NewMux(queries, frontendURL, rateConfig, muxOpts...)

	addr := fmt.Sprintf("%s:%s", bindHost, port)
	srv := &http.Server{
		Addr:    addr,
		Handler: mux,
	}

	go func() {
		slog.Info("server listening", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	slog.Info("shutting down...")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown error", "error", err)
		os.Exit(1)
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
