import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCustomCommands } from "../../server/commands";

const dirs: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "atelier-commands-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("custom commands", () => {
  it("returns nothing when no command directory exists", () => {
    expect(loadCustomCommands(workspace())).toEqual([]);
  });

  it("loads markdown prompts with optional frontmatter description", () => {
    const root = workspace();
    mkdirSync(join(root, ".atelier", "commands"), { recursive: true });
    writeFileSync(join(root, ".atelier", "commands", "review.md"), "---\ndescription: Review the diff\n---\nReview $ARGUMENTS\n");
    writeFileSync(join(root, ".atelier", "commands", "plain.md"), "Explain the repo\n");
    writeFileSync(join(root, ".atelier", "commands", "bad name.md"), "x");
    writeFileSync(join(root, ".atelier", "commands", "notes.txt"), "x");
    const found = loadCustomCommands(root);
    expect(found.map((c) => c.name)).toEqual(["plain", "review"]);
    expect(found[1]).toMatchObject({ description: "Review the diff", kind: "custom", template: "Review $ARGUMENTS\n" });
    expect(found[0]?.description).toBe("Explain the repo");
  });

  it("reads Claude Code command files and prefers the atelier copy on a clash", () => {
    const root = workspace();
    mkdirSync(join(root, ".atelier", "commands"), { recursive: true });
    mkdirSync(join(root, ".claude", "commands"), { recursive: true });
    writeFileSync(join(root, ".atelier", "commands", "ship.md"), "atelier ship");
    writeFileSync(join(root, ".claude", "commands", "ship.md"), "claude ship");
    writeFileSync(join(root, ".claude", "commands", "lint.md"), "claude lint");
    const found = loadCustomCommands(root);
    expect(found.map((c) => [c.name, c.template])).toEqual([["lint", "claude lint"], ["ship", "atelier ship"]]);
  });

  it("skips oversized files and caps the count", () => {
    const root = workspace();
    mkdirSync(join(root, ".atelier", "commands"), { recursive: true });
    writeFileSync(join(root, ".atelier", "commands", "huge.md"), "x".repeat(40_000));
    for (let i = 0; i < 130; i += 1) writeFileSync(join(root, ".atelier", "commands", `c${String(i).padStart(3, "0")}.md`), "p");
    const found = loadCustomCommands(root);
    expect(found.some((c) => c.name === "huge")).toBe(false);
    expect(found.length).toBe(100);
  });
});

describe("workspace file list", () => {
  it("lists files, skips heavy directories and caps the count", async () => {
    const { listWorkspaceFiles } = await import("../../server/workspace");
    const root = workspace();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules", "x"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "a");
    writeFileSync(join(root, "node_modules", "x", "b.js"), "b");
    writeFileSync(join(root, "top.md"), "t");
    expect(listWorkspaceFiles(root, 100)).toEqual(["src/a.ts", "top.md"]);
    expect(listWorkspaceFiles(root, 1).length).toBe(1);
  });
});

describe("skills as commands", () => {
  it("exposes each skill as a /name command that points the agent at its file", async () => {
    const { loadAllCommands } = await import("../../server/commands");
    const root = workspace();
    mkdirSync(join(root, ".atelier", "skills", "release"), { recursive: true });
    writeFileSync(join(root, ".atelier", "skills", "release", "SKILL.md"), "---\ndescription: Cut a release\n---\nsteps");
    const found = loadAllCommands(root);
    const release = found.find((command) => command.name === "release");
    expect(release).toMatchObject({ kind: "custom", description: "Skill: Cut a release" });
    expect(release?.template).toContain(".atelier/skills/release/SKILL.md");
    expect(release?.template).toContain("$ARGUMENTS");
  });

  it("lets an explicit command win over a skill with the same name", async () => {
    const { loadAllCommands } = await import("../../server/commands");
    const root = workspace();
    mkdirSync(join(root, ".atelier", "commands"), { recursive: true });
    mkdirSync(join(root, ".atelier", "skills", "ship"), { recursive: true });
    writeFileSync(join(root, ".atelier", "commands", "ship.md"), "explicit ship");
    writeFileSync(join(root, ".atelier", "skills", "ship", "SKILL.md"), "skill ship");
    const ship = loadAllCommands(root).filter((command) => command.name === "ship");
    expect(ship).toHaveLength(1);
    expect(ship[0]?.template).toBe("explicit ship");
  });
});
