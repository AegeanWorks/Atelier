import { findModel } from "./catalog.js";
import type { ChatMessage, ProviderConfig } from "./types.js";

/**
 * A reason to refuse before calling the provider: the conversation has images and the catalog says this
 * model cannot read them. A model the catalog does not know, or does not flag, is allowed through.
 */
export function visionProblem(provider: ProviderConfig, model: string, messages: ChatMessage[]): string | null {
  if (!messages.some((message) => (message.images ?? []).length > 0)) return null;
  if (findModel(provider, model)?.vision !== false) return null;
  return `${model} does not support images. Choose a vision model in Settings, or send the message without images.`;
}
