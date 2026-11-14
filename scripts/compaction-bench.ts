import { compactMessages, estimateTokens } from "../server/compaction";
import type { ChatMessage } from "../server/providers/types";

const messages: ChatMessage[] = Array.from({ length: 200 }, (_value, index) => ({
  role: index % 3 === 2 ? "tool" : index % 2 === 0 ? "user" : "assistant",
  content: `turn ${index}: ${"x".repeat(4_000)}`,
}));
const beforeTokens = messages.reduce((total, message) => total + estimateTokens(message.content), 0);
const samples: number[] = [];
let result = compactMessages(messages, 12_000);
for (let run = 0; run < 25; run += 1) {
  const started = performance.now();
  result = compactMessages(messages, 12_000);
  samples.push(performance.now() - started);
}
samples.sort((left, right) => left - right);
console.log(JSON.stringify({
  messages: messages.length,
  budgetTokens: 12_000,
  beforeTokens,
  afterTokens: result.stats.afterTokens,
  droppedMessages: result.stats.droppedMessages,
  reductionPct: Number((((beforeTokens - result.stats.afterTokens) / beforeTokens) * 100).toFixed(1)),
  p50Ms: Number(samples[Math.floor(samples.length / 2)]?.toFixed(3)),
  p95Ms: Number(samples[Math.floor(samples.length * 0.95)]?.toFixed(3)),
}, null, 2));
