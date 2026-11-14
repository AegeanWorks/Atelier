import { AtelierError } from "../config.js";
import { resolveApiKey, type Config, type Secrets } from "../state.js";
import { anthropicMessages } from "./anthropic.js";
import { gemini } from "./gemini.js";
import { openaiChat } from "./openaiChat.js";
import { openaiResponses } from "./openaiResponses.js";
import { catalogFor } from "./catalog.js";
import type { ModelInfo, ProviderAdapter, ProviderConfig, ProviderContext, Protocol } from "./types.js";

const ADAPTERS: Record<Protocol, ProviderAdapter> = {
  "openai-chat": openaiChat,
  "openai-responses": openaiResponses,
  "anthropic-messages": anthropicMessages,
  gemini,
};

export function adapterFor(protocol: Protocol): ProviderAdapter {
  return ADAPTERS[protocol];
}

export function findProvider(config: Config, id: string): ProviderConfig {
  const provider = config.providers.find((entry) => entry.id === id);
  if (provider === undefined) {
    throw new AtelierError("PROVIDER_NOT_FOUND", `Provider '${id}' is not configured.`, "The id is absent from config.json.", "Add it in Settings or POST /api/providers.");
  }
  return provider;
}

export function providerContext(
  provider: ProviderConfig,
  secrets: Secrets,
  env: NodeJS.ProcessEnv = process.env,
): ProviderContext {
  const key = resolveApiKey(provider, secrets, env);
  return { config: provider, apiKey: key.key, baseUrl: provider.baseUrl };
}

export async function listModels(
  provider: ProviderConfig,
  secrets: Secrets,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ModelInfo[]> {
  try {
    const live = await adapterFor(provider.protocol).listModels(providerContext(provider, secrets, env), signal);
    return catalogFor(provider, live);
  } catch {
    return catalogFor(provider);
  }
}

export async function probeModels(
  provider: ProviderConfig,
  secrets: Secrets,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ModelInfo[]> {
  const live = await adapterFor(provider.protocol).listModels(providerContext(provider, secrets, env), signal);
  return catalogFor(provider, live);
}
