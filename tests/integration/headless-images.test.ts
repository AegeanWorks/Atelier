import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureHome } from "../../server/config";
import { openDatabase } from "../../server/db";
import { runHeadless } from "../../server/headless";
import type { ChatRequest, ProviderAdapter, StreamEvent } from "../../server/providers/types";
import { visionProblem } from "../../server/providers/vision";
import { loadConfig, saveConfig } from "../../server/state";

const dirs: string[] = [];
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function homeWith(models: Array<{ id: string; vision?: boolean }>, model: string): string {
  const home = tempDir("atelier-himg-home-");
  const paths = ensureHome(home);
  const config = loadConfig(paths);
  saveConfig(paths, {
    ...config,
    providers: [{ id: "fixture", name: "Fixture", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", defaultModel: model, models }],
    defaults: { provider: "fixture", model },
  });
  return home;
}

function capture(seen: ChatRequest[]): ProviderAdapter {
  const events: StreamEvent[] = [{ type: "text-delta", text: "seen" }, { type: "finish", reason: "stop" }];
  return {
    protocol: "openai-chat",
    async listModels() {
      return [];
    },
    async *stream(_context, request) {
      seen.push(request);
      yield* events;
    },
  };
}

function imageFile(name = "shot.png", base64 = PNG): string {
  const path = join(tempDir("atelier-himg-files-"), name);
  writeFileSync(path, Buffer.from(base64, "base64"));
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("vision gating", () => {
  const provider = { id: "p", name: "P", protocol: "openai-chat" as const, baseUrl: "http://x", models: [{ id: "text-only", vision: false }, { id: "sees", vision: true }, { id: "unknown-flag" }] };
  const withImage = [{ role: "user" as const, content: "x", images: [{ mediaType: "image/png", data: PNG }] }];

  it("blocks only a model the catalog says cannot see images", () => {
    expect(visionProblem(provider, "text-only", withImage)).toMatch(/does not support images/i);
    expect(visionProblem(provider, "sees", withImage)).toBeNull();
    expect(visionProblem(provider, "unknown-flag", withImage)).toBeNull();
    expect(visionProblem(provider, "not-listed", withImage)).toBeNull();
  });

  it("ignores conversations without images", () => {
    expect(visionProblem(provider, "text-only", [{ role: "user", content: "hi" }])).toBeNull();
  });
});

describe("headless images", () => {
  it("attaches --image files and sends them to the model", async () => {
    const home = homeWith([{ id: "sees", vision: true }], "sees");
    const seen: ChatRequest[] = [];
    const result = await runHeadless({ homeDir: home, prompt: "what is this?", images: [imageFile()], adapter: capture(seen) });
    expect(result.status).toBe("finished");
    const sent = seen[0]?.messages.find((message) => message.role === "user");
    expect(sent?.content).toBe("what is this?");
    expect(sent?.images).toEqual([{ mediaType: "image/png", data: PNG }]);
  });

  it("blocks before calling the provider when the model has no vision", async () => {
    const home = homeWith([{ id: "text-only", vision: false }], "text-only");
    const seen: ChatRequest[] = [];
    const result = await runHeadless({ homeDir: home, prompt: "what is this?", images: [imageFile()], adapter: capture(seen) });
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/does not support images/i);
    expect(seen).toHaveLength(0);
  });

  it("refuses a missing file, an unsupported extension and a fake image with a clear error", async () => {
    const home = homeWith([{ id: "sees", vision: true }], "sees");
    const seen: ChatRequest[] = [];
    await expect(runHeadless({ homeDir: home, prompt: "x", images: [join(tempDir("atelier-himg-none-"), "nope.png")], adapter: capture(seen) })).rejects.toMatchObject({ code: "HEADLESS_IMAGE" });
    await expect(runHeadless({ homeDir: home, prompt: "x", images: [imageFile("notes.txt")], adapter: capture(seen) })).rejects.toMatchObject({ code: "HEADLESS_IMAGE" });
    await expect(runHeadless({ homeDir: home, prompt: "x", images: [imageFile("fake.png", Buffer.from("hello world").toString("base64"))], adapter: capture(seen) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const db = openDatabase(ensureHome(home));
    try {
      expect((db.db.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
    expect(seen).toHaveLength(0);
  });
});
