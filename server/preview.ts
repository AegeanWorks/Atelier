import { AtelierError } from "./config.js";
import { isLoopbackHost } from "./state.js";

const MAX_BODY_BYTES = 5 * 1024 * 1024;

export function validatePreviewUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AtelierError("PREVIEW_URL", "Preview URL is invalid.", raw, "Use a loopback http:// or https:// URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new AtelierError("PREVIEW_URL", "Preview URL must be HTTP or HTTPS.", url.protocol, "Use a loopback URL.");
  if (!isLoopbackHost(url.hostname)) throw new AtelierError("PREVIEW_HOST", "Preview URL is not loopback.", url.hostname, "Preview runs on 127.0.0.1 or localhost.");
  if (url.username.length > 0 || url.password.length > 0) throw new AtelierError("PREVIEW_URL", "Preview URL must not embed credentials.", raw, "Remove the credentials.");
  return url;
}

export interface PreviewSession {
  token: string;
  base: string;
  prefix: string;
}

export function encodePreviewBase(raw: string): PreviewSession {
  const url = validatePreviewUrl(raw);
  const base = url.href.endsWith("/") ? url.href : `${url.href}/`;
  const token = Buffer.from(base, "utf8").toString("base64url");
  return { token, base, prefix: `/api/preview/${token}/` };
}

export function decodePreviewBase(token: string): string {
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    throw new AtelierError("BAD_REQUEST", "Preview token is invalid.", token.slice(0, 40), "Load the preview from the URL form.");
  }
  try {
    return validatePreviewUrl(decoded).href;
  } catch {
    throw new AtelierError("BAD_REQUEST", "Preview token is invalid.", "The token does not decode to a loopback HTTP(S) URL.", "Load the preview from the URL form.");
  }
}

export function rewritePreviewAssetUrls(text: string, prefix: string): string {
  return text
    .replace(/(\s(?:src|href)\s*=\s*["'])\/(?!\/)/gi, `$1${prefix}`)
    .replace(/url\(\s*(["']?)\/(?!\/)/gi, `url($1${prefix}`);
}

export async function fetchPreview(raw: string): Promise<{ status: number; contentType: string; body: ArrayBuffer }> {
  const url = validatePreviewUrl(raw);
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000), headers: { accept: "text/html,application/xhtml+xml,*/*" } });
  if (response.status >= 300 && response.status < 400) throw new AtelierError("PREVIEW_REDIRECT", "Preview redirect was not followed.", response.headers.get("location") ?? url.href, "Load the final loopback URL.");
  if (!response.ok) throw new AtelierError("PREVIEW_HTTP", "Preview target returned an error.", `HTTP ${response.status}`, "Start the preview server and retry.");
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) throw new AtelierError("PREVIEW_LARGE", "Preview response is too large.", `${body.byteLength} bytes`, "Reduce the page size.");
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "text/html; charset=utf-8",
    body,
  };
}
