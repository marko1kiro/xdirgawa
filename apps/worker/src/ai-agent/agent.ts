import type { AgentConfig, AgentEnv, AgentInput, AgentReply, RetrievedChunk } from "./types";
import { classifyIntent, redactSensitive, shouldEscalateToHuman } from "./guardrails";
import { createDb, eq, desc, messages } from "@workspace/db";
import { buildSystemPrompt } from "./system-prompt";
import { generateChat, isGatewayEnabledForWorkspace, resolveGatewayConfig } from "./gateway-provider";
import type { GatewayChatMessage, GatewayFetch } from "./gateway-provider";

const MAX_INPUT_CHARS = 4000;
const MAX_THREAD_CHARS = 6000;

const NO_INFO_REPLY =
  "I don't have that information on hand. I'll flag this for a team member to follow up with you.";
const CLARIFY_REPLY =
  "Hey! How can I help you today?";
const GATEWAY_HANDOFF_REPLY =
  "I'm having trouble reaching my assistant right now — a team member will follow up with you shortly.";

/**
 * XdirgaWA v1 agent pipeline. Deliberately narrower than the upstream
 * pipeline, and every output is a DRAFT for human review:
 *
 *   1. Intent gate — keyword rules, then the user's gateway (never
 *      Workers AI). Blocked intents return a canned refusal as a draft.
 *   2. Context — the same conversation's recent D1 messages only
 *      (no RAG, no cross-conversation history, no secrets in prompt).
 *   3. Generation — one non-streaming, tool-free gateway call. No
 *      Workers AI, no Vectorize, no fallback model, no answer cache.
 *   4. Redaction — secret patterns are scrubbed; a secret-bearing or
 *      empty gateway answer becomes a human handoff, never a draft.
 *   5. Fail-closed — gateway off, unconfigured, or failed means a
 *      human handoff notice, never a guessed answer and never a send.
 *
 * Callers must NOT pass `reply.text` to a send path: `isDraft` is
 * always true in v1. The WhatsApp auto-reply bridge (ai-autoreply.ts)
 * records the text as a pending human escalation instead of sending it.
 */
export async function handleAgentMessage(
  env: AgentEnv,
  config: AgentConfig,
  input: AgentInput,
  fetchImpl?: GatewayFetch,
): Promise<AgentReply> {
  if (!config.enabled) {
    return draftReply("", [], true);
  }

  const message = input.message.trim().slice(0, MAX_INPUT_CHARS);
  if (!message) {
    return draftReply("", [], false);
  }

  // ── 1) Intent gate (gateway or keyword-only fallback) ──
  const gate = await classifyIntent(env, config, message, fetchImpl);
  if (!gate.allowed) {
    return draftReply(gate.cannedReply ?? NO_INFO_REPLY, [], true, gate.label);
  }

  // ── 2) Same-conversation context only ──
  const gatewayResolved = resolveGatewayConfig(env);
  const maxContext = gatewayResolved.ok ? gatewayResolved.config.maxContextMessages : 20;
  const thread = input.conversationId ? await loadConversationThread(env, input, maxContext) : "";
  const context: RetrievedChunk[] = thread
    ? [{ id: "same-conversation", text: thread, score: 1, source: "same-conversation" }]
    : [];

  // ── 3) Gateway generation, or fail-closed handoff ──
  if (!gatewayResolved.ok || !isGatewayEnabledForWorkspace(gatewayResolved.config, config.workspaceId)) {
    return draftReply(GATEWAY_HANDOFF_REPLY, context, false, undefined, "gateway_disabled");
  }
  const history: GatewayChatMessage[] = thread
    ? [{ role: "user", content: thread }]
    : [];
  const result = await generateChat(
    gatewayResolved.config,
    {
      systemPrompt: buildSystemPrompt(config, context, context.length > 0),
      history,
      message,
    },
    { fetchImpl },
  );
  if (result.status !== "ok") {
    return draftReply(GATEWAY_HANDOFF_REPLY, context, false, undefined, result.reason);
  }

  // ── 4) Redaction (defense in depth: the adapter already rejects
  // secret-bearing answers, but never trust a single layer) ──
  const safeText = redactSensitive(result.text);
  if (!safeText.trim()) {
    return draftReply(GATEWAY_HANDOFF_REPLY, context, false, undefined, "gateway_empty_response");
  }

  // A customer asking for a human, or clearly frustrated, is a handoff
  // even when generation succeeded — the draft is still recorded by the
  // caller, with the handoff reason attached.
  if (shouldEscalateToHuman(message)) {
    return draftReply(NO_INFO_REPLY, context, false, undefined, "human_requested");
  }

  return draftReply(safeText, context, false);
}

function draftReply(
  text: string,
  usedContext: RetrievedChunk[],
  blocked: boolean,
  blockReason?: AgentReply["blockReason"],
  handoffReason?: string,
): AgentReply {
  return {
    text,
    usedTools: [],
    usedContext,
    blocked,
    blockReason,
    cached: false,
    isDraft: true,
    handoffReason,
  };
}

/**
 * Loads the tail of a conversation (most recent `limit` messages, oldest
 * first) from D1, scoped to this conversation id only. Missing
 * conversation / no rows is not an error — the caller just gets no thread.
 */
async function loadConversationThread(
  env: AgentEnv,
  input: AgentInput,
  limit: number,
  maxChars = MAX_THREAD_CHARS,
): Promise<string> {
  if (!input.conversationId) return "";
  try {
    const db = createDb(env.DB);
    const rows = await db
      .select({ direction: messages.direction, body: messages.body })
      .from(messages)
      .where(eq(messages.conversationId, input.conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(limit)
      .all();

    const parts = rows
      .filter((r) => r.body)
      .reverse()
      .map((r) => `${r.direction === "in" ? "Customer" : "Agent"}: ${r.body}`);
    if (parts.length === 0) return "";

    let text = `[Previous messages]\n${parts.join("\n")}`;
    if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`;
    return text;
  } catch {
    // Conversation read problems must never fail the whole agent pipeline.
    return "";
  }
}

/** Workers AI can hand tool arguments back as a string or an object. Kept for test compatibility; v1 never receives tool calls. */
export function parseToolArgs(argumentsRaw: any): Record<string, any> {
  if (argumentsRaw && typeof argumentsRaw === "object") return argumentsRaw;
  if (typeof argumentsRaw === "string") {
    try {
      const parsed = JSON.parse(argumentsRaw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}
