import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../server/app";
import { createAuth } from "../../server/auth";
import { ensureHome } from "../../server/config";
import { openDatabase, recoverOnBoot } from "../../server/db";
import { validatePreviewUrl } from "../../server/preview";

const dirs: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("preview proxy", () => {
  it("proxies loopback HTML and strips framing headers", async () => {
    const target = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" });
      response.end("<h1>preview</h1>");
    });
    servers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const paths = ensureHome(tempDir("atelier-preview-home-"));
    const db = openDatabase(paths);
    try {
      const recovery = recoverOnBoot(db);
      const auth = createAuth(paths);
      const app = createApp({ paths, db, auth, recovery, version: "0.1.0", startedAt: Date.now(), workspace: paths.home });
      const response = await app.request(`/api/preview?url=${encodeURIComponent(`http://127.0.0.1:${address.port}/`)}`, { headers: { authorization: `Bearer ${auth.token}` } });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("preview");
      expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(response.headers.get("content-security-policy")).toContain("sandbox");
    } finally {
      db.close();
    }
  });

  it("serves a directory session and rewrites root-relative assets", async () => {
    const target = createServer((request, response) => {
      if (request.url === "/app.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end("console.log('app');");
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<html><head><link rel="stylesheet" href="/style.css"></head><body><script src="/app.js"></script></body></html>');
    });
    servers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const paths = ensureHome(tempDir("atelier-preview-home-"));
    const db = openDatabase(paths);
    try {
      const recovery = recoverOnBoot(db);
      const auth = createAuth(paths);
      const app = createApp({ paths, db, auth, recovery, version: "0.1.0", startedAt: Date.now(), workspace: paths.home });
      const headers = { authorization: `Bearer ${auth.token}`, "content-type": "application/json" };
      const session = await app.request("/api/preview/session", { method: "POST", headers, body: JSON.stringify({ url: `http://127.0.0.1:${address.port}/` }) });
      expect(session.status).toBe(200);
      const { prefix } = (await session.json()) as { prefix: string };
      expect(prefix).toMatch(/^\/api\/preview\/[A-Za-z0-9_-]+\/$/);

      const page = await app.request(prefix, { headers });
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("sandbox");
      const html = await page.text();
      expect(html).toContain(`src="${prefix}app.js"`);
      expect(html).toContain(`href="${prefix}style.css"`);

      const asset = await app.request(`${prefix}app.js`, { headers });
      expect(asset.status).toBe(200);
      expect(await asset.text()).toContain("console.log");

      const bad = await app.request("/api/preview/not-a-token/", { headers });
      expect(bad.status).toBe(400);
    } finally {
      db.close();
    }
  });

  it("refuses non-loopback previews", () => {
    expect(() => validatePreviewUrl("http://example.com/")).toThrow(/loopback/i);
    expect(() => validatePreviewUrl("file:///tmp/index.html")).toThrow(/HTTP/i);
  });
});
