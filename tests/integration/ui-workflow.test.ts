import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function readText(...parts: string[]): string {
  return readFileSync(join(root, ...parts), "utf8");
}

describe("UI screenshot workflow", () => {
  it("binds ui:before and ui:after to the labeled captures", () => {
    const pkg = JSON.parse(readText("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["ui:before"]).toBe("node scripts/ui-shots.mjs before");
    expect(pkg.scripts["ui:after"]).toBe("node scripts/ui-shots.mjs after");
    expect(pkg.scripts["ui:shots"]).toBe("node scripts/ui-shots.mjs");
    expect(pkg.scripts["ui:panels"]).toBe("node scripts/ui-panels.mjs");
    expect(pkg.scripts["ui:audit"]).toBe("node scripts/ui-audit.mjs");
  });

  it("records G-007 with the before/after workflow", () => {
    const guidelines = readText(".aikit", "guidelines.md");
    const rule = guidelines.split(/\r?\n/).find((line) => line.startsWith("- **G-007**"));
    expect(rule).toBeDefined();
    expect(rule).toContain("(user)");
    expect(rule).toContain("ui:before");
    expect(rule).toContain("ui:after");
    expect(rule).toContain("390/768/1440");
    expect(rule).toContain("checkpoint");
  });

  it("rejects a path-like label before launching a browser", () => {
    const result = spawnSync(process.execPath, ["scripts/ui-shots.mjs", "../escape"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("What: the screenshot label is invalid.");
    expect(result.stderr).toContain("Why:");
    expect(result.stderr).toContain("Fix:");
  });
});
