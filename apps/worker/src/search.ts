// XdirgaWA v1: semantic search is OFF. This module no longer embeds
// messages with Workers AI and no longer reads or writes Vectorize
// (wa-messages). Inbox sync, contacts, and schedules do not depend on
// it: indexing was fire-and-forget and failure-tolerant by design.
//
// - indexMessageForSearch / indexMessagesForSearch report not indexed.
// - semanticSearch returns no matches.
// Old Vectorize data is left untouched (not deleted) — only its use is
// off. Re-enabling semantic search is a v2 decision with its own spec.
import type { Env } from "./index";

const MIN_INDEXABLE_CHARS = 12;
export function isWorthIndexing(text: string) {
  return text.length >= MIN_INDEXABLE_CHARS && /[\p{L}\p{N}]/u.test(text);
}

/**
 * Kept for id compatibility only: it hashes the composite key the same
 * way the old code did, but v1 never upserts the resulting id anywhere.
 */
export async function searchVectorId(workspaceId: string, waSessionId: string, messageId: string): Promise<string> {
  const input = `${workspaceId}:${waSessionId}:${messageId}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 48);
}

export async function indexMessageForSearch(
  _env: Env,
  _params: {
    messageId: string;
    workspaceId: string;
    waSessionId: string;
    conversationId: string;
    text: string;
    isGroup?: boolean;
    groupName?: string | null;
    senderName?: string | null;
    senderJid?: string | null;
  },
) {
  return { indexed: false, disabled: true };
}

export async function indexMessagesForSearch(
  _env: Env,
  _workspaceId: string,
  _items: { messageId: string; waSessionId: string; conversationId: string; text: string }[],
) {
  return { indexed: 0, disabled: true };
}

export interface SearchMatch {
  messageId: string;
  score: number;
  conversationId: string;
  waSessionId: string;
  text: string;
  isGroup?: boolean;
  groupName?: string | null;
  senderName?: string | null;
  senderJid?: string | null;
}

/** v1: semantic search is disabled, so there are never matches. */
export async function semanticSearch(
  _env: Env,
  _workspaceId: string,
  _query: string,
  _topK = 10,
): Promise<SearchMatch[]> {
  return [];
}
