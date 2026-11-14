import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-server",
  ".vite",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  "target",
  "__pycache__",
]);

export interface WalkOptions {
  maxFiles?: number;
  skipDirs?: Set<string>;
}

export function walkWorkspace(root: string, options: WalkOptions = {}): string[] {
  const maxFiles = options.maxFiles ?? 20_000;
  const skipDirs = options.skipDirs ?? SKIP_DIRS;
  const files: string[] = [];
  const stack: string[] = [resolve(root)];
  while (stack.length > 0 && files.length < maxFiles) {
    const current = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (skipDirs.has(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) files.push(relative(root, path).split("\\").join("/"));
    }
  }
  return files.sort();
}

export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped
    .replace(/\*\*\//g, "\uE000")
    .replace(/\*\*/g, "\uE001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\uE000/g, "(?:.*/)?")
    .replace(/\uE001/g, ".*");
  return new RegExp(`^${body}$`);
}

export function matchGlob(files: string[], pattern: string, limit = 500): string[] {
  const matcher = globToRegExp(pattern);
  const matches = files.filter((file) => matcher.test(file));
  return matches.slice(0, limit);
}

export interface SearchOptions {
  query: string;
  path?: string;
  maxHits?: number;
  ignoreCase?: boolean;
  fixed?: boolean;
  include?: string;
  maxFileBytes?: number;
  maxFiles?: number;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

function looksBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, 4096);
  return probe.includes(0);
}

export function searchText(root: string, options: SearchOptions): { hits: SearchHit[]; scanned: number; truncated: boolean } {
  const maxHits = Math.min(500, Math.max(1, options.maxHits ?? 50));
  const maxFileBytes = options.maxFileBytes ?? 1_000_000;
  const query = options.query;
  if (query.length === 0) throw new Error("search query is empty");
  let matcher: RegExp;
  if (options.fixed === true) {
    const literal = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    matcher = new RegExp(literal, options.ignoreCase === true ? "i" : "");
  } else {
    matcher = new RegExp(query, options.ignoreCase === true ? "i" : "");
  }
  const base = options.path !== undefined && options.path.length > 0 ? resolve(root, options.path) : resolve(root);
  const baseIsFile = (() => {
    try {
      return statSync(base).isFile();
    } catch {
      return false;
    }
  })();
  const prefix = relative(root, base).split("\\").join("/");
  const candidates = baseIsFile
    ? [prefix]
    : matchGlob(walkWorkspace(root, { maxFiles: options.maxFiles ?? 20_000 }), options.include ?? "**/*", 20_000)
        .filter((file) => prefix === "" || file === prefix || file.startsWith(`${prefix}/`))
        .filter((file) => (options.include === undefined ? true : globToRegExp(options.include).test(file)));
  const hits: SearchHit[] = [];
  let scanned = 0;
  let truncated = false;
  for (const file of candidates) {
    if (hits.length >= maxHits) {
      truncated = true;
      break;
    }
    const absolute = join(root, file);
    let buffer: Buffer;
    try {
      const stat = statSync(absolute);
      if (!stat.isFile() || stat.size > maxFileBytes) continue;
      buffer = readFileSync(absolute);
    } catch {
      continue;
    }
    if (looksBinary(buffer)) continue;
    scanned += 1;
    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (matcher.test(line)) {
        hits.push({ path: file, line: index + 1, text: line.length > 300 ? `${line.slice(0, 300)}…` : line });
        if (hits.length >= maxHits) {
          truncated = true;
          break;
        }
      }
    }
  }
  return { hits, scanned, truncated };
}

export function formatHits(hits: SearchHit[]): string {
  return hits.map((hit) => `${hit.path}:${hit.line}:${hit.text}`).join("\n");
}
