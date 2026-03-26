/**
 * Share dialog -- invite members, manage roles, remove members.
 */

import { log, warn, error } from "../lib/logger";
import {
  deriveUserId, encryptBookKeyForUser, keyFingerprint,
} from "../lib/crypto";
import {
  getIdentityPrivateKey, getIdentityPublicKey, getSessionKeys,
} from "../lib/auth";
import { toBase64, fromBase64 } from "../lib/encoding";
import { showConfirm } from "../lib/dialogs";
import { openModal } from "../lib/modal";
import { toastSuccess, toastError } from "../lib/toast";
import { getDocMgr, getSyncClient } from "../state";
import { pushSnapshot, catalogDocId } from "../sync/push";
import { memberName, rotateVaultKey } from "../sync/vault-helpers";
import type { Book, RecipeCatalog } from "../types";

let sharingBook: Book | null = null;
let shareBookDialog: HTMLDialogElement;
let shareMemberList: HTMLUListElement;
let inviteForm: HTMLFormElement;
let inviteError: HTMLElement;
let inviteSuccess: HTMLElement;

export function openShareDialog(book: Book) {
  const syncClient = getSyncClient();
  sharingBook = book;
  (document.getElementById("share-book-name") as HTMLElement).textContent = book.name;
  inviteError.hidden = true; inviteSuccess.hidden = true;
  shareMemberList.innerHTML = "<li style='font-size:0.8rem;color:var(--subtle)'>Loading...</li>";
  openModal(shareBookDialog); syncClient?.listVaultMembers(book.vaultId);
}

/** Returns the vault ID of the currently open share dialog, or null. */
export function getSharingVaultId(): string | null {
  return sharingBook?.vaultId ?? null;
}

export function renderMemberList(members: Array<{ userId: string; role: string; publicKey?: string }>) {
  const syncClient = getSyncClient();
  shareMemberList.innerHTML = "";
  if (members.length === 0) { shareMemberList.innerHTML = "<li style='font-size:0.8rem;color:var(--subtle)'>No members</li>"; return; }
  const myUserId = getSessionKeys()?.userId;
  // Derive role from the authoritative member list, not stale local book state
  const myMember = members.find((m) => m.userId === myUserId);
  const isOwner = myMember?.role === "owner";
  // Update local book role to match server state
  if (sharingBook && myMember && sharingBook.role !== myMember.role) {
    sharingBook.role = myMember.role as any;
  }
  for (const m of members) {
    const li = document.createElement("li");
    const displayName = memberName(m.userId, sharingBook?.vaultId);
    const isSelf = m.userId === myUserId;
    const info = document.createElement("span");
    info.textContent = `${displayName}${isSelf ? " (you)" : ""} - ${m.role}`;
    li.appendChild(info);
    const actions = document.createElement("span"); actions.style.display = "flex"; actions.style.gap = "0.25rem";
    if (isOwner && !isSelf) {
      if (m.role !== "owner") { const tb = document.createElement("button"); tb.className = "sm"; tb.textContent = "Make Owner"; tb.addEventListener("click", async () => { if (!sharingBook || !syncClient) return; const ok = await showConfirm(`Transfer ownership of "${sharingBook.name}" to ${displayName}? You will become an editor.`, { title: "Transfer Ownership", confirmText: "Transfer", danger: true }); if (!ok) return; try { await syncClient.transferOwnership(sharingBook.vaultId, m.userId); syncClient.listVaultMembers(sharingBook.vaultId); toastSuccess("Ownership transferred"); } catch (e: any) { error("[share] transfer failed:", e); toastError("Transfer failed"); } }); actions.appendChild(tb); }
      if (m.role === "editor") { const db = document.createElement("button"); db.className = "sm"; db.textContent = "Viewer"; db.addEventListener("click", async () => { if (!sharingBook || !syncClient) return; try { await syncClient.changeRole(sharingBook.vaultId, m.userId, "viewer"); syncClient.listVaultMembers(sharingBook.vaultId); } catch (e: any) { error("[share] role change failed:", e); } }); actions.appendChild(db); }
      else if (m.role === "viewer") { const pb = document.createElement("button"); pb.className = "sm"; pb.textContent = "Editor"; pb.addEventListener("click", async () => { if (!sharingBook || !syncClient) return; try { await syncClient.changeRole(sharingBook.vaultId, m.userId, "editor"); syncClient.listVaultMembers(sharingBook.vaultId); } catch (e: any) { error("[share] role change failed:", e); } }); actions.appendChild(pb); }
      const rmb = document.createElement("button"); rmb.className = "sm danger"; rmb.textContent = "Remove";
      rmb.addEventListener("click", async () => {
        if (!sharingBook || !syncClient) return;
        const ok = await showConfirm(`Remove ${displayName} from this book? The vault key will be rotated.`, { title: "Remove Member", confirmText: "Remove", danger: true }); if (!ok) return;
        rmb.disabled = true; rmb.textContent = "Removing...";
        try {
          await syncClient.removeFromVault(sharingBook.vaultId, m.userId);
          log("[share] removal confirmed, rotating vault key");
          await rotateVaultKey(sharingBook.vaultId);
        } catch (e: any) {
          error("[share] removal failed:", e);
        }
        getSyncClient()?.listVaultMembers(sharingBook!.vaultId);
      });
      actions.appendChild(rmb);
    }
    li.appendChild(actions); shareMemberList.appendChild(li);
  }
}

export function initShare() {
  shareBookDialog = document.getElementById("share-book-dialog") as HTMLDialogElement;
  shareMemberList = document.getElementById("share-member-list") as HTMLUListElement;
  inviteForm = document.getElementById("invite-form") as HTMLFormElement;
  inviteError = document.getElementById("invite-error") as HTMLElement;
  inviteSuccess = document.getElementById("invite-success") as HTMLElement;

  inviteForm.addEventListener("submit", async (e) => {
    e.preventDefault(); inviteError.hidden = true; inviteSuccess.hidden = true;
    const syncClient = getSyncClient();
    const docMgr = getDocMgr();
    if (!sharingBook || !syncClient || !docMgr) return;
    const ti = document.getElementById("invite-username") as HTMLInputElement;
    const tu = ti.value.trim(); if (!tu) return;
    try {
      log("[invite] looking up user:", tu);
      const tuid = await deriveUserId(tu);
      const { publicKey: tpk } = await syncClient.lookupUser(tuid);
      const pk = getIdentityPrivateKey(); const pub = getIdentityPublicKey();
      if (!pk || !pub || !sharingBook.encKey) { inviteError.textContent = "Missing keys."; inviteError.hidden = false; return; }
      const raw = new Uint8Array(await crypto.subtle.exportKey("raw", sharingBook.encKey));
      const tpb = fromBase64(tpk); const fp = await keyFingerprint(tpb);
      const enc = await encryptBookKeyForUser(pk, tpb, raw);
      // Default role is viewer
      syncClient.inviteToVault(sharingBook.vaultId, tuid, toBase64(enc), toBase64(pub), "viewer");
      // Write their username into the catalog member map
      const catDocId = `${sharingBook.vaultId}/catalog`;
      const catalog = docMgr.get<RecipeCatalog>(catDocId);
      if (catalog) {
        catalog.change((d) => {
          if (!d.members) d.members = {} as any;
          (d.members as any)[tuid] = tu;
        });
        pushSnapshot(catDocId);
      }
      log("[invite] invited", tu, "as viewer, fingerprint:", fp);
      inviteSuccess.textContent = `Invited ${tu}! Key: ${fp}`; inviteSuccess.hidden = false;
      syncClient.listVaultMembers(sharingBook.vaultId); ti.value = "";
    } catch (e: any) { error("[invite] failed:", e); inviteError.textContent = e.message ?? "Failed"; inviteError.hidden = false; }
  });
}
