import { describe, expect, it } from "vitest";
import { applyLiveEvent, LIVE_TEXT_LIMIT } from "../../src/live";

const delta = (runId: string, step: number, text: string) => ({ runId, step, text });

describe("applyLiveEvent", () => {
  it("starts a live reply with the first delta and appends the following ones", () => {
    let live = applyLiveEvent(null, "text.delta", delta("r1", 0, "Hel"));
    live = applyLiveEvent(live, "text.delta", delta("r1", 0, "lo"));
    expect(live).toEqual({ runId: "r1", step: 0, text: "Hello" });
  });

  it("shows only the current step, because earlier text is not part of the final answer", () => {
    let live = applyLiveEvent(null, "text.delta", delta("r1", 0, "let me look"));
    live = applyLiveEvent(live, "text.delta", delta("r1", 1, "The answer"));
    expect(live).toEqual({ runId: "r1", step: 1, text: "The answer" });
  });

  it("starts over when a different run begins streaming", () => {
    const live = applyLiveEvent({ runId: "old", step: 3, text: "stale" }, "text.delta", delta("new", 0, "fresh"));
    expect(live).toEqual({ runId: "new", step: 0, text: "fresh" });
  });

  it("clears the live reply when a run starts, ends or blocks", () => {
    const live = { runId: "r1", step: 0, text: "partial" };
    for (const type of ["run.finished", "run.blocked", "run.started"]) {
      expect(applyLiveEvent(live, type, { runId: "r1" }), type).toBeNull();
    }
  });

  it("keeps the live reply for events that say nothing about it", () => {
    const live = { runId: "r1", step: 0, text: "partial" };
    expect(applyLiveEvent(live, "tool.result", { runId: "r1" })).toBe(live);
    expect(applyLiveEvent(live, "llm.usage", {})).toBe(live);
  });

  it("ignores a malformed delta and bounds what it keeps to the newest text", () => {
    const live = { runId: "r1", step: 0, text: "ok" };
    expect(applyLiveEvent(live, "text.delta", { runId: 5, text: 7 })).toBe(live);
    expect(applyLiveEvent(live, "text.delta", null)).toBe(live);
    const big = applyLiveEvent(null, "text.delta", delta("r1", 0, "a".repeat(LIVE_TEXT_LIMIT) + "END"));
    expect(big?.text.length).toBe(LIVE_TEXT_LIMIT);
    expect(big?.text.endsWith("END")).toBe(true);
  });
});
