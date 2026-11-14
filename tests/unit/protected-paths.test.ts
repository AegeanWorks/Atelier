import { describe, expect, it } from "vitest";
import { evaluateRules, isProtectedConfigPath, type Rule } from "../../server/rules";

function rule(id: string, action: Rule["action"], match: string, decision: Rule["decision"]): Rule {
  return { id, action, match, decision };
}

describe("isProtectedConfigPath", () => {
  it("protects the agent's own configuration wherever it sits, however it is spelled", () => {
    for (const path of [".atelier/commands/x.md", ".atelier/skills/s/SKILL.md", ".claude/settings.json", ".claude/commands/x.md", ".agents/skills/x/SKILL.md", "AGENTS.md", "CLAUDE.md", "docs/AGENTS.md", "pkg/sub/CLAUDE.md", "./AGENTS.md", ".claude\\settings.json", "src/../.atelier/x", "agents.md", ".CLAUDE/x"]) {
      expect(isProtectedConfigPath(path), path).toBe(true);
    }
  });

  it("leaves ordinary files alone, including ones that merely look similar", () => {
    for (const path of ["src/a.ts", "README.md", "docs/agents-guide.md", "claude.md.bak", "atelier/x", ".claudeignore", "my.agents/x", "AGENTS.md.orig"]) {
      expect(isProtectedConfigPath(path), path).toBe(false);
    }
  });
});

describe("protected paths and permission rules", () => {
  it("never auto-allows an edit of a protected path, even under a broad allow rule", () => {
    const rules = [rule("all", "edit", "*", "allow")];
    expect(evaluateRules(rules, "edit", "src/a.ts").decision).toBe("allow");
    for (const path of [".atelier/commands/evil.md", ".claude/settings.json", "AGENTS.md", "docs/CLAUDE.md", ".agents/skills/x/SKILL.md"]) {
      expect(evaluateRules(rules, "edit", path), path).toEqual({ decision: "ask", ruleId: null });
    }
  });

  it("still lets a deny rule refuse a protected path", () => {
    const rules = [rule("frozen", "edit", "AGENTS.md", "deny"), rule("all", "edit", "*", "allow")];
    expect(evaluateRules(rules, "edit", "AGENTS.md")).toEqual({ decision: "deny", ruleId: "frozen" });
  });

  it("does not affect command rules", () => {
    expect(evaluateRules([rule("t", "exec", "cat AGENTS.md", "allow")], "exec", "cat AGENTS.md").decision).toBe("allow");
  });
});
