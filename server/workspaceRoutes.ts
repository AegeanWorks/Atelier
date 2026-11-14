import { Hono } from "hono";
import { z } from "zod";
import { AtelierError } from "./config.js";
import { toReport } from "./errors.js";
import { loadAllCommands } from "./commands.js";
import { createSkill, loadSkills } from "./skills.js";
import { execInWorkspace, stopTerminals } from "./terminal.js";
import { listCheckpoints, restoreCheckpoint, restoreDirectory } from "./checkpoints.js";
import { addWorktree, listWorktrees, removeWorktree } from "./worktrees.js";
import {
  createWorkspaceFile,
  deleteWorkspaceFile,
  gitCommit,
  gitDiff,
  gitLog,
  gitStage,
  gitStatus,
  gitUnstage,
  listTree,
  listWorkspaceFiles,
  readWorkspaceFile,
  renameWorkspaceFile,
  searchWorkspace,
  writeWorkspaceFile,
} from "./workspace.js";

const skillInput = z.object({ name: z.string().max(100), description: z.string().max(1000).optional() });
const fileWrite = z.object({ path: z.string().min(1), content: z.string(), expectedHash: z.string().optional() });
const fileCreate = z.object({ path: z.string().min(1), content: z.string().optional() });
const fileDelete = z.object({ path: z.string().min(1) });
const fileRename = z.object({ from: z.string().min(1), to: z.string().min(1) });
const gitPath = z.object({ path: z.string().min(1) });
const commitInput = z.object({ message: z.string().trim().min(1).max(500) });
const terminalInput = z.object({ command: z.string().min(1).max(20_000), cwd: z.string().optional(), timeoutMs: z.number().int().min(1000).max(300_000).optional() });
const restoreInput = z.object({ commit: z.string().regex(/^[0-9a-f]{7,40}$/i), path: z.string().min(1) });
const restoreDirectoryInput = z.object({ path: z.string().max(500) });
const worktreeInput = z.object({ name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/), branch: z.string().min(1).max(120).optional() });
const worktreePath = z.object({ path: z.string().min(1) });

export interface WorkspaceRouteDeps {
  workspace: string;
  home: string;
}

export function createWorkspaceRoutes(deps: WorkspaceRouteDeps): Hono {
  const app = new Hono();

  app.get("/skills", (c) => c.json({ skills: loadSkills(deps.workspace) }));

  app.post("/skills", async (c) => {
    const parsed = skillInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new AtelierError("BAD_REQUEST", "Invalid skill payload.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send { name, description? }.");
    return c.json({ skill: createSkill(deps.workspace, parsed.data.name, parsed.data.description) }, 201);
  });

  app.get("/commands", (c) => c.json({ commands: loadAllCommands(deps.workspace) }));

  app.get("/workspace/files", (c) => c.json({ files: listWorkspaceFiles(deps.workspace) }));

  app.get("/workspace/tree", (c) => c.json({ entries: listTree(deps.workspace, c.req.query("path") ?? ".", Number(c.req.query("depth") ?? "2")) }));

  app.get("/workspace/file", (c) => {
    const path = c.req.query("path");
    if (path === undefined || path.length === 0) throw new AtelierError("BAD_REQUEST", "Missing file path.", "The query has no path.", "Send ?path=<relative>.");
    return c.json(readWorkspaceFile(deps.workspace, path));
  });

  app.put("/workspace/file", async (c) => {
    const parsed = fileWrite.safeParse(await c.req.json());
    if (!parsed.success) throw new AtelierError("BAD_REQUEST", "Invalid file payload.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send path, content and optional expectedHash.");
    try {
      return c.json(writeWorkspaceFile(deps.workspace, parsed.data.path, parsed.data.content, parsed.data.expectedHash, deps.home));
    } catch (error) {
      if (error instanceof AtelierError && error.code === "FILE_CONFLICT") return c.json({ error: toReport(error) }, 409);
      throw error;
    }
  });

  app.post("/workspace/file", async (c) => {
    const parsed = fileCreate.safeParse(await c.req.json());
    if (!parsed.success) throw new AtelierError("BAD_REQUEST", "Invalid file payload.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send path and optional content.");
    return c.json(createWorkspaceFile(deps.workspace, parsed.data.path, parsed.data.content ?? ""), 201);
  });

  app.delete("/workspace/file", async (c) => {
    const parsed = fileDelete.safeParse(await c.req.json());
    if (!parsed.success) throw new AtelierError("BAD_REQUEST", "Invalid delete payload.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send path.");
    deleteWorkspaceFile(deps.workspace, parsed.data.path, deps.home);
    return c.json({ ok: true });
  });

  app.post("/workspace/rename", async (c) => {
    const parsed = fileRename.safeParse(await c.req.json());
    if (!parsed.success) throw new AtelierError("BAD_REQUEST", "Invalid rename payload.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send from and to.");
    renameWorkspaceFile(deps.workspace, parsed.data.from, parsed.data.to, deps.home);
    return c.json({ ok: true });
  });

  app.get("/workspace/search", (c) => c.json({ output: searchWorkspace(deps.workspace, c.req.query("q") ?? "") }));

  app.get("/checkpoints", (c) => c.json({ checkpoints: listCheckpoints(deps.workspace, 50, deps.home) }));

  app.get("/worktrees", (c) => c.json({ worktrees: listWorktrees(deps.workspace) }));

  app.post("/worktrees", async (c) => {
    const parsed = worktreeInput.safeParse(await c.req.json());
    if (!parsed.success) throw new AtelierError("BAD_REQUEST", "Invalid worktree payload.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send name and optional branch.");
    return c.json(addWorktree(deps.workspace, parsed.data.name, deps.home, parsed.data.branch), 201);
  });

  app.delete("/worktrees", async (c) => {
    const parsed = worktreePath.safeParse(await c.req.json());
    if (!parsed.success) throw new AtelierError("BAD_REQUEST", "Invalid worktree payload.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send path.");
    removeWorktree(deps.workspace, parsed.data.path, deps.home);
    return c.json({ ok: true });
  });

  app.post("/checkpoints/restore", async (c) => {
    const parsed = restoreInput.safeParse(await c.req.json());
    if (!parsed.success) throw new AtelierError("BAD_REQUEST", "Invalid checkpoint payload.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send commit and path.");
    return c.json(restoreCheckpoint(deps.workspace, parsed.data.commit, parsed.data.path, deps.home));
  });

  app.post("/checkpoints/restore-directory", async (c) => {
    const parsed = restoreDirectoryInput.safeParse(await c.req.json());
    if (!parsed.success) throw new AtelierError("BAD_REQUEST", "Invalid checkpoint payload.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send a directory path; empty restores the workspace root.");
    return c.json(restoreDirectory(deps.workspace, parsed.data.path, deps.home));
  });

  app.get("/git/status", (c) => c.json(gitStatus(deps.workspace)));

  app.get("/git/diff", (c) => c.json({ diff: gitDiff(deps.workspace, c.req.query("path"), c.req.query("staged") === "1") }));

  app.get("/git/log", (c) => c.json({ log: gitLog(deps.workspace, Number(c.req.query("limit") ?? "20")) }));

  app.post("/git/stage", async (c) => {
    const parsed = gitPath.safeParse(await c.req.json());
    if (!parsed.success) throw new AtelierError("BAD_REQUEST", "Invalid stage payload.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send path.");
    gitStage(deps.workspace, parsed.data.path);
    return c.json({ ok: true, status: gitStatus(deps.workspace) });
  });

  app.post("/git/unstage", async (c) => {
    const parsed = gitPath.safeParse(await c.req.json());
    if (!parsed.success) throw new AtelierError("BAD_REQUEST", "Invalid unstage payload.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send path.");
    gitUnstage(deps.workspace, parsed.data.path);
    return c.json({ ok: true, status: gitStatus(deps.workspace) });
  });

  app.post("/git/commit", async (c) => {
    const parsed = commitInput.safeParse(await c.req.json());
    if (!parsed.success) throw new AtelierError("BAD_REQUEST", "Invalid commit payload.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send message.");
    const output = gitCommit(deps.workspace, parsed.data.message);
    return c.json({ ok: true, output, status: gitStatus(deps.workspace) });
  });

  app.post("/terminal/exec", async (c) => {
    const parsed = terminalInput.safeParse(await c.req.json());
    if (!parsed.success) throw new AtelierError("BAD_REQUEST", "Invalid terminal payload.", parsed.error.issues[0]?.message ?? "Invalid JSON.", "Send command and optional cwd/timeoutMs.");
    const result = await execInWorkspace(deps.workspace, parsed.data.command, parsed.data.cwd ?? ".", parsed.data.timeoutMs ?? 30_000);
    return c.json(result);
  });

  app.post("/terminal/stop", (c) => c.json({ stopped: stopTerminals() }));

  return app;
}
