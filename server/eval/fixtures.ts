import { readFileSync } from "node:fs";
import { AtelierError } from "../config.js";
import type { ChatRequest, ModelInfo, ProviderAdapter, ProviderContext, StreamEvent } from "../providers/types.js";
import type { FixtureSpec } from "./types.js";

export class FixtureProviderAdapter implements ProviderAdapter {
  readonly protocol = "openai-chat" as const;
  readonly requests: ChatRequest[] = [];
  readonly usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  private index = 0;

  constructor(private readonly spec: FixtureSpec) {}

  async listModels(_context: ProviderContext): Promise<ModelInfo[]> {
    return this.spec.models.map((model) => ({ id: model.id, name: model.name ?? model.id, tools: true }));
  }

  async *stream(_context: ProviderContext, request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    const response = this.spec.responses[this.index];
    this.index += 1;
    if (response === undefined) {
      throw new AtelierError("FIXTURE_EXHAUSTED", "Fixture has no response for this request.", `Request #${this.index} of ${this.spec.responses.length}.`, "Add another response to the fixture.");
    }
    if (response.error !== undefined) {
      throw new AtelierError(response.error.code ?? "FIXTURE_ERROR", response.error.message, "The fixture injected this failure.", "Handle the failure or change the fixture.");
    }
    for (const event of response.events) {
      if (event.type === "usage") {
        this.usage.promptTokens += event.promptTokens;
        this.usage.completionTokens += event.completionTokens;
        this.usage.cachedTokens += event.cachedTokens ?? 0;
      }
      yield event;
    }
  }
}

export function loadFixture(path: string): FixtureSpec {
  return JSON.parse(readFileSync(path, "utf8")) as FixtureSpec;
}
