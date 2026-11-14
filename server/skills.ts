import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { AtelierError } from "./config.js";
import { join } from "node:path";

export interface Skill {
  name: string;
  description: string;
  /** Workspace-relative path with forward slashes, so the agent can read_file it. */
  path: string;
}

// Later entries win a name clash, so .atelier beats .agents, which beats .claude.
const SOURCES = [".claude/skills", ".agents/skills", ".atelier/skills"];
const MAX_SKILLS = 30;
const MAX_BYTES = 50_000;
const MAX_DESCRIPTION = 200;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/;

function describe(body: string, fallbackName: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(body);
  const front = match?.[1] ?? "";
  const text = match === null ? body : (match[2] ?? "");
  const declaredName = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim();
  const declared = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim();
  const first = text.split(/\r?\n/).map((line) => line.replace(/^#+\s*/, "").trim()).find((line) => line.length > 0) ?? "";
  return {
    name: declaredName !== undefined && NAME.test(declaredName) ? declaredName : fallbackName,
    description: (declared ?? first).slice(0, MAX_DESCRIPTION),
  };
}

const PLACEHOLDER = "Describe when to use this skill";

function template(name: string, description: string): string {
  const title = name.replace(/[-_]+/g, " ").replace(/^./, (letter) => letter.toUpperCase());
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    `# ${title}`,
    "",
    "## When to use",
    "Say when this skill applies, so the agent only reads it for matching requests.",
    "",
    "## Steps",
    "1. The first thing to do.",
    "2. The next thing, and how to check it worked.",
    "",
    "## Notes",
    "Commands to run, files to touch, and mistakes to avoid.",
    "",
  ].join("\n");
}

/** Create .atelier/skills/<name>/SKILL.md from a template; never overwrites an existing skill. */
export function createSkill(workspace: string, name: string, description?: string): Skill {
  if (!NAME.test(name)) {
    throw new AtelierError("BAD_REQUEST", "That skill name is not allowed.", `${JSON.stringify(name)} is not a plain folder name.`, "Use letters, digits, - or _, starting with a letter or digit, at most 41 characters.");
  }
  const text = (description ?? "").trim() || PLACEHOLDER;
  if (/[\r\n]/.test(text)) {
    throw new AtelierError("BAD_REQUEST", "The description must be one line.", "A line break would break the frontmatter.", "Write the description on a single line.");
  }
  const clipped = text.slice(0, MAX_DESCRIPTION);
  const dir = join(workspace, ".atelier", "skills", name);
  const file = join(dir, "SKILL.md");
  if (existsSync(file) || loadSkills(workspace).some((skill) => skill.name === name)) {
    throw new AtelierError("SKILL_EXISTS", "A skill with that name already exists.", `${name} is already defined.`, "Pick another name, or edit the existing skill.");
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, template(name, clipped), { encoding: "utf8", flag: "wx" });
  return { name, description: clipped, path: `.atelier/skills/${name}/SKILL.md` };
}

/** Skills in the workspace from .claude, .agents and .atelier skill folders; .atelier wins a name clash, then .agents. */
export function loadSkills(workspace: string): Skill[] {
  const byName = new Map<string, Skill>();
  for (const source of SOURCES) {
    const dir = join(workspace, source);
    if (!existsSync(dir)) continue;
    let folders: string[];
    try {
      folders = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch {
      continue;
    }
    for (const folder of folders) {
      if (!NAME.test(folder)) continue;
      const file = join(dir, folder, "SKILL.md");
      try {
        const stats = statSync(file);
        if (!stats.isFile() || stats.size > MAX_BYTES) continue;
        const { name, description } = describe(readFileSync(file, "utf8"), folder);
        byName.set(name, { name, description, path: `${source}/${folder}/SKILL.md` });
      } catch {
        continue;
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_SKILLS);
}
