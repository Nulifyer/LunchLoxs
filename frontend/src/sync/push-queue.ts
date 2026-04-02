/**
 * Persistent push queue with dirty tracking, debounce, rate-limit backoff,
 * and a background reconciliation loop.
 *
 * Two complementary mechanisms:
 * - **Reactive**: markDirty() schedules debounced pushes for responsive sync
 * - **Proactive**: background poll every POLL_INTERVAL_MS finds and pushes
 *   any dirty docs (including closed stores) that were missed
 *
 * Guarantees: every local change eventually reaches the server.
 * - Dirty flags persist in IndexedDB (survive page reloads/crashes)
 * - Re-pushes always use the latest snapshot (idempotent via Automerge merge)
 * - Rate-limit errors pause the queue with exponential backoff
 * - Closed docs are temporarily re-opened for push, then closed again
 */

import { log, warn } from "../lib/logger";
import { getAllDirtyDocIds, clearDirtyFlag, setSeqFlag, getAllPendingVaults, clearPendingVault } from "../lib/automerge-store";
import type { DocumentManager } from "../lib/document-manager";
import type { SyncClient, PushResult } from "../lib/sync-client";

const DEBOUNCE_MS = 200;
const MAX_WAIT_MS = 1500;
const BACKOFF_INITIAL = 2000;
const BACKOFF_MAX = 30000;
const POLL_INTERVAL_MS = 5000;
const MAX_PUSH_ERRORS = 5;

/** Injected function to sign a payload before pushing. */
export type SignFn = (raw: Uint8Array) => Promise<Uint8Array> | Uint8Array;

export class PushQueue {
  private docMgr: DocumentManager;
  private syncClient: SyncClient | null;
  private db: IDBDatabase;
  private signFn: SignFn | null;

  // In-memory dirty set (dedup - union of reactive marks + poll discoveries)
  private dirtySet = new Set<string>();

  // Debounce state per doc
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private firstChange = new Map<string, number>();

  // Flush state
  private flushing = false;
  private ratePaused = false;
  private backoffMs = BACKOFF_INITIAL;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;

  // Per-doc consecutive push error counts
  private errorCounts = new Map<string, number>();

  // Docs deferred due to missing vault key -- skip during flush, retry when vaults change
  private deferredNoKey = new Set<string>();

  // Vaults with permanent permission errors -- skip all their docs
  private failedVaults = new Set<string>();

  // Vault IDs still pending server confirmation -- skip their docs during flush
  private pendingVaultIds = new Set<string>();

  // True after onVaultList has run post-connect. Prevents flushing before vault state is known.
  // Starts true (initial PushQueue creation has vault context); set false on updateRefs (reconnect).
  private ready = true;

  // Background poll
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  // Listener for badge updates
  private onDirtyChange?: () => void;

  constructor(docMgr: DocumentManager, syncClient: SyncClient | null, db: IDBDatabase, signFn?: SignFn) {
    this.docMgr = docMgr;
    this.syncClient = syncClient;
    this.db = db;
    this.signFn = signFn ?? null;
  }

  /** Load dirty set from IndexedDB and start background poll. */
  async start(): Promise<void> {
    const ids = await getAllDirtyDocIds(this.db);
    for (const id of ids) this.dirtySet.add(id);
    if (ids.length > 0) log("[push-queue] loaded", ids.length, "dirty docs from IndexedDB");
    // Start background reconciliation loop
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    }
  }

  /** Stop the background poll (e.g. on logout). */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.firstChange.clear();
  }

  // -- Reactive: respond to local changes --

  /** Called when a doc changes locally. Marks dirty and schedules a debounced push. */
  markDirty(docId: string): void {
    this.dirtySet.add(docId);
    this.onDirtyChange?.();
    this.schedulePush(docId);
  }

  // -- Server responses --

  /** Server acknowledged a push. Clear the dirty flag (works even for closed stores). */
  async onAck(docId: string, seq: number): Promise<void> {
    const store = this.docMgr.get(docId);
    if (store) {
      await store.clearDirty();
      await store.setLastSeq(seq);
    } else {
      // Store is closed (e.g. import closed it) - clear directly in IndexedDB
      await clearDirtyFlag(this.db, docId);
      await setSeqFlag(this.db, docId, seq);
    }
    const wasDirty = this.dirtySet.has(docId);
    this.dirtySet.delete(docId);
    this.errorCounts.delete(docId);
    if (wasDirty) {
      log("[push-queue] ack cleared", docId.slice(-8), "remaining:", this.dirtySet.size);
      // Reset backoff on successful ack -- we're making progress
      this.backoffMs = BACKOFF_INITIAL;
    }
    this.onDirtyChange?.();
  }

  /** Server rejected a push for a specific doc (e.g. permissions). Track errors and give up after MAX_PUSH_ERRORS. */
  async onPushError(docId: string, message: string): Promise<void> {
    // Permission errors for vaults we know about are permanent -- fail immediately.
    // But if the vault is still pending creation, this is expected -- just skip it.
    if (message.includes("insufficient permissions")) {
      const slashIdx = docId.indexOf("/");
      if (slashIdx > 0) {
        const vaultId = docId.slice(0, slashIdx);
        if (this.pendingVaultIds.has(vaultId)) {
          // Vault not yet created on server -- don't fail, just remove from dirty set.
          // Poll will re-discover once the vault is created and pending cleared.
          this.dirtySet.delete(docId);
          this.onDirtyChange?.();
          return;
        }
        if (!this.failedVaults.has(vaultId)) {
          warn("[push-queue] vault", vaultId.slice(0, 8), "has insufficient permissions");
          this.failedVaults.add(vaultId);
          const vaultDirtyIds = [...this.dirtySet].filter((id) => id.startsWith(vaultId + "/"));
          if (vaultDirtyIds.length > 0) {
            const discardAll = async () => {
              for (const id of vaultDirtyIds) {
                this.dirtySet.delete(id);
                await clearDirtyFlag(this.db, id);
              }
              this.onDirtyChange?.();
            };
            try {
              const { showConfirm } = await import("../lib/dialogs");
              const discard = await showConfirm(
                `You have ${vaultDirtyIds.length} unsaved change(s) in a book you no longer have write access to. Discard these changes?`,
                { title: "Permission Changed", confirmText: "Discard", cancelText: "Keep Locally", danger: true },
              );
              if (discard) await discardAll();
              this.onDirtyChange?.();
            } catch {
              // No DOM (tests/headless) — discard silently
              await discardAll();
            }
          }
        }
        this.onDirtyChange?.();
        return;
      }
    }

    const count = (this.errorCounts.get(docId) ?? 0) + 1;
    this.errorCounts.set(docId, count);
    warn("[push-queue] push rejected for", docId.slice(0, 12), "-", message, `(${count}/${MAX_PUSH_ERRORS})`);
    this.dirtySet.delete(docId);
    if (count >= MAX_PUSH_ERRORS) {
      warn("[push-queue] giving up on", docId.slice(0, 12), "after", MAX_PUSH_ERRORS, "consecutive errors");
      await clearDirtyFlag(this.db, docId);
      this.errorCounts.delete(docId);
    }
    this.onDirtyChange?.();
  }

  /** Server said rate_limited. Pause current flush and retry after server-specified delay. */
  onRateLimited(retryAfterMs?: number): void {
    this.ratePaused = true;
    // Use the server's delay as a floor, but don't let it override exponential backoff
    if (retryAfterMs && retryAfterMs > 0) {
      this.backoffMs = Math.max(this.backoffMs, retryAfterMs);
    }
    if (!this.backoffTimer) {
      warn("[push-queue] rate limited, retry after", this.backoffMs, "ms");
      this.scheduleBackoffFlush();
    }
  }

  // -- Flush: push dirty docs to server --

  /** Push all dirty docs. Sends as fast as possible; server rate limiting is the throttle. */
  async flushAllDirty(): Promise<void> {
    if (this.flushing || !this.isConnected() || !this.ready) return;
    this.flushing = true;
    this.ratePaused = false;
    const sizeBefore = this.dirtySet.size;
    try {
      const docIds = [...this.dirtySet];
      if (docIds.length === 0) return;
      log("[push-queue] flushing", docIds.length, "dirty docs");
      let sent = 0;
      let skipped = 0;
      for (const docId of docIds) {
        if (!this.isConnected() || this.ratePaused) break;
        // Skip docs that were acked/cleared by a concurrent onAck during this flush
        if (!this.dirtySet.has(docId)) { skipped++; continue; }
        // Skip docs deferred due to missing key (will retry when vaults change)
        if (this.deferredNoKey.has(docId)) { skipped++; continue; }
        // Skip docs for vaults not yet confirmed by server
        const slashIdx = docId.indexOf("/");
        const vaultId = slashIdx > 0 ? docId.slice(0, slashIdx) : "";
        if (vaultId && this.pendingVaultIds.has(vaultId)) { skipped++; continue; }
        // Skip docs for vaults with permanent permission errors
        if (vaultId && this.failedVaults.has(vaultId)) { skipped++; continue; }
        const result = await this.pushDoc(docId);
        if (result === "not_connected") break;
        if (result === "no_key") skipped++;
        else sent++;
      }
      if (sent > 0 || skipped < docIds.length) {
        log("[push-queue] flushed", sent, "/", docIds.length, "docs" + (skipped > 0 ? " (" + skipped + " deferred)" : ""));
      }
    } finally {
      this.flushing = false;
    }
    // If rate limited or still dirty (and some are pushable), backoff timer will retry
    const hasPushable = [...this.dirtySet].some((id) => {
      if (this.deferredNoKey.has(id)) return false;
      const si = id.indexOf("/");
      if (si > 0 && this.pendingVaultIds.has(id.slice(0, si))) return false;
      if (si > 0 && this.failedVaults.has(id.slice(0, si))) return false;
      return true;
    });
    if (hasPushable && this.isConnected() && !this.backoffTimer) {
      this.scheduleBackoffFlush();
    }
  }

  /** Push a specific doc immediately, bypassing debounce. */
  async flushNow(docId: string): Promise<void> {
    this.cancelTimer(docId);
    this.dirtySet.add(docId);
    await this.pushDoc(docId);
  }

  /**
   * On caught_up, check if a dirty doc's push already reached the server.
   * Compares current Automerge heads with the heads stored at push time.
   * If they match, the server has our data -- clear dirty without re-pushing.
   */
  async tryClearDirtyOnCaughtUp(docId: string): Promise<void> {
    if (!this.dirtySet.has(docId)) return;
    const store = this.docMgr.get(docId);
    if (!store) return;
    const pushHeads = await store.getPushHeads();
    if (!pushHeads) return; // never pushed, needs a real push
    const currentHeads = store.getHeads();
    // If heads match, the server already has our latest state
    if (pushHeads.length === currentHeads.length && pushHeads.every((h, i) => h === currentHeads[i])) {
      log("[push-queue] caught_up cleared dirty for", docId, "(heads match)");
      await store.clearDirty();
      this.dirtySet.delete(docId);
      this.onDirtyChange?.();
    }
  }

  // -- State --

  /**
   * Remove dirty flags for docs belonging to vaults no longer in the books list.
   * Called after onVaultList loads to clean up orphaned docs from deleted vaults.
   */
  async purgeOrphanedDirty(knownVaultIds: Set<string>): Promise<void> {
    let purged = 0;
    for (const docId of [...this.dirtySet]) {
      const slashIdx = docId.indexOf("/");
      if (slashIdx <= 0) continue; // personal doc, keep it
      const vaultId = docId.slice(0, slashIdx);
      if (knownVaultIds.has(vaultId)) continue; // vault exists, keep it
      this.dirtySet.delete(docId);
      await clearDirtyFlag(this.db, docId);
      purged++;
    }
    if (purged > 0) {
      warn("[push-queue] purged", purged, "dirty docs for unknown vaults");
      this.onDirtyChange?.();
    }
  }

  /**
   * Create any vaults that were created offline and haven't been confirmed by the server yet.
   * Sends all create requests without blocking on confirmations -- the server's vault_created
   * response triggers onVaultCreated which calls listVaults, refreshing the vault list.
   * Pending flags are cleared when the vault appears in the next vault list.
   */
  async createPendingVaults(knownVaultIds: Set<string>): Promise<void> {
    const pending = await getAllPendingVaults(this.db);
    if (pending.length === 0) return;
    let sent = 0;
    for (const pv of pending) {
      if (knownVaultIds.has(pv.vaultId)) {
        await clearPendingVault(this.db, pv.vaultId);
        log("[push-queue] pending vault already exists:", pv.vaultId.slice(0, 8));
        continue;
      }
      if (!this.syncClient) { warn("[push-queue] no sync client"); break; }
      this.syncClient.createVaultFireAndForget(pv.vaultId, pv.encryptedVaultKey, pv.senderPublicKey);
      sent++;
    }
    if (sent > 0) log("[push-queue] sent", sent, "pending vault creation requests");
  }

  hasDirty(): boolean { return this.dirtySet.size > 0; }
  dirtyCount(): number { return this.dirtySet.size; }
  /** Count of dirty docs that can actually be pushed right now (excludes deferred/pending). */
  pushableCount(): number {
    let n = 0;
    for (const id of this.dirtySet) {
      if (this.deferredNoKey.has(id)) continue;
      const si = id.indexOf("/");
      if (si > 0 && this.pendingVaultIds.has(id.slice(0, si))) continue;
      if (si > 0 && this.failedVaults.has(id.slice(0, si))) continue;
      n++;
    }
    return n;
  }
  isDirty(docId: string): boolean { return this.dirtySet.has(docId); }

  /** Set vault IDs that are still pending server confirmation. Docs for these vaults are skipped during flush. */
  setPendingVaultIds(ids: Set<string>): void { this.pendingVaultIds = ids; }

  /** Mark a single vault as no longer pending (server confirmed creation). */
  clearPendingVault(vaultId: string): void { this.pendingVaultIds.delete(vaultId); }

  /** Called when vault keys change (e.g. onVaultList). Clears deferred and failed state so docs are retried. */
  onVaultsChanged(): void {
    this.ready = true;
    if (this.deferredNoKey.size > 0) {
      log("[push-queue] vaults changed, clearing", this.deferredNoKey.size, "deferred docs");
      this.deferredNoKey.clear();
    }
    if (this.failedVaults.size > 0) {
      log("[push-queue] vaults changed, clearing", this.failedVaults.size, "failed vaults");
      this.failedVaults.clear();
    }
  }

  setDirtyChangeListener(fn: () => void): void { this.onDirtyChange = fn; }

  updateRefs(docMgr: DocumentManager, syncClient: SyncClient, signFn?: SignFn): void {
    this.docMgr = docMgr;
    this.syncClient = syncClient;
    this.ready = false; // Wait for onVaultList before flushing
    if (signFn !== undefined) this.signFn = signFn;
  }

  // -- Proactive: background poll --

  private async poll(): Promise<void> {
    if (this.flushing || !this.isConnected()) return;
    // Re-scan IndexedDB for dirty docs (picks up anything missed)
    const ids = await getAllDirtyDocIds(this.db);
    let discovered = 0;
    for (const id of ids) {
      if (this.dirtySet.has(id)) continue;
      // Skip docs for vaults with permanent permission errors
      const si = id.indexOf("/");
      if (si > 0 && this.failedVaults.has(id.slice(0, si))) continue;
      this.dirtySet.add(id);
      discovered++;
    }
    if (discovered > 0) {
      log("[push-queue] poll discovered", discovered, "dirty docs");
      this.onDirtyChange?.();
    }
    // Flush if anything is dirty
    if (this.dirtySet.size > 0 && !this.backoffTimer) {
      await this.flushAllDirty();
    }
  }

  // -- Internal --

  private schedulePush(docId: string): void {
    const existing = this.timers.get(docId);
    if (existing) clearTimeout(existing);

    const now = Date.now();
    if (!this.firstChange.has(docId)) this.firstChange.set(docId, now);

    const elapsed = now - this.firstChange.get(docId)!;
    if (elapsed >= MAX_WAIT_MS) {
      this.fireDebounce(docId);
    } else {
      const delay = Math.min(DEBOUNCE_MS, MAX_WAIT_MS - elapsed);
      this.timers.set(docId, setTimeout(() => this.fireDebounce(docId), delay));
    }
  }

  private fireDebounce(docId: string): void {
    this.cancelTimer(docId);
    if (!this.isConnected()) return;
    this.pushDoc(docId).catch((e) => warn("[push-queue] debounce push failed:", e));
  }

  private cancelTimer(docId: string): void {
    const t = this.timers.get(docId);
    if (t) clearTimeout(t);
    this.timers.delete(docId);
    this.firstChange.delete(docId);
  }

  /**
   * Push a single doc. Opens closed stores temporarily.
   * Returns "sent", "no_key", or "not_connected".
   */
  private async pushDoc(docId: string): Promise<"sent" | "no_key" | "not_connected"> {
    if (!this.isConnected()) return "not_connected";

    let store = this.docMgr.get(docId);
    let tempOpened = false;

    // If store is closed, re-open it temporarily.
    // Local IndexedDB is always encrypted with the master key (docMgr default).
    // The vault key is only for transit encryption (handled by SyncClient.getDocKey).
    if (!store) {
      try {
        store = await this.docMgr.open(docId, (d: any) => {});
        tempOpened = true;
        // Verify re-opened store actually has changes worth pushing
        if (store.getAllChanges().length === 0) {
          warn("[push-queue] re-opened", docId.slice(0, 12), "but no changes, clearing dirty");
          await clearDirtyFlag(this.db, docId);
          this.dirtySet.delete(docId);
          await this.docMgr.close(docId);
          this.onDirtyChange?.();
          return "sent";
        }
      } catch (e) {
        // Can't open (e.g. corrupted data)
        warn("[push-queue] can't open", docId, "skipping (will retry):", e);
        return "sent"; // not a fatal error, poll will retry later
      }
    }

    // Ensure any pending writes are flushed before reading
    await store.waitForWrite();
    // Record heads before push so we can compare on caught_up
    const heads = store.getHeads();
    const raw = store.save();
    const payload = this.signFn ? await this.signFn(raw) : raw;
    const result = await this.syncClient!.push(docId, payload);

    if (result === "sent") {
      store.setPushHeads(heads);
    } else if (result === "no_key") {
      // No encryption key available (vault key not yet loaded).
      // Keep in dirty set but defer so flush skips it until vaults change.
      if (!this.deferredNoKey.has(docId)) {
        warn("[push-queue] no key for", docId.slice(0, 12), "- deferring");
      }
      this.deferredNoKey.add(docId);
    }

    if (tempOpened) await this.docMgr.close(docId);
    return result;
  }

  private isConnected(): boolean {
    return this.syncClient?.isOpen() ?? false;
  }

  private scheduleBackoffFlush(): void {
    if (this.backoffTimer) return;
    this.backoffTimer = setTimeout(async () => {
      this.backoffTimer = null;
      this.ratePaused = false;
      this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX);
      await this.flushAllDirty();
    }, this.backoffMs);
  }
}
