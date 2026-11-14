import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../server/app";
import { createAuth } from "../../server/auth";
import { ensureHome } from "../../server/config";
import { openDatabase, recoverOnBoot } from "../../server/db";
import { buildSystemPrompt } from "../../server/prompt";
import { createSkill, loadSkills } from "../../server/skills";

const dirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "atelier-skills-"));
  dirs.push(dir);
  return dir;
}
function skill(root: string, base: string, name: string, body: string): void {
  mkdirSync(join(root, base, name), { recursive: true });
  writeFileSync(join(root, base, name, "SKILL.md"), body);
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("loadSkills", () => {
  it("returns nothing when there are no skill folders", () => {
    expect(loadSkills(workspace())).toEqual([]);
  });

  it("reads name, description and a workspace-relative path from SKILL.md frontmatter", () => {
    const root = workspace();
    skill(root, ".atelier/skills", "release", "---\nname: release\ndescription: Cut a release with the checklist\n---\n# Release\nsteps\n");
    const [found] = loadSkills(root);
    expect(found).toEqual({ name: "release", description: "Cut a release with the checklist", path: ".atelier/skills/release/SKILL.md" });
  });

  it("falls back to the folder name and the first line when frontmatter is missing", () => {
    const root = workspace();
    skill(root, ".atelier/skills", "triage", "Triage a bug report step by step\n\nmore detail\n");
    expect(loadSkills(root)[0]).toMatchObject({ name: "triage", description: "Triage a bug report step by step" });
  });

  it("reads Claude Code skills too and prefers the atelier copy on a clash, sorted by name", () => {
    const root = workspace();
    skill(root, ".claude/skills", "zeta", "---\ndescription: claude zeta\n---\n");
    skill(root, ".claude/skills", "ship", "---\ndescription: claude ship\n---\n");
    skill(root, ".atelier/skills", "ship", "---\ndescription: atelier ship\n---\n");
    const found = loadSkills(root);
    expect(found.map((entry) => entry.name)).toEqual(["ship", "zeta"]);
    expect(found[0]?.description).toBe("atelier ship");
    expect(found[0]?.path).toBe(".atelier/skills/ship/SKILL.md");
  });

  it("skips bad folder names, folders without SKILL.md and oversized files, and caps the count and description", () => {
    const root = workspace();
    skill(root, ".atelier/skills", "bad name", "x");
    mkdirSync(join(root, ".atelier/skills/empty"), { recursive: true });
    skill(root, ".atelier/skills", "huge", "x".repeat(60_000));
    skill(root, ".atelier/skills", "long", `---\ndescription: ${"d".repeat(500)}\n---\n`);
    for (let i = 0; i < 40; i += 1) skill(root, ".atelier/skills", `s${String(i).padStart(2, "0")}`, "p");
    const found = loadSkills(root);
    expect(found.some((entry) => ["bad name", "empty", "huge"].includes(entry.name))).toBe(false);
    expect(found.find((entry) => entry.name === "long")?.description.length).toBeLessThanOrEqual(200);
    expect(found.length).toBe(30);
  });
});

describe("skills in the system prompt", () => {
  it("lists each skill with its description and path, and tells the agent to read it when relevant", () => {
    const root = workspace();
    skill(root, ".atelier/skills", "release", "---\ndescription: Cut a release\n---\n");
    const prompt = buildSystemPrompt(root);
    expect(prompt).toContain("Available skills");
    expect(prompt).toContain("release: Cut a release (.atelier/skills/release/SKILL.md)");
    expect(prompt).toMatch(/read_file/);
  });

  it("adds nothing when the workspace has no skills", () => {
    expect(buildSystemPrompt(workspace())).not.toContain("Available skills");
  });
});

describe("skills over HTTP", () => {
  it("serves the discovered skills", async () => {
    const root = workspace();
    skill(root, ".atelier/skills", "release", "---\ndescription: Cut a release\n---\n");
    const home = workspace();
    const paths = ensureHome(home);
    const db = openDatabase(paths);
    try {
      const auth = createAuth(paths);
      const app = createApp({ paths, db, auth, recovery: recoverOnBoot(db), version: "0.1.0", startedAt: Date.now(), workspace: root });
      const response = await app.request("/api/skills", { headers: { authorization: `Bearer ${auth.token}` } });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { skills: Array<{ name: string }> }).skills.map((entry) => entry.name)).toEqual(["release"]);
    } finally {
      db.close();
    }
  });
});

describe("createSkill", () => {
  it("writes a SKILL.md template that loadSkills then finds", () => {
    const root = workspace();
    const made = createSkill(root, "release", "Cut a release with the checklist");
    expect(made).toEqual({ name: "release", description: "Cut a release with the checklist", path: ".atelier/skills/release/SKILL.md" });
    const text = readFileSync(join(root, ".atelier", "skills", "release", "SKILL.md"), "utf8");
    expect(text.startsWith("---")).toBe(true);
    expect(text).toContain("name: release");
    expect(text).toContain("description: Cut a release with the checklist");
    expect(text).toMatch(/## When to use/);
    expect(text).toMatch(/## Steps/);
    expect(loadSkills(root)).toEqual([made]);
  });

  it("uses a placeholder description when none is given", () => {
    expect(createSkill(workspace(), "triage").description).toMatch(/when to use/i);
  });

  it("never overwrites an existing skill", () => {
    const root = workspace();
    skill(root, ".atelier/skills", "release", "---\ndescription: mine\n---\nkeep me");
    expect(() => createSkill(root, "release", "x")).toThrowError(/already exists/i);
    expect(readFileSync(join(root, ".atelier", "skills", "release", "SKILL.md"), "utf8")).toContain("keep me");
  });

  it("rejects names that are not plain folder names and descriptions that would break the frontmatter", () => {
    const root = workspace();
    for (const bad of ["", "a/b", "../x", "a b", ".hidden", "x".repeat(60)]) expect(() => createSkill(root, bad, "d")).toThrowError(/name/i);
    expect(() => createSkill(root, "ok", "line one\nline two")).toThrowError(/one line/i);
    expect(existsSync(join(root, ".atelier", "skills", "ok"))).toBe(false);
  });
});

describe("creating a skill over HTTP", () => {
  it("creates one, refuses a duplicate with 409 and a bad name with 400", async () => {
    const root = workspace();
    const home = workspace();
    const paths = ensureHome(home);
    const db = openDatabase(paths);
    try {
      const auth = createAuth(paths);
      const app = createApp({ paths, db, auth, recovery: recoverOnBoot(db), version: "0.1.0", startedAt: Date.now(), workspace: root });
      const headers = { authorization: `Bearer ${auth.token}`, "content-type": "application/json" };
      const first = await app.request("/api/skills", { method: "POST", headers, body: JSON.stringify({ name: "release", description: "Cut a release" }) });
      expect(first.status).toBe(201);
      expect(((await first.json()) as { skill: { path: string } }).skill.path).toBe(".atelier/skills/release/SKILL.md");
      expect((await app.request("/api/skills", { method: "POST", headers, body: JSON.stringify({ name: "release" }) })).status).toBe(409);
      expect((await app.request("/api/skills", { method: "POST", headers, body: JSON.stringify({ name: "../evil" }) })).status).toBe(400);
    } finally {
      db.close();
    }
  });
});

