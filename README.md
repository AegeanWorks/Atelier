# Atelier

[![Built with AIKit](https://img.shields.io/badge/built%20with-AIKit-6f42c1)](https://github.com/AegeanWorks/AIKit)

Local-first agent workspace: multi-conversation chat, file editing, git diffs, terminal, browser preview, and plans in one fast UI for any model API.

## ⚡ 30-Second Cold-Start Quick Reference

- **Runtime Prerequisites**: Node.js **>=22.12** and npm **>=10**; SQLite is bundled by `better-sqlite3` (3.53.4). Windows 10+, macOS 13+, or a current Linux distribution.
- **Canonical Regression Shield Gate**:
  ```bash
  npm install
  npm test
  ```

### 🛠️ AIKit Commands (run from the AIKit folder)
| Role | Command |
|---|---|
| Status, task and gates | `python aikit.py status atelier` |
| Phase 4: every gate | `python aikit.py check atelier` |
| Repair memory and map, then check | `python aikit.py fix atelier` |
| Resume an interrupted task | `python aikit.py resume atelier` |

## 🚀 Run It

Double-click `start.bat` (Windows) or run `sh start.sh` (macOS/Linux): it installs dependencies and builds only when something is missing or stale, starts the server, and opens atelier in its own app window (Edge or Chrome `--app` mode, no tabs or address bar) with a 1440x900 frame; if no Chromium-based browser is available it falls back to the system opener.

From a terminal:

```bash
npm install
npm run dev          # API on 127.0.0.1:4317, UI on 127.0.0.1:5173 (next free port if busy)
npm start            # install and build if needed, serve the production UI, open the app window
npm run doctor       # read-only runtime and database diagnostics
npm run help         # CLI help in under 1 s
```

Headless runs are available for scripts and CI. `atelier run "<prompt>"` starts a read-only plan run in a new conversation and prints the answer on stdout with a one-line summary on stderr; `--session <id>` continues an existing conversation, `--continue` (`-c`) continues the most recent one (an error if there is none; it cannot be combined with `--session`), `atelier sessions [--json]` lists conversations newest first with id, last update and title, `@path` mentions in a headless prompt attach file contents exactly as in the UI, `--mode build` allows edits and commands, and `--json` prints one machine-readable object with status, text, run id, session id, step and tool counts and accumulated usage. A build run has no human to approve a write, so it fails fast with a clear reason unless you pass `--yes`, which prints a warning and approves every edit and command for that run; `--output-format stream-json` prints one JSON object per line, each session event as it happens (`{"type":"event","seq","event","data"}`) and then a final `{"type":"result",...}` line, so an agent can follow a run live (`json` is the same as `--json`, `text` the default), `--max-budget-usd <x>` stops a run once its priced spend reaches x dollars (checked between model turns, so one turn may overshoot; a final answer is kept; a model without a price blocks with `budget unpriced` because the cap could not be enforced), `--max-turns <n>` (1 to 200, default 40) stops a run after n model turns and leaves it blocked with the reason `step cap reached`; the exit code is 0 when the run finished, 1 when it blocked, and 2 for invalid usage (`atelier --help` lists them).

Pass `--no-open` to the server (or `start.bat --no-open`) to keep the window closed; the automated scripts and tests always pass it. Set `ATELIER_BROWSER` to a Chromium/Edge executable path to choose the app-window host explicitly. The server answers only requests addressed to `localhost`, `*.localhost` or an IP address, and refuses every other Host with `421 HOST_REJECTED` before issuing any cookie, which blocks DNS-rebinding attacks from web pages; if you reach it through a reverse proxy or a custom name, list that name in `ATELIER_ALLOWED_HOSTS` (comma separated).

The server creates `~/.atelier/` (override with `ATELIER_HOME`), writes a 0600 runtime token, and keeps all state outside the project tree. The agent runs a system prompt that names the tool contract and injects the workspace's `AGENTS.md` (or `CLAUDE.md`) when present, bounded at 8,000 characters, so project rules travel with every turn. Providers and keys are configured in the **Settings** workspace tab; keys are read from the environment or a 0600 secrets file and rendered only as SET / MISSING. In build mode, `write_file`, `edit_file`, `multi_edit` and `bash` pause on a durable approval; approve or deny it in the dock above the composer, optionally with a short note that is recorded as the decision reason. Edit approvals carry a reviewable unified diff: the dock computes the proposed change in memory (`server/editPreview.ts` over the same pure edit functions the tools execute in `server/edits.ts`), stores it with the approval (schema 9 adds `approvals.preview`) and renders it collapsed-by-default with `+n/−n` counts and per-line add/remove colouring, so nothing is written until the diff is approved. Tools cover line-windowed reads, directory listing, glob, regex text search, exact and multi-edit writes, shell commands with a `timeoutMs` limit, git status and diff, delegation and MCP. Search works without external binaries: `ripgrep` uses `rg` when installed and otherwise falls back to a built-in walker that skips `node_modules`, `.git` and build output while honoring `include` globs, `ignoreCase` and literal `fixed` queries. `edit_file` accepts `replaceAll`, and `multi_edit` applies several exact edits to one file as a single atomic write with all-or-nothing validation. A timed-out command has its whole process tree killed, so a long child never keeps the workspace locked. Assistant tool calls are replayed back to every protocol in its native form — OpenAI `tool_calls`, Responses `function_call`/`function_call_output` items, Anthropic `tool_use`/`tool_result` blocks, Gemini `functionCall`/`functionResponse` parts — so multi-step tool use works across all four adapters. Large tool results are offloaded to `~/.atelier/artifacts/`, and long sessions are compacted to a bounded summary before each request; the system prompt is kept out of compaction. MCP servers are configured in `mcpServers` in `~/.atelier/config.json` (`{ id, name, transport: "stdio", command, args? }` or `{ id, name, transport: "http" | "sse", url }`) and appear to the agent as `mcp__<server>__<tool>`; calls are approval-gated and deduplicated through the effect ledger; a server that exits mid-run is rebuilt for later calls, and the failed call is reported rather than retried. Edits and deletes are snapshotted in a shadow git repository under `~/.atelier/checkpoints/`; `GET /api/checkpoints` lists them, `POST /api/checkpoints/restore` restores one path, and `POST /api/checkpoints/restore-directory` restores the latest checkpoint of every file under a prefix; the History tab drives both. `GET/POST/DELETE /api/worktrees` manages isolated branches under `~/.atelier/worktrees/`. The Preview tab opens a directory-prefixed session through the sandboxed `/api/preview/<token>/` proxy, so relative and root-relative assets resolve against the target; external hosts and redirects are refused.

## 🧭 The Six Binding Rules

1. **As fast as possible** — measured startup, first-token, commit, session-switch and test budgets; regressions are rejected.
2. **AI Usage Compatible** — OpenAI Chat/Responses, Anthropic Messages and Gemini adapters, a model catalog, per-role bindings, MCP tools, headless parity and machine-readable events/traces.
3. **Crash Free** — crash-only boot, a 3 s/30 s single-instance lock, WAL with explicit `FULL`, durable events, recovery and a kill/restart dogfood.
4. **AI Testable** — `npm run verify -- --json` returns a stable result; deterministic fixtures, trace replay, hidden-test integrity and per-tier budgets.
5. **Browser usage compatible** — Chromium/Firefox/WebKit targets, 390/768/1440 layouts, keyboard and axe accessibility, feature fallbacks.
6. **Aesthetic and easy to use** — theme tokens only, one visual grammar with visible focus, one primary action per surface, tinted and confirmed destructive actions, truthful labels, nothing clipped at 390/768/1440.

## ✅ Verification

```bash
npm test                 # unit, integration and UI suites
npm run test:budgets     # unit <=20 ms, integration <=1000 ms per test
npm run verify -- --json # typecheck, test, lint and build as one machine result
npm run dogfood          # create, message, kill, restart, recover
npm run crash:test       # kill/restart integrity smoke
npm run test:browser     # Chromium shell + 390 px overflow check
npm run test:a11y        # axe serious/critical gate
npm run ui:before        # capture the unchanged UI into shots/before (G-007)
npm run ui:after         # capture the changed UI into shots/after and compare
npm run ui:shots         # 390/768/1440 screenshots in shots/ (overwrites)
npm run ui:panels        # one screenshot per workspace panel in shots/panels
npm run ui:audit         # measured overflow, tab bounds and hit targets at 390/768/1440
npm run bench            # built CLI help latency
npm run eval             # deterministic harness suite with RR/CSR/ES
npm run eval:baseline    # freeze the current dev run as a timestamped baseline
npm run eval:gate        # run dev and compare to the latest baseline
npm run eval:compare -- --candidate <runId> --baseline <label>
npm run eval:release     # frozen test split, explicit release run
npm run eval:quality     # coding + long-recall quality suite (fixtures)
npm run eval:quality:baseline  # freeze a quality baseline
npm run eval:quality:gate      # compare quality candidates to the latest quality baseline
npm run perf             # perf alias
npm run bench:compaction # before/after context token and latency measurement
npm run test:agent-perf   # agent run/tool/commit/session/compaction p95 budgets
npm run bench:agent       # repeated agent tasks with Wilson/bootstrap/McNemar results
```

## 📦 What's Inside

```text
atelier/
├── .gitignore               <- transient state, builds and local DBs excluded
├── assets/
├── docs/
├── evals/
├── package-lock.json
├── scratch-mcp-sse.py
├── LICENSE                  <- Aegean License 1.1 (AL-1.1)
├── COMMERCIAL.md            <- commercial licensing terms
├── LICENSES/                <- REUSE license texts
├── REUSE.toml               <- machine-readable SPDX metadata
├── server/
│   ├── main.ts            <- CLI, lock, recovery, HTTP listener
│   ├── app.ts             <- Hono routes, auth, SSE, static UI
│   ├── browser.ts         <- dedicated app-window launcher with a system-opener fallback
│   ├── db.ts              <- SQLite schema v2, WAL/FULL, sessions, memo
│   ├── lock.ts            <- single-instance lock, 3 s acquire / 30 s stale
│   ├── state.ts           <- config/secrets atomic state, masked key status
│   ├── config.ts          <- home paths, 10 MB headroom, error triads
│   ├── auth.ts            <- 0600 token, HttpOnly cookie, CSRF
│   ├── agent.ts           <- tool loop: system prompt, approvals, delegation
│   ├── cli.ts             <- flags, help text and run validation
│   ├── headless.ts        <- scriptable one-shot runs with exit codes
│   ├── prompt.ts          <- agent instructions plus AGENTS.md / CLAUDE.md
│   ├── tools.ts           <- file, search, edit, bash and git tools
│   ├── edits.ts           <- pure exact-edit application shared by tools and preview
│   ├── diff.ts            <- bounded LCS line diff with context trimming
│   ├── editPreview.ts     <- approval diff for a proposed write
│   ├── search.ts          <- built-in walker, glob and text search (no rg needed)
│   ├── acp/                  <- Agent Client Protocol agent: JSON-RPC peer, mappings, run bridge
│   ├── approvals.ts          <- durable tool approvals with diff preview and decisions
│   ├── attachments.ts        <- appends @-mentioned file contents to a prompt, secret files skipped
│   ├── audit.ts              <- per-run audit findings from the event log
│   ├── checkpoints.ts        <- shadow-git snapshots before edits, restore for undo
│   ├── commands.ts           <- custom prompt commands, with skills exposed as slash commands
│   ├── compaction.ts         <- context compaction and tool-output offload
│   ├── effects.ts            <- idempotent effect journal so a replay never repeats a write
│   ├── errors.ts             <- What/Why/Fix error reports
│   ├── eval/                 <- fixture adapters, statistics and run comparison for the eval harness
│   ├── eval.ts               <- eval suite runner and gates
│   ├── evalRoutes.ts         <- eval HTTP routes
│   ├── fork.ts               <- copy a conversation up to a message into a new one
│   ├── hooks.ts              <- pre/post tool hook runner, exit code 2 vetoes a call
│   ├── liveStream.ts         <- in-memory channel for live token deltas, never stored
│   ├── hosts.ts              <- Host header allow-list that blocks DNS rebinding
│   ├── images.ts             <- content-addressed image blobs with an integrity check
│   ├── mcp.ts                <- MCP client hub over stdio, http and sse
│   ├── mcpEffects.ts         <- MCP tool calls under the effect journal
│   ├── permissions.ts        <- read/edit/exec permission decisions and the secret-path policy
│   ├── planRoutes.ts         <- plan HTTP routes
│   ├── plans.ts              <- durable plan objects with revisions
│   ├── preview.ts            <- loopback preview proxy and dev-server detection
│   ├── previewRoutes.ts      <- preview HTTP routes
│   ├── rules.ts              <- allow/deny permission rules with path and command normalisation
│   ├── runRoutes.ts          <- run, approval, image, compact and fork HTTP routes
│   ├── runner.ts             <- run lifecycle: lease, execute, resume, stop
│   ├── runs.ts               <- run and step records and session events
│   ├── shellEnv.ts           <- secret-free environment for commands the agent runs
│   ├── skills.ts             <- SKILL.md discovery and scaffolding
│   ├── summarize.ts          <- /compact: a summary through the configured provider
│   ├── terminal.ts           <- workspace command execution with process-tree teardown
│   ├── todos.ts              <- agent todo list storage
│   ├── usage.ts              <- token, cost and context-window accounting
│   ├── usageRoutes.ts        <- usage HTTP route
│   ├── workspace.ts          <- workspace file and git operations
│   ├── workspaceRoutes.ts    <- files, git, terminal, command and skill HTTP routes
│   ├── worktrees.ts          <- git worktree add and remove
│   └── providers/         <- four protocol adapters, catalog, memoized runner
├── src/
│   ├── App.tsx            <- four-region workspace shell
│   ├── RailConversations.tsx <- search, inline rename, confirmed delete
│   ├── Markdown.tsx       <- dependency-free assistant markdown with code copy
│   ├── transcript.ts     <- markdown transcript formatter and download
│   ├── SettingsPanel.tsx  <- provider CRUD, key status, defaults and roles
│   ├── UsagePanel.tsx     <- token, request and cost totals per session
│   ├── PlansPanel.tsx     <- plan-mode capture, status and editing
│   ├── TaskPanel.tsx      <- run list, steps, audit and resume/stop
│   ├── FilesPanel.tsx     <- workspace tree, file create and editor
│   ├── GitPanel.tsx       <- staged-aware status, diffs and commit controls
│   ├── TerminalPanel.tsx  <- pipe terminal with bounded persisted history
│   ├── EvalsPanel.tsx     <- eval suites and run results
│   ├── PreviewPanel.tsx   <- sandboxed preview with detect, reload and open-in-tab
│   ├── HistoryPanel.tsx   <- checkpoint history and directory restore
│   ├── ActivityFeed.tsx   <- live per-run tool activity under the transcript
│   ├── TodoStrip.tsx      <- agent todo list with progress and current step
│   ├── DiffView.tsx          <- unified diff renderer
│   ├── attachments.ts        <- separates typed text from attached file and image markers
│   ├── context.ts            <- context meter label and level
│   ├── images.ts             <- image file checks and base64 reading
│   ├── main.tsx              <- React entry point
│   ├── mention.ts            <- @ mention parsing and ranking
│   ├── live.ts               <- folds live text deltas into the reply being written
│   ├── rules.ts              <- builds the Always allow rule from an approval and owns the protected-path check
│   ├── slash.ts              <- built-in slash commands and prompt templates
│   ├── terminalStore.ts      <- bounded persisted terminal history
│   ├── theme.css          <- every color and spacing token
│   ├── api.ts             <- credentialed fetch + structured errors
│   └── types.ts
├── tests/                 <- unit, integration and jsdom UI suites
├── scripts/               <- dev, start, verify, dogfood, crash, browser, shots
├── shots/                 <- generated screenshot evidence (git-ignored)
├── index.html
├── start.bat              <- one-click Windows start: preflight, build if stale, serve, open the app window
├── start.sh               <- one-click macOS/Linux start with the same behavior
├── package.json
├── vite.config.ts
├── tsconfig.json
├── tsconfig.server.json
├── inventory.py           <- AI-compat inventory: kind|name|locator lines
├── demo.py                <- AI-compat scripted drive: WORLD-DELTA lines
├── .aikit/                <- project memory: UI contract, decisions, ledger
└── README.md
```

## 🧱 Architecture

The browser talks to a loopback-only Hono server over a credentialed JSON/SSE API. Durable writes go through `better-sqlite3` in WAL mode with an explicit `FULL` synchronous setting; deltas are not persisted. The server refuses a second instance, checks at least 10 MB free before state writes, refuses a newer schema in place, and runs recovery before listening. `GET /api/sessions/:id/events` replays the durable log from `after`, then polls new rows every 250 ms inside the open stream and keeps it alive with a 15 s heartbeat, so approvals, run state and assistant replies arrive without a refresh.

M1 ships the shell, durable sessions/messages, auth, health/boot/recovery, and the headless verification surface. M2 adds the four provider protocols, model catalog, per-role bindings, Settings CRUD, masked key status, provider test endpoint, 429/529 retry with jitter, failover, and LLM memoization (`llm_requests` keyed by a canonical request hash). Each provider step also appends a durable `llm.usage` event priced from the catalog; `GET /api/usage` aggregates requests, replays, tokens and estimated cost per session or globally, and the Usage panel plus status bar read those totals. Plan mode is read-only; a finished plan-mode run is saved as a durable plan object, and `GET/POST/PATCH/DELETE /api/plans` backs the Plans panel, where a plan can be viewed, edited, activated, completed, archived, deleted, or restored from its revision history. The Task panel reads `GET /api/runs`, `GET /api/runs/:id` and `GET /api/audit/:id` and drives retry, fork and stop, so a blocked or failed run, its durable steps and its audit findings are inspectable in the app. The rail searches conversation titles and message text, renames a conversation inline and deletes one after a second confirming click; a new conversation takes its title from the first message. Conversations can be pinned to the top or archived out of the active list, and the Archived toggle lists them for restore; both flags are stored in the database and served as pinned/rchived on every session row, with GET /api/sessions?archived=1 returning the archived set. The conversation column follows new messages while you are at the bottom, offers a jump-to-latest pill once you scroll away, and every message exposes a copy button. Assistant replies render as markdown — headings, lists, quotes, rules, inline emphasis and links — and fenced code blocks keep their language, scroll horizontally and offer their own copy button; raw HTML is never injected, and only `http(s)`/`mailto` links are rendered. While a run is in flight the conversation shows a working indicator with elapsed seconds, a visible task list from `todo_write` (each item marked pending, in progress or done, with a progress bar and the current step) and a live activity feed under the transcript: each tool call appears as a labelled row (Read, Edited, Ran, Searched, Delegated, or the MCP name) with its target path or command and an ok/failed state, duplicate calls are folded, only the last six rows stay visible while the total step count is always shown, Details jumps to the Task panel, and a finished run keeps its feed until it is dismissed or a new run starts; and an unsent composer draft is kept per conversation in local storage, so switching conversations never discards typing. The Files panel opens any workspace file for editing, saves with Cmd/Ctrl+S or the Save button, marks the buffer unsaved until it is written with a hash check, and needs a second confirming click before deleting a file. Settings closes the setup loop: it lists the chosen provider’s models for the default model field (any id can still be typed), saves the default provider and model through PUT /api/config, and a blocked run names the exact missing step in the error banner. A fresh start reports a clean recovery and shows no banner; the banner appears only when recovery actually changed something and counts actions, not runs. The same panel owns MCP servers: it lists the configured stdio/http/sse servers, adds one (command plus one argument per line for stdio, or a URL), and removes one after a confirming click, persisting the whole list through `PUT /api/config`; invalid entries are refused with a 400 that names the problem. A provider can be edited in place: the row opens an inline form for its name, protocol, base URL, an optional replacement key and a clear-stored-key switch, saved through `PUT /api/providers/:id`, so an endpoint or key can change without losing the provider id or its role bindings. The terminal keeps its scrollback and command history across panel toggles in bounded local storage, recalls previous commands with ArrowUp/ArrowDown while preserving an unsent draft, and can clear its scrollback without forgetting history. Cmd/Ctrl+K opens a command palette that filters as you type, walks its rows with the arrow keys, runs the active row with Enter, and offers a Go to action for every workspace panel alongside new conversation, terminal, theme and composer-focus commands. Alt+1..9 jumps straight to a workspace panel (ignored while typing in a field), and each Go to row shows its chord. The workspace tab strip follows the ARIA tabs pattern: a single tab stop, Left/Right to move with wrap-around, Home/End to jump, focus following selection, and the panel labelled by its selected tab. The Git panel shows the index and worktree column of every change, stages or unstages one file, stages everything pending in one action, requests the staged diff for a fully staged file, and only offers Commit once a message exists and the index is not empty. The Preview panel remembers the last loopback URL, can Detect a running dev server on the usual ports (3000, 5173, 4173, 8080, 8000), reloads the proxied page with a fresh key, opens it in a real browser tab, and closes it. A running run can be stopped from the conversation header; a deliberate stop settles to idle with a dismissible notice instead of an error. Run state is per conversation: switching away resets the indicator, elapsed timer and Stop control, and the per-session replay re-establishes a run that is still active. A conversation runs at most one agent at a time: a second send while a run is working is refused with a 409 `RUN_ACTIVE` and the Send button stays disabled until that run finishes or is stopped. When a run finishes the rail re-reads the session list, so the ordering and relative times follow the server's last-updated timestamp without a reload. The live stream follows tab visibility: a hidden tab closes its SSE connection, so it costs no database polling, and reopening resumes from the last seen event id instead of replaying the session from the start. The browser tab title names the open conversation and prefixes a dot marker while a run is working or an approval is pending, so a background tab shows when the agent needs attention. Beyond chat, the composer, agent and CLI offer slash commands (`/plan`, `/build`, `/new`, `/compact`, `/fork`, `/undo`, `/init`, `/instructions`, `/model`, `/skills`, `/skill-new`, `/export`, `/terminal`, `/theme`) and your own prompt files, `@` file mentions and attachments, image attachments, a plan-to-build handoff, hooks, skills, permission rules with an Always allow button, a context meter, conversation fork, and the `--continue`, `sessions`, `--image` and `acp` CLI options (the last lets an ACP editor launch atelier). Each is described, with its limits and safety details, in [docs/FEATURES.md](docs/FEATURES.md). The header export button and an Export transcript palette action download the current conversation as a markdown file named from its title, with each message attributed and a timestamped footer.

## 📜 License

Free for personal use under the Aegean License 1.1 (AL-1.1); see [LICENSE](LICENSE). Any commercial use needs the Aegean Commercial License 1.0 (ACL-1.0); see [COMMERCIAL.md](COMMERCIAL.md).
