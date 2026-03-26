/**
 * Sync status bar UI -- two independent indicators:
 *   <connection status> <dot> <sync progress>
 * Subscribes to sync events. No sync logic here, purely display.
 */

import { getSyncStatus, getPushQueue } from "../state";
import { on as onSyncEvent } from "../sync/sync-events";

function updateSyncBadge() {
  const syncStatus = getSyncStatus();
  const pushQueue = getPushQueue();

  const bar = document.getElementById("sync-badge") as HTMLElement;
  const connEl = document.getElementById("conn-status") as HTMLSpanElement;
  const syncEl = document.getElementById("sync-progress") as HTMLSpanElement;
  bar.hidden = false;

  const dirtyCount = pushQueue?.dirtyCount() ?? 0;
  const pushableCount = pushQueue?.pushableCount() ?? 0;

  // Connection status (left side)
  if (syncStatus === "connected") {
    connEl.className = "conn-status connected";
    connEl.textContent = "online";
  } else if (syncStatus === "connecting") {
    connEl.className = "conn-status connecting";
    connEl.textContent = "connecting";
  } else {
    connEl.className = "conn-status disconnected";
    connEl.textContent = "offline";
  }

  // Sync progress (right side)
  if (pushableCount > 0) {
    syncEl.className = "sync-progress syncing";
    syncEl.textContent = `syncing ${pushableCount}`;
  } else if (dirtyCount > 0) {
    syncEl.className = "sync-progress pending";
    syncEl.textContent = `${dirtyCount} pending`;
  } else {
    syncEl.className = "sync-progress synced";
    syncEl.textContent = "synced";
  }
}

export function initSyncStatus() {
  onSyncEvent("status-change", updateSyncBadge);
  onSyncEvent("dirty-change", updateSyncBadge);
}

export { updateSyncBadge };
