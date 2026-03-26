package sync_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kyle/recipepwa/backend/internal/db"
	"github.com/kyle/recipepwa/backend/internal/server"
	syncpkg "github.com/kyle/recipepwa/backend/internal/sync"
)

// --- Test helpers ---

type wsMsg map[string]any

func getTestDSN() string {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://postgres:postgres@localhost:5432/todos_test?sslmode=disable"
	}
	return dsn
}

func setupTestDB(t *testing.T) *db.Queries {
	t.Helper()
	ctx := context.Background()
	dsn := getTestDSN()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Skipf("Cannot connect to test DB: %v (set TEST_DATABASE_URL or run postgres)", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Skipf("Cannot ping test DB: %v", err)
	}
	// Clean tables for each test (order respects FK constraints)
	if _, err := pool.Exec(ctx, "DELETE FROM sync_messages; DELETE FROM vault_members; DELETE FROM vaults; DELETE FROM devices; DELETE FROM users"); err != nil {
		pool.Close()
		t.Fatalf("Failed to clean tables: %v", err)
	}
	t.Cleanup(func() { pool.Close() })
	return db.New(pool)
}

func startTestServer(t *testing.T, queries *db.Queries) string {
	t.Helper()
	rate := syncpkg.RateConfig{PerSec: 50, Burst: 100}
	mux := server.NewMux(queries, "http://localhost:5000", rate)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return "ws" + srv.URL[4:] // http -> ws
}

type testClient struct {
	conn *websocket.Conn
	t    *testing.T
}

func connect(t *testing.T, wsURL string) *testClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL+"/ws", nil)
	if err != nil {
		t.Fatalf("Failed to connect: %v", err)
	}
	conn.SetReadLimit(10 * 1024 * 1024)
	t.Cleanup(func() { conn.CloseNow() })
	return &testClient{conn: conn, t: t}
}

func (c *testClient) send(msg wsMsg) {
	c.t.Helper()
	data, _ := json.Marshal(msg)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.conn.Write(ctx, websocket.MessageText, data); err != nil {
		c.t.Fatalf("Failed to send: %v", err)
	}
}

func (c *testClient) recv(timeout time.Duration) wsMsg {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	_, data, err := c.conn.Read(ctx)
	if err != nil {
		c.t.Fatalf("Failed to recv: %v", err)
	}
	var msg wsMsg
	if err := json.Unmarshal(data, &msg); err != nil {
		c.t.Fatalf("Failed to parse: %v", err)
	}
	return msg
}

func (c *testClient) recvType(msgType string, timeout time.Duration) wsMsg {
	c.t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			c.t.Fatalf("Timed out waiting for message type %q", msgType)
		}
		msg := c.recv(remaining)
		if msg["type"] == msgType {
			return msg
		}
	}
}

// getFloat64 safely extracts a float64 from a JSON-decoded map (handles nil, missing).
func getFloat64(msg wsMsg, key string) float64 {
	v, ok := msg[key]
	if !ok || v == nil {
		return 0
	}
	f, ok := v.(float64)
	if !ok {
		return 0
	}
	return f
}

func (c *testClient) authenticate(userID, authHash, deviceID string, isSignup bool) {
	c.t.Helper()
	c.send(wsMsg{
		"type":      "connect",
		"user_id":   userID,
		"device_id": deviceID,
		"auth_hash": authHash,
		"is_signup": isSignup,
	})
	msg := c.recvType("connected", 10*time.Second) // 2s auth delay + buffer
	if msg["type"] != "connected" {
		c.t.Fatalf("Expected connected, got: %v", msg)
	}
}

// --- Tests ---

func TestBasicSync(t *testing.T) {
	queries := setupTestDB(t)
	wsURL := startTestServer(t, queries)

	// Connect two clients as same user, different devices
	clientA := connect(t, wsURL)
	clientA.authenticate("user1", "hash1", "00000000-0000-0000-0000-00000000000a", true)

	clientB := connect(t, wsURL)
	clientB.authenticate("user1", "hash1", "00000000-0000-0000-0000-00000000000b", false)

	// Both subscribe to same doc
	clientA.send(wsMsg{"type": "subscribe", "doc_id": "catalog", "last_seq": 0})
	clientA.recvType("caught_up", 5*time.Second)

	clientB.send(wsMsg{"type": "subscribe", "doc_id": "catalog", "last_seq": 0})
	clientB.recvType("caught_up", 5*time.Second)

	// A pushes
	clientA.send(wsMsg{"type": "push", "doc_id": "catalog", "payload": "dGVzdC1kYXRh"})
	ack := clientA.recvType("ack", 5*time.Second)
	if ack["doc_id"] != "catalog" {
		t.Fatalf("Expected ack for catalog, got: %v", ack)
	}

	// B receives sync
	sync := clientB.recvType("sync", 5*time.Second)
	if sync["doc_id"] != "catalog" {
		t.Fatalf("Expected sync for catalog, got: %v", sync)
	}
	if sync["payload"] != "dGVzdC1kYXRh" {
		t.Fatalf("Payload mismatch: %v", sync["payload"])
	}
}

func TestCaughtUpSequencing(t *testing.T) {
	queries := setupTestDB(t)
	wsURL := startTestServer(t, queries)

	clientA := connect(t, wsURL)
	clientA.authenticate("user1", "hash1", "00000000-0000-0000-0000-00000000000a", true)

	// Subscribe, get caught_up at seq 0
	clientA.send(wsMsg{"type": "subscribe", "doc_id": "catalog", "last_seq": 0})
	cu := clientA.recvType("caught_up", 5*time.Second)
	if getFloat64(cu, "latest_seq") != 0 {
		t.Fatalf("Expected latest_seq 0, got: %v", cu["latest_seq"])
	}

	// Push, get ack at seq 1
	clientA.send(wsMsg{"type": "push", "doc_id": "catalog", "payload": "cGF5bG9hZDE="})
	ack := clientA.recvType("ack", 5*time.Second)
	seq1 := getFloat64(ack, "seq")
	if seq1 != 1 {
		t.Fatalf("Expected seq 1, got: %v", seq1)
	}

	// New client subscribes with last_seq=0, should get sync + caught_up
	clientB := connect(t, wsURL)
	clientB.authenticate("user1", "hash1", "00000000-0000-0000-0000-00000000000b", false)
	clientB.send(wsMsg{"type": "subscribe", "doc_id": "catalog", "last_seq": 0})

	syncMsg := clientB.recvType("sync", 5*time.Second)
	if getFloat64(syncMsg, "seq") != 1 {
		t.Fatalf("Expected sync seq 1, got: %v", syncMsg["seq"])
	}

	cu2 := clientB.recvType("caught_up", 5*time.Second)
	if getFloat64(cu2, "latest_seq") != 1 {
		t.Fatalf("Expected latest_seq 1, got: %v", cu2["latest_seq"])
	}

	// Subscribe again with last_seq=1, should get caught_up with no sync
	clientB.send(wsMsg{"type": "subscribe", "doc_id": "catalog", "last_seq": 1})
	cu3 := clientB.recvType("caught_up", 5*time.Second)
	if getFloat64(cu3, "latest_seq") != 1 {
		t.Fatalf("Expected latest_seq 1 (no new messages), got: %v", cu3["latest_seq"])
	}
}

func TestRateLimiting(t *testing.T) {
	queries := setupTestDB(t)

	// Use very low rate limit for testing
	rate := syncpkg.RateConfig{PerSec: 2, Burst: 3}
	mux := server.NewMux(queries, "http://localhost:5000", rate)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	wsURL := "ws" + srv.URL[4:]

	client := connect(t, wsURL)
	client.authenticate("user1", "hash1", "00000000-0000-0000-0000-00000000000a", true)
	client.send(wsMsg{"type": "subscribe", "doc_id": "catalog", "last_seq": 0})
	client.recvType("caught_up", 5*time.Second)

	// Send rapid pushes -- first few should get acks, rest should be rate limited
	acks := 0
	errors := 0
	var gotRetryAfter bool
	for i := 0; i < 8; i++ {
		client.send(wsMsg{"type": "push", "doc_id": "catalog", "payload": base64.StdEncoding.EncodeToString([]byte(fmt.Sprintf("payload-%d", i)))})
	}

	deadline := time.Now().Add(5 * time.Second)
	for acks+errors < 8 && time.Now().Before(deadline) {
		msg := client.recv(time.Until(deadline))
		switch msg["type"] {
		case "ack":
			acks++
		case "error":
			if msg["message"] == "rate_limited" {
				errors++
				// Verify retry_after_ms is present and reasonable
				retryMs := getFloat64(msg, "retry_after_ms")
				if retryMs >= 100 {
					gotRetryAfter = true
				}
			}
		}
	}

	if acks == 0 {
		t.Fatal("Expected at least some acks")
	}
	if errors == 0 {
		t.Fatal("Expected at least some rate_limited errors")
	}
	if !gotRetryAfter {
		t.Fatal("Expected retry_after_ms >= 100 in rate_limited response")
	}
	t.Logf("acks=%d rate_limited=%d", acks, errors)
}

func TestDisconnectDuringPush(t *testing.T) {
	queries := setupTestDB(t)
	wsURL := startTestServer(t, queries)

	clientA := connect(t, wsURL)
	clientA.authenticate("user1", "hash1", "00000000-0000-0000-0000-00000000000a", true)
	clientA.send(wsMsg{"type": "subscribe", "doc_id": "catalog", "last_seq": 0})
	clientA.recvType("caught_up", 5*time.Second)

	// Push a message
	clientA.send(wsMsg{"type": "push", "doc_id": "catalog", "payload": "cHVzaGVk"})
	clientA.recvType("ack", 5*time.Second)

	// Disconnect immediately
	clientA.conn.Close(websocket.StatusNormalClosure, "")

	// Reconnect as new connection, same device
	clientA2 := connect(t, wsURL)
	clientA2.authenticate("user1", "hash1", "00000000-0000-0000-0000-00000000000a", false)
	clientA2.send(wsMsg{"type": "subscribe", "doc_id": "catalog", "last_seq": 0})

	// Should receive the previously pushed message in replay
	syncMsg := clientA2.recvType("sync", 5*time.Second)
	if syncMsg["payload"] != "cHVzaGVk" {
		t.Fatalf("Expected replayed payload, got: %v", syncMsg["payload"])
	}

	cu := clientA2.recvType("caught_up", 5*time.Second)
	if getFloat64(cu, "latest_seq") < 1 {
		t.Fatalf("Expected latest_seq >= 1, got: %v", cu["latest_seq"])
	}
}

func TestConcurrentEdits(t *testing.T) {
	queries := setupTestDB(t)
	wsURL := startTestServer(t, queries)

	clientA := connect(t, wsURL)
	clientA.authenticate("user1", "hash1", "00000000-0000-0000-0000-00000000000a", true)

	clientB := connect(t, wsURL)
	clientB.authenticate("user1", "hash1", "00000000-0000-0000-0000-00000000000b", false)

	clientA.send(wsMsg{"type": "subscribe", "doc_id": "catalog", "last_seq": 0})
	clientA.recvType("caught_up", 5*time.Second)

	clientB.send(wsMsg{"type": "subscribe", "doc_id": "catalog", "last_seq": 0})
	clientB.recvType("caught_up", 5*time.Second)

	// Both push at the same time
	clientA.send(wsMsg{"type": "push", "doc_id": "catalog", "payload": "ZnJvbS1B"})
	clientB.send(wsMsg{"type": "push", "doc_id": "catalog", "payload": "ZnJvbS1C"})

	// Collect messages from each client: expect 1 ack + 1 sync each (order varies)
	collectMsgs := func(c *testClient, count int) []wsMsg {
		var msgs []wsMsg
		for i := 0; i < count; i++ {
			msgs = append(msgs, c.recv(5*time.Second))
		}
		return msgs
	}

	msgsA := collectMsgs(clientA, 2)
	msgsB := collectMsgs(clientB, 2)

	// A should have 1 ack (own push) + 1 sync (from B)
	var gotAckA, gotSyncA bool
	for _, m := range msgsA {
		if m["type"] == "ack" { gotAckA = true }
		if m["type"] == "sync" && m["payload"] == "ZnJvbS1C" { gotSyncA = true }
	}
	if !gotAckA { t.Fatal("A did not receive ack for own push") }
	if !gotSyncA { t.Fatal("A did not receive sync from B") }

	// B should have 1 ack (own push) + 1 sync (from A)
	var gotAckB, gotSyncB bool
	for _, m := range msgsB {
		if m["type"] == "ack" { gotAckB = true }
		if m["type"] == "sync" && m["payload"] == "ZnJvbS1B" { gotSyncB = true }
	}
	if !gotAckB { t.Fatal("B did not receive ack for own push") }
	if !gotSyncB { t.Fatal("B did not receive sync from A") }
}

func TestLargePayload(t *testing.T) {
	queries := setupTestDB(t)
	wsURL := startTestServer(t, queries)

	clientA := connect(t, wsURL)
	clientA.authenticate("user1", "hash1", "00000000-0000-0000-0000-00000000000a", true)
	clientA.send(wsMsg{"type": "subscribe", "doc_id": "catalog", "last_seq": 0})
	clientA.recvType("caught_up", 5*time.Second)

	// Generate a large base64 payload (~100KB)
	bigPayload := make([]byte, 100000)
	for i := range bigPayload {
		bigPayload[i] = byte('A' + (i % 26))
	}
	encoded := base64.StdEncoding.EncodeToString(bigPayload)

	clientA.send(wsMsg{"type": "push", "doc_id": "catalog", "payload": encoded})
	ack := clientA.recvType("ack", 10*time.Second)
	if ack["doc_id"] != "catalog" {
		t.Fatalf("Expected ack for catalog, got: %v", ack)
	}

	// New client should receive the large payload on subscribe replay
	clientB := connect(t, wsURL)
	clientB.authenticate("user1", "hash1", "00000000-0000-0000-0000-00000000000b", false)
	clientB.send(wsMsg{"type": "subscribe", "doc_id": "catalog", "last_seq": 0})

	syncMsg := clientB.recvType("sync", 10*time.Second)
	if syncMsg["payload"] != encoded {
		t.Fatal("Large payload round-trip failed")
	}
}

func TestVaultScopedPush(t *testing.T) {
	queries := setupTestDB(t)
	wsURL := startTestServer(t, queries)

	// User1 creates a vault
	owner := connect(t, wsURL)
	owner.authenticate("user1", "hash1", "00000000-0000-0000-0000-00000000000a", true)
	owner.send(wsMsg{"type": "set_identity", "public_key": "b3duZXItcHVia2V5", "wrapped_private_key": "d3JhcHBlZC1rZXk="})

	vaultID := "vault-" + fmt.Sprintf("%d", time.Now().UnixNano())
	owner.send(wsMsg{
		"type":                "create_vault",
		"vault_id":            vaultID,
		"encrypted_vault_key": "ZW5jLXZhdWx0LWtleQ==",
		"sender_public_key":   "c2VuZGVyLXB1YmtleQ==",
	})
	owner.recvType("vault_created", 5*time.Second)

	// Owner subscribes and pushes to vault doc
	docID := vaultID + "/catalog"
	owner.send(wsMsg{"type": "subscribe", "doc_id": docID, "last_seq": 0})
	owner.recvType("caught_up", 5*time.Second)

	payload := base64.StdEncoding.EncodeToString([]byte("vault-data"))
	owner.send(wsMsg{"type": "push", "doc_id": docID, "payload": payload})
	ack := owner.recvType("ack", 5*time.Second)
	if ack["doc_id"] != docID {
		t.Fatalf("Expected ack for %s, got: %v", docID, ack)
	}

	// Another device of same user should receive the push on subscribe
	ownerB := connect(t, wsURL)
	ownerB.authenticate("user1", "hash1", "00000000-0000-0000-0000-00000000000b", false)
	ownerB.send(wsMsg{"type": "subscribe", "doc_id": docID, "last_seq": 0})

	sync := ownerB.recvType("sync", 5*time.Second)
	if sync["payload"] != payload {
		t.Fatalf("Expected vault payload, got: %v", sync["payload"])
	}
	ownerB.recvType("caught_up", 5*time.Second)
}

func TestVaultViewerCannotPush(t *testing.T) {
	queries := setupTestDB(t)
	wsURL := startTestServer(t, queries)

	// User1 (owner) creates vault and sets identity
	owner := connect(t, wsURL)
	owner.authenticate("user1", "hash1", "00000000-0000-0000-0000-00000000000a", true)
	owner.send(wsMsg{"type": "set_identity", "public_key": "b3duZXItcHVia2V5", "wrapped_private_key": "d3JhcHBlZC1rZXk="})

	vaultID := "vault-viewer-" + fmt.Sprintf("%d", time.Now().UnixNano())
	owner.send(wsMsg{
		"type":                "create_vault",
		"vault_id":            vaultID,
		"encrypted_vault_key": "ZW5jLXZhdWx0LWtleQ==",
		"sender_public_key":   "c2VuZGVyLXB1YmtleQ==",
	})
	owner.recvType("vault_created", 5*time.Second)

	// User2 signs up and sets identity
	viewer := connect(t, wsURL)
	viewer.authenticate("user2", "hash2", "00000000-0000-0000-0000-00000000000c", true)
	viewer.send(wsMsg{"type": "set_identity", "public_key": "dmlld2VyLXB1YmtleQ==", "wrapped_private_key": "d3JhcHBlZC1rZXk="})

	// Owner invites user2 as viewer
	owner.send(wsMsg{
		"type":                "invite_to_vault",
		"vault_id":            vaultID,
		"target_user_id":      "user2",
		"encrypted_vault_key": "ZW5jLWtleS1mb3Itdmlld2Vy",
		"sender_public_key":   "c2VuZGVyLXB1YmtleQ==",
		"role":                "viewer",
	})
	owner.recvType("vault_invite_ok", 5*time.Second)

	// Viewer subscribes (should work -- viewers can read)
	docID := vaultID + "/catalog"
	viewer.send(wsMsg{"type": "subscribe", "doc_id": docID, "last_seq": 0})
	viewer.recvType("caught_up", 5*time.Second)

	// Viewer tries to push (should get push_error)
	viewer.send(wsMsg{
		"type":    "push",
		"doc_id":  docID,
		"payload": base64.StdEncoding.EncodeToString([]byte("viewer-data")),
	})
	errMsg := viewer.recvType("push_error", 5*time.Second)
	if errMsg["message"] != "insufficient permissions to write" {
		t.Fatalf("Expected push_error with permission message, got: %v", errMsg)
	}
	if errMsg["doc_id"] != docID {
		t.Fatalf("Expected push_error for doc %s, got: %v", docID, errMsg["doc_id"])
	}
}

func TestNonMemberCannotPushToVault(t *testing.T) {
	queries := setupTestDB(t)
	wsURL := startTestServer(t, queries)

	// User1 creates a vault
	owner := connect(t, wsURL)
	owner.authenticate("user1", "hash1", "00000000-0000-0000-0000-00000000000a", true)
	owner.send(wsMsg{"type": "set_identity", "public_key": "b3duZXItcHVia2V5", "wrapped_private_key": "d3JhcHBlZC1rZXk="})

	vaultID := "vault-nonmember-" + fmt.Sprintf("%d", time.Now().UnixNano())
	owner.send(wsMsg{
		"type":                "create_vault",
		"vault_id":            vaultID,
		"encrypted_vault_key": "ZW5jLXZhdWx0LWtleQ==",
		"sender_public_key":   "c2VuZGVyLXB1YmtleQ==",
	})
	owner.recvType("vault_created", 5*time.Second)

	// User2 connects but is NOT invited to the vault
	stranger := connect(t, wsURL)
	stranger.authenticate("user2", "hash2", "00000000-0000-0000-0000-00000000000c", true)

	// Stranger tries to push to the vault doc
	docID := vaultID + "/catalog"
	stranger.send(wsMsg{
		"type":    "push",
		"doc_id":  docID,
		"payload": base64.StdEncoding.EncodeToString([]byte("unauthorized")),
	})
	errMsg := stranger.recvType("push_error", 5*time.Second)
	if errMsg["message"] != "insufficient permissions to write" {
		t.Fatalf("Expected push_error for non-member, got: %v", errMsg)
	}
}
