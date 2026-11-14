import { describe, expect, it } from "vitest";
import { AtelierError } from "../../server/config";
import { decodePreviewBase, encodePreviewBase, rewritePreviewAssetUrls } from "../../server/preview";

describe("preview directory proxy", () => {
  it("round-trips a loopback base", () => {
    const session = encodePreviewBase("http://127.0.0.1:3000");
    expect(session.prefix).toBe(`/api/preview/${session.token}/`);
    expect(decodePreviewBase(session.token)).toBe("http://127.0.0.1:3000/");
  });

  it("rejects a token that does not decode to a loopback URL", () => {
    const external = Buffer.from("http://example.com/", "utf8").toString("base64url");
    expect(() => decodePreviewBase(external)).toThrow(AtelierError);
    expect(() => decodePreviewBase("not-a-token")).toThrow(AtelierError);
  });

  it("rewrites root-relative attributes and CSS urls under the prefix", () => {
    const prefix = "/api/preview/tok/";
    const html = '<script src="/app.js"></script><link href=\'/style.css\'><img src="//cdn.example/x.png"><a href="https://example.com">x</a>';
    const rewritten = rewritePreviewAssetUrls(html, prefix);
    expect(rewritten).toContain('src="/api/preview/tok/app.js"');
    expect(rewritten).toContain("href='/api/preview/tok/style.css'");
    expect(rewritten).toContain('src="//cdn.example/x.png"');
    expect(rewritten).toContain('href="https://example.com"');
    expect(rewritePreviewAssetUrls("body{background:url(/img.png)}", prefix)).toContain("url(/api/preview/tok/img.png)");
    expect(rewritePreviewAssetUrls("body{background:url('/img.png')}", prefix)).toContain("url('/api/preview/tok/img.png')");
  });
});
