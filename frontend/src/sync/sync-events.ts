/**
 * Typed event emitter for sync state changes.
 * Decouples the sync layer from UI -- sync emits events, UI subscribes.
 */

import type { SyncStatus } from "../lib/sync-client";
import type { Book } from "../types";

export interface SyncEventMap {
  "status-change": SyncStatus;
  "dirty-change": { dirtyCount: number; pushableCount: number };
  "auth-error": { type: string; message: string; isReconnect: boolean };
  "auth-success": { username: string };
  "books-change": Book[];
}

type Handler<T> = (data: T) => void;

const listeners = new Map<string, Set<Handler<any>>>();

export function on<K extends keyof SyncEventMap>(event: K, fn: Handler<SyncEventMap[K]>): void {
  let set = listeners.get(event);
  if (!set) { set = new Set(); listeners.set(event, set); }
  set.add(fn);
}

export function off<K extends keyof SyncEventMap>(event: K, fn: Handler<SyncEventMap[K]>): void {
  listeners.get(event)?.delete(fn);
}

export function emit<K extends keyof SyncEventMap>(event: K, data: SyncEventMap[K]): void {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of set) fn(data);
}
