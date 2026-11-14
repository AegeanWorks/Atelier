export const VERSION = "0.1.0";

export const HELP = `atelier ${VERSION} - local agent workspace

Usage:
  atelier [options]
  atelier run <prompt> [--mode plan|build] [--session <id> | --continue] [--image <file>]... [--max-turns <n>] [--max-budget-usd <x>] [--output-format text|json|stream-json] [--yes] [--json]
  atelier sessions [--json]
  atelier acp
  atelier --check
  atelier --doctor [--json]

Options:
  --port <n>       port (default 4317; 0 picks a free port)
  --host <host>    bind host (default 127.0.0.1)
  --no-open        do not open the workspace window
  --mode <m>       run mode for the run command (plan, the default, or build)
  --session <id>   continue an existing conversation
  --continue, -c   continue the most recent conversation
  --image <file>   attach a png, jpeg, gif or webp image (repeatable, at most 4)
  --max-turns <n>  stop a run after n model turns (1 to 200; the default is 40)
  --max-budget-usd <x>  stop a run once its priced spend reaches x US dollars (above 0, at most 1000); needs a priced model
  --output-format <f>  text (the default), json (one result object, same as --json) or stream-json (one JSON object per line: every session event as it happens, then a final result)
  --yes            approve edits and commands for a headless build run
  --check          print runtime and path checks, then exit
  --doctor         print state and database diagnostics, then exit
  --json           machine-readable output for run, --check and --doctor

acp speaks the Agent Client Protocol on stdin and stdout so an editor such as Zed can launch atelier as its agent;
it prints nothing else on stdout and logs to stderr.
  --help, -h       show this help
  --version        print the version

Exit codes:
  0  the command succeeded (a run finished)
  1  the command failed (a run was blocked, hit its turn cap or hit an error)
  2  invalid usage or configuration; nothing was run

Environment:
  ATELIER_HOME       state directory (default ~/.atelier)
  ATELIER_PORT       default port
  ATELIER_WORKSPACE  workspace reported by /api/boot
  ATELIER_ALLOWED_HOSTS  extra host names to answer to, comma separated
`;

export interface Options {
  port: string | undefined;
  host: string;
  check: boolean;
  doctor: boolean;
  json: boolean;
  help: boolean;
  version: boolean;
  noOpen: boolean;
  command: string | null;
  prompt: string | null;
  mode: string;
  session: string | null;
  continue: boolean;
  images: string[];
  yes: boolean;
  /** NaN when the value was not a number, so validateRun can name it. */
  maxTurns: number | null;
  outputFormat: string;
  maxBudgetUsd: number | null;
}

export function parse(argv: string[]): Options {
  const options: Options = {
    port: process.env.ATELIER_PORT,
    host: "127.0.0.1",
    check: false,
    doctor: false,
    json: false,
    help: false,
    version: false,
    noOpen: false,
    command: null,
    prompt: null,
    mode: "plan",
    session: null,
    continue: false,
    images: [],
    yes: false,
    maxTurns: null,
    outputFormat: "text",
    maxBudgetUsd: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const next = argv[index + 1];
    if (arg === "--") {
      for (const rest of argv.slice(index + 1)) {
        if (options.command === null) options.command = rest;
        else if (options.prompt === null) options.prompt = rest;
        else options.prompt = `${options.prompt} ${rest}`;
      }
      break;
    }
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--version") options.version = true;
    else if (arg === "--check") options.check = true;
    else if (arg === "--doctor") options.doctor = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--no-open") options.noOpen = true;
    else if (arg === "--continue" || arg === "-c") options.continue = true;
    else if (arg === "--image" && next !== undefined) {
      options.images.push(next);
      index += 1;
    } else if (arg.startsWith("--image=")) options.images.push(arg.slice("--image=".length));
    else if (arg === "--max-turns" && next !== undefined) {
      options.maxTurns = Number(next);
      index += 1;
    } else if (arg.startsWith("--max-turns=")) options.maxTurns = Number(arg.slice("--max-turns=".length));
    else if (arg === "--max-budget-usd" && next !== undefined) {
      options.maxBudgetUsd = Number(next);
      index += 1;
    } else if (arg.startsWith("--max-budget-usd=")) options.maxBudgetUsd = Number(arg.slice("--max-budget-usd=".length));
    else if (arg === "--output-format" && next !== undefined) {
      options.outputFormat = next;
      index += 1;
    } else if (arg.startsWith("--output-format=")) options.outputFormat = arg.slice("--output-format=".length);
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--port" && next !== undefined) {
      options.port = next;
      index += 1;
    } else if (arg.startsWith("--port=")) options.port = arg.slice("--port=".length);
    else if (arg === "--host" && next !== undefined) {
      options.host = next;
      index += 1;
    } else if (arg.startsWith("--host=")) options.host = arg.slice("--host=".length);
    else if (arg === "--mode" && next !== undefined) {
      options.mode = next;
      index += 1;
    } else if (arg.startsWith("--mode=")) options.mode = arg.slice("--mode=".length);
    else if (arg === "--session" && next !== undefined) {
      options.session = next;
      index += 1;
    } else if (arg.startsWith("--session=")) options.session = arg.slice("--session=".length);
    else if (arg.startsWith("-")) throw new Error(`Unknown argument '${arg}'. Run --help.`);
    else if (options.command === null) options.command = arg;
    else if (options.prompt === null) options.prompt = arg;
    else options.prompt = `${options.prompt} ${arg}`;
  }
  if (options.json && options.outputFormat === "text") options.outputFormat = "json";
  return options;
}

export interface ValidationError {
  what: string;
  why: string;
  fix: string;
}

export function validateRun(options: Options): ValidationError | null {
  if (options.prompt === null || options.prompt.trim().length === 0) {
    return {
      what: "a prompt is required.",
      why: "the run command needs text to work on.",
      fix: 'pass a prompt, for example `atelier run "fix the failing test"`.',
    };
  }
  if (options.continue && options.session !== null) {
    return {
      what: "--continue and --session cannot be combined.",
      why: "both choose the conversation to continue.",
      fix: "pass --session <id> for a specific one, or --continue for the latest.",
    };
  }
  if (options.mode !== "plan" && options.mode !== "build") {
    return {
      what: `unknown mode '${options.mode}'.`,
      why: "modes are plan (read-only) and build (writes need approval).",
      fix: "pass `--mode plan` or `--mode build`.",
    };
  }
  if (options.outputFormat !== "text" && options.outputFormat !== "json" && options.outputFormat !== "stream-json") {
    return {
      what: `unknown --output-format '${options.outputFormat}'.`,
      why: "--output-format is text, json or stream-json.",
      fix: "pass `--output-format json` for one result object or `--output-format stream-json` for a live line-per-event stream.",
    };
  }
  if (options.maxBudgetUsd !== null && !(Number.isFinite(options.maxBudgetUsd) && options.maxBudgetUsd > 0 && options.maxBudgetUsd <= 1000)) {
    return {
      what: "--max-budget-usd must be a number above 0 and at most 1000.",
      why: "it caps what one run may spend, in US dollars.",
      fix: "pass for example `--max-budget-usd 0.50`, or drop it for no cap.",
    };
  }
  if (options.maxTurns !== null && (!Number.isInteger(options.maxTurns) || options.maxTurns < 1 || options.maxTurns > 200)) {
    return {
      what: "--max-turns must be a whole number from 1 to 200.",
      why: "it caps how many model turns one run may take.",
      fix: "pass for example `--max-turns 20`, or drop it for the default of 40.",
    };
  }
  if (options.yes && options.mode !== "build") {
    return {
      what: "--yes has no effect in plan mode.",
      why: "plan mode never writes or runs commands.",
      fix: "drop --yes, or add `--mode build`.",
    };
  }
  return null;
}
