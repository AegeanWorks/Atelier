import type { ChatMessage } from "./types.js";

type Part = Record<string, unknown>;

function hasImages(message: ChatMessage): boolean {
  return (message.images ?? []).length > 0;
}

function dataUrl(mediaType: string, data: string): string {
  return `data:${mediaType};base64,${data}`;
}

export function openaiChatContent(message: ChatMessage): string | Part[] {
  if (!hasImages(message)) return message.content;
  const parts: Part[] = message.content.length > 0 ? [{ type: "text", text: message.content }] : [];
  for (const image of message.images ?? []) parts.push({ type: "image_url", image_url: { url: dataUrl(image.mediaType, image.data) } });
  return parts;
}

export function openaiResponsesContent(message: ChatMessage): string | Part[] {
  if (!hasImages(message)) return message.content;
  const parts: Part[] = message.content.length > 0 ? [{ type: "input_text", text: message.content }] : [];
  for (const image of message.images ?? []) parts.push({ type: "input_image", image_url: dataUrl(image.mediaType, image.data) });
  return parts;
}

export function anthropicContent(message: ChatMessage): string | Part[] {
  if (!hasImages(message)) return message.content;
  const parts: Part[] = (message.images ?? []).map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } }));
  if (message.content.length > 0) parts.push({ type: "text", text: message.content });
  return parts;
}

export function geminiParts(message: ChatMessage): Part[] {
  const parts: Part[] = message.content.length > 0 || !hasImages(message) ? [{ text: message.content }] : [];
  for (const image of message.images ?? []) parts.push({ inlineData: { mimeType: image.mediaType, data: image.data } });
  return parts;
}
