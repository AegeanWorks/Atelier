import { describe, expect, it } from "vitest";
import { publishLive, subscribeLive, type LiveEvent } from "../../server/liveStream";

const delta = (text: string, runId = "run_1"): LiveEvent => ({ type: "text.delta", runId, step: 0, text });

describe("live stream", () => {
  it("delivers events to a subscriber of that session, in order", () => {
    const seen: string[] = [];
    const off = subscribeLive("ses_a", (event) => seen.push(event.text));
    publishLive("ses_a", delta("Hel"));
    publishLive("ses_a", delta("lo"));
    off();
    expect(seen).toEqual(["Hel", "lo"]);
  });

  it("keeps sessions apart", () => {
    const a: string[] = [];
    const b: string[] = [];
    const offA = subscribeLive("ses_a2", (event) => a.push(event.text));
    const offB = subscribeLive("ses_b2", (event) => b.push(event.text));
    publishLive("ses_a2", delta("for a"));
    publishLive("ses_b2", delta("for b"));
    offA();
    offB();
    expect(a).toEqual(["for a"]);
    expect(b).toEqual(["for b"]);
  });

  it("stops delivering after unsubscribing, and unsubscribing twice is harmless", () => {
    const seen: string[] = [];
    const off = subscribeLive("ses_c", (event) => seen.push(event.text));
    off();
    off();
    publishLive("ses_c", delta("late"));
    expect(seen).toEqual([]);
  });

  it("lets every subscriber hear an event, and one that throws cannot silence the others or the publisher", () => {
    const seen: string[] = [];
    const offBad = subscribeLive("ses_d", () => {
      throw new Error("subscriber failed");
    });
    const offGood = subscribeLive("ses_d", (event) => seen.push(event.text));
    expect(() => publishLive("ses_d", delta("still delivered"))).not.toThrow();
    offBad();
    offGood();
    expect(seen).toEqual(["still delivered"]);
  });

  it("does nothing, and keeps no memory, for a session nobody listens to", () => {
    expect(() => publishLive("ses_nobody", delta("x"))).not.toThrow();
  });
});
