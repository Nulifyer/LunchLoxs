# RecipePWA - Senior Engineer Code Review & Implementation Plan

## Executive Summary

This is a well-architected E2EE recipe PWA with Automerge CRDTs, WebSocket sync, and a Go backend. The core crypto primitives are solid (Argon2id + AES-256-GCM + ECDH P-256). However, there are significant gaps in book member management, encryption model completeness, data export, and code organization that need addressing.

---

## Part 1: Security & Encryption Issues

### 1.1 CRITICAL: Auth hash timing attack (db.go:74)

```go
OK: existingHash == authHash,
```

Plain string comparison is vulnerable to timing attacks. Use `crypto/subtle.ConstantTimeCompare`.

### 1.2 CRITICAL: CORS wildcard on WebSocket (server.go:19)

```go
OriginPatterns: []string{"*"}
```

Any origin can connect to the WebSocket. Must validate against `FRONTEND_URL`.

### 1.3 HIGH: No vault-scoped authorization on subscribe/push

`handleSubscribe` and `handlePush` (client.go:230, 276) don't check if the user is a member of the vault a doc belongs to. Any authenticated user who guesses a `doc_id` like `{vaultId}/catalog` could subscribe. The server should parse the vault prefix from `doc_id` and call `IsVaultMember` before allowing access.

### 1.4 HIGH: ECDH shared secret used directly as AES key (crypto.ts:228-234)

The raw ECDH shared bits are imported directly as an AES-GCM key without a proper KDF step. Per Proton Pass and industry standards, the shared secret should be passed through HKDF with context info (e.g., `"RecipePWA vault key wrapping"`) to derive the actual encryption key. This prevents related-key attacks.

```typescript
// Current (weak):
const sharedBits = await crypto.subtle.deriveBits(...);
return crypto.subtle.importKey("raw", sharedBits, { name: "AES-GCM" }, ...);

// Should be:
const sharedBits = await crypto.subtle.deriveBits(...);
const hkdfKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
return crypto.subtle.deriveKey(
  { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("RecipePWA-vault-key") },
  hkdfKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
);
```

### 1.5 HIGH: No public key verification / MITM vulnerability

When user A invites user B, A fetches B's public key from the server via `lookup_user`. A compromised or malicious server could substitute a different public key, intercepting the vault key. Proton Pass solves this with cross-signed address keys. At minimum, the app should:
- Display a key fingerprint in the share dialog so users can verify out-of-band
- Consider signing public keys with the user's identity key

### 1.6 MEDIUM: No key rotation when members are removed

When a user is removed from a vault (client.go:531), the vault key remains the same. The removed user still has the key and could decrypt any data they previously accessed or intercept future sync messages if they had cached the key. After removing a member:
1. Generate a new vault key
2. Re-encrypt all vault data with the new key
3. Re-encrypt the new vault key for all remaining members

### 1.7 MEDIUM: Argon2id parameters are weak

```typescript
iterations: 2, memorySize: 19456, parallelism: 1
```

OWASP recommends: iterations: 3, memorySize: 65536 (64MB), parallelism: 4 for sensitive applications. The current 19MB/2 iterations is below recommended minimums. Consider making these configurable and bumping for production.

### 1.8 LOW: Username-derived user_id leaks info (crypto.ts:276-279)

`SHA-256("user_id:" + username)` is deterministic. Anyone who knows a username can compute the user_id and check if they exist. Consider adding a server-side random component or using the full Argon2id-derived value.

---

## Part 2: Book (Vault) Member Management Issues

### 2.1 CRITICAL: Owner cannot transfer ownership

There is no mechanism for an owner to transfer ownership to another member. If the owner loses access to their account, the vault is permanently unmanageable. Need a `transfer_ownership` message type.

### 2.2 CRITICAL: Owner can be removed from their own vault

`RemoveVaultMember` (db.go:239) has no check preventing removal of the owner. The backend check in client.go:526 only verifies the *requester* is the owner, but doesn't prevent `target_user_id == owner`. Add:

```go
if msg.TargetUserID == c.UserID {
    c.sendError("cannot remove yourself as owner; transfer ownership first")
    return
}
```

Also need to prevent removing the *last* owner.

### 2.3 HIGH: No role change mechanism

To change a member's role (e.g., editor -> viewer), you must remove and re-invite them, which requires re-encrypting the vault key. Need a `change_role` operation.

### 2.4 HIGH: Editors can invite but shouldn't always

Editors can invite new members (client.go:479). This may not be desired. Consider making invite permissions configurable per-vault, or restricting to owner-only.

### 2.5 MEDIUM: No invite acceptance flow

Members are added directly without consent. Add an invite/accept flow where the target user must accept before being added to the vault.

### 2.6 MEDIUM: Book names only stored in Automerge doc

When listing vaults (index.ts:331), book names are just `vaultId.slice(0, 8)` until the catalog doc is opened. The vault name should be stored server-side (encrypted or as metadata) so it appears immediately in the book selector.

---

## Part 3: Code Organization & Quality

### 3.1 index.ts is a 865-line monolith

This file handles state management, UI rendering, event handling, book management, sharing dialog, login/logout, and account management. It should be split into:

- `state/app-state.ts` - Centralized state with typed events
- `state/book-manager.ts` - Book CRUD, switching, and sync
- `ui/login.ts` - Login/logout flow
- `ui/account.ts` - Account page, password change, purge
- `ui/book-dialogs.ts` - Manage books, share, invite
- `ui/recipe-crud.ts` - Add/edit/delete recipe dialogs

### 3.2 Base64 helpers duplicated 3 times

`toB64`/`fromB64` in index.ts:63-64, `bytesToBase64`/`base64ToBytes` in sync-client.ts:384-395, and manual inline conversions in auth.ts:37-40, 45-46. Extract to a shared `lib/encoding.ts`.

### 3.3 `toB64` redeclared inside changePwForm handler (index.ts:552)

A local `toB64` is redeclared inside the password change handler, shadowing the module-level one. This is a bug waiting to happen.

### 3.4 Dead code: origOnVaultMembers (index.ts:818-820)

```typescript
const origOnVaultMembers = syncClient?.opts?.onVaultMembers;
// We set onVaultMembers in the SyncClient options, but also need to handle it for the share dialog
// This is done via the onVaultMembers callback in the sync client opts
```

This variable is assigned but never used. Remove it.

### 3.5 Inconsistent null handling

Some places use optional chaining (`catalog?.getDoc()`), others access directly without checks. For example, index.ts:608:

```typescript
const recipe = catalog?.getDoc().recipes.find(...)
```

If `catalog` is null, `.getDoc()` is not called but `recipes` would throw. Should be:

```typescript
const recipe = catalog?.getDoc()?.recipes?.find(...)
```

### 3.6 `escapeHtml` duplicated in recipe-list.ts:54 and recipe-detail.ts:336

Extract to a shared utility.

### 3.7 pendingInvite is fragile global state (index.ts:845)

The invite flow uses a global `pendingInvite` variable set before `lookupUser` and consumed in `onUserLookup`. If the user clicks invite twice quickly, or if the lookup fails silently, state becomes inconsistent. Convert to a Promise-based flow:

```typescript
async function lookupUser(userId: string): Promise<{userId: string, publicKey: string}> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Lookup timed out")), 10000);
    // set one-time handler, resolve on response, clear timeout
  });
}
```

### 3.8 SyncClient exposes internal state

`syncClient!.ws`, `syncClient!.sendMsg`, and `syncClient!.opts.encKey` are accessed directly from index.ts (lines 286, 289, 291). These should be proper public methods, not direct property access.

### 3.9 Go backend: No structured logging

Using `log.Printf` everywhere. Switch to `slog` (stdlib since Go 1.21) for structured, leveled logging.

### 3.10 Go backend: PurgeUser doesn't clean up vault memberships (db.go:300-311)

When purging a user, their vault memberships and owned vaults are not cleaned up. Owned vaults become orphaned. Need to:
1. Transfer ownership of owned vaults (or delete them)
2. Remove from all vault memberships
3. Then delete user data

### 3.11 Go backend: DeleteVault is not transactional (db.go:281-290)

Two separate DELETE statements without a transaction. If the first succeeds and second fails, sync_messages are deleted but the vault still exists.

---

## Part 4: UI, Caching & PWA Issues

### 4.1 Service worker: Static asset list (service-worker.ts:5)

```typescript
const STATIC_ASSETS = ["/", "/index.html", "/index.js", "/app.css"];
```

If new files are added (fonts, vendor bundles, icons), they won't be cached. Generate the asset list at build time from the dist/ directory contents.

### 4.2 Service worker: No offline indication

When the WebSocket disconnects, the sync badge shows "disconnected" but there's no clear UX for "you're offline, changes are saved locally". Add an offline banner and queue indicator.

### 4.3 No loading states

- `deriveKeys` with Argon2id is CPU-intensive but shows only "Deriving keys..." text on the button. Add a proper spinner.
- Book switching, vault creation, and invite operations have no loading indicators.
- The share dialog shows "Loading..." for members but has no error state.

### 4.4 WebSocket URL hardcoded (index.ts:258)

```typescript
const wsUrl = `${wsProtocol}//${location.hostname}:8080/ws`;
```

Port 8080 is hardcoded. In production behind a reverse proxy this would break. Use `location.host` or make it configurable.

### 4.5 No IndexedDB migration strategy (automerge-store.ts:164)

`indexedDB.open(dbName, 1)` always uses version 1. When the schema changes (e.g., adding new stores), existing data will be inaccessible without upgrade handlers.

### 4.6 innerHTML with marked output (recipe-detail.ts:331)

```typescript
instrPreviewContainer.innerHTML = (marked.parse(instrMd) as string)
```

`marked.parse` doesn't sanitize HTML by default. If recipe instructions contain `<script>` tags or event handlers, they'd execute. Use DOMPurify or marked's `sanitize` option.

### 4.7 Update banner uses innerHTML with onclick (index.ts:854)

```typescript
banner.innerHTML = `A new version is available. <button onclick="location.reload()">Refresh</button>`;
```

Use `createElement` + `addEventListener` instead of inline event handlers.

---

## Part 5: Data Export Feature (New)

### Design: Export Book as Zip of Markdown Files

Each recipe exported as a single `.md` file with YAML frontmatter for importability:

```markdown
---
id: "550e8400-e29b-41d4-a716-446655440000"
title: "Chocolate Chip Cookies"
tags: ["dessert", "baking", "cookies"]
servings: 24
prepMinutes: 15
cookMinutes: 12
createdAt: 2026-03-20T10:30:00Z
updatedAt: 2026-03-22T14:15:00Z
---

## Ingredients

- 2 1/4 cups all-purpose flour
- 1 tsp baking soda
- 1 cup butter, softened

## Instructions

Preheat oven to 375F. Combine flour and baking soda...

## Notes

Best when slightly underbaked. Store in airtight container.
```

### Implementation Plan

**Frontend additions:**
1. Add an "Export" button in the book management dialog (owner/editor)
2. Use the `JSZip` library (or manual ZIP construction) to create the archive
3. Iterate over all recipes in the catalog, open each content doc, format as markdown
4. Trigger browser download of the zip

**Import feature:**
1. Add "Import" button in book management
2. Accept `.zip` file upload
3. Parse each `.md` file: extract YAML frontmatter + body sections
4. Create recipe entries in catalog + content docs
5. Push snapshots for all new docs

**File naming:** `{slugified-title}.md` (e.g., `chocolate-chip-cookies.md`)

**Zip structure:**
```
My Recipe Book/
  _book.yaml           # Book metadata (name, export date, version)
  chocolate-chip-cookies.md
  grandmas-lasagna.md
  thai-green-curry.md
```

`_book.yaml`:
```yaml
name: "My Recipe Book"
exportedAt: "2026-03-24T12:00:00Z"
format: "recipepwa-v1"
recipeCount: 3
```

---

## Part 6: Implementation Plan (Prioritized)

### Phase 1: Security Fixes (Do First)

| # | Task | Files | Effort |
|---|------|-------|--------|
| 1 | Constant-time auth hash comparison | db.go | S |
| 2 | CORS validation from FRONTEND_URL | server.go | S |
| 3 | Vault-scoped subscribe/push authorization | client.go | M |
| 4 | Add HKDF step to ECDH shared key derivation | crypto.ts | S |
| 5 | Prevent owner self-removal | client.go | S |
| 6 | Sanitize marked output with DOMPurify | recipe-detail.ts, package.json | S |
| 7 | Fix innerHTML onclick in update banner | index.ts | S |

### Phase 2: Book Member Management

| # | Task | Files | Effort |
|---|------|-------|--------|
| 8 | Add `transfer_ownership` message + handler | client.go, db.go, sync-client.ts, index.ts | M |
| 9 | Prevent removing last owner | client.go, db.go | S |
| 10 | Add `change_role` message + handler | client.go, db.go, sync-client.ts | M |
| 11 | Display key fingerprints in share dialog | index.ts, crypto.ts | S |
| 12 | Clean up vault memberships on purge | db.go | S |
| 13 | Make DeleteVault transactional | db.go | S |

### Phase 3: Code Cleanup & Refactoring

| # | Task | Files | Effort |
|---|------|-------|--------|
| 14 | Extract base64 helpers to lib/encoding.ts | New file, index.ts, sync-client.ts, auth.ts | S |
| 15 | Remove dead code (origOnVaultMembers, duplicate toB64) | index.ts | S |
| 16 | Extract escapeHtml to lib/html.ts | recipe-list.ts, recipe-detail.ts | S |
| 17 | Split index.ts into modules | Multiple new files | L |
| 18 | Convert pendingInvite to Promise-based flow | index.ts, sync-client.ts | M |
| 19 | Make SyncClient internals private, add public API | sync-client.ts, index.ts | M |
| 20 | Switch Go logging to slog | All .go files | M |

### Phase 4: UI & PWA Improvements

| # | Task | Files | Effort |
|---|------|-------|--------|
| 21 | Generate static asset list at build time | copy-public.ts, service-worker.ts | M |
| 22 | Add offline indicator banner | index.ts, app.css | S |
| 23 | Add loading spinners for async operations | index.ts, app.css | M |
| 24 | Fix hardcoded WebSocket port | index.ts | S |
| 25 | Add IndexedDB version migration support | automerge-store.ts | M |

### Phase 5: Data Export/Import

| # | Task | Files | Effort |
|---|------|-------|--------|
| 26 | Add JSZip dependency | package.json | S |
| 27 | Implement export-book-as-zip | New lib/export.ts | M |
| 28 | Add Export button to book management dialog | index.ts (or book-dialogs.ts), index.html | S |
| 29 | Implement import-from-zip | New lib/import.ts | M |
| 30 | Add Import button + file picker | index.ts (or book-dialogs.ts), index.html | S |

### Phase 6: Encryption Hardening (If Time Permits)

| # | Task | Files | Effort |
|---|------|-------|--------|
| 31 | Key rotation on member removal | crypto.ts, sync-client.ts, client.go | L |
| 32 | Bump Argon2id params (configurable) | crypto.ts | S |
| 33 | Per-recipe item keys (Proton Pass model) | crypto.ts, automerge-store.ts, document-manager.ts | XL |

**Effort key:** S = < 1 hour, M = 1-3 hours, L = 3-8 hours, XL = 1+ days

---

## Appendix A: Proton Pass Comparison

| Feature | Proton Pass | RecipePWA Current | Recommended |
|---------|-------------|-------------------|-------------|
| Key hierarchy | User key -> Vault key -> Item key (3 tiers) | Passphrase -> Master key -> Book key (2.5 tiers) | Add item-level keys long term |
| KDF | bcrypt + SRP | Argon2id (weak params) | Bump Argon2id params |
| Shared key derivation | OpenPGP + Curve25519 + signed | ECDH P-256 raw (no HKDF, no signatures) | Add HKDF + key signatures |
| Key rotation | On member removal | None | Implement rotation |
| Public key trust | Cross-signed address keys | Trust server blindly | Add fingerprint verification |
| Metadata encryption | All metadata E2EE | Book names unencrypted at rest | Encrypt book names |
| Access control | Admin-only sharing | Owner + editor can invite | Make configurable |

## Appendix B: Sync Architecture Notes

The current approach of sending full Automerge snapshots on every push is bandwidth-heavy but correct. For future optimization, consider sending only Automerge changes (deltas) and periodically compacting with full snapshots. This would reduce payload sizes from potentially 100KB+ to a few bytes per keystroke.

The `StoreMessage` + `CompactDocument` pattern has a race condition: `MAX(seq)` is evaluated in a subquery at INSERT time, but the DELETE in CompactDocument uses a separate `MAX(seq)` query. Under concurrent pushes from multiple devices, this could delete a message that was just inserted. Wrap both in a transaction or use a single CTE.
