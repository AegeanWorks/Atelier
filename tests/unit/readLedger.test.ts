/**
 * The read ledger keeps two caches, and both must be bounded: a server that walks a large
 * repository touches thousands of paths, so an uncapped map is a slow leak rather than a
 * hypothetical one.
 *
 * Measured before the hash ceiling existed: 833 bytes retained per hashed path, with no way for
 * a long-lived process to release it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkWrite, hashCacheSize, HASH_CACHE_LIMIT, hashOf, recordRead, resetLedgers, setHashCeiling } from "../../server/readLedger";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  resetLedgers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("read ledger bounds", () => {
  it("stops the hash cache growing past its ceiling", () => {
    // Lower the ceiling instead of hashing thousands of files: the property under test is that
    // the map stops growing, not the specific number it stops at.
    const dir = tempDir("atelier-hash-cap-");
    setHashCeiling(10);
    try {
      for (let index = 0; index < 40; index += 1) {
        const file = join(dir, `f${index}.txt`);
        writeFileSync(file, `${index}\n`, "utf8");
        hashOf(file);
        expect(hashCacheSize()).toBeLessThanOrEqual(10);
      }
      expect(hashCacheSize()).toBeGreaterThan(0);
    } finally {
      resetLedgers();
      setHashCeiling(HASH_CACHE_LIMIT);
    }
  });

  it("still answers correctly after the cache is emptied", () => {
    // Emptying a cache must cost a re-read, never a wrong answer.
    const dir = tempDir("atelier-hash-correct-");
    const file = join(dir, "one.txt");
    writeFileSync(file, "alpha\n", "utf8");
    const first = hashOf(file);
    for (let index = 0; index <= HASH_CACHE_LIMIT; index += 1) hashOf(join(dir, `pad${index}.txt`));
    expect(hashOf(file)).toBe(first);
  });

  it("treats a file changed after a read as stale", () => {
    // The ledger's whole purpose: a write must not clobber bytes this run did not see.
    const dir = tempDir("atelier-hash-stale-");
    const file = join(dir, "watched.txt");
    writeFileSync(file, "before\n", "utf8");
    recordRead("run-1", dir, "watched.txt");
    expect(checkWrite("run-1", dir, "watched.txt").ok).toBe(true);
    writeFileSync(file, "after\n", "utf8");
    expect(checkWrite("run-1", dir, "watched.txt").ok).toBe(false);
  });
});
