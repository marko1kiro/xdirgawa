// XdirgaWA v1: RAG is OFF. This module no longer embeds, queries, or
// upserts Vectorize, and no longer calls Workers AI.
//
// - retrieveContext() always returns []: the v1 agent grounds only on the
//   same conversation's recent messages (see agent.ts), never on docs.
// - ingestDocument() is disabled: doc upload is a v2 decision. Old
//   doc_chunks rows and old Vectorize indexes are left untouched (not
//   deleted) — only their *use* is off.
// - chunkText() stays as a pure helper (tested, no model calls), so a
//   future v2 can reuse it without resurrecting the v1-disabled path.
import type { AgentConfig, AgentEnv, RetrievedChunk } from "./types";

/** v1: RAG retrieval is disabled. Always no grounding chunks. */
export async function retrieveContext(
  _env: AgentEnv,
  _config: AgentConfig,
  _query: string,
): Promise<RetrievedChunk[]> {
  return [];
}

/** v1: RAG document ingestion is disabled. */
export async function ingestDocument(
  _env: AgentEnv,
  _config: AgentConfig,
  _params: { source: string; text: string; docId?: string; chunkSize?: number },
): Promise<{ chunks: number; deleted?: number }> {
  throw new Error("RAG document ingestion is disabled in XdirgaWA v1");
}

/**
 * Paragraph-aware chunking: packs paragraphs into chunks up to `size`
 * characters instead of blindly slicing at an exact offset, so a chunk
 * rarely cuts a thought in half (better match quality, and the vectorizer
 * gets coherent units to embed). Falls back to hard-slicing a single
 * over-long paragraph.
 */
export function chunkText(text: string, size = 800): string[] {
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (cleaned === "") return [];

  const paragraphs = cleaned.split(/\n\s*\n/).filter((p) => p.trim());
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    const c = current.trim();
    if (c) chunks.push(c);
    current = "";
  };

  for (const p of paragraphs) {
    if (p.length > size) {
      // Flush the accumulator before hard-slicing a monster paragraph.
      if (current) flush();
      for (let i = 0; i < p.length; i += size) {
        chunks.push(p.slice(i, i + size).trim());
      }
      continue;
    }
    if (current.length > 0 && current.length + p.length + 1 > size) flush();
    current = current ? `${current}\n${p}` : p;
  }
  flush();
  return chunks;
}
