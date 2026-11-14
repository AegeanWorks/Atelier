import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "../../src/Markdown";

describe("markdown parsing", () => {
  it("splits paragraphs and headings", () => {
    expect(parseMarkdown("# Title\n\nBody line one\nBody line two")).toEqual([
      { kind: "heading", level: 1, tokens: [{ kind: "text", text: "Title" }] },
      { kind: "paragraph", tokens: [{ kind: "text", text: "Body line one\nBody line two" }] },
    ]);
  });

  it("keeps fenced code verbatim with its language", () => {
    expect(parseMarkdown("Before\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\nAfter")).toEqual([
      { kind: "paragraph", tokens: [{ kind: "text", text: "Before" }] },
      { kind: "code", language: "ts", text: "const a = 1;\n\nconst b = 2;" },
      { kind: "paragraph", tokens: [{ kind: "text", text: "After" }] },
    ]);
  });

  it("groups unordered and ordered list items separately", () => {
    expect(parseMarkdown("- one\n- two\n\n1. first\n2. second")).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [[{ kind: "text", text: "one" }], [{ kind: "text", text: "two" }]],
      },
      {
        kind: "list",
        ordered: true,
        items: [[{ kind: "text", text: "first" }], [{ kind: "text", text: "second" }]],
      },
    ]);
  });

  it("recognizes quotes and horizontal rules", () => {
    expect(parseMarkdown("> quoted\n\n---")).toEqual([
      { kind: "quote", tokens: [{ kind: "text", text: "quoted" }] },
      { kind: "rule" },
    ]);
  });

  it("parses inline code, emphasis, strong text and links", () => {
    expect(parseInline("run `npm test` and **now** with *care* see [docs](https://example.com)")).toEqual([
      { kind: "text", text: "run " },
      { kind: "code", text: "npm test" },
      { kind: "text", text: " and " },
      { kind: "strong", text: "now" },
      { kind: "text", text: " with " },
      { kind: "em", text: "care" },
      { kind: "text", text: " see " },
      { kind: "link", text: "docs", href: "https://example.com" },
    ]);
  });

  it("refuses a javascript: link and keeps it as text", () => {
    expect(parseInline("[bad](javascript:alert(1))")).toEqual([
      { kind: "text", text: "[bad](javascript:alert(1))" },
    ]);
  });

  it("leaves an unterminated marker as literal text", () => {
    expect(parseInline("a **b")).toEqual([{ kind: "text", text: "a **b" }]);
    expect(parseInline("a `b")).toEqual([{ kind: "text", text: "a `b" }]);
  });
});
