import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../server/app";
import { createAuth } from "../../server/auth";
import { attachMentionedFiles } from "../../server/attachments";
import { ensureHome } from "../../server/config";
import { openDatabase, recoverOnBoot } from "../../server/db";
import { loadImage, saveImage } from "../../server/images";
import { resolveInside } from "../../server/tools";

const dirs: string[] = [];
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("@mentions respect the secrets policy", () => {
  it("never attaches a secret file even though it is inside the workspace", () => {
    const root = tempDir("atelier-harden-ws-");
    writeFileSync(join(root, ".env"), "API_KEY=do-not-send\n");
    writeFileSync(join(root, "id_rsa"), "PRIVATE");
    writeFileSync(join(root, "cert.pem"), "PEM");
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config", "secrets.json"), "{}");
    for (const mention of ["@.env", "@id_rsa", "@cert.pem", "@config/secrets.json"]) {
      expect(attachMentionedFiles(root, `look at ${mention}`)).toBe(`look at ${mention}`);
    }
  });

  it("still attaches an ordinary file", () => {
    const root = tempDir("atelier-harden-ws-");
    writeFileSync(join(root, "notes.md"), "hello");
    expect(attachMentionedFiles(root, "see @notes.md")).toContain("hello");
  });
});

describe("the path jail follows links", () => {
  function linked(): { root: string; outside: string } {
    const root = tempDir("atelier-harden-ws-");
    const outside = tempDir("atelier-harden-out-");
    writeFileSync(join(outside, "secret.txt"), "outside data");
    symlinkSync(outside, join(root, "escape"), "junction");
    return { root, outside };
  }

  it("refuses a path that reaches outside the workspace through a link", () => {
    const { root } = linked();
    expect(() => resolveInside(root, "escape/secret.txt")).toThrowError(/escapes the workspace/i);
  });

  it("refuses to create a new file through a link that leaves the workspace", () => {
    const { root } = linked();
    expect(() => resolveInside(root, "escape/new.txt")).toThrowError(/escapes the workspace/i);
  });

  it("does not let an @mention read through a link", () => {
    const { root } = linked();
    expect(attachMentionedFiles(root, "@escape/secret.txt")).toBe("@escape/secret.txt");
  });

  it("still allows ordinary nested paths, new files and paths in a real subdirectory", () => {
    const root = tempDir("atelier-harden-ws-");
    mkdirSync(join(root, "src"));
    expect(resolveInside(root, "src/a.ts")).toContain("a.ts");
    expect(resolveInside(root, "src/new/deeper/b.ts")).toContain("b.ts");
    expect(resolveInside(root, "top.txt")).toContain("top.txt");
  });
});

describe("image blobs survive a torn write", () => {
  it("treats a truncated blob as missing and repairs it on the next save", () => {
    const home = tempDir("atelier-harden-home-");
    const paths = ensureHome(home);
    const id = saveImage(paths, "image/png", PNG);
    // simulate a crash that left half the bytes under the content-hash name
    writeFileSync(join(paths.blobs, `img_${id}`), Buffer.from(PNG, "base64").subarray(0, 20));
    expect(loadImage(paths, id)).toBeNull();
    expect(saveImage(paths, "image/png", PNG)).toBe(id);
    expect(loadImage(paths, id)).toEqual({ mediaType: "image/png", data: PNG });
  });
});

describe("served images cannot be sniffed into something else", () => {
  it("sends nosniff with the image", async () => {
    const home = tempDir("atelier-harden-home-");
    const paths = ensureHome(home);
    const db = openDatabase(paths);
    try {
      const auth = createAuth(paths);
      const app = createApp({ paths, db, auth, recovery: recoverOnBoot(db), version: "0.1.0", startedAt: Date.now(), workspace: home });
      const id = saveImage(paths, "image/png", PNG);
      const response = await app.request(`/api/images/${id}`, { headers: { authorization: `Bearer ${auth.token}` } });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      db.close();
    }
  });
});
