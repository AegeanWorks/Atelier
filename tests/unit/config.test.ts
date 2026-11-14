import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtelierError, assertDiskSpace, checkDiskSpace, ensureHome, parsePort, resolveHome } from "../../server/config";

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "atelier-config-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("config", () => {
  it("resolves an explicit ATELIER_HOME", () => {
    const home = tempHome();
    expect(resolveHome({ ATELIER_HOME: home })).toBe(home);
  });

  it("refuses a home that is not a non-empty string instead of creating [object Object]", () => {
    for (const bad of [{ home: "x" }, 42, "", "   ", null]) {
      expect(() => ensureHome(bad as unknown as string)).toThrow(AtelierError);
    }
  });

  it("creates every runtime directory", () => {
    const paths = ensureHome(tempHome());
    expect(paths.db.endsWith("atelier.db")).toBe(true);
    expect(paths.runtime.endsWith("runtime")).toBe(true);
  });

  it("reports disk space as a structured value", () => {
    const result = checkDiskSpace(tempHome());
    expect(result.requiredBytes).toBe(10 * 1024 * 1024);
    expect(typeof result.ok).toBe("boolean");
  });

  it("rejects an impossible headroom requirement with a triad", () => {
    try {
      assertDiskSpace(tempHome(), Number.MAX_SAFE_INTEGER);
      throw new Error("expected assertDiskSpace to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AtelierError);
      const typed = error as AtelierError;
      expect(typed.code).toBe("ENOSPC_PREFLIGHT");
      expect(typed.fix.length).toBeGreaterThan(0);
    }
  });

  it("parses valid ports and rejects invalid ones", () => {
    expect(parsePort("4317")).toBe(4317);
    expect(parsePort("0")).toBe(0);
    expect(() => parsePort("70000")).toThrow(AtelierError);
  });
});
