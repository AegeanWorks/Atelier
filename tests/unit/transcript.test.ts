// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { conversationMarkdown, downloadTranscript, transcriptFilename } from "../../src/transcript";
import type { Message } from "../../src/types";

function message(id: string, role: "user" | "assistant", text: string, seq: number): Message {
  return { id, session_id: "ses_1", seq, role, text, client_id: null, created: 1 } as Message;
}

describe("conversation transcript", () => {
  it("renders a title, attributed messages and an export stamp", () => {
    const text = conversationMarkdown(
      "Fix the parser",
      [message("m1", "user", "  why does it fail?  ", 1), message("m2", "assistant", "Because of the fence.", 2)],
      0,
    );
    expect(text).toContain("# Fix the parser");
    expect(text).toContain("## You\n\nwhy does it fail?");
    expect(text).toContain("## Atelier\n\nBecause of the fence.");
    expect(text.endsWith("_Exported 1970-01-01T00:00:00.000Z._\n")).toBe(true);
  });

  it("exports attached files by name instead of dumping their contents", () => {
    const body = "fix @a.ts\n\n<attached_file path=\"a.ts\">\nSECRET BODY\n</attached_file>";
    const text = conversationMarkdown("T", [message("m1", "user", body, 1)], 0);
    expect(text).toContain("fix @a.ts");
    expect(text).toContain("Attached: `a.ts`");
    expect(text).not.toContain("SECRET BODY");
  });

  it("notes an empty conversation", () => {
    expect(conversationMarkdown("Empty", [], 0)).toContain("_No messages in this conversation._");
  });

  it("builds a filesystem-safe filename", () => {
    expect(transcriptFilename("Fix: the parser / tests?")).toBe("Fix-the-parser-tests.md");
    expect(transcriptFilename("Café — résumé")).toBe("Cafe-resume.md");
    expect(transcriptFilename("   ")).toBe("conversation.md");
    expect(transcriptFilename("a".repeat(120))).toHaveLength(63);
  });

  it("downloads through a blob URL and revokes it", async () => {
    let captured: Blob | null = null;
    const createObjectURL = vi.fn((blob: Blob) => {
      captured = blob;
      return "blob:transcript";
    });
    const revokeObjectURL = vi.fn();
    const click = vi.fn();
    expect(downloadTranscript("Title", [message("m1", "user", "hello", 1)], {
      createObjectURL,
      revokeObjectURL,
      click,
    })).toBe(true);
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:transcript");
    const anchor = click.mock.calls[0]?.[0] as HTMLAnchorElement;
    expect(anchor.download).toBe("Title.md");
    expect(anchor.href).toContain("blob:transcript");
    expect(captured).not.toBeNull();
    expect((captured as unknown as Blob).type).toContain("text/markdown");
    expect(await (captured as unknown as Blob).text()).toContain("## You");
  });

  it("returns false when object URL creation throws", () => {
    const createObjectURL = vi.fn(() => {
      throw new Error("blocked");
    });
    expect(downloadTranscript("Title", [], {
      createObjectURL,
      revokeObjectURL: vi.fn(),
      click: vi.fn(),
    })).toBe(false);
  });
});
