import { describe, expect, it } from "vitest";
import { alwaysAllowRule } from "../../src/rules";

const call = (action: string, resource: string) => ({ action, resource });

describe("alwaysAllowRule", () => {
  it("builds an exact-match allow rule for a plain command or a path", () => {
    expect(alwaysAllowRule(call("exec", "npm test"), [])).toMatchObject({ action: "exec", match: "npm test", decision: "allow" });
    expect(alwaysAllowRule(call("edit", "docs/a.md"), [])).toMatchObject({ action: "edit", match: "docs/a.md", decision: "allow" });
    expect(alwaysAllowRule(call("exec", "npm test"), [])?.id).toMatch(/^always-[a-z0-9]+$/);
  });

  it("offers nothing for commands the server would still ask about", () => {
    for (const command of ["npm test && rm x", "a; b", "a | b", "a > out", "a `b`", "a $(b)", "a\nb", "a & b"]) {
      expect(alwaysAllowRule(call("exec", command), [])).toBeNull();
    }
  });

  it("offers nothing for wildcards, climbing paths, empty text or other actions", () => {
    expect(alwaysAllowRule(call("exec", "rm *.log"), [])).toBeNull();
    expect(alwaysAllowRule(call("edit", "src/../x"), [])).toBeNull();
    expect(alwaysAllowRule(call("edit", ""), [])).toBeNull();
    expect(alwaysAllowRule(call("read", "a"), [])).toBeNull();
    expect(alwaysAllowRule(call("exec", "x".repeat(501)), [])).toBeNull();
  });

  it("returns null when the same rule already exists, and picks a fresh id otherwise", () => {
    const existing = [{ id: "always-x", action: "exec" as const, match: "npm test", decision: "allow" as const }];
    expect(alwaysAllowRule(call("exec", "npm test"), existing)).toBeNull();
    const second = alwaysAllowRule(call("exec", "npm run build"), existing);
    expect(second?.id).not.toBe("always-x");
  });

  it("offers nothing for a protected configuration path, which no rule can auto-approve", () => {
    for (const path of [".claude/settings.json", ".atelier/commands/x.md", "docs/AGENTS.md", "CLAUDE.md", ".agents/skills/s/SKILL.md"]) {
      expect(alwaysAllowRule(call("edit", path), []), path).toBeNull();
    }
    expect(alwaysAllowRule(call("edit", "docs/readme.md"), [])).not.toBeNull();
  });

  it("offers nothing when a permission rule is the reason for asking, since an allow cannot override an ask", () => {
    expect(alwaysAllowRule({ action: "exec", resource: "git push origin main", reason: "permission rule no-push asks before bash runs" }, [])).toBeNull();
    expect(alwaysAllowRule({ action: "exec", resource: "git status", reason: "bash requires approval in build mode" }, [])).not.toBeNull();
  });
});
