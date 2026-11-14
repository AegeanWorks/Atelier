import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "../../server/providers/types";
import type { Config } from "../../server/state";
import { contextOf, priceStep, priceUsage, summarizeUsage } from "../../server/usage";

const provider: ProviderConfig = {
  id: "openai",
  name: "OpenAI",
  protocol: "openai-chat",
  baseUrl: "http://127.0.0.1:1/v1",
};

const config: Config = {
  schema: 1,
  providers: [provider],
  roles: { executor: null, manager: null, auditor: null, compactor: null },
  defaults: { provider: "openai", model: "gpt-4.1" },
  mcpServers: [],
  hooks: [],
  rules: [],
  shellEnvPassthrough: [],
};

function event(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

describe("usage accounting", () => {
  it("prices a known catalog model per million tokens", () => {
    const price = priceUsage(provider, "gpt-4.1", { promptTokens: 1_000_000, completionTokens: 1_000_000 });
    expect(price.priced).toBe(true);
    expect(price.costUsd).toBeCloseTo(10, 9);
  });

  it("reports an unknown model or provider as unpriced instead of guessing", () => {
    expect(priceUsage(provider, "not-in-catalog", { promptTokens: 10, completionTokens: 20 })).toEqual({ costUsd: 0, priced: false });
    expect(priceStep(config, "missing", "gpt-4.1", { promptTokens: 1, completionTokens: 1 }, false)).toEqual({ costUsd: 0, priced: false });
  });

  it("excludes memo replays from billed totals and counts malformed events", () => {
    const summary = summarizeUsage("ses_1", [
      event({ providerId: "openai", model: "gpt-4.1", promptTokens: 1000, completionTokens: 500, cachedTokens: 0, costUsd: 0.006, priced: true, replayed: false }),
      event({ providerId: "openai", model: "gpt-4.1", promptTokens: 1000, completionTokens: 500, cachedTokens: 0, costUsd: 0, priced: true, replayed: true }),
      event({ providerId: "local", model: "unknown", promptTokens: 200, completionTokens: 100, cachedTokens: 0, costUsd: 0, priced: false, replayed: false }),
      "{not json",
    ]);
    expect(summary.sessionId).toBe("ses_1");
    expect(summary.requests).toBe(2);
    expect(summary.replays).toBe(1);
    expect(summary.promptTokens).toBe(1200);
    expect(summary.completionTokens).toBe(600);
    expect(summary.costUsd).toBeCloseTo(0.006, 9);
    expect(summary.unpricedRequests).toBe(1);
    expect(summary.invalidEvents).toBe(1);
    expect(summary.byModel.find((entry) => entry.model === "gpt-4.1")).toMatchObject({ requests: 1, promptTokens: 1000, completionTokens: 500 });
  });

  it("records a memo replay as priced but free", () => {
    expect(priceStep(config, "openai", "gpt-4.1", { promptTokens: 999, completionTokens: 111 }, true)).toEqual({ costUsd: 0, priced: true });
  });

  it("reports the latest billed request as the current context and ignores replays for it", () => {
    const summary = summarizeUsage("ses_1", [
      event({ providerId: "openai", model: "gpt-4.1", promptTokens: 100, completionTokens: 5, costUsd: 0, priced: true }),
      event({ providerId: "openai", model: "gpt-4.1", promptTokens: 900, completionTokens: 5, costUsd: 0, priced: true }),
      event({ providerId: "openai", model: "gpt-4.1", promptTokens: 7, completionTokens: 0, costUsd: 0, priced: true, replayed: true }),
    ]);
    expect(summary.last).toEqual({ providerId: "openai", model: "gpt-4.1", promptTokens: 900 });
    expect(summarizeUsage("ses_1", []).last).toBeNull();
  });
});

describe("context window", () => {
  it("resolves the window of a catalog model and leaves it null for an unknown one", () => {
    const known = summarizeUsage("s", [event({ providerId: "openai", model: "gpt-4.1", promptTokens: 52_428, completionTokens: 1, costUsd: 0, priced: true })]);
    expect(contextOf(known, config)).toEqual({ providerId: "openai", model: "gpt-4.1", usedTokens: 52_428, windowTokens: 1_047_576 });
    const unknown = summarizeUsage("s", [event({ providerId: "openai", model: "mystery", promptTokens: 10, completionTokens: 1, costUsd: 0, priced: false })]);
    expect(contextOf(unknown, config)).toMatchObject({ usedTokens: 10, windowTokens: null });
    expect(contextOf(summarizeUsage("s", []), config)).toBeNull();
  });

  it("takes the window from a provider's own model list when it declares one", () => {
    const custom: Config = { ...config, providers: [{ ...provider, models: [{ id: "local-7b", contextWindow: 32_768 }] }] };
    const summary = summarizeUsage("s", [event({ providerId: "openai", model: "local-7b", promptTokens: 1000, completionTokens: 1, costUsd: 0, priced: false })]);
    expect(contextOf(summary, custom)?.windowTokens).toBe(32_768);
  });
});

describe("delegated usage", () => {
  const own = event({ providerId: "openai", model: "gpt-4.1", promptTokens: 1000, completionTokens: 10, costUsd: 0.5, priced: true });
  const child = event({ providerId: "openai", model: "gpt-4.1", promptTokens: 200, completionTokens: 20, costUsd: 0.25, priced: true });

  it("adds delegated requests to the totals and reports them separately", () => {
    const summary = summarizeUsage("s", [own], [child]);
    expect(summary.requests).toBe(2);
    expect(summary.promptTokens).toBe(1200);
    expect(summary.costUsd).toBeCloseTo(0.75, 9);
    expect(summary.delegated).toEqual({ requests: 1, costUsd: 0.25 });
    expect(summary.byModel[0]).toMatchObject({ requests: 2, promptTokens: 1200 });
  });

  it("keeps the context meter on the conversation's own latest request, not a sub-agent's", () => {
    expect(summarizeUsage("s", [own], [child]).last).toEqual({ providerId: "openai", model: "gpt-4.1", promptTokens: 1000 });
    expect(summarizeUsage("s", [], [child]).last).toBeNull();
  });

  it("reports nothing delegated when there are no sub-agent events", () => {
    expect(summarizeUsage("s", [own]).delegated).toEqual({ requests: 0, costUsd: 0 });
  });

  it("ignores replayed and malformed delegated events like it does for the conversation's own", () => {
    const replay = event({ providerId: "openai", model: "gpt-4.1", promptTokens: 5, completionTokens: 5, costUsd: 9, priced: true, replayed: true });
    const summary = summarizeUsage("s", [own], [replay, "not json"]);
    expect(summary.delegated).toEqual({ requests: 0, costUsd: 0 });
    expect(summary.replays).toBe(1);
    expect(summary.invalidEvents).toBe(1);
  });
});
