import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../server/prompt";
import { createSkill, loadSkills } from "../../server/skills";

const dirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "atelier-agents-skills-"));
  dirs.push(dir);
  return dir;
}
function skill(root: string, base: string, name: string, description: string): void {
  mkdirSync(join(root, base, name), { recursive: true });
  writeFileSync(join(root, base, name, "SKILL.md"), `---\ndescription: ${description}\n---\nbody\n`);
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("skills in .agents/skills", () => {
  it("are found next to the other skill folders, sorted by name", () => {
    const root = workspace();
    skill(root, ".agents/skills", "deploy", "from agents");
    skill(root, ".claude/skills", "audit", "from claude");
    skill(root, ".atelier/skills", "release", "from atelier");
    expect(loadSkills(root).map((entry) => [entry.name, entry.path])).toEqual([
      ["audit", ".claude/skills/audit/SKILL.md"],
      ["deploy", ".agents/skills/deploy/SKILL.md"],
      ["release", ".atelier/skills/release/SKILL.md"],
    ]);
  });

  it("rank .atelier first, then .agents, then .claude when a name is defined in more than one", () => {
    const root = workspace();
    skill(root, ".claude/skills", "ship", "claude copy");
    skill(root, ".agents/skills", "ship", "agents copy");
    expect(loadSkills(root)[0]).toMatchObject({ description: "agents copy", path: ".agents/skills/ship/SKILL.md" });
    skill(root, ".atelier/skills", "ship", "atelier copy");
    expect(loadSkills(root)).toHaveLength(1);
    expect(loadSkills(root)[0]).toMatchObject({ description: "atelier copy", path: ".atelier/skills/ship/SKILL.md" });
  });

  it("count toward the same cap as the others", () => {
    const root = workspace();
    for (let i = 0; i < 20; i += 1) skill(root, ".agents/skills", `a${String(i).padStart(2, "0")}`, "x");
    for (let i = 0; i < 20; i += 1) skill(root, ".claude/skills", `c${String(i).padStart(2, "0")}`, "x");
    expect(loadSkills(root)).toHaveLength(30);
  });

  it("are listed in the system prompt with their own path", () => {
    const root = workspace();
    skill(root, ".agents/skills", "deploy", "Ship it");
    expect(buildSystemPrompt(root)).toContain("deploy: Ship it (.agents/skills/deploy/SKILL.md)");
  });

  it("block scaffolding a skill of the same name, so /skill-new cannot shadow one", () => {
    const root = workspace();
    skill(root, ".agents/skills", "deploy", "existing");
    expect(() => createSkill(root, "deploy", "mine")).toThrowError(/already exists/i);
  });
});
