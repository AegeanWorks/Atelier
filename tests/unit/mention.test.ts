import { describe, expect, it } from "vitest";
import { activeMention, applyMention, rankFiles } from "../../src/mention";

describe("file mentions", () => {
  it("finds the @token ending at the caret", () => {
    expect(activeMention("look at @src/a", 14)).toEqual({ start: 8, query: "src/a" });
    expect(activeMention("@", 1)).toEqual({ start: 0, query: "" });
    expect(activeMention("mail a@b.com", 12)).toBeNull();
    expect(activeMention("no mention", 10)).toBeNull();
    expect(activeMention("@done and more", 14)).toBeNull();
  });

  it("replaces the token with the chosen path and a trailing space", () => {
    expect(applyMention("look at @sr tail", { start: 8, query: "sr" }, "src/a.ts")).toEqual({ text: "look at @src/a.ts  tail", caret: 18 });
  });

  it("ranks basename-prefix before path-substring and caps results", () => {
    const files = ["docs/app.md", "lib/myapp.ts", "src/App.tsx", "src/apple.ts", "lib/x.ts"];
    expect(rankFiles(files, "app", 8)).toEqual(["docs/app.md", "src/App.tsx", "src/apple.ts", "lib/myapp.ts"]);
    expect(rankFiles(files, "", 2)).toEqual(["docs/app.md", "lib/myapp.ts"]);
    expect(rankFiles(files, "zzz", 8)).toEqual([]);
  });
});
