import { spawnSync } from "node:child_process";
import type { QualityCheck } from "./types.js";

export interface QualityGrade {
  score: number;
  passed: number;
  total: number;
  failures: string[];
}

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/^["'`]+|["'`]+$/g, "");
}

function numbersIn(value: string): number[] {
  return [...value.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
}

function jsTests(answer: string, entry: string, cases: Array<{ args: unknown[]; expect: unknown }>): { ok: boolean; detail: string } {
  if (answer.trim().length === 0) return { ok: false, detail: "empty answer" };
  const code = answer.replace(/^```[\w-]*\s*$/gm, "").replace(/^```\s*$/gm, "").replace(/^export\s+/gm, "").trim();
  const script = `${code}\nconst __qualityCases = ${JSON.stringify(cases)};\nconst __qualityOut = [];\nfor (const __qualityCase of __qualityCases) {\n  try {\n    if (typeof ${entry} !== "function") throw new Error("missing function ${entry}");\n    const __qualityValue = ${entry}(...__qualityCase.args);\n    __qualityOut.push({ ok: JSON.stringify(__qualityValue) === JSON.stringify(__qualityCase.expect) });\n  } catch (__qualityError) {\n    __qualityOut.push({ ok: false, error: String(__qualityError) });\n  }\n}\nconsole.log("__QUALITY__" + JSON.stringify(__qualityOut));\n`;
  const run = spawnSync(process.execPath, ["--permission", "--no-addons", "-e", script], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1_000_000,
    windowsHide: true,
  });
  if (run.error !== undefined) return { ok: false, detail: String(run.error) };
  if (run.status !== 0) return { ok: false, detail: (run.stderr || "").slice(-400) || `exit ${run.status}` };
  const line = run.stdout.split(/\r?\n/).reverse().find((entryLine) => entryLine.startsWith("__QUALITY__"));
  if (line === undefined) return { ok: false, detail: "no test output" };
  try {
    const results = JSON.parse(line.slice("__QUALITY__".length)) as Array<{ ok: boolean; error?: string }>;
    const failed = results.filter((result) => !result.ok);
    return { ok: failed.length === 0, detail: failed.map((result) => result.error ?? "mismatch").join("; ").slice(0, 400) };
  } catch {
    return { ok: false, detail: "unreadable test output" };
  }
}

export function gradeQuality(answer: string, checks: QualityCheck[]): QualityGrade {
  const failures: string[] = [];
  let passed = 0;
  for (const check of checks) {
    let ok = false;
    let detail = "";
    if (check.type === "exact") {
      ok = normalized(answer) === normalized(check.value);
      detail = `expected ${JSON.stringify(check.value)}`;
    } else if (check.type === "includes") {
      ok = normalized(answer).includes(normalized(check.value));
      detail = `expected answer to include ${JSON.stringify(check.value)}`;
    } else if (check.type === "regex") {
      try {
        ok = new RegExp(check.pattern, "i").test(answer);
      } catch {
        ok = false;
      }
      detail = `expected /${check.pattern}/i`;
    } else if (check.type === "number") {
      ok = numbersIn(answer).some((value) => Math.abs(value - check.value) < 1e-9);
      detail = `expected number ${check.value}`;
    } else {
      const result = jsTests(answer, check.entry, check.cases);
      ok = result.ok;
      detail = result.detail;
    }
    if (ok) passed += 1;
    else failures.push(`${check.type}: ${detail}`);
  }
  return { score: checks.length === 0 ? 0 : passed / checks.length, passed, total: checks.length, failures };
}
