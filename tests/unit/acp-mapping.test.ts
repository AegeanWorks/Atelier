import { describe, expect, it } from "vitest";
import { blockMessage, convertPrompt, stopReasonFor, toolKind, toolTitle } from "../../server/acp/mapping";
import { RpcError } from "../../server/acp/rpc";

const ws = process.platform === "win32" ? "C:\\work\\repo" : "/work/repo";
const fileUri = (path: string): string => (process.platform === "win32" ? `file:///C:/work/repo/${path}` : `file:///work/repo/${path}`);

describe("convertPrompt", () => {
  it("joins text blocks in order", () => {
    expect(convertPrompt([{ type: "text", text: "fix the bug" }, { type: "text", text: "in the parser" }], ws)).toEqual({ text: "fix the bug\nin the parser", images: [] });
  });

  it("turns a resource link inside the workspace into an @ mention, so its contents are attached", () => {
    const out = convertPrompt([{ type: "text", text: "explain" }, { type: "resource_link", uri: fileUri("src/a.ts"), name: "a.ts" }], ws);
    expect(out.text).toBe("explain\n@src/a.ts");
  });

  it("keeps a link outside the workspace, or not a file, as plain text that attaches nothing", () => {
    const out = convertPrompt([{ type: "text", text: "see" }, { type: "resource_link", uri: "https://example.com/doc", name: "the doc" }, { type: "resource_link", uri: "file:///etc/passwd", name: "passwd" }], ws);
    expect(out.text).not.toContain("@");
    expect(out.text).toContain("[the doc](https://example.com/doc)");
    expect(out.text).toContain("[passwd]");
  });

  it("collects image blocks for the image store and adds a default sentence when there is no text", () => {
    const out = convertPrompt([{ type: "image", mimeType: "image/png", data: "QUJD" }], ws);
    expect(out.images).toEqual([{ mediaType: "image/png", data: "QUJD" }]);
    expect(out.text).toBe("See the attached image.");
  });

  it("refuses what the agent did not advertise or cannot read, with invalid params", () => {
    for (const bad of [[], "nope", [{ type: "audio", mimeType: "audio/wav", data: "x" }], [{ type: "resource", resource: { uri: "file:///a", text: "t" } }], [{ type: "image", mimeType: "image/svg+xml", data: "x" }], [{ type: "text" }], [{ type: "text", text: "" }, { type: "mystery" }], [{ type: "text", text: "x".repeat(100_001) }]]) {
      let error: unknown;
      try {
        convertPrompt(bad, ws);
      } catch (caught) {
        error = caught;
      }
      expect(error, JSON.stringify(bad).slice(0, 60)).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe(-32602);
    }
  });
});

describe("toolKind and toolTitle", () => {
  it("classify atelier's tools into ACP's kinds", () => {
    expect(toolKind("read_file")).toBe("read");
    expect(toolKind("git_diff")).toBe("read");
    expect(toolKind("ripgrep")).toBe("search");
    expect(toolKind("glob")).toBe("search");
    expect(toolKind("write_file")).toBe("edit");
    expect(toolKind("multi_edit")).toBe("edit");
    expect(toolKind("bash")).toBe("execute");
    expect(toolKind("delegate")).toBe("think");
    expect(toolKind("mcp__echo__echo")).toBe("other");
    expect(toolKind("something_new")).toBe("other");
  });

  it("title a call with its tool and a bounded detail", () => {
    expect(toolTitle("bash", "npm test")).toBe("bash: npm test");
    expect(toolTitle("list_dir", "")).toBe("list_dir");
    expect(toolTitle("bash", "x".repeat(300)).length).toBeLessThanOrEqual(130);
  });
});

describe("stopReasonFor", () => {
  it("maps the run reasons that have an ACP stop reason and leaves real failures to be errors", () => {
    expect(stopReasonFor("stopped")).toBe("cancelled");
    expect(stopReasonFor("step cap reached")).toBe("max_turn_requests");
    expect(stopReasonFor("provider_missing")).toBeNull();
    expect(stopReasonFor("doom loop: identical tool call repeated")).toBeNull();
  });
});

describe("blockMessage", () => {
  it("explains the configuration problems an editor user can actually fix", () => {
    expect(blockMessage("no_provider")).toMatch(/no provider is configured.*settings/i);
    expect(blockMessage("provider_missing")).toMatch(/no longer exists/i);
    expect(blockMessage("no_model")).toMatch(/no default model/i);
    expect(blockMessage("lease_busy")).toMatch(/already running/i);
  });

  it("passes any other reason through unchanged so nothing is hidden", () => {
    expect(blockMessage("doom loop: identical tool call repeated")).toBe("doom loop: identical tool call repeated");
    expect(blockMessage("model is unavailable")).toBe("model is unavailable");
  });
});
