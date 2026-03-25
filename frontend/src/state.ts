import type { DocumentManager } from "./lib/document-manager";
import type { SyncClient, SyncStatus } from "./lib/sync-client";
import type { Book } from "./types";

// -- Mutable state --
let docMgr: DocumentManager | null = null;
let syncClient: SyncClient | null = null;
let syncStatus: SyncStatus = "disconnected";
let selectedRecipeId: string | null = null;
let books: Book[] = [];
let activeBook: Book | null = null;
let currentUsername: string = "";
let currentUserId: string = "";
/** Cache of userId -> signing public key (raw bytes) for signature verification */
const signingKeyCache = new Map<string, Uint8Array>();
let isSignup = false;

// -- Getters / Setters --

export function getDocMgr(): DocumentManager | null { return docMgr; }
export function setDocMgr(d: DocumentManager | null) { docMgr = d; }

export function getSyncClient(): SyncClient | null { return syncClient; }
export function setSyncClient(s: SyncClient | null) { syncClient = s; }

export function getSyncStatus(): SyncStatus { return syncStatus; }
export function setSyncStatus(s: SyncStatus) { syncStatus = s; }

export function getSelectedRecipeId(): string | null { return selectedRecipeId; }
export function setSelectedRecipeId(id: string | null) { selectedRecipeId = id; }

export function getBooks(): Book[] { return books; }
export function setBooks(b: Book[]) { books = b; }

export function getActiveBook(): Book | null { return activeBook; }
export function setActiveBook(b: Book | null) { activeBook = b; }

export function getCurrentUsername(): string { return currentUsername; }
export function setCurrentUsername(u: string) { currentUsername = u; }

export function getCurrentUserId(): string { return currentUserId; }
export function setCurrentUserId(u: string) { currentUserId = u; }

export function getSigningKeyCache(): Map<string, Uint8Array> { return signingKeyCache; }

export function getIsSignup(): boolean { return isSignup; }
export function setIsSignup(v: boolean) { isSignup = v; }
