import { openBrowser } from "./browser.js";
import { resolveHome } from "./config.js";
import { printReport } from "./errors.js";
import { HELP, VERSION, parse, validateRun, type Options } from "./cli.js";
import { parseAllowedHosts } from "./hosts.js";

async function run(options: Options): Promise<void> {
  const { ensureHome, parsePort } = await import("./config.js");
  const { acquireLock } = await import("./lock.js");
  const { openDatabase, recoverOnBoot } = await import("./db.js");
  const { createAuth } = await import("./auth.js");
  const { createApp } = await import("./app.js");
  const { serve } = await import("@hono/node-server");

  const home = resolveHome();
  const paths = ensureHome(home);
  const port = parsePort(options.port);
  const workspace = process.env.ATELIER_WORKSPACE?.trim() || process.cwd();

  if (options.check) {
    const result = {
      ok: true,
      version: VERSION,
      node: process.versions.node,
      home,
      db: paths.db,
      port,
      host: options.host,
      workspace,
    };
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`atelier ${VERSION}`);
      console.log(`Node ${process.versions.node}`);
      console.log(`Home ${home}`);
      console.log(`DB   ${paths.db}`);
      console.log(`URL  http://${options.host}:${port}`);
    }
    return;
  }

  if (options.doctor) {
    const db = openDatabase(paths);
    const result = {
      ok: db.quickCheck() === "ok",
      version: VERSION,
      node: process.versions.node,
      home,
      db: paths.db,
      sqliteVersion: db.sqliteVersion,
      schemaVersion: db.schemaVersion,
      journalMode: String(db.db.pragma("journal_mode", { simple: true })),
      synchronous: String(db.db.pragma("synchronous", { simple: true })),
      sessions: (db.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n,
      events: (db.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
      lockPresent: false,
    };
    db.close();
    const { existsSync } = await import("node:fs");
    result.lockPresent = existsSync(paths.lock);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`atelier ${VERSION} doctor`);
      console.log(`Node ${process.versions.node} · SQLite ${result.sqliteVersion} · schema ${result.schemaVersion}`);
      console.log(`Home ${home}`);
      console.log(`DB   ${paths.db} (${result.journalMode}, sync=${result.synchronous})`);
      console.log(`Sessions ${result.sessions} · events ${result.events}`);
      console.log(`Lock ${result.lockPresent ? "present" : "clear"}`);
      console.log(`Status ${result.ok ? "ok" : "CHECK FAILED"}`);
    }
    return;
  }

  const lock = await acquireLock(home, { port });
  let db: Awaited<ReturnType<typeof openDatabase>> | null = null;
  try {
    db = openDatabase(paths);
    const recovery = recoverOnBoot(db);
    const auth = createAuth(paths);
    const app = createApp({
      paths,
      db,
      auth,
      recovery,
      version: VERSION,
      startedAt: Date.now(),
      workspace,
      allowedHosts: parseAllowedHosts(process.env.ATELIER_ALLOWED_HOSTS),
    });
    const server = serve({ fetch: app.fetch, port, hostname: options.host }, (info) => {
      const url = `http://${options.host}:${info.port}`;
      console.log(`atelier ${VERSION} listening on ${url}`);
      console.log(`state: ${home}`);
      if (recovery.actionCount > 0) console.log(`recovery: ${recovery.actionCount} action(s), ${recovery.result}`);
      if (!options.noOpen) {
        openBrowser(url, {
          onError: (error) => {
            console.error("What: the workspace window could not be opened.");
            console.error(`Why: ${error.message}`);
            console.error(`Fix: open ${url} in Edge or Chrome, or set a browser path.`);
          },
        });
      }
    });
    let stopping = false;
    const stop = (signal: string): void => {
      if (stopping) return;
      stopping = true;
      console.log(`atelier: ${signal}, releasing state`);
      server.close(() => {
        lock.release();
        db?.close();
        process.exit(0);
      });
      setTimeout(() => {
        lock.release();
        db?.close();
        process.exit(0);
      }, 1500).unref();
    };
    process.on("SIGINT", () => stop("SIGINT"));
    process.on("SIGTERM", () => stop("SIGTERM"));
  } catch (error) {
    lock.release();
    db?.close();
    throw error;
  }
}

async function acpCli(): Promise<number> {
  // stdout belongs to the protocol: nothing here may print to it.
  try {
    const { serveAcp } = await import("./acp/agent.js");
    const { ensureHome } = await import("./config.js");
    const { openDatabase, recoverOnBoot } = await import("./db.js");
    const db = openDatabase(ensureHome(resolveHome()));
    try {
      recoverOnBoot(db);
      await serveAcp(process.stdin, process.stdout, { db, version: VERSION });
    } finally {
      db.close();
    }
    return 0;
  } catch (error) {
    return printReport(error);
  }
}

async function sessionsCli(options: Options): Promise<number> {
  try {
    const { listHeadlessSessions } = await import("./headless.js");
    const sessions = listHeadlessSessions();
    if (options.json) console.log(JSON.stringify({ sessions }));
    else if (sessions.length === 0) console.log("No conversations yet. Start one with `atelier run \"<prompt>\"`.");
    else for (const session of sessions) console.log(`${session.id}  ${new Date(session.updated).toISOString()}  ${session.title}`);
    return 0;
  } catch (error) {
    return printReport(error);
  }
}

async function runCli(options: Options): Promise<number> {
  const invalid = validateRun(options);
  if (invalid !== null) {
    console.error(`What: ${invalid.what}`);
    console.error(`Why: ${invalid.why}`);
    console.error(`Fix: ${invalid.fix}`);
    return 2;
  }
  const prompt = options.prompt as string;
  if (options.yes) console.error("Warning: --yes approves every edit and command in this run.");
  try {
    const { runHeadless } = await import("./headless.js");
    const result = await runHeadless({
      prompt,
      mode: options.mode === "build" ? "build" : "plan",
      sessionId: options.session,
      continueLatest: options.continue,
      images: options.images,
      autoApprove: options.yes,
      ...(options.maxTurns === null ? {} : { maxTurns: options.maxTurns }),
      ...(options.maxBudgetUsd === null ? {} : { maxBudgetUsd: options.maxBudgetUsd }),
      ...(options.outputFormat === "stream-json" ? { onEvent: (event: { seq: number; type: string; data: unknown }) => console.log(JSON.stringify({ type: "event", seq: event.seq, event: event.type, data: event.data })) } : {}),
    });
    if (options.outputFormat === "stream-json") {
      console.log(JSON.stringify({ type: "result", ...result }));
    } else if (options.outputFormat === "json") {
      console.log(JSON.stringify(result));
    } else if (result.status === "finished") {
      console.log(result.text);
      const usage = result.usage === null ? "" : `, ${result.usage.promptTokens + result.usage.completionTokens} tokens`;
      console.error(`run ${result.runId} finished: ${result.steps} step(s), ${result.tools} tool call(s)${usage}, session ${result.sessionId}`);
    } else {
      console.error(`What: the run did not finish.`);
      console.error(`Why: ${result.reason ?? "the provider or a tool blocked it"}.`);
      console.error(`Fix: inspect ${result.sessionId} in the workspace, or re-run with --mode build --yes if a write was blocked.`);
    }
    return result.status === "finished" ? 0 : 1;
  } catch (error) {
    return printReport(error);
  }
}

async function main(): Promise<number> {
  let options: Options;
  try {
    options = parse(process.argv.slice(2));
  } catch (error) {
    console.error(`What: ${error instanceof Error ? error.message : String(error)}`);
    console.error("Why: the command line could not be parsed.");
    console.error("Fix: run `atelier --help` to see the accepted options.");
    return 2;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  if (options.version) {
    console.log(VERSION);
    return 0;
  }
  if (options.command !== null) {
    if (options.command === "sessions") return sessionsCli(options);
    if (options.command === "acp") return acpCli();
    if (options.command !== "run") {
      console.error(`What: unknown command '${options.command}'.`);
      console.error("Why: the commands are run, sessions and acp.");
      console.error("Fix: run `atelier --help` to see the accepted commands.");
      return 2;
    }
    return runCli(options);
  }
  try {
    await run(options);
    return 0;
  } catch (error) {
    return printReport(error);
  }
}

const code = await main();
if (code !== 0) process.exitCode = code;
