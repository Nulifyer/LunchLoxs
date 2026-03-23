/**
 * E2EE WebSocket sync client — reusable across projects.
 *
 * Connects to a relay server, sends/receives encrypted Automerge changes.
 * Handles reconnection with exponential backoff.
 * The server never sees plaintext — only encrypted blobs.
 */

import { encrypt, decrypt } from "./crypto";

export type SyncStatus = "connecting" | "connected" | "disconnected";

export interface SyncClientOptions {
  /** WebSocket URL, e.g. ws://localhost:8080/ws */
  url: string;
  /** Opaque user identifier (SHA-256 of username) */
  userId: string;
  /** Unique device identifier (UUID) */
  deviceId: string;
  /** Auth hash (SHA-256 of Argon2 auth_key) — sent to server for auth */
  authHash: string;
  /** AES-256-GCM encryption key */
  encKey: CryptoKey;
  /** Get last processed sequence number */
  getLastSeq: () => Promise<number>;
  /** Called when encrypted change arrives from another device */
  onRemoteChange: (change: Uint8Array, seq: number) => Promise<void>;
  /** Called when catchup is complete */
  onCaughtUp: (latestSeq: number) => void;
  /** Called when connection status changes */
  onStatusChange: (status: SyncStatus) => void;
}

interface ServerMessage {
  type: string;
  seq?: number;
  payload?: string; // base64
  from_device?: string;
  latest_seq?: number;
  message?: string;
}

export class SyncClient {
  private ws: WebSocket | null = null;
  private opts: SyncClientOptions;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private pendingPushes: Uint8Array[] = [];

  constructor(opts: SyncClientOptions) {
    this.opts = opts;
  }

  /** Start the WebSocket connection. */
  connect(): void {
    this.intentionalClose = false;
    this.opts.onStatusChange("connecting");

    this.ws = new WebSocket(this.opts.url);

    this.ws.onopen = async () => {
      this.reconnectDelay = 1000; // reset backoff
      const lastSeq = await this.opts.getLastSeq();
      this.ws!.send(JSON.stringify({
        type: "connect",
        user_id: this.opts.userId,
        device_id: this.opts.deviceId,
        auth_hash: this.opts.authHash,
        last_seq: lastSeq,
      }));
    };

    this.ws.onmessage = async (event) => {
      const msg: ServerMessage = JSON.parse(event.data);

      switch (msg.type) {
        case "connected":
          this.opts.onStatusChange("connected");
          // Flush any changes made while disconnected
          await this.flushPending();
          break;

        case "sync":
          if (msg.payload && msg.seq !== undefined) {
            try {
              const encrypted = base64ToBytes(msg.payload);
              const plaintext = await decrypt(encrypted, this.opts.encKey);
              await this.opts.onRemoteChange(plaintext, msg.seq);
            } catch (e) {
              console.error("sync: decryption failed (wrong key?):", e);
            }
          }
          break;

        case "caught_up":
          this.opts.onCaughtUp(msg.latest_seq ?? 0);
          break;

        case "ack":
          // Server confirmed our push — seq is in msg.seq
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
    };

    this.ws.onclose = () => {
      this.opts.onStatusChange("disconnected");
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after this
    };
  }

  /** Send an encrypted Automerge change to the relay. */
  async push(change: Uint8Array): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const encrypted = await encrypt(change, this.opts.encKey);
      this.ws.send(JSON.stringify({
        type: "push",
        payload: bytesToBase64(encrypted),
      }));
    } else {
      // Queue for when we reconnect
      this.pendingPushes.push(change);
    }
  }

  /** Push multiple changes (e.g., full history for initial sync). */
  async pushAll(changes: Uint8Array[]): Promise<void> {
    for (const change of changes) {
      await this.push(change);
    }
  }

  /** Gracefully disconnect. */
  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
  }

  private async flushPending(): Promise<void> {
    const pending = this.pendingPushes.splice(0);
    for (const change of pending) {
      await this.push(change);
    }
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.connect();
    }, this.reconnectDelay);
  }
}

// ── Base64 helpers ──

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
