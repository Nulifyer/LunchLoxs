/**
 * E2EE WebSocket sync client with per-document channels.
 *
 * - Connects to a relay server, sends/receives encrypted Automerge snapshots
 * - Supports subscribing to specific documents (per-recipe sync)
 * - Handles reconnection with exponential backoff
 * - Messages processed sequentially to ensure ordering
 * - Promise-based user lookup for invite flow
 */

import { encrypt, decrypt } from "./crypto";
import { toBase64, fromBase64 } from "./encoding";

export type SyncStatus = "connecting" | "connected" | "disconnected";
export type PushResult = "sent" | "no_key" | "not_connected";

export interface VaultInfo {
  vaultId: string;
  encryptedVaultKey: string;
  senderPublicKey: string;
  role: string;
}

export interface VaultMemberInfo {
  userId: string;
  role: string;
  publicKey?: string;
  signingPublicKey?: string;
}

export interface SyncClientOptions {
  url: string;
  userId: string;
  deviceId: string;
  authHash: string;
  isSignup?: boolean;
  encKey: CryptoKey;
  /** Resolve the encryption key for a given doc_id. Vault-scoped docs use the vault key. */
  getDocKey?: (docId: string) => CryptoKey | null;
  wrappedKey?: string;
  onConnected?: (data: {
    wrappedKey?: string;
    publicKey?: string;
    wrappedPrivateKey?: string;
    signingPublicKey?: string;
    wrappedSigningPrivateKey?: string;
  }) => Promise<void> | void;
  onRemoteChange: (docId: string, snapshot: Uint8Array, seq: number, senderUserId?: string) => Promise<void>;
  onCaughtUp: (docId: string, latestSeq: number) => void;
  onStatusChange: (status: SyncStatus) => void;
  onPurged?: () => void;
  onPresence?: (docId: string, deviceId: string, data: any) => void;
  onPasswordChanged?: () => void;
  onAuthError?: (message: string) => void;
  onAck?: (docId: string, seq: number) => void;
  onPushError?: (docId: string, message: string) => void;
  onRateLimited?: (retryAfterMs?: number) => void;
  onVaultList?: (vaults: VaultInfo[]) => void;
  onVaultCreated?: (vaultId: string) => void;
  onVaultInvited?: (vaultId: string, encryptedVaultKey: string, role: string) => void;
  onVaultRemoved?: (vaultId: string) => void;
  onVaultDeleted?: (vaultId: string) => void;
  onVaultMembers?: (vaultId: string, members: VaultMemberInfo[]) => void;
  onOwnershipTransferred?: (vaultId: string, newOwnerUserId: string) => void;
  onOwnershipReceived?: (vaultId: string, fromUserId: string) => void;
  onRoleChanged?: (vaultId: string, targetUserId: string, newRole: string) => void;
  onVaultKeyRotated?: (vaultId: string) => void;
}

interface ServerMessage {
  type: string;
  doc_id?: string;
  seq?: number;
  payload?: string;
  from_device?: string;
  latest_seq?: number;
  message?: string;
  retry_after_ms?: number;
  presence?: any;
  public_key?: string;
  wrapped_private_key?: string;
  signing_public_key?: string;
  wrapped_signing_private_key?: string;
  sender_user_id?: string;
  vault_id?: string;
  vaults?: Array<{ vault_id: string; encrypted_vault_key: string; sender_public_key: string; role: string }>;
  members?: Array<{ user_id: string; role: string; public_key?: string; signing_public_key?: string }>;
  encrypted_vault_key?: string;
  role?: string;
  new_role?: string;
  target_user_id?: string;
  target_public_key?: string;
}

export class SyncClient {
  ws: WebSocket | null = null;
  opts: SyncClientOptions;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private messageQueue: Promise<void> = Promise.resolve();
  private subscriptions = new Set<string>();
  private lastSeqs = new Map<string, number>();
  private getLastSeq: (docId: string) => Promise<number> = () => Promise.resolve(0);

  /** Pending user lookup promises keyed by target user ID */
  private lookupResolvers = new Map<string, {
    resolve: (result: { userId: string; publicKey: string }) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(opts: SyncClientOptions) {
    this.opts = opts;
  }

  setLastSeqGetter(fn: (docId: string) => Promise<number>): void {
    this.getLastSeq = fn;
  }

  connect(): void {
    this.intentionalClose = false;
    this.messageQueue = Promise.resolve();
    this.opts.onStatusChange("connecting");

    this.ws = new WebSocket(this.opts.url);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      const msg: any = {
        type: "connect",
        user_id: this.opts.userId,
        device_id: this.opts.deviceId,
        auth_hash: this.opts.authHash,
        is_signup: this.opts.isSignup ?? false,
      };
      if (this.opts.wrappedKey) msg.wrapped_key = this.opts.wrappedKey;
      this.ws!.send(JSON.stringify(msg));
    };

    this.ws.onmessage = (event) => {
      this.messageQueue = this.messageQueue.then(() => this.handleMessage(event.data));
    };

    this.ws.onclose = (ev) => {
      console.warn("sync: ws closed, code:", ev.code, "reason:", ev.reason || "(none)", "intentional:", this.intentionalClose);
      this.opts.onStatusChange("disconnected");
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (ev) => {
      console.error("sync: ws error", ev);
    };
  }

  private async handleMessage(data: string): Promise<void> {
    const msg: ServerMessage = JSON.parse(data);

    switch (msg.type) {
      case "connected":
        this.opts.onStatusChange("connected");
        await this.opts.onConnected?.({
          wrappedKey: msg.payload || undefined,
          publicKey: msg.public_key || undefined,
          wrappedPrivateKey: msg.wrapped_private_key || undefined,
          signingPublicKey: msg.signing_public_key || undefined,
          wrappedSigningPrivateKey: msg.wrapped_signing_private_key || undefined,
        });
        await this.resubscribeAll();
        break;

      case "sync":
        if (msg.payload && msg.seq !== undefined && msg.doc_id) {
          const key = this.resolveKey(msg.doc_id);
          if (!key) { console.error(`sync: no key for doc ${msg.doc_id}`); break; }
          try {
            const encrypted = fromBase64(msg.payload);
            const plaintext = await decrypt(encrypted, key);
            await this.opts.onRemoteChange(msg.doc_id, plaintext, msg.seq, msg.sender_user_id);
          } catch (e) {
            console.error(`sync: decryption failed for doc ${msg.doc_id}:`, e);
          }
        }
        break;

      case "caught_up":
        if (msg.doc_id) {
          this.lastSeqs.set(msg.doc_id, msg.latest_seq ?? 0);
          this.opts.onCaughtUp(msg.doc_id, msg.latest_seq ?? 0);
        }
        break;

      case "ack":
        if (msg.doc_id && msg.seq !== undefined) {
          this.opts.onAck?.(msg.doc_id, msg.seq);
        }
        break;

      case "push_error":
        if (msg.doc_id) {
          this.opts.onPushError?.(msg.doc_id, msg.message ?? "unknown");
        }
        break;

      case "purged":
        this.opts.onPurged?.();
        break;

      case "presence":
        if (msg.from_device && msg.presence) {
          this.opts.onPresence?.(msg.doc_id ?? "", msg.from_device, msg.presence);
        }
        break;

      case "password_changed":
        this.opts.onPasswordChanged?.();
        break;

      case "password_change_ok":
      case "key_stored":
      case "identity_stored":
        break;

      case "vault_list":
        this.opts.onVaultList?.(
          (msg.vaults ?? []).map((v) => ({
            vaultId: v.vault_id,
            encryptedVaultKey: v.encrypted_vault_key,
            senderPublicKey: v.sender_public_key,
            role: v.role,
          }))
        );
        break;

      case "vault_created": {
        const vid = msg.vault_id ?? "";
        // Resolve the createVault() promise if this device initiated it
        const resolver = this.confirmResolvers.get(`vault_created:${vid}`);
        if (resolver) resolver();
        this.opts.onVaultCreated?.(vid);
        break;
      }

      case "vault_invited":
        this.opts.onVaultInvited?.(msg.vault_id ?? "", msg.encrypted_vault_key ?? "", msg.role ?? "editor");
        break;

      case "vault_removed":
        this.opts.onVaultRemoved?.(msg.vault_id ?? "");
        break;

      case "vault_deleted":
        this.opts.onVaultDeleted?.(msg.vault_id ?? "");
        break;

      case "vault_members":
        this.opts.onVaultMembers?.(
          msg.vault_id ?? "",
          (msg.members ?? []).map((m) => ({
            userId: m.user_id,
            role: m.role,
            publicKey: m.public_key,
            signingPublicKey: m.signing_public_key,
          }))
        );
        break;

      case "user_lookup": {
        const targetId = msg.target_user_id ?? "";
        const pending = this.lookupResolvers.get(targetId);
        if (pending) {
          clearTimeout(pending.timer);
          this.lookupResolvers.delete(targetId);
          pending.resolve({ userId: targetId, publicKey: msg.target_public_key ?? "" });
        }
        break;
      }

      case "ownership_transferred":
        this.opts.onOwnershipTransferred?.(msg.vault_id ?? "", msg.target_user_id ?? "");
        break;

      case "ownership_received":
        this.opts.onOwnershipReceived?.(msg.vault_id ?? "", msg.target_user_id ?? "");
        break;

      case "role_changed":
        this.opts.onRoleChanged?.(msg.vault_id ?? "", msg.target_user_id ?? "", msg.new_role ?? "");
        break;

      case "vault_key_rotated":
        this.opts.onVaultKeyRotated?.(msg.vault_id ?? "");
        break;

      case "vault_member_removed":
      case "transfer_ok":
      case "role_change_ok":
      case "vault_key_rotation_ok": {
        const resolver = this.confirmResolvers.get(msg.type);
        if (resolver) resolver();
        break;
      }

      case "vault_invite_ok":
      case "signing_identity_stored":
        break;

      case "error":
        if (msg.message === "auth_failed" || msg.message === "user_not_found" || msg.message === "user_already_exists") {
          console.error("sync: auth error:", msg.message);
          this.intentionalClose = true;
          this.ws?.close();
          this.opts.onStatusChange("disconnected");
          this.opts.onAuthError?.(msg.message);
        } else if (msg.message === "rate_limited") {
          console.warn("sync: rate limited, retry after", msg.retry_after_ms ?? "unknown", "ms");
          this.opts.onRateLimited?.(msg.retry_after_ms);
        } else {
          console.error("sync: server error:", msg.message);
          // Reject any pending lookup that might have caused this
          for (const [id, pending] of this.lookupResolvers) {
            clearTimeout(pending.timer);
            pending.reject(new Error(msg.message ?? "Server error"));
            this.lookupResolvers.delete(id);
          }
        }
        break;
    }
  }

  async subscribe(docId: string, lastSeq?: number): Promise<void> {
    this.subscriptions.add(docId);
    const seq = lastSeq ?? await this.getLastSeq(docId);
    this.lastSeqs.set(docId, seq);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: "subscribe",
        doc_id: docId,
        last_seq: seq,
      }));
    }
  }

  unsubscribe(docId: string): void {
    this.subscriptions.delete(docId);
    this.lastSeqs.delete(docId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "unsubscribe", doc_id: docId }));
    }
  }

  async push(docId: string, snapshot: Uint8Array): Promise<PushResult> {
    const key = this.resolveKey(docId);
    if (!key) {
      console.warn("sync: push skipped, no key for", docId.slice(0, 20));
      return "no_key";
    }
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.warn("sync: push skipped, ws not open for", docId.slice(0, 20), "state:", this.ws?.readyState);
      return "not_connected";
    }
    const encrypted = await encrypt(snapshot, key);
    this.ws.send(JSON.stringify({
      type: "push",
      doc_id: docId,
      payload: toBase64(encrypted),
    }));
    return "sent";
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  changePassword(newAuthHash: string, wrappedKey: string): void {
    this.sendMsg({ type: "change_password", new_auth_hash: newAuthHash, wrapped_key: wrappedKey });
  }

  // -- Vault operations --

  setIdentity(publicKey: string, wrappedPrivateKey: string): void {
    this.sendMsg({ type: "set_identity", public_key: publicKey, wrapped_private_key: wrappedPrivateKey });
  }

  setKey(wrappedKey: string): void {
    this.sendMsg({ type: "set_key", wrapped_key: wrappedKey });
  }

  listVaults(): void {
    this.sendMsg({ type: "list_vaults" });
  }

  createVault(vaultId: string, encryptedVaultKey: string, senderPublicKey: string): Promise<void> {
    return this.awaitConfirmation(`vault_created:${vaultId}`, () => {
      this.sendMsg({ type: "create_vault", vault_id: vaultId, encrypted_vault_key: encryptedVaultKey, sender_public_key: senderPublicKey });
    });
  }

  inviteToVault(vaultId: string, targetUserId: string, encryptedVaultKey: string, senderPublicKey: string, role = "editor"): void {
    this.sendMsg({ type: "invite_to_vault", vault_id: vaultId, target_user_id: targetUserId, encrypted_vault_key: encryptedVaultKey, sender_public_key: senderPublicKey, role });
  }

  removeFromVault(vaultId: string, targetUserId: string): Promise<void> {
    return this.awaitConfirmation("vault_member_removed", () => {
      this.sendMsg({ type: "remove_from_vault", vault_id: vaultId, target_user_id: targetUserId });
    });
  }

  listVaultMembers(vaultId: string): void {
    this.sendMsg({ type: "list_vault_members", vault_id: vaultId });
  }

  deleteVault(vaultId: string): void {
    this.sendMsg({ type: "delete_vault", vault_id: vaultId });
  }

  transferOwnership(vaultId: string, newOwnerUserId: string): Promise<void> {
    return this.awaitConfirmation("transfer_ok", () => {
      this.sendMsg({ type: "transfer_ownership", vault_id: vaultId, target_user_id: newOwnerUserId });
    });
  }

  changeRole(vaultId: string, targetUserId: string, newRole: string): Promise<void> {
    return this.awaitConfirmation("role_change_ok", () => {
      this.sendMsg({ type: "change_role", vault_id: vaultId, target_user_id: targetUserId, new_role: newRole });
    });
  }

  /** Generic helper: send a message, resolve when a specific confirmation type arrives. */
  private awaitConfirmation(confirmType: string, send: () => void, timeoutMs = 10000): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`${confirmType}: not connected`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.confirmResolvers.delete(confirmType); reject(new Error(`${confirmType} timed out`)); }, timeoutMs);
      this.confirmResolvers.set(confirmType, () => { clearTimeout(timer); this.confirmResolvers.delete(confirmType); resolve(); });
      send();
    });
  }
  private confirmResolvers = new Map<string, () => void>();

  setSigningIdentity(signingPublicKey: string, wrappedSigningPrivateKey: string): void {
    this.sendMsg({ type: "set_signing_identity", signing_public_key: signingPublicKey, wrapped_signing_private_key: wrappedSigningPrivateKey });
  }

  rotateVaultKey(vaultId: string, members: Array<{ userId: string; encryptedVaultKey: string; senderPublicKey: string }>): void {
    this.sendMsg({
      type: "rotate_vault_key",
      vault_id: vaultId,
      vault_key_updates: members.map((m) => ({
        user_id: m.userId,
        encrypted_vault_key: m.encryptedVaultKey,
        sender_public_key: m.senderPublicKey,
      })),
    });
  }

  /**
   * Look up a user's public key by their user ID.
   * Returns a Promise that resolves with the user info or rejects on timeout/error.
   */
  lookupUser(targetUserId: string): Promise<{ userId: string; publicKey: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.lookupResolvers.delete(targetUserId);
        reject(new Error("User lookup timed out"));
      }, 10000);

      this.lookupResolvers.set(targetUserId, { resolve, reject, timer });
      this.sendMsg({ type: "lookup_user", target_user_id: targetUserId });
    });
  }

  sendPresence(docId: string, data: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "presence", doc_id: docId, presence: data }));
    }
  }

  purge(): void {
    this.sendMsg({ type: "purge" });
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Reject all pending lookups
    for (const [, pending] of this.lookupResolvers) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Disconnected"));
    }
    this.lookupResolvers.clear();
    this.ws?.close();
  }

  /** Resolve the encryption key for a doc. Vault-scoped docs use getDocKey. */
  private resolveKey(docId: string): CryptoKey | null {
    if (this.opts.getDocKey) {
      const key = this.opts.getDocKey(docId);
      if (key) return key;
    }
    // Only fall back to master key for non-vault docs
    const isVaultDoc = docId.indexOf("/") > 0;
    if (isVaultDoc) {
      // Never encrypt vault docs with the master key -- that would be unreadable by other members
      return null;
    }
    return this.opts.encKey ?? null;
  }

  private sendMsg(obj: Record<string, any>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private async resubscribeAll(): Promise<void> {
    for (const docId of this.subscriptions) {
      const seq = this.lastSeqs.get(docId) ?? await this.getLastSeq(docId);
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: "subscribe",
          doc_id: docId,
          last_seq: seq,
        }));
      }
    }
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.connect();
    }, this.reconnectDelay);
  }
}
