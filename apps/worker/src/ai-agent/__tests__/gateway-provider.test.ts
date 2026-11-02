import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { generateChat, isGatewayEnabledForWorkspace, resolveGatewayConfig } from "../gateway-provider";
import type { GatewayFetch, GatewayProviderConfig } from "../gateway-provider";
import { buildSystemPrompt } from "../system-prompt";
import { classifyIntent } from "../guardrails";
import type { AgentConfig, AgentEnv } from "../types";

// Placeholder mock key only. Never a real gateway key: tests must never
// contain, log, or transmit a real credential.
const MOCK_KEY = "mock-test-key-12345";

function config(overrides: Partial<GatewayProviderConfig> = {}): GatewayProviderConfig {
  return {
    provider: "gateway",
    baseUrl: "https://gateway.example/v1",
    model: "mock-model",
    apiKey: MOCK_KEY,
    timeoutMs: 1000,
    maxContextMessages: 20,
    enabledWorkspaces: ["ws-1"],
    ...overrides,
  };
}

function mockFetch(
  handler: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>,
): { fetch: GatewayFetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: GatewayFetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetch, calls };
}

function okResponse(text: string) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }) };
}

function agentConfig(): AgentConfig {
  return {
    workspaceId: "ws-1",
    enabled: true,
    businessName: "Acme Co",
    scopeDescription: "product support",
    replyInGroups: false,
    models: { classifier: "c", generator: "g", embedding: "e" },
    maxContextChunks: 4,
    similarityThreshold: 0.72,
    cacheTtlSeconds: 3600,
  };
}

describe("resolveGatewayConfig", () => {
  it("defaults to off, which disables the gateway", () => {
    const resolved = resolveGatewayConfig({});
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.config.provider).toBe("off");
      expect(isGatewayEnabledForWorkspace(resolved.config, "ws-1")).toBe(false);
    }
  });

  it("accepts a public https gateway", () => {
    const resolved = resolveGatewayConfig({
      AI_PROVIDER: "gateway",
      GATEWAY_BASE_URL: "https://gateway.example/v1/",
      GATEWAY_MODEL: "mock-model",
      GATEWAY_API_KEY: MOCK_KEY,
      AI_ENABLED_WORKSPACES: "ws-1, ws-2",
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.config.baseUrl).toBe("https://gateway.example/v1");
      expect(isGatewayEnabledForWorkspace(resolved.config, "ws-1")).toBe(true);
      expect(isGatewayEnabledForWorkspace(resolved.config, "ws-9")).toBe(false);
    }
  });

  it("rejects http, localhost, and loopback base URLs", () => {
    for (const baseUrl of [
      "http://gateway.example/v1",
      "https://localhost:8080/v1",
      "https://127.0.0.1/v1",
      "https://foo.localhost/v1",
    ]) {
      const resolved = resolveGatewayConfig({
        AI_PROVIDER: "gateway",
        GATEWAY_BASE_URL: baseUrl,
        GATEWAY_MODEL: "mock-model",
        GATEWAY_API_KEY: MOCK_KEY,
      });
      expect(resolved.ok).toBe(false);
    }
  });

  it("rejects a gateway config with a missing model or key", () => {
    expect(
      resolveGatewayConfig({ AI_PROVIDER: "gateway", GATEWAY_BASE_URL: "https://gateway.example/v1", GATEWAY_MODEL: "", GATEWAY_API_KEY: MOCK_KEY }).ok,
    ).toBe(false);
    expect(
      resolveGatewayConfig({ AI_PROVIDER: "gateway", GATEWAY_BASE_URL: "https://gateway.example/v1", GATEWAY_MODEL: "mock-model", GATEWAY_API_KEY: "" }).ok,
    ).toBe(false);
  });

  it("rejects an unknown provider and clamps context messages to 20", () => {
    expect(resolveGatewayConfig({ AI_PROVIDER: "workers" }).ok).toBe(false);
    const resolved = resolveGatewayConfig({
      AI_PROVIDER: "gateway",
      GATEWAY_BASE_URL: "https://gateway.example/v1",
      GATEWAY_MODEL: "mock-model",
      GATEWAY_API_KEY: MOCK_KEY,
      AI_MAX_CONTEXT_MESSAGES: "99",
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.config.maxContextMessages).toBe(20);
  });

  it("an empty workspace allow-list enables nobody", () => {
    const cfg = config({ enabledWorkspaces: [] });
    expect(isGatewayEnabledForWorkspace(cfg, "ws-1")).toBe(false);
  });
});

describe("generateChat", () => {
  it("succeeds, sends no tools, and does not stream", async () => {
    const { fetch, calls } = mockFetch(async () => okResponse("  Hello, how can I help?  "));
    const result = await generateChat(
      config(),
      { systemPrompt: "Be helpful.", history: [{ role: "user", content: "hi" }], message: "hello" },
      { fetchImpl: fetch, retryDelayMs: 0 },
    );
    expect(result).toEqual({ status: "ok", text: "Hello, how can I help?" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://gateway.example/v1/chat/completions");
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body.model).toBe("mock-model");
    expect(body.stream).toBe(false);
    expect(body.tools).toBeUndefined();
    expect(body.messages).toHaveLength(3);
    const headers = new Headers(calls[0].init.headers as HeadersInit);
    expect(headers.get("Authorization")).toBe(`Bearer ${MOCK_KEY}`);
  });

  it("caps history to maxContextMessages, same conversation only by caller design", async () => {
    const { fetch, calls } = mockFetch(async () => okResponse("ok"));
    await generateChat(
      config({ maxContextMessages: 2 }),
      {
        systemPrompt: "s",
        history: [
          { role: "user", content: "a" },
          { role: "user", content: "b" },
          { role: "user", content: "c" },
        ],
        message: "d",
      },
      { fetchImpl: fetch, retryDelayMs: 0 },
    );
    const body = JSON.parse(String(calls[0].init.body)) as { messages: unknown[] };
    // system + last 2 history + user
    expect(body.messages).toHaveLength(4);
  });

  it("retries a timeout once, then fails closed to handoff", async () => {
    const { fetch, calls } = mockFetch(() => new Promise(() => {}));
    const result = await generateChat(
      config({ timeoutMs: 20 }),
      { systemPrompt: "s", history: [], message: "hi" },
      { fetchImpl: fetch, retryDelayMs: 0 },
    );
    expect(result).toEqual({ status: "failed", reason: "gateway_timeout" });
    expect(calls).toHaveLength(2);
  });

  it("never retries a 401, and never leaks the key in the reason", async () => {
    const { fetch, calls } = mockFetch(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "bad key" }),
    }));
    const result = await generateChat(
      config(),
      { systemPrompt: "s", history: [], message: "hi" },
      { fetchImpl: fetch, retryDelayMs: 0 },
    );
    expect(result).toEqual({ status: "failed", reason: "gateway_auth_failed" });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(MOCK_KEY);
  });

  it("retries a 500 once, then fails", async () => {
    const { fetch, calls } = mockFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const result = await generateChat(
      config(),
      { systemPrompt: "s", history: [], message: "hi" },
      { fetchImpl: fetch, retryDelayMs: 0 },
    );
    expect(result).toEqual({ status: "failed", reason: "gateway_http_5xx" });
    expect(calls).toHaveLength(2);
  });

  it("fails on an invalid response shape, without retry", async () => {
    const { fetch, calls } = mockFetch(async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) }));
    const result = await generateChat(
      config(),
      { systemPrompt: "s", history: [], message: "hi" },
      { fetchImpl: fetch, retryDelayMs: 0 },
    );
    expect(result).toEqual({ status: "failed", reason: "gateway_invalid_response" });
    expect(calls).toHaveLength(1);
  });

  it("fails on an empty answer, without returning it", async () => {
    const { fetch } = mockFetch(async () => okResponse("   "));
    const result = await generateChat(
      config(),
      { systemPrompt: "s", history: [], message: "hi" },
      { fetchImpl: fetch, retryDelayMs: 0 },
    );
    expect(result).toEqual({ status: "failed", reason: "gateway_empty_response" });
  });

  it("fails on a secret-bearing answer, and never returns that text", async () => {
    const { fetch } = mockFetch(async () => okResponse("here is your key: Bearer abcdefghijklmnop"));
    const result = await generateChat(
      config(),
      { systemPrompt: "s", history: [], message: "hi" },
      { fetchImpl: fetch, retryDelayMs: 0 },
    );
    expect(result).toEqual({ status: "failed", reason: "gateway_secret_in_response" });
    expect(JSON.stringify(result)).not.toContain("abcdefghijklmnop");
  });

  it("with the provider off, makes zero gateway calls", async () => {
    const { fetch, calls } = mockFetch(async () => okResponse("should never be used"));
    const result = await generateChat(
      config({ provider: "off" }),
      { systemPrompt: "s", history: [], message: "hi" },
      { fetchImpl: fetch, retryDelayMs: 0 },
    );
    expect(result).toEqual({ status: "failed", reason: "gateway_disabled" });
    expect(calls).toHaveLength(0);
  });

  it("retries a network error once, then fails", async () => {
    const { fetch, calls } = mockFetch(async () => {
      throw new Error("network down");
    });
    const result = await generateChat(
      config(),
      { systemPrompt: "s", history: [], message: "hi" },
      { fetchImpl: fetch, retryDelayMs: 0 },
    );
    expect(result).toEqual({ status: "failed", reason: "gateway_network_error" });
    expect(calls).toHaveLength(2);
  });
});

describe("v1 system prompt guardrails", () => {
  it("forbids answering from outside the conversation and forbids credentials", () => {
    const prompt = buildSystemPrompt(agentConfig(), [{ id: "1", text: "We ship worldwide", score: 1, source: "same-conversation" }], true);
    expect(prompt).toContain("Answer only from the context of this conversation");
    expect(prompt).toContain("Never write, guess, or repeat credentials, tokens, passwords, or secrets");
    expect(prompt).toContain("You have no tools in this version");
  });
});

describe("classifyIntent with the gateway off", () => {
  it("falls back to keyword rules and makes zero gateway calls", async () => {
    const fetchSpy = vi.fn(async () => okResponse("SUPPORT")) as unknown as GatewayFetch;
    const env = { AI_PROVIDER: "off" } as unknown as AgentEnv;
    const blocked = await classifyIntent(env, agentConfig(), "write me a python script", fetchSpy);
    expect(blocked.allowed).toBe(false);
    expect(blocked.label).toBe("CODING");
    const open = await classifyIntent(env, agentConfig(), "where is my order?", fetchSpy);
    expect(open.allowed).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("AI path is off (source guard)", () => {
  function read(rel: string): string {
    return readFileSync(new URL(rel, import.meta.url), "utf8");
  }

  it("agent, guardrails, rag, search, and auto-reply contain no Workers AI or Vectorize calls", () => {
    for (const rel of [
      "../agent.ts",
      "../guardrails.ts",
      "../rag.ts",
      "../../search.ts",
      "../../ai-autoreply.ts",
    ]) {
      const src = read(rel);
      expect(src).not.toContain("env.AI.run");
      expect(src).not.toContain("AGENT_VECTORIZE.");
      expect(src).not.toContain("VECTORIZE.");
    }
    expect(read("../agent.ts")).not.toContain("retrieveContext");
    expect(read("../agent.ts")).not.toContain("executeTool");
    expect(read("../../ai-autoreply.ts")).not.toContain("sendMessage");
    expect(read("../../ai-autoreply.ts")).not.toContain("maybeAiAutoReply");
  });

  it("message-events sends only keyword replies, never an AI draft", () => {
    const src = read("../../session/message-events.ts");
    expect(src).toContain("maybeAiDraft");
    expect(src).not.toContain("maybeAiAutoReply");
    const sendCount = (src.match(/sendMessage\(/g) ?? []).length;
    expect(sendCount).toBe(1);
  });
});
