import { Hono, type Context } from "hono";
import { z } from "zod";
import { AtelierError } from "./config.js";
import { decodePreviewBase, encodePreviewBase, fetchPreview, rewritePreviewAssetUrls } from "./preview.js";

const sessionInput = z.object({ url: z.string().min(1) });

async function servePreview(c: Context): Promise<Response> {
  const token = c.req.param("token") ?? "";
  const base = decodePreviewBase(token);
  const requestUrl = new URL(c.req.url);
  const marker = `/preview/${token}/`;
  const index = requestUrl.pathname.indexOf(marker);
  const rest = index >= 0 ? requestUrl.pathname.slice(index + marker.length) : "";
  const target = new URL(`${rest}${requestUrl.search}`, base);
  const preview = await fetchPreview(target.href);
  c.header("Content-Type", preview.contentType);
  c.header("Cache-Control", "no-store");
  c.header("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-same-origin");
  const textual = preview.contentType.startsWith("text/html") || preview.contentType.startsWith("text/css");
  if (textual) {
    const text = rewritePreviewAssetUrls(new TextDecoder().decode(preview.body), `/api/preview/${token}/`);
    return c.body(text, preview.status as 200);
  }
  return c.body(preview.body, preview.status as 200);
}

export function createPreviewRoutes(): Hono {
  const app = new Hono();

  app.get("/preview", async (c) => {
    const target = c.req.query("url");
    if (target === undefined || target.length === 0) throw new AtelierError("PREVIEW_URL", "Preview URL is missing.", "The query has no url.", "Send ?url=http://127.0.0.1:<port>/.");
    const preview = await fetchPreview(target);
    c.header("Content-Type", preview.contentType);
    c.header("Cache-Control", "no-store");
    c.header("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-same-origin");
    return c.body(preview.body, preview.status as 200);
  });

  app.post("/preview/session", async (c) => {
    const parsed = sessionInput.safeParse(await c.req.json());
    if (!parsed.success) throw new AtelierError("BAD_REQUEST", "Invalid preview payload.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send `{ url }`.");
    return c.json(encodePreviewBase(parsed.data.url));
  });

  app.get("/preview/:token/*", servePreview);
  app.get("/preview/:token/", servePreview);

  return app;
}
