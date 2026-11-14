import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtelierError, ensureHome } from "../../server/config";
import {
  loadConfig,
  loadSecrets,
  providerStatuses,
  saveConfig,
  saveSecrets,
  validateProvider,
} from "../../server/state";

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "atelier-state-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("config and secrets state", () => {
  it("creates a default config and a 0600 secrets file", () => {
    const paths = ensureHome(tempHome());
    const config = loadConfig(paths);
    expect(config.schema).toBe(1);
    expect(config.providers).toEqual([]);
    const secrets = loadSecrets(paths);
    secrets.keys.demo = "sk-test";
    saveSecrets(paths, secrets);
    expect(statSync(paths.secrets).mode & 0o600).toBe(0o600);
    expect(readFileSync(paths.secrets, "utf8")).toContain("sk-test");
  });

  it("recovers from a corrupt config through .bak", () => {
    const paths = ensureHome(tempHome());
    const config = loadConfig(paths);
    saveConfig(paths, { ...config, defaults: { provider: null, model: "backup-model" } });
    saveConfig(paths, { ...config, defaults: { provider: null, model: "latest-model" } });
    writeFileSync(paths.config, "{ not json", "utf8");
    const recovered = loadConfig(paths);
    expect(recovered.defaults.model).toBe("backup-model");
  });

  it("refuses a newer config schema in place", () => {
    const paths = ensureHome(tempHome());
    loadConfig(paths);
    writeFileSync(paths.config, JSON.stringify({ schema: 9 }), "utf8");
    expect(() => loadConfig(paths)).toThrow(AtelierError);
  });

  it("rejects plaintext non-loopback provider URLs", () => {
    expect(() => validateProvider({ id: "x", name: "X", protocol: "openai-chat", baseUrl: "http://example.com/v1" })).toThrow(AtelierError);
    expect(() => validateProvider({ id: "x", name: "X", protocol: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1" })).not.toThrow();
    expect(() => validateProvider({ id: "x", name: "X", protocol: "openai-chat", baseUrl: "https://example.com/v1" })).not.toThrow();
  });

  it("masks provider keys in status", () => {
    const paths = ensureHome(tempHome());
    const config = loadConfig(paths);
    const secrets = loadSecrets(paths);
    secrets.keys.demo = "sk-secret-value";
    const status = providerStatuses(
      { ...config, providers: [{ id: "demo", name: "Demo", protocol: "openai-chat", baseUrl: "https://example.com/v1" }] },
      secrets,
    );
    const text = JSON.stringify(status);
    expect(text).not.toContain("sk-secret-value");
    expect(status[0]?.key).toEqual({ set: true, source: "secret" });
  });
});
