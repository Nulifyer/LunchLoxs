/**
 * E2EE WebSocket sync client with per-document channels — reusable across projects.
 *
 * - Connects to a relay server, sends/receives encrypted Automerge snapshots
 * - Supports subscribing to specific documents (per-recipe sync)
 * - Handles reconnection with exponential backoff
 * - Messages processed sequentially to ensure ordering
 */

import { encrypt, decrypt } from "./crypto";

export type SyncStatus = "connecting" | "connected" | "disconnected";

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
}

export interface SyncClientOptions {
  url: string;
  userId: string;
  deviceId: string;
  authHash: string;
  encKey: CryptoKey;
  wrappedKey?: string;
  onConnected?: (data: {
    wrappedKey?: string;
    publicKey?: string;
    wrappedPrivateKey?: string;
  }) => Promise<void> | void;
  onRemoteChange: (docId: string, snapshot: Uint8Array, seq: number) => Promise<void>;
  onCaughtUp: (docId: string, latestSeq: number) => void;
  onStatusChange: (status: SyncStatus) => void;
  onPurged?: () => void;
  onPresence?: (docId: string, deviceId: string, data: any) => void;
  onPasswordChanged?: () => void;
  // Vault callbacks
  onVaultList?: (vaults: VaultInfo[]) => void;
  onVaultCreated?: (vaultId: string) => void;
  onVaultInvited?: (vaultId: string, encryptedVaultKey: string, role: string) => void;
  onVaultRemoved?: (vaultId: string) => void;
  onVaultDeleted?: (vaultId: string) => void;
  onVaultMembers?: (vaultId: string, members: VaultMemberInfo[]) => void;
  onUserLookup?: (userId: string, publicKey: string) => void;
}

interface ServerMessage {
  type: string;
  doc_id?: string;
  seq?: number;
  payload?: string;
  from_device?: string;
  latest_seq?: number;
  message?: string;
  presence?: any;
  // Identity
  public_key?: string;
  wrapped_private_key?: string;
  // Vault fields
  vault_id?: string;
  vaults?: Array<{ vault_id: string; encrypted_vault_key: string; sender_public_key: string; role: string }>;
  members?: Array<{ user_id: string; role: string; public_key?: string }>;
  encrypted_vault_key?: string;
  role?: string;
  target_user_id?: string;
  target_public_key?: string;
}

export class SyncClient {
  ws: WebSocket | null = null;
  opts: SyncClientOptions;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private pendingPushes: Array<{ docId: string; data: Uint8Array }> = [];
  private messageQueue: Promise<void> = Promise.resolve();
  private subscriptions = new Set<string>();
  /** Stored per-doc last_seq for resubscribe on reconnect */
  private lastSeqs = new Map<string, number>();
  private getLastSeq: (docId: string) => Promise<number> = () => Promise.resolve(0);

  constructor(opts: SyncClientOptions) {
    this.opts = opts;
  }

  /** Set the function to get last seq per document (called on subscribe/reconnect). */
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
      };
      if (this.opts.wrappedKey) msg.wrapped_key = this.opts.wrappedKey;
      this.ws!.send(JSON.stringify(msg));
    };

    this.ws.onmessage = (event) => {
      this.messageQueue = this.messageQueue.then(() => this.handleMessage(event.data));
    };

    this.ws.onclose = () => {
      this.opts.onStatusChange("disconnected");
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {};
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
        });
        // Resubscribe to all documents
        await this.resubscribeAll();
        await this.flushPending();
        break;

      case "sync":
        if (msg.payload && msg.seq !== undefined && msg.doc_id && this.opts.encKey) {
          try {
            const encrypted = base64ToBytes(msg.payload);
            const plaintext = await decrypt(encrypted, this.opts.encKey);
            await this.opts.onRemoteChange(msg.doc_id, plaintext, msg.seq);
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

      case "vault_created":
        this.opts.onVaultCreated?.(msg.vault_id ?? "");
        break;

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
          }))
        );
        break;

      case "user_lookup":
        this.opts.onUserLookup?.(msg.target_user_id ?? "", msg.target_public_key ?? "");
        break;

      case "vault_invite_ok":
      case "vault_member_removed":
        break;

      case "error":
        if (msg.message === "auth_failed") {
          console.error("sync: authentication failed — wrong passphrase?");
          this.intentionalClose = true;
          this.ws?.close();
          this.opts.onStatusChange("disconnected");
        } else {
          console.error("sync: server error:", msg.message);
        }
        break;
    }
  }

  /** Subscribe to a document's changes. */
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

  /** Unsubscribe from a document. */
  unsubscribe(docId: string): void {
    this.subscriptions.delete(docId);
    this.lastSeqs.delete(docId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "unsubscribe", doc_id: docId }));
    }
  }

  /** Push an encrypted snapshot for a specific document. */
  async push(docId: string, snapshot: Uint8Array): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN && this.opts.encKey) {
      const encrypted = await encrypt(snapshot, this.opts.encKey);
      this.ws.send(JSON.stringify({
        type: "push",
        doc_id: docId,
        payload: bytesToBase64(encrypted),
      }));
    } else {
      this.pendingPushes.push({ docId, data: snapshot });
    }
  }

  changePassword(newAuthHash: string, wrappedKey: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: "change_password",
        new_auth_hash: newAuthHash,
        wrapped_key: wrappedKey,
      }));
    }
  }

  // ── Vault operations ──

  setIdentity(publicKey: string, wrappedPrivateKey: string): void {
    this.sendMsg({ type: "set_identity", public_key: publicKey, wrapped_private_key: wrappedPrivateKey });
  }

  listVaults(): void {
    this.sendMsg({ type: "list_vaults" });
  }

  createVault(vaultId: string, encryptedVaultKey: string, senderPublicKey: string): void {
    this.sendMsg({ type: "create_vault", vault_id: vaultId, encrypted_vault_key: encryptedVaultKey, sender_public_key: senderPublicKey });
  }

  inviteToVault(vaultId: string, targetUserId: string, encryptedVaultKey: string, senderPublicKey: string, role = "editor"): void {
    this.sendMsg({ type: "invite_to_vault", vault_id: vaultId, target_user_id: targetUserId, encrypted_vault_key: encryptedVaultKey, sender_public_key: senderPublicKey, role });
  }

  removeFromVault(vaultId: string, targetUserId: string): void {
    this.sendMsg({ type: "remove_from_vault", vault_id: vaultId, target_user_id: targetUserId });
  }

  listVaultMembers(vaultId: string): void {
    this.sendMsg({ type: "list_vault_members", vault_id: vaultId });
  }

  deleteVault(vaultId: string): void {
    this.sendMsg({ type: "delete_vault", vault_id: vaultId });
  }

  lookupUser(targetUserId: string): void {
    this.sendMsg({ type: "lookup_user", target_user_id: targetUserId });
  }

  private sendMsg(obj: Record<string, any>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  sendPresence(docId: string, data: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "presence", doc_id: docId, presence: data }));
    }
  }

  purge(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "purge" }));
    }
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
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

  private async flushPending(): Promise<void> {
    const pending = this.pendingPushes.splice(0);
    for (const { docId, data } of pending) {
      await this.push(docId, data);
    }
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.connect();
    }, this.reconnectDelay);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
