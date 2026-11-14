#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./runtime.mjs";

const source = readdirSync(join(ROOT, "src"))
  .filter((name) => name.endsWith(".tsx"))
  .map((name) => readFileSync(join(ROOT, "src", name), "utf8"))
  .join("\n");
const ids = [...source.matchAll(/data-testid="([^"]+)"/g)].map((match) => match[1]);
const unique = [...new Set(ids)].sort();
for (const id of unique) console.log(`control|${id}|[data-testid="${id}"]`);
