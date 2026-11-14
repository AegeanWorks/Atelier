import { describe, expect, it } from "vitest";
import { evaluateRules, type Rule } from "../../server/rules";

function rule(id: string, action: Rule["action"], match: string, decision: Rule["decision"]): Rule {
  return { id, action, match, decision };
}

describe("evaluateRules", () => {
  it("asks when nothing matches", () => {
    expect(evaluateRules([], "exec", "npm test")).toEqual({ decision: "ask", ruleId: null });
    expect(evaluateRules([rule("a", "exec", "npm test", "allow")], "exec", "npm run build").decision).toBe("ask");
  });

  it("matches exactly and with * wildcards, case-sensitively", () => {
    const rules = [rule("t", "exec", "npm test*", "allow")];
    expect(evaluateRules(rules, "exec", "npm test")).toEqual({ decision: "allow", ruleId: "t" });
    expect(evaluateRules(rules, "exec", "npm test -- --watch")).toEqual({ decision: "allow", ruleId: "t" });
    expect(evaluateRules(rules, "exec", "NPM TEST").decision).toBe("ask");
    expect(evaluateRules(rules, "exec", "xnpm test").decision).toBe("ask");
  });

  it("only applies a rule to its own action", () => {
    const rules = [rule("e", "edit", "src/*", "allow")];
    expect(evaluateRules(rules, "edit", "src/a.ts").decision).toBe("allow");
    expect(evaluateRules(rules, "exec", "src/a.ts").decision).toBe("ask");
  });

  it("treats regex characters in a pattern literally", () => {
    const rules = [rule("d", "exec", "node a.js", "allow")];
    expect(evaluateRules(rules, "exec", "node a.js").decision).toBe("allow");
    expect(evaluateRules(rules, "exec", "node abjs").decision).toBe("ask");
  });

  it("lets a deny rule win over an allow rule whatever the order", () => {
    const rules = [rule("a", "exec", "git *", "allow"), rule("d", "exec", "git push*", "deny")];
    expect(evaluateRules(rules, "exec", "git status")).toEqual({ decision: "allow", ruleId: "a" });
    expect(evaluateRules(rules, "exec", "git push origin main")).toEqual({ decision: "deny", ruleId: "d" });
  });

  it("never auto-allows a command that chains, pipes, redirects or substitutes", () => {
    const rules = [rule("t", "exec", "npm test*", "allow")];
    for (const command of ["npm test && rm x", "npm test; ls", "npm test | tee out", "npm test > out.txt", "npm test || true", "npm test `id`", "npm test $(id)", "npm test\nls", "npm test & ls"]) {
      expect(evaluateRules(rules, "exec", command).decision).toBe("ask");
    }
  });

  it("still lets a deny rule catch a chained command", () => {
    const rules = [rule("d", "exec", "*rm -rf*", "deny")];
    expect(evaluateRules(rules, "exec", "npm test && rm -rf build").decision).toBe("deny");
  });

  it("does not apply the chaining guard to edit paths", () => {
    expect(evaluateRules([rule("e", "edit", "docs/*", "allow")], "edit", "docs/a;b.md").decision).toBe("allow");
  });

  it("refuses to auto-allow a path that climbs out with ..", () => {
    expect(evaluateRules([rule("e", "edit", "src/*", "allow")], "edit", "src/../../etc/passwd").decision).toBe("ask");
  });

  it("matches deny rules against the normalised path, so spelling cannot dodge them", () => {
    const rules = [rule("frozen", "edit", "dist/*", "deny")];
    for (const spelled of ["dist/a.js", "./dist/a.js", "dist//a.js", "src/../dist/a.js", "dist\\a.js", ".\\dist\\a.js"]) {
      expect(evaluateRules(rules, "edit", spelled).decision).toBe("deny");
    }
    expect(evaluateRules(rules, "edit", "distribution/a.js").decision).toBe("ask");
  });

  it("matches allow rules the same way once normalised, still refusing paths that climb out", () => {
    const rules = [rule("docs", "edit", "docs/*", "allow")];
    expect(evaluateRules(rules, "edit", "./docs/a.md").decision).toBe("allow");
    expect(evaluateRules(rules, "edit", "docs\\a.md").decision).toBe("allow");
    expect(evaluateRules(rules, "edit", "docs/../../etc/passwd").decision).toBe("ask");
  });

  it("normalises a rule's own pattern the same way", () => {
    expect(evaluateRules([rule("a", "edit", "./out.txt", "deny")], "edit", "out.txt").decision).toBe("deny");
  });

  it("cannot dodge a command deny rule with extra whitespace", () => {
    const rules = [rule("no-push", "exec", "git push*", "deny")];
    for (const spelled of ["git push origin", "git  push origin", "  git push origin", "git	push origin"]) {
      expect(evaluateRules(rules, "exec", spelled).decision).toBe("deny");
    }
  });

  it("still matches an allow rule after collapsing whitespace but keeps allow case-sensitive", () => {
    const rules = [rule("t", "exec", "npm test*", "allow")];
    expect(evaluateRules(rules, "exec", "npm   test").decision).toBe("allow");
    expect(evaluateRules(rules, "exec", "NPM TEST").decision).toBe("ask");
  });

  it.skipIf(process.platform !== "win32")("on Windows a deny rule ignores case, because the shell does", () => {
    expect(evaluateRules([rule("no-push", "exec", "git push*", "deny")], "exec", "GIT PUSH origin").decision).toBe("deny");
    expect(evaluateRules([rule("frozen", "edit", "dist/*", "deny")], "edit", "DIST/a.js").decision).toBe("deny");
  });
});

describe("ask rules", () => {
  it("beat an allow that would otherwise cover the call, whatever the order", () => {
    const rules = [rule("all-git", "exec", "git *", "allow"), rule("confirm-push", "exec", "git push*", "ask")];
    expect(evaluateRules(rules, "exec", "git status")).toEqual({ decision: "allow", ruleId: "all-git" });
    expect(evaluateRules(rules, "exec", "git push origin main")).toEqual({ decision: "ask", ruleId: "confirm-push" });
    expect(evaluateRules([...rules].reverse(), "exec", "git push origin main")).toEqual({ decision: "ask", ruleId: "confirm-push" });
  });

  it("lose to a deny, so the order is deny, then ask, then allow", () => {
    const rules = [rule("ask", "exec", "rm *", "ask"), rule("deny", "exec", "rm *", "deny"), rule("allow", "exec", "rm *", "allow")];
    expect(evaluateRules(rules, "exec", "rm x")).toEqual({ decision: "deny", ruleId: "deny" });
  });

  it("apply to edit paths after normalisation and report the rule that asked", () => {
    const rules = [rule("docs", "edit", "docs/*", "allow"), rule("changelog", "edit", "docs/CHANGELOG.md", "ask")];
    expect(evaluateRules(rules, "edit", "docs/a.md").decision).toBe("allow");
    expect(evaluateRules(rules, "edit", "./docs/CHANGELOG.md")).toEqual({ decision: "ask", ruleId: "changelog" });
  });

  it("match a chained command too, because asking is always safe", () => {
    expect(evaluateRules([rule("p", "exec", "*git push*", "ask")], "exec", "npm test && git push")).toEqual({ decision: "ask", ruleId: "p" });
  });

  it("leave an unmatched call to the default prompt with no rule named", () => {
    expect(evaluateRules([rule("p", "exec", "git push*", "ask")], "exec", "ls")).toEqual({ decision: "ask", ruleId: null });
  });
});
