import { escapeHtml } from "../../lib/html";
import { getStore } from "./state";

const metaEl = document.getElementById("recipe-meta") as HTMLElement;

export function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

export function renderMetaDisplay() {
  const store = getStore();
  if (!store) return;
  const doc = store.getDoc();
  metaEl.innerHTML = "";

  // Tags line
  const tags = doc.tags ?? [];
  if (tags.length > 0) {
    const tagLine = document.createElement("div");
    tagLine.className = "meta-tags-line";
    tagLine.innerHTML = tags.map((t: string) => `<span class="tag">${escapeHtml(t)}</span>`).join(" ");
    metaEl.appendChild(tagLine);
  }

  // Stats line: servings · prep · cook · updated
  const stats = [
    doc.servings ? `${doc.servings} servings` : "",
    doc.prepMinutes ? `${doc.prepMinutes}m prep` : "",
    doc.cookMinutes ? `${doc.cookMinutes}m cook` : "",
  ].filter(Boolean);
  if (doc.updatedAt && doc.updatedAt > 0) {
    stats.push("updated " + timeAgo(doc.updatedAt));
  }
  if (stats.length > 0) {
    const statsLine = document.createElement("div");
    statsLine.className = "meta-stats-line";
    statsLine.textContent = stats.join(" · ");
    if (doc.updatedAt && doc.updatedAt > 0) {
      statsLine.title = new Date(doc.updatedAt).toLocaleString();
    }
    metaEl.appendChild(statsLine);
  }
}
