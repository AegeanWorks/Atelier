import { describe, expect, it } from "vitest";
import { BUILTIN_COMMANDS, INIT_PROMPT, expandTemplate, matchCommands, parseSlash, type SlashCommand } from "../../src/slash";

const custom: SlashCommand[] = [{ name: "review", description: "Review the diff", kind: "custom", template: "Review: $ARGUMENTS" }];

describe("slash commands", () => {
  it("parses a command and its arguments", () => {
    expect(parseSlash("/plan")).toEqual({ name: "plan", args: "" });
    expect(parseSlash("  /review src/a.ts now ")).toEqual({ name: "review", args: "src/a.ts now" });
  });

  it("ignores text that is not a command", () => {
    expect(parseSlash("hello /plan")).toBeNull();
    expect(parseSlash("/")).toBeNull();
    expect(parseSlash("/usr/bin/env")).toBeNull();
    expect(parseSlash("//comment")).toBeNull();
  });

  it("matches by prefix only while the name is being typed", () => {
    const all = [...BUILTIN_COMMANDS, ...custom];
    expect(matchCommands(all, "/pl").map((c) => c.name)).toEqual(["plan"]);
    expect(matchCommands(all, "/").length).toBe(all.length);
    expect(matchCommands(all, "/plan now")).toEqual([]);
    expect(matchCommands(all, "plan")).toEqual([]);
  });

  it("expands arguments into a template", () => {
    expect(expandTemplate("Review: $ARGUMENTS", "a.ts")).toBe("Review: a.ts");
    expect(expandTemplate("Explain the repo", "")).toBe("Explain the repo");
    expect(expandTemplate("Explain the repo", "briefly")).toBe("Explain the repo\n\nbriefly");
    expect(expandTemplate("A $ARGUMENTS B $ARGUMENTS", "x")).toBe("A x B x");
  });

  it("offers /init and /instructions for project instructions", () => {
    const names = BUILTIN_COMMANDS.map((command) => command.name);
    expect(names).toContain("init");
    expect(names).toContain("instructions");
  });

  it("asks for an AGENTS.md grounded in the repository and sized for the injection cap", () => {
    expect(INIT_PROMPT).toMatch(/AGENTS\.md/);
    expect(INIT_PROMPT).toMatch(/test|build|lint/i);
    expect(INIT_PROMPT).toMatch(/do not invent|only .* you (?:read|verified|observed)/i);
    expect(INIT_PROMPT).toMatch(/8,?000/);
    expect(INIT_PROMPT).toMatch(/update|improve|existing/i);
  });
});
