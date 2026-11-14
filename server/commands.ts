import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SlashCommand } from "../src/slash.js";
import { loadSkills } from "./skills.js";

const SOURCES = [".claude/commands", ".atelier/commands"];
const MAX_COMMANDS = 100;
const MAX_BYTES = 20_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/;

function describe(body: string): { description: string; template: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(body);
  const front = match?.[1] ?? "";
  const template = match === null ? body : (match[2] ?? "");
  const declared = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim();
  const first = template.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
  return { description: (declared ?? first).slice(0, 120), template };
}

/** Custom prompts from the workspace: .claude/commands first, .atelier/commands wins on a name clash. */
export function loadCustomCommands(workspace: string): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  for (const source of SOURCES) {
    const dir = join(workspace, source);
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const file of names) {
      const name = file.slice(0, -3);
      if (!NAME.test(name)) continue;
      const path = join(dir, file);
      try {
        const stats = statSync(path);
        if (!stats.isFile() || stats.size > MAX_BYTES) continue;
        const { description, template } = describe(readFileSync(path, "utf8"));
        byName.set(name, { name, description, kind: "custom", template });
      } catch {
        continue;
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_COMMANDS);
}

/** Custom prompt commands plus every skill as a /name command; an explicit command wins a name clash. */
export function loadAllCommands(workspace: string): SlashCommand[] {
  const commands = loadCustomCommands(workspace);
  const taken = new Set(commands.map((command) => command.name));
  const fromSkills: SlashCommand[] = loadSkills(workspace)
    .filter((skill) => !taken.has(skill.name))
    .map((skill) => ({
      name: skill.name,
      description: `Skill: ${skill.description}`.slice(0, 120),
      kind: "custom",
      template: `Use the "${skill.name}" skill for this task: read ${skill.path} with read_file and follow it.\n\n$ARGUMENTS`,
    }));
  return [...commands, ...fromSkills].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_COMMANDS);
}
