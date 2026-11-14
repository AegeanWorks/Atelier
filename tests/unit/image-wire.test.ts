import { describe, expect, it } from "vitest";
import { anthropicContent, geminiParts, openaiChatContent, openaiResponsesContent } from "../../server/providers/images";
import type { ChatMessage } from "../../server/providers/types";

const withImage: ChatMessage = { role: "user", content: "what is this?", images: [{ mediaType: "image/png", data: "QUJD" }] };
const plain: ChatMessage = { role: "user", content: "hello" };

describe("image wire formats", () => {
  it("leaves a plain message as a string for every protocol", () => {
    expect(openaiChatContent(plain)).toBe("hello");
    expect(openaiResponsesContent(plain)).toBe("hello");
    expect(anthropicContent(plain)).toBe("hello");
    expect(geminiParts(plain)).toEqual([{ text: "hello" }]);
  });

  it("maps an image for OpenAI chat as an image_url data URL after the text", () => {
    expect(openaiChatContent(withImage)).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
    ]);
  });

  it("maps an image for OpenAI responses as input_image", () => {
    expect(openaiResponsesContent(withImage)).toEqual([
      { type: "input_text", text: "what is this?" },
      { type: "input_image", image_url: "data:image/png;base64,QUJD" },
    ]);
  });

  it("maps an image for Anthropic as a base64 source block placed before the text", () => {
    expect(anthropicContent(withImage)).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
      { type: "text", text: "what is this?" },
    ]);
  });

  it("maps an image for Gemini as inlineData", () => {
    expect(geminiParts(withImage)).toEqual([{ text: "what is this?" }, { inlineData: { mimeType: "image/png", data: "QUJD" } }]);
  });

  it("omits an empty text part when only images are sent", () => {
    const only: ChatMessage = { role: "user", content: "", images: [{ mediaType: "image/jpeg", data: "QQ==" }] };
    expect(openaiChatContent(only)).toEqual([{ type: "image_url", image_url: { url: "data:image/jpeg;base64,QQ==" } }]);
    expect(geminiParts(only)).toEqual([{ inlineData: { mimeType: "image/jpeg", data: "QQ==" } }]);
  });
});
