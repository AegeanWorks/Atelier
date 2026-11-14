import type { ModelInfo, Protocol, ProviderConfig } from "./types.js";

const BUILTIN: Record<Protocol, ModelInfo[]> = {
  "openai-chat": [
    { id: "gpt-4.1", name: "GPT-4.1", contextWindow: 1_047_576, maxOutput: 32_768, tools: true, vision: true, pricing: { input: 2, output: 8 } },
    { id: "gpt-4.1-mini", name: "GPT-4.1 mini", contextWindow: 1_047_576, maxOutput: 32_768, tools: true, vision: true, pricing: { input: 0.4, output: 1.6 } },
    { id: "gpt-4o", name: "GPT-4o", contextWindow: 128_000, maxOutput: 16_384, tools: true, vision: true, pricing: { input: 2.5, output: 10 } },
    { id: "o3", name: "o3", contextWindow: 200_000, maxOutput: 100_000, tools: true, reasoning: true, pricing: { input: 2, output: 8 } },
    { id: "o4-mini", name: "o4-mini", contextWindow: 200_000, maxOutput: 100_000, tools: true, reasoning: true, pricing: { input: 1.1, output: 4.4 } },
  ],
  "openai-responses": [
    { id: "gpt-4.1", name: "GPT-4.1", contextWindow: 1_047_576, maxOutput: 32_768, tools: true, vision: true, pricing: { input: 2, output: 8 } },
    { id: "o3", name: "o3", contextWindow: 200_000, maxOutput: 100_000, tools: true, reasoning: true, pricing: { input: 2, output: 8 } },
    { id: "o4-mini", name: "o4-mini", contextWindow: 200_000, maxOutput: 100_000, tools: true, reasoning: true, pricing: { input: 1.1, output: 4.4 } },
  ],
  "anthropic-messages": [
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 200_000, maxOutput: 64_000, tools: true, vision: true, reasoning: true, pricing: { input: 3, output: 15 } },
    { id: "claude-opus-4-1", name: "Claude Opus 4.1", contextWindow: 200_000, maxOutput: 32_000, tools: true, vision: true, reasoning: true, pricing: { input: 15, output: 75 } },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000, maxOutput: 32_000, tools: true, vision: true, pricing: { input: 1, output: 5 } },
  ],
  gemini: [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 1_048_576, maxOutput: 65_536, tools: true, vision: true, reasoning: true, pricing: { input: 1.25, output: 10 } },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", contextWindow: 1_048_576, maxOutput: 65_536, tools: true, vision: true, pricing: { input: 0.3, output: 2.5 } },
  ],
};

export function builtInModels(protocol: Protocol): ModelInfo[] {
  return BUILTIN[protocol].map((model) => ({ ...model }));
}

export function catalogFor(provider: ProviderConfig, live: ModelInfo[] = []): ModelInfo[] {
  const seen = new Set<string>();
  const result: ModelInfo[] = [];
  for (const model of [...(provider.models ?? []), ...live, ...builtInModels(provider.protocol)]) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    result.push(model);
  }
  return result;
}

export function findModel(provider: ProviderConfig, modelId: string): ModelInfo | null {
  return catalogFor(provider).find((model) => model.id === modelId) ?? null;
}
