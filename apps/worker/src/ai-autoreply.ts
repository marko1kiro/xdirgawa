// XdirgaWA v1: bridges the AI agent to the WhatsApp inbound path, as a
// DRAFT bridge only. This file must never send an AI output.
//
// Runs only when the workspace has opted in (agent_configs.enabled),
// honours the existing auto-reply access rules (blacklist/whitelist),
// and defaults to private chats unless the workspace sets replyInGroups.
// Keyword auto-reply rules run first (in whatsapp-session.ts) — this is
// the fallback when no canned rule matched, and unlike the upstream
// bridge it returns a draft, not a sendable reply.
//
// The draft is recorded as a pending row in agent_escalations (the
// existing human-handoff queue, visible in the web app under
// Automation > Escalations). A human copies it into the inbox composer
// and sends it manually; that manual send goes through the normal
// outbound guard, pace buckets, and daily caps. Nothing in this file
// calls the socket send API, and nothing returns AI text to a sender.
import type { Env } from "./index";
import { createDb, agentEscalations } from "@workspace/db";
import { isBlocked } from "./automation";
import { loadAgentConfig } from "./ai-agent/config";
import { handleAgentMessage } from "./ai-agent/agent";
import type { GatewayFetch } from "./ai-agent/gateway-provider";

export interface AiAutoReplyParams {
  waSessionId: string;
  workspaceId: string;
  conversationId: string;
  remoteJid: string;
  senderJid: string;
  isGroup: boolean;
  body: string;
}

export interface AiDraft {
  text: string;
  handoffReason?: string;
  blocked: boolean;
}

// Anti-abuse: per-conversation cap on how many times the agent is invoked
// (a gateway call costs real money per call, and a chatty customer could
// otherwise burn unbounded spend by paraphrasing the same question). The
// window is a rolling one — every handled message slides the expiry, so a
// quiet gap resets it. 0 = fully off to be safe.
const RATE_WINDOW_SECONDS = 300; // 5 minutes
const MAX_AGENT_INVOCATIONS_PER_WINDOW = 5;

/**
 * Returns a draft for human review, or null if the agent is off, quiet,
 * or produced nothing worth reviewing. NEVER returns a string for a
 * caller to send: message-events.ts must not send this text.
 */
export async function maybeAiDraft(
  env: Env,
  params: AiAutoReplyParams,
  fetchImpl?: GatewayFetch,
): Promise<AiDraft | null> {
  const config = await loadAgentConfig(env, params.workspaceId);
  if (!config.enabled) return null;
  if (params.isGroup && !config.replyInGroups) return null;

  const db = createDb(env.DB);
  if (await isBlocked(db, params.workspaceId, params.waSessionId, "auto_reply", params.senderJid)) return null;

  // Rate-limit BEFORE doing any expensive work (classifier/generation).
  // KV read-modify-write counter, sliding-window via a fresh TTL on every
  // write. On a KV failure we fail OPEN (count 0) so a cache hiccup never
  // silences a customer; the classifier gate is the real backstop.
  const bucket = params.conversationId;
  const rlKey = `agent:rl:${params.workspaceId}:${bucket}`;
  let count = 0;
  try {
    const parsed = Number((await env.REPLY_CACHE.get(rlKey)) ?? 0);
    count = Number.isFinite(parsed) ? parsed : 0;
  } catch {
    count = 0;
  }
  if (count >= MAX_AGENT_INVOCATIONS_PER_WINDOW) {
    // Stay completely quiet — don't even tell the customer we're throttled,
    // that would just invite more messages.
    return null;
  }
  // write-back the incremented counter (KV has no atomic increment in the
  // stable typing, so this is a soft, best-effort limiter — the classifier
  // gate + per-message spend caps are the real backstops).
  count += 1;
  await env.REPLY_CACHE
    .put(rlKey, String(count), { expirationTtl: RATE_WINDOW_SECONDS })
    .catch(() => {});

  const reply = await handleAgentMessage(
    env,
    config,
    {
      message: params.body,
      conversationId: params.conversationId,
      waSessionId: params.waSessionId,
      remoteJid: params.remoteJid,
      senderJid: params.senderJid,
      isGroup: params.isGroup,
    },
    fetchImpl,
  );
  if (!reply.text) return null;
  if (!reply.isDraft) return null; // defense in depth: v1 replies are always drafts

  const reason = reply.handoffReason
    ? `AI handoff (${reply.handoffReason}): ${reply.text}`
    : `AI draft (not sent): ${reply.text}`;
  try {
    await db
      .insert(agentEscalations)
      .values({
        workspaceId: params.workspaceId,
        conversationId: params.conversationId,
        remoteJid: params.remoteJid,
        reason,
        status: "pending",
      });
  } catch {
    // A draft-queue write failure must never turn into a send, and must
    // never crash inbound processing. The draft is still returned to the
    // caller for logging; it is simply not queued.
  }
  return { text: reply.text, handoffReason: reply.handoffReason, blocked: reply.blocked };
}
