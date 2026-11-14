export interface SlashCommand {
  name: string;
  description: string;
  kind: "builtin" | "custom";
  template?: string;
  /** Picking it from the menu inserts "/name " for the user to finish instead of running it. */
  takesArgs?: boolean;
}

export const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "plan", description: "Switch to Plan mode (read-only)", kind: "builtin" },
  { name: "build", description: "Switch to Build mode (edits need approval)", kind: "builtin" },
  { name: "compact", description: "Summarise this conversation into a fresh one", kind: "builtin" },
  { name: "fork", description: "Branch this conversation into a new one", kind: "builtin" },
  { name: "init", description: "Have the agent write or improve AGENTS.md for this project", kind: "builtin" },
  { name: "instructions", description: "Open the project's AGENTS.md (or CLAUDE.md) for editing", kind: "builtin" },
  { name: "skill-new", description: "Create a skill from a template: /skill-new <name> [description]", kind: "builtin", takesArgs: true },
  { name: "skills", description: "List the project's skills (each is also a /command)", kind: "builtin" },
  { name: "model", description: "Show or switch the model: /model <id>", kind: "builtin", takesArgs: true },
  { name: "undo", description: "Put back the file the agent last edited (run again to redo)", kind: "builtin" },
  { name: "new", description: "Start a new conversation", kind: "builtin" },
  { name: "export", description: "Download this conversation as markdown", kind: "builtin" },
  { name: "terminal", description: "Show or hide the terminal", kind: "builtin" },
  { name: "theme", description: "Switch between light and dark", kind: "builtin" },
];

/** Sent by /init: grounded in the repository, bounded by the 8,000 character cap on injected instructions. */
export const INIT_PROMPT = [
  "Create or improve AGENTS.md at the repository root so future coding sessions start with the right context.",
  "First inspect the repository with your tools: the README, the package or build manifests, the test and lint setup, and the directory layout. If an AGENTS.md or CLAUDE.md already exists, read it and update it rather than starting over.",
  "Write it for an agent, concisely: what the project is, how to install, build, test and lint (the exact commands), the main directories and what lives in each, code conventions you actually observed, and anything that is easy to get wrong.",
  "Only state facts you read or verified in this repository. Do not invent commands, tools or conventions; leave a section out when you could not confirm it.",
  "Keep the file under 8,000 characters, because longer instructions are truncated when they are injected into each run.",
  "Write the file with a single edit and then summarise what you put in it.",
].join("\n\n");

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/;

export function parseSlash(text: string): { name: string; args: string } | null {
  const match = /^\s*\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  if (match === null) return null;
  const name = match[1] ?? "";
  if (!NAME.test(name)) return null;
  return { name, args: (match[2] ?? "").trim() };
}

/** Commands whose name starts with what is typed, only while the name itself is still being typed. */
export function matchCommands(commands: SlashCommand[], draft: string): SlashCommand[] {
  const match = /^\/([A-Za-z0-9_-]*)$/.exec(draft);
  if (match === null) return [];
  const prefix = (match[1] ?? "").toLowerCase();
  return commands.filter((command) => command.name.toLowerCase().startsWith(prefix));
}

export function expandTemplate(template: string, args: string): string {
  if (template.includes("$ARGUMENTS")) return template.split("$ARGUMENTS").join(args);
  return args.length === 0 ? template : `${template}\n\n${args}`;
}
