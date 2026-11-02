// XdirgaWA v1 AI adapter — the SINGLE point where the AI path talks to a
// model. Every other file in the AI path must use this module; no other
// file may fetch a chat gateway, call Workers AI, or touch Vectorize.
//
// v1 rules enforced here:
// - AI_PROVIDER is "gateway" or "off", default "off" (kill-switch: off
//   means zero gateway calls, no code redeploy needed to stop AI).
// - GATEWAY_BASE_URL must be public HTTPS. localhost, loopback and http
//   are rejected at config validation, because a Cloudflare Worker
//   cannot reach a gateway on the user's PC.
// - GATEWAY_API_KEY comes only from a Worker secret. It is never logged,
//   never echoed in an error, and never appears in a prompt.
// - No tools, no streaming: the request body contains no `tools` field
//   and sets stream:false, so the gateway model cannot call tools.
// - Generate retries at most once, only for network errors, 5xx, or a
//   timeout. 4xx (including 401/403/429) is never retried: it means
//   config, key, or quota, not a transient failure.
// - On any failure the caller must fail closed to human handoff. There
//   is deliberately NO fallback to Workers AI in this module.

export const DEFAULT_GATEWAY_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_CONTEXT_MESSAGES = 20;
export const MAX_GATEWAY_REPLY_TOKENS = 400;
export const GATEWAY_TEMPERATURE = 0.2;

export type GatewayProviderName = "gateway" | "off";

export interface GatewayProviderConfig {
  provider: GatewayProviderName;
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  maxContextMessages: number;
  enabledWorkspaces: string[];
}

export type GatewayConfigResult =
  | { ok: true; config: GatewayProviderConfig }
  | { ok: false; error: string };

export interface GatewayChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GenerateChatInput {
  systemPrompt: string;
  /** Already same-conversation only; sliced again to maxContextMessages. */
  history: GatewayChatMessage[];
  message: string;
}

export type GenerateChatResult =
  | { status: "ok"; text: string }
  | { status: "failed"; reason: string };

/** Minimal fetch shape: the real global fetch satisfies it, and tests can stub it. */
export type GatewayFetch = (
  url: string,
  init: RequestInit,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export function gatewayChatEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Validates the gateway configuration from Worker env vars. Returns a
 * generic error string only — never the key, never the full URL with
 * credentials, never a request body.
 */
export function resolveGatewayConfig(env: {
  AI_PROVIDER?: string;
  GATEWAY_BASE_URL?: string;
  GATEWAY_MODEL?: string;
  GATEWAY_API_KEY?: string;
  AI_CHAT_TIMEOUT_MS?: string;
  AI_MAX_CONTEXT_MESSAGES?: string;
  AI_ENABLED_WORKSPACES?: string;
}): GatewayConfigResult {
  const providerRaw = (env.AI_PROVIDER ?? "off").trim().toLowerCase();
  const timeoutMs = Math.min(
    120_000,
    Math.max(1_000, parsePositiveInt(env.AI_CHAT_TIMEOUT_MS, DEFAULT_GATEWAY_TIMEOUT_MS)),
  );
  const maxContextMessages = Math.min(
    20,
    Math.max(1, parsePositiveInt(env.AI_MAX_CONTEXT_MESSAGES, DEFAULT_MAX_CONTEXT_MESSAGES)),
  );
  const enabledWorkspaces = (env.AI_ENABLED_WORKSPACES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (providerRaw === "off") {
    return {
      ok: true,
      config: {
        provider: "off",
        baseUrl: "",
        model: "",
        apiKey: "",
        timeoutMs,
        maxContextMessages,
        enabledWorkspaces,
      },
    };
  }
  if (providerRaw !== "gateway") {
    return { ok: false, error: "invalid AI_PROVIDER" };
  }

  const baseUrl = (env.GATEWAY_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) return { ok: false, error: "gateway base URL missing" };
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, error: "gateway base URL invalid" };
  }
  if (parsed.protocol !== "https:") return { ok: false, error: "gateway base URL must be https" };
  if (parsed.username || parsed.password) return { ok: false, error: "gateway base URL must not contain credentials" };
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  ) {
    return { ok: false, error: "gateway base URL must be a public host" };
  }
  const model = (env.GATEWAY_MODEL ?? "").trim();
  if (!model) return { ok: false, error: "gateway model missing" };
  const apiKey = env.GATEWAY_API_KEY ?? "";
  if (!apiKey) return { ok: false, error: "gateway key missing" };

  return {
    ok: true,
    config: { provider: "gateway", baseUrl, model, apiKey, timeoutMs, maxContextMessages, enabledWorkspaces },
  };
}

/** Fail-closed workspace gate: an empty allow-list enables nobody. */
export function isGatewayEnabledForWorkspace(
  config: GatewayProviderConfig,
  workspaceId: string,
): boolean {
  return config.provider === "gateway" && config.enabledWorkspaces.includes(workspaceId);
}

const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+\S+/,
  /\bsk-[A-Za-z0-9]{16,}/,
  /\bgh[pous]_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBEGIN\s+(RSA|EC|OPENSSH|PRIVATE)\s+KEY\b/,
];

function containsSecretPattern(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/**
 * One chat generation through the user's gateway. No tools, no streaming.
 * The caller (agent.ts) owns redaction and the draft/human decision; this
 * function only guarantees: ok with clean non-empty text, or failed with
 * a generic reason. It never returns a secret-bearing or empty answer.
 */
export async function generateChat(
  config: GatewayProviderConfig,
  input: GenerateChatInput,
  options?: { fetchImpl?: GatewayFetch; retryDelayMs?: number },
): Promise<GenerateChatResult> {
  if (config.provider !== "gateway") return { status: "failed", reason: "gateway_disabled" };
  const fetchFn: GatewayFetch = options?.fetchImpl ?? fetch;
  const retryDelayMs = options?.retryDelayMs ?? 500;
  const history = input.history.slice(-config.maxContextMessages);
  const body = {
    model: config.model,
    messages: [
      { role: "system", content: input.systemPrompt },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: input.message },
    ],
    temperature: GATEWAY_TEMPERATURE,
    max_tokens: MAX_GATEWAY_REPLY_TOKENS,
    stream: false,
  };

  for (let attempt = 0; attempt <= 1; attempt++) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        try {
          controller.abort();
        } catch {
          // abort is best-effort; the race below still times out.
        }
        // Named TimeoutError so the catch below classifies it as a
        // timeout (not a generic network error), even when a stubbed
        // fetch ignores the abort signal and never settles.
        const timeoutError = new Error("gateway timeout");
        timeoutError.name = "TimeoutError";
        reject(timeoutError);
      }, config.timeoutMs);
    });
    try {
      const response = await Promise.race([
        fetchFn(gatewayChatEndpoint(config.baseUrl), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return { status: "failed", reason: "gateway_auth_failed" };
        }
        if (response.status >= 400 && response.status < 500) {
          return { status: "failed", reason: "gateway_http_4xx" };
        }
        if (response.status >= 500 && attempt === 0) {
          await delay(retryDelayMs);
          continue;
        }
        return { status: "failed", reason: "gateway_http_5xx" };
      }
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        return { status: "failed", reason: "gateway_invalid_response" };
      }
      const content = (parsed as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]
        ?.message?.content;
      if (typeof content !== "string") return { status: "failed", reason: "gateway_invalid_response" };
      const text = content.trim();
      if (!text) return { status: "failed", reason: "gateway_empty_response" };
      if (containsSecretPattern(text)) return { status: "failed", reason: "gateway_secret_in_response" };
      return { status: "ok", text };
    } catch (err) {
      const retryable = isAbortError(err) || err instanceof Error;
      // Network / timeout errors are retryable once; a second failure is final.
      if (retryable && attempt === 0) {
        await delay(retryDelayMs);
        continue;
      }
      if (isAbortError(err)) return { status: "failed", reason: "gateway_timeout" };
      return { status: "failed", reason: "gateway_network_error" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return { status: "failed", reason: "gateway_network_error" };
}
