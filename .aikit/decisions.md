# Decisions

Why this project is built the way it is, oldest first. One entry per decision that changes a
contract, a dependency, a data format or the architecture; IDs are consecutive and never reused.

<!-- Entry format:
### ADR-NNN: <decision in one line>
- **Date**: YYYY-MM-DD
- **Status**: Accepted
- **Context**: <what forced the decision>
- **Decision**: <what was decided>
- **Consequences**: <what follows, including what it costs>
-->

### ADR-001: Node/TypeScript server with a React browser client
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: Atelier must be a fast local workspace with chat, files, git, terminal and preview, and the user chose a browser-first form factor over Electron/Tauri.
- **Decision**: Use Node 22+ with Hono and `@hono/node-server` on loopback, React 19 + Vite 8 for the client, and TypeScript everywhere. Keep the server and UI in one repository with explicit `server/` and `src/` boundaries.
- **Consequences**: No native desktop packaging in v1; the browser is the delivery surface. Vite dev proxies `/api` to the server. The production build serves `dist/` from Hono.

### ADR-002: SQLite WAL with explicit FULL and a durable event log
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: Sessions, messages, runs and effects need a durable commit primitive that survives process death without a second database. `better-sqlite3` bundles SQLite 3.53.4, which includes the WAL-reset fix.
- **Decision**: Use `better-sqlite3` in WAL mode with an explicit `PRAGMA synchronous=FULL` on the durable connection, `busy_timeout=3000`, `foreign_keys=ON`, 64 MB cache, 256 MB mmap and `wal_autocheckpoint=4000`. Persist only durable events; stream deltas are ephemeral. Schema version lives in `PRAGMA user_version`; a newer version is refused in place.
- **Consequences**: Critical writes pay one WAL fsync; bulk projections can use a second `NORMAL` connection later. `quick_check` runs on boot. `BEGIN CONCURRENT`/WAL2 are not used because they are unmerged branches.

### ADR-003: Crash-only lifecycle with a 3 s/30 s single-instance lock
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: A second writer or a half-written state file corrupts the workspace; AIKit PRINCIPLE-013 requires an advisory lock, 10 MB headroom, quarantine and recovery tests.
- **Decision**: `stop` is a crash and `start` recovers. Acquire `~/.atelier/runtime/server.lock` with a 3 s timeout and a 30 s stale takeover; heartbeat every 1 s. Check at least 10 MB free before state writes. On boot: refuse a newer schema, run `quick_check`, record a recovery decision, settle runs, then listen. Never auto-sweep temp files at startup; `atelier clean` owns that.
- **Consequences**: One server per state directory. A stale lock costs up to 30 s to take over; tests override the timeout. Orphan processes are reaped from the registry, not temp files.

### ADR-004: Five binding rules and M1 vertical slice
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: The plan review fixed five non-negotiable rules: as fast as possible, AI usage compatible, crash free, AI testable, and browser usage compatible. M1 must prove the shell and durability path before providers or tools.
- **Decision**: Ship M1 as a vertical slice: Hono auth/health/boot/recovery/session/message/SSE routes, SQLite schema 1, crash-only lock, React four-region shell, headless `verify`/`dogfood`/`crash:test`, browser and axe gates. Every milestone gate includes all five rules.
- **Consequences**: The agent loop, providers, files, git, terminal and preview remain M2–M6. The shell already writes messages through the durable log, so later features extend the same contracts instead of replacing them.

### ADR-005: UI contract and generated evidence
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: AIKit's UI and compat gates need a declared surface, protected tests, a fast proof, an inventory and before/after screenshots.
- **Decision**: Declare `.aikit/ui.json` with surface `app`, `src/**`, protected tests and `theme_paths=["src/theme.css"]`. Inventory is generated from `data-testid` attributes; `inventory.py` mirrors it for AIKit compat. `npm run ui:shots` writes before/after plus 390/768/1440 evidence to `shots/`.
- **Consequences**: A control without a stable test id is invisible to the inventory; adding one is part of the feature. Screenshots are regenerated, never hand-edited.

### ADR-006: Four provider protocols behind one canonical stream
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: M2 must support any model API without four separate chat paths in the UI. The protocols differ in auth, tool schemas and streaming event names.
- **Decision**: Implement `openai-chat`, `openai-responses`, `anthropic-messages` and `gemini` adapters behind `ProviderAdapter`. Each emits the same `StreamEvent` union (`text-delta`, `reasoning-delta`, `tool-arg-delta`, `tool-call`, `usage`, `finish`, `error`, `provider.failover`, `memo.replay`). SSE parsing handles CRLF, multiline data and stalls; 429/529 and 5xx retry with full jitter.
- **Consequences**: A provider is a config entry, not code. Capability gaps are lowered or rejected explicitly. The built-in model catalog is a fallback when a provider has no `/models` endpoint.

### ADR-007: Config/secrets state files and LLM memoization
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: Provider keys must never enter the repo, logs or API responses, and a crashed LLM step must replay without a second paid call.
- **Decision**: Store non-secret provider config in `~/.atelier/config.json` and keys in `~/.atelier/secrets.json` (0600, atomic temp+fsync+rename, `.bak` rotation, corrupt quarantine). Resolve keys environment-first, then secrets. Add SQLite schema v2 `llm_requests` keyed by `sha256(canonicalJson({providerId, request}))`; a replay returns recorded events with `memo.replay`. Provider status exposes only SET/MISSING.
- **Consequences**: Config and secrets are state files under PRINCIPLE-013. A newer schema is refused in place. Memoization covers complete streams only; failed or partial streams are not replayed.

### ADR-008: Durable runs, leases and the resume contract
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: A chat turn can outlive a request, crash mid-provider call, or be resumed concurrently. Messages alone cannot express ownership, progress or consume-once semantics.
- **Decision**: Add schema v3 `runs`, `run_steps`, `leases`, `interrupts` and `resume_requests`. A run owns a lease (5 s TTL, 1 s heartbeat) and one LLM step. Boot recovery expires leases, marks interrupted runs `blocked` with reason `interrupted`, and rebuilds the message projection from durable events once. `POST /api/runs/:id/resume` supports `retry` (CAS blocked→running) and `fork` (new run with parent/fork ids); duplicate resume keys are rejected. Stop aborts the in-flight provider call and marks the run blocked.
- **Consequences**: Two conversations run concurrently with independent leases. A crashed run is resumable or visibly blocked, never silently dead. Fork and retry never share an address; a retry clears the dead lease before claiming.

### ADR-009: Permissioned tool loop with an effect ledger
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: A single provider turn cannot edit, test and verify. A tool loop introduces duplicate side effects, path escapes, plan/build drift and shell abuse.
- **Decision**: Cap the loop at 8 steps. Tools are read/list/glob/ripgrep/write/edit/bash/git status/diff; every call passes a permission check (plan is read-only; build is workspace-scoped; secrets, `.git` and destructive commands are denied) and emits `access.decision`. Mutations use an intent row keyed by run/call/tool/args/pre-hash, then applied/failed with post-hash; a replayed applied effect returns its stored result without re-executing. File writes are temp+fsync+rename. Identical tool calls three times block the run as a doom loop.
- **Consequences**: Tool results feed back into the provider context. MCP tools, shadow-git checkpoints, approval prompts and staged compaction are deferred to M5–M6; the bash tool uses a shell with a 30 s timeout and 50k output cap.

### ADR-010: Workspace, git and terminal surfaces
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: M5 needs a usable file tree, editor, git panel and terminal without a new native dependency. The agent already has a path jail and atomic writer.
- **Decision**: Add workspace routes for tree/read/write/create/delete/rename with hash-conflict saves; git routes for status/diff/stage/unstage/commit/log; and a pipe-fallback terminal with a 30 s timeout, 200k output cap and process-tree stop. The UI renders Files, Git and Terminal panels with stable test ids.
- **Consequences**: Files and git are fully usable locally. PTY, worktrees, the preview proxy, MCP, shadow-git checkpoints and staged compaction are not yet implemented; the terminal is a command runner, not an interactive PTY.

### ADR-011: Deterministic eval lab and run audit
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: Harness changes need measurable evidence, and a run needs an independent check that every mutation had a permission decision and settled effect.
- **Decision**: Add a deterministic task suite (`evals/atelier-core/tasks.json`) that executes scripted tool steps against a temp workspace and checks acceptance, RR, CSR and ES. Add `auditRun` with L1 permission/decision checks, L2 unsettled-effect/failed-step checks and L3 workspace existence, exposed as `GET /api/audit/:runId`. `npm run eval` and `npm run perf` are the machine commands.
- **Consequences**: The suite tests the harness and tools without a paid model; it is not a model-quality benchmark. MCP, checkpoints, approvals, compaction, worktrees, PTY and preview remain deferred.

### ADR-012: Harness measurement ground and regression gate
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: Harness changes (loop, prompt, tools, context, permissions, recovery) can improve one task and regress another. A pass rate without a baseline, split and cost is not evidence.
- **Decision**: Add hashed `HarnessProfile` versions, a `FixtureProviderAdapter`, agent-mode tasks in a `dev`/`test` split, isolated temp workspaces, hidden checks/protected paths, eval_runs/eval_results/eval_baselines/harness_changes tables, Wilson/bootstrap/McNemar statistics, and `eval:baseline`/`eval:compare`/`eval:gate` commands. The gate is fixture-only and fast; real-provider runs are release-only. The test split is frozen and never used for tuning.
- **Consequences**: Harness changes now carry a version hash and a paired report. A candidate that loses two dev tasks or any integrity/CSR check is rejected. The suite is small, so the gate catches large regressions, not small gains; the test split is the release claim.

### ADR-013: Configured-provider eval and comparison view
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: The fixture gate is fast but cannot exercise real protocol behavior; comparing runs was CLI-only.
- **Decision**: Add `provider: "configured"` tasks that resolve the active atelier provider/model, a separate `atelier-real` release suite, and an Evals panel compare view backed by `/api/evals/baselines` and `/api/evals/compare`. The fixture gate remains the every-change command; configured-provider runs are release evidence.
- **Consequences**: Real-provider runs can be measured without changing the gate. The compare view reports delta, bootstrap CI, McNemar, flips and gate findings. A configured run still needs a provider and model in Settings.

### ADR-014: Read-only delegated subagent for r5
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: The measurement ladder needs a delegation rung, but the built-in loop had no subagent runtime. Faking delegation would make the rung meaningless.
- **Decision**: Add a `delegate` tool that creates a nested session/run in the same workspace, runs the `delegate-v1` profile (read-only tools, 3 steps, plan permissions), records `delegate.started/finished` events, and returns the nested answer as a tool result. The delegate profile cannot call `delegate`, so recursion is bounded. Add r5 to the dev suite and baseline-v4.
- **Consequences**: Delegation is measured with real nested runs. The subagent is read-only and bounded; it does not write files or spawn additional delegates. A failed delegate returns a blocked tool result, not a fake success.

### ADR-015: Quality mode for coding and long-recall benchmarks
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: The agent rungs measure harness behaviour, not model coding accuracy or long-context recall. ModelDuck already has both, but its suite is tuned for local GGUF models and is not wired into atelier's baselines.
- **Decision**: Add `mode: "quality"` tasks with exact/includes/regex/number checks and sandboxed `jsTests`. Coding output runs in `node --permission --no-addons` with a 5-second timeout; code fences and `export` prefixes are stripped first. Add a thirteen-task `atelier-quality` suite derived from ModelDuck shapes and public items: six coding items (including HumanEval/26 and MBPP/80), locker lookups, latest-status tracking, multi-needle recall, and 4k/8k/16k needle recall. Fixture tasks make the gate cheap; `--provider configured` runs the same prompts against a real provider.
- **Consequences**: Coding and long-recall quality are measured separately from harness rungs. The fixture gate proves the grader, while real quality claims require a configured-provider run. Prompt files are generated deterministically by `scripts/build-quality-suite.mjs`; the 16k task needs a context window that can hold it.

### ADR-016: Durable tool approvals
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: The UI claimed build-mode edits require approval, but edits and shell commands ran immediately. Approval must survive a slow user and a restart-capable event log.
- **Decision**: Add schema v6 `approvals` and a 60 s request window. In build mode, `write_file`, `edit_file` and `bash` create a durable pending approval, emit `approval.request`, and block the loop until `POST /api/runs/:id/approvals/:approvalId` resolves it or the deadline expires. The UI renders the pending tool, resource and reason with Approve/Deny controls, and consumes `approval.resolved` over SSE. Evaluation tasks pass an explicit auto-approve callback so fixture and configured-provider runs stay deterministic.
- **Consequences**: No build-mode mutation executes before a decision. Denials produce a denied tool result and an `access.decision` audit event; timeouts mark the approval expired. Approvals are deleted with their session. A blocked run still needs resume for long waits beyond the 60 s window.

### ADR-017: Staged context compaction and tool-output offload
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: The agent sent the last 40 messages raw. A 10k-line tool result or a long session could exceed the useful context, increase cost and truncate state unpredictably.
- **Decision**: Add a deterministic three-stage compactor. Tool results over 8k characters are written to `~/.atelier/artifacts/<run>/` and replaced with a 500-character preview plus the artifact path. Before each provider request on the `summary` profile, older messages are folded into a bounded `[compacted earlier context]` message and recent messages are kept within `contextTokens`. Every compaction emits `context.compacted` and every offload emits `artifact.offloaded`. `npm run bench:compaction` records the paired token/latency numbers required by G-006.
- **Consequences**: The prompt stays bounded without a second model call on the token path. The summary is deterministic and lossy; the artifact is the complete record. The `full-v1` profile now uses a 12k-token budget, so its harness hash and baselines moved to v5.

### ADR-018: Stdio MCP client and namespaced tools
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: The plan requires MCP tools to be callable by the agent without vendor lock-in. The provider adapter is stable, but external tools need discovery, namespacing and a process lifecycle.
- **Decision**: Add `mcpServers` to config and newline-delimited JSON-RPC clients for stdio, streamable HTTP and legacy SSE. On a run, initialize each server, list tools, expose them as `mcp__<server>__<tool>`, append them to the provider tool list under the `mcp` profile capability, and close the child in a `finally`. MCP calls are approval-gated in build mode and emit an `access.decision`. Fixture stdio, HTTP and SSE MCP servers prove discovery and calls. The config API exposes `mcpServers`; reconnect remains deferred.
- **Consequences**: Stdio, streamable-HTTP and legacy-SSE MCP tools work end to end and are auditable. A failed server is skipped with a recorded error rather than blocking the run. MCP side effects do not yet use the effect ledger; reconnect is not implemented. Preview proxying landed in ADR-021.

### ADR-019: Shadow-git checkpoints for pre-mutation restores
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: Edits and deletes had no undo path outside the workspace's own git history, and a UI save could overwrite an agent change with no recoverable pre-state.
- **Decision**: Add a shadow git loose-object store under `~/.atelier/checkpoints/<workspace-hash>` (blob objects plus JSONL metadata, no commit process). Before an agent edit or a UI write/delete/rename, `checkpointPath` writes only the affected path as a git blob and appends its metadata. Add `GET /api/checkpoints` and `POST /api/checkpoints/restore`; restoring first checkpoints the current file, then checks out the selected commit path. Emit `checkpoint.created` on agent mutations.
- **Consequences**: Pre-mutation state is recoverable per path without touching the workspace `.git`. Checkpoints are path-scoped, so directory-wide restores are not implemented; a checkpoint failure blocks the mutation rather than silently losing the pre-state.

### ADR-020: Git worktrees under the atelier home
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: Isolating a branch for a sub-task required leaving the app or risking the main working tree.
- **Decision**: Add `GET/POST/DELETE /api/worktrees`. Worktrees are created under `~/.atelier/worktrees/<workspace-hash>/<name>`, use a `worktree-<name>` branch by default, list via `git worktree list --porcelain`, and can only be removed from that root. Paths are compared with canonical real paths so Windows short names and long names match.
- **Consequences**: Worktrees are isolated from the main workspace and removable through the app. Nested worktree creation and branch conflict resolution are left to git's own errors; removal is always forced and limited to the atelier root.

### ADR-021: Loopback-only preview proxy
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: The Preview tab was a placeholder; loading a dev server directly would expose the app origin and framing policy to an arbitrary page.
- **Decision**: Add `GET /api/preview?url=` that accepts only loopback HTTP(S) URLs without credentials, refuses redirects, caps the body at 5 MB and 5 s, strips the target's framing/CSP headers, and returns a sandbox CSP. The UI loads the proxy URL in an iframe with `allow-scripts allow-forms allow-same-origin` and no top navigation.
- **Consequences**: Preview works for local dev servers without exposing arbitrary hosts. Relative asset URLs resolve against the proxy origin and may need the target to serve absolute asset URLs; directory-wide proxying is not implemented.

### ADR-022: Agent-performance budgets and baseline
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: "As fast as possible" needs a repeatable agent-level test, not only unit and integration durations.
- **Decision**: Add `npm run test:agent-perf`, a fixture-provider benchmark that runs real agent loops and measures p50/p95 for agent runs, tool dispatch, durable event commits, 500-event session switch and context compaction. Absolute budgets: agent 150 ms, dispatch 10 ms, commit 5 ms, session switch 80 ms, compaction 25 ms. A checked-in `.aikit/agent-perf-baseline.json` rejects a p95 more than 50% above baseline; compaction is excluded from relative comparison because it is sub-millisecond and noisy. `verify` runs the gate.
- **Consequences**: Agent-speed regressions fail `verify` with named metrics. The benchmark uses fixture providers, so it measures harness overhead, not model latency; a loaded machine can widen results, but absolute budgets are intentionally generous.

### ADR-023: Statistically meaningful agent benchmark
- **Date**: 2026-11-08
- **Status**: Accepted
- **Context**: A single agent timing is noise. "As fast as possible" needs repeated tasks with intervals and a paired baseline, not one run.
- **Decision**: Add `npm run bench:agent`, which runs four real fixture-provider agent tasks (`r0`, `r1`, `r2`, `r5`) ten times each and reports overall success with a Wilson 95% interval, bootstrap 95% latency intervals, and per-task mean/p50/p95. A checked-in `.aikit/agent-bench-baseline.json` stores per-run results; comparisons use bootstrap latency deltas and exact McNemar on pass flips. `verify` runs both the micro-perf gate and this benchmark. The benchmark itself uses the fast in-process fixture path and no model calls.
- **Consequences**: Agent-benchmark claims carry intervals and paired evidence. The benchmark is task-set specific and measures harness overhead, not model latency; changing the task set or repeat count requires a new baseline.

### ADR-024: Usage accounting from durable llm.usage events
- **Date**: 2026-11-09
- **Status**: Accepted
- **Context**: The status bar hardcoded `tokens 0` and `$0.00`, the Usage tab was a placeholder, and the agent loop discarded the usage record every provider adapter emits. The catalog already carries per-model input and output pricing, so an estimate needed no new dependency and no second model call.
- **Decision**: The agent loop appends one `llm.usage` session event per provider step with provider, model, prompt/completion/cached tokens, estimated cost, latency and a `replayed` flag. Cost is `(promptTokens * input + completionTokens * output) / 1e6` from the catalog; an unknown model or provider is recorded as `priced: false` with zero cost rather than guessed. Memo replays are recorded but priced at zero and excluded from billed totals. `GET /api/usage[?session=<id>]` aggregates the events into requests, replays, tokens, cost, unpriced and invalid counts and per-model totals; a malformed event increments `invalidEvents` instead of failing the request. The Usage panel shows session and global totals with the per-model breakdown, and the status bar shows the active session's live tokens and cost.
- **Consequences**: Token and cost figures survive restart because they live in the durable event log. They are catalog estimates, not a provider invoice; changing a price means updating that model's `pricing` entry. Replays cost nothing but still count as replays. The event type is additive, so no schema migration is required.

### ADR-025: Persistent plan objects and the Plans panel
- **Date**: 2026-11-09
- **Status**: Accepted
- **Context**: The Plans tab was a placeholder while the product promise is "plans in one fast UI". A finished plan-mode run left only an assistant message, with no persistent object, list or status to revisit, even though plan mode already made tools read-only.
- **Decision**: Add schema v7 `plans` (id, session_id, title, body, status, source_run_id, created, updated). A finished run whose profile is `plan` is saved automatically as a draft plan; the title is the first non-empty line with a markdown heading or list marker stripped, truncated to 80 characters. `createPlan`/`updatePlan`/`deletePlan` append `plan.created`/`plan.updated`/`plan.deleted` session events in the same transaction as the row write. `GET/POST /api/plans` and `GET/PATCH/DELETE /api/plans/:id` expose CRUD; deleting a session also deletes its plans. Statuses are `draft`, `active`, `done` and `archived`. The Plans panel lists plans for the active conversation, shows the body, edits title and body, changes status and deletes.
- **Consequences**: Plans survive restart and session switches and are auditable through the event log. There is no plan version history beyond that log, and a plan is a plain-text artifact, not a structured task graph. A plan-mode run that blocks or returns empty text creates no plan.

### ADR-026: Task panel over existing run contracts
- **Date**: 2026-11-09
- **Status**: Accepted
- **Context**: The Task tab was the last placeholder, while the server already exposed run lists, per-run durable steps, audit reports, retry/fork and stop. Diagnosing a blocked or failed run therefore required curl or the CLI.
- **Decision**: Add a UI-only Task panel that reads `GET /api/runs?session=`, `GET /api/runs/:id` and `GET /api/audit/:id`, and drives `POST /api/runs/:id/resume` (retry for a blocked run, fork with a generated fork id) and `POST /api/sessions/:id/stop`. The app refreshes the panel on `run.started`, `run.finished`, `run.blocked`, `run.resumed` and `run.forked`. No server contract, route or schema changes.
- **Consequences**: A conversation's run history, durable steps and audit findings are visible and actionable in one place. The panel shows the newest runs first and does not edit run state beyond the existing guarded retry, fork and stop operations; audit findings stay read-only.

### ADR-027: MCP calls join the effect ledger
- **Date**: 2026-11-09
- **Status**: Accepted
- **Context**: ADR-018 recorded that MCP side effects bypass the effect ledger, so a replayed run could re-execute a non-idempotent external tool while built-in tools returned their stored applied result. The agent's MCP branch called `hub.call` directly.
- **Decision**: Route MCP calls through `callMcpTool`, which keys an `effects` row by run/call/tool/args with no file pre-hash, returns the stored result when the row is `applied`, and settles the row `applied` or `failed` after the call. The agent's MCP branch uses it, so the run step stores the effect key.
- **Consequences**: Applied MCP calls are deduplicated on replay and audited like built-in tools. An intent row whose process died before settlement is retried, the same ambiguity the built-in ledger has; MCP calls still do not snapshot external state.

### ADR-028: Rebuild a dead MCP server for later calls
- **Date**: 2026-11-09
- **Status**: Accepted
- **Context**: The MCP hub is opened per run; a server that exited mid-run made every later call fail for that run. ADR-018 recorded reconnect as deferred, and blindly retrying the failed call could duplicate a non-idempotent external side effect.
- **Decision**: On a transport failure, the hub rebuilds that server's client, re-initializes it, re-registers its tools (dropping tools it no longer exposes), closes the stale client, and returns the original failure with a reconnect note. The failed call is not retried; a later call uses the fresh client. Closing the hub closes the original clients and any reconnected client.
- **Consequences**: A transient MCP server death no longer disables its tools for the rest of the run. The failed call still surfaces as a failed tool result and its effect row is settled `failed`, so the agent decides whether to call again; a server that cannot restart is recorded in `hub.errors` and stays unavailable.

### ADR-029: Checkpoint history and directory restore
- **Date**: 2026-11-09
- **Status**: Accepted
- **Context**: Checkpoints were path-scoped and had no UI. Recovering a folder or a deleted subtree required knowing every path and calling the API by hand, and ADR-019 recorded directory-wide restores as not implemented.
- **Decision**: Add `restoreDirectory`, which takes a workspace-relative prefix (empty = root), selects the latest checkpoint per path under it, reads every object before writing anything, checkpoints each current file as `pre-restore`, recreates missing parent directories, and writes the stored content. Expose `POST /api/checkpoints/restore-directory { path }` and add a History tab that lists checkpoints, restores one file, and confirms a directory restore in two steps. The panel refreshes on `checkpoint.created`.
- **Consequences**: A deleted subtree is recoverable and every directory restore is itself undoable through the pre-restore checkpoints. A directory restore is sequential and not transactional across files: a write failure stops the loop with earlier files restored, though every object is verified before the first write. `.git`, `node_modules` and the other skipped paths are refused.

### ADR-030: Directory-prefixed preview proxy
- **Date**: 2026-11-09
- **Status**: Accepted
- **Context**: The preview proxy fetched one HTML document, so relative and root-relative assets resolved against the atelier origin and a real dev-server page rendered without its CSS or scripts. ADR-021 recorded directory-wide proxying as not implemented.
- **Decision**: Add `POST /api/preview/session { url }`, which validates a loopback HTTP(S) base (adding a trailing slash) and returns a base64url token plus `/api/preview/<token>/`. A wildcard route under that prefix resolves the remaining path and query against the base and fetches through the existing loopback, redirect, 5 MB and 5 s rules. Textual HTML/CSS responses are rewritten so root-relative `src`/`href` and `url(/...)` references use the prefix; protocol-relative and external URLs are untouched. The Preview tab loads the session prefix in the sandboxed iframe; the single-document `GET /api/preview?url=` remains.
- **Consequences**: Relative assets work without target changes, and root-relative HTML/CSS assets resolve. Inline JavaScript that fetches an absolute path still targets the atelier origin, because only HTML/CSS references are rewritten. The token is stateless and carries the validated base, so no server-side registry is needed.

### ADR-031: Plan revision history
- **Date**: 2026-11-09
- **Status**: Accepted
- **Context**: Plans kept only their current title and body. `updatePlan` overwrote the row and `plan.updated` events omitted the body, so an earlier plan version could not be recovered.
- **Decision**: Add schema v8 `plan_revisions` (id, plan_id, title, body, status, created). `createPlan` and `updatePlan` insert a revision in the same transaction as the plan write; the v7→v8 migration backfills one revision per existing plan from its current row. Add `GET /api/plans/:id/revisions` and `POST /api/plans/:id/revisions/:revisionId/restore`; restore writes the revision's title and body through `updatePlan`, which records the restore as a new revision and keeps the current status. The Plans panel lists revisions and previews or restores one.
- **Consequences**: Every plan create, update and restore is recoverable and auditable through the revision table. Status-only updates also create a revision, so the history includes state changes. The list endpoint caps at 50 revisions and old revisions are not pruned automatically.

### ADR-032: One-click start with a detached browser opener
- **Date**: 2026-11-10
- **Status**: Accepted
- **Context**: The CLI accepted `--no-open` for parity but never opened anything, so first use required a terminal, `npm install`, `npm start`, copying a printed URL and pasting it into a browser. G-001 wants the fastest possible path to a usable workspace, and PRINCIPLE-011 forbids prompts and raw tracebacks on first run.
- **Decision**: Add `server/browser.ts`, whose `browserLaunch(url, platform)` maps a validated http(s) URL to `rundll32.exe url.dll,FileProtocolHandler` on Windows, `open` on macOS and `xdg-open` elsewhere, and whose `openBrowser` spawns it detached with `stdio: "ignore"`, unrefs it and reports failures through an injected callback. The server opens the workspace in the `listen` callback unless `--no-open` is passed; `scripts/runtime.mjs` always passes it for automated servers. Add `start.bat` and `start.sh`, which check Node >= 22.12, delegate to `scripts/start.mjs`, and pause on error so a double-clicked window stays readable. `scripts/start.mjs` now installs only when `node_modules/vite/bin/vite.js` is missing, builds only when an output is missing or older than the newest source, and every failure prints the What/Why/Fix triad.
- **Consequences**: Double-clicking `start.bat` or running `./start.sh` produces a running workspace in the default browser without terminal knowledge. Opening the browser is best-effort: a missing opener prints a triad and the server keeps running. Headless runs stay browser-free through `--no-open`, and a full rebuild is skipped when the build is current.

### ADR-033: Conversation search, rename and confirmed delete in the rail
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: The rail listed conversations but could not search message text, rename a conversation, or remove one, even though `GET /api/search`, `PATCH /api/sessions/:id` and `DELETE /api/sessions/:id` already existed. Every session stayed titled "New conversation" until the user manually changed it, and the only way to reach a specific conversation was scrolling.
- **Decision**: Move the rail list into `src/RailConversations.tsx`. It debounces a `GET /api/search?q=` query (200 ms, minimum two characters), filters titles locally, and shows matching messages as snippets that open their session. Rename runs inline with Enter saving and Escape cancelling; delete needs a second click on the same row before `DELETE` runs. `App` sends the first message of an untitled conversation to `PATCH /api/sessions/:id` so the title becomes the prompt prefix. The recovery banner becomes an informational tone because a successful recovery is not an error.
- **Consequences**: A conversation can be found, retitled and removed without leaving the rail, and a first message names its conversation. Search stays bounded to the 20 rows each endpoint returns, and title filtering over the loaded session list is immediate. Hidden action buttons reveal on hover or focus and stay visible on touch layouts.

### ADR-034: Live SSE delivery and conversation follow behavior
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: `GET /api/sessions/:id/events` wrote only the rows that existed when the stream opened and then sent heartbeats every 15 s. New durable events such as `run.started`, `approval.request`, `text.ended` and `run.finished` never reached an already-open browser, so approvals only appeared after a refresh and an assistant reply never appeared until the session was reloaded. The conversation column also never followed new messages, and message text could only be selected by hand.
- **Decision**: The SSE handler tracks the last emitted sequence, replays rows after `after`, then polls `listEvents` every 250 ms inside the stream and writes each new row with its sequence id; idle streams still send a heartbeat after 15 s. The conversation column tracks whether the viewport is within 80 px of the bottom, follows new messages while it is, shows a "Latest" pill once the reader is more than 240 px away, and resets to the bottom on a session switch. Each message gets a copy action that writes through `navigator.clipboard` and confirms for 1.5 s.
- **Consequences**: Approvals, run status and assistant replies now appear live in the open tab without a reload, and a reader who scrolled up is never yanked away by an arriving message. Polling costs one indexed SQLite read per 250 ms per open tab, bounded by the number of open browser tabs. Copying is best-effort; a denied clipboard permission leaves the message untouched.

### ADR-035: Dependency-free markdown for assistant replies
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: Assistant text was rendered as one pre-wrapped string, so headings, lists, emphasis and code fences appeared as literal punctuation. A chat workspace whose replies come from a model needs readable structure and copyable code, and the project only allows declared dependencies.
- **Decision**: Add `src/Markdown.tsx` with a pure `parseMarkdown`/`parseInline` pair and a renderer that emits React elements only. Blocks cover paragraphs, `#`/`##`/`###` headings, fenced code with a language label, unordered and ordered lists, blockquotes and horizontal rules. Inline spans cover code, strong, emphasis and links; a link renders only when it starts with `http(s)://` or `mailto:`. Fenced code blocks get a language header and a copy button. User messages stay plain pre-wrapped text.
- **Consequences**: Replies are readable without a markdown dependency, and raw HTML can never be injected because the renderer never sets innerHTML. The parser is deliberately small: code fences, headings, lists, quotes, rules and inline spans only; tables, nested lists and reference links stay literal text until needed.

### ADR-036: Per-conversation drafts, a working indicator and a growing composer
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: The composer held one `draft` string for the whole app, so selecting another conversation either leaked a half-written prompt into it or discarded it, and nothing in the conversation showed that a run was still working after the send button returned. The textarea was also a fixed 84 px box with a manual resize handle.
- **Decision**: Replace the single draft with a `Record<sessionId, text>` keyed by the active conversation (`"new"` before the first session exists), persisted to `localStorage` under `atelier.drafts` and restored automatically because the value is derived from the active key. While `runStatus` is `running`, the conversation renders a working row with three pulsing dots and an elapsed-second counter driven by a one-second interval that is cleared when the run settles. The composer starts at one row, grows with its content up to 240 px through `field-sizing: content` plus a `scrollHeight` fallback, and no longer shows the manual resize handle.
- **Consequences**: Switching conversations never loses typing, and a long run is visibly alive with its duration. Drafts stay on this device only and are never sent anywhere; a session deleted from the rail leaves its draft behind until local storage is cleared, which costs a few hundred bytes. Compilers without `field-sizing` fall back to the measured height.

### ADR-037: A second click guards file deletion and Cmd/Ctrl+S saves the editor
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: The Files panel deleted the open workspace file on a single click of the Delete button, which sits directly beside Save, and the save path required a mouse trip to that corner button. Deletion is irreversible from the UI and can discard work that the agent or the user just typed.
- **Decision**: The Delete button now arms on the first click (`Delete?`) and deletes only on the second, resetting whenever another file is opened or the open file is removed. A `saveRef` holds the newest `save` closure so a window-level keydown listener registered once can save on Cmd/Ctrl+S; the handler ignores the shortcut when there is no open file or when the draft already matches the stored content, and the header notes the shortcut while the buffer is dirty.
- **Consequences**: A stray click can no longer remove a file, and keyboard-only editing works end to end. Deletion still does not need a modal, and the confirmation is local to the panel, so the pattern matches the conversation delete guard. The shortcut is intercepted only when a dirty draft exists, so browser save-page still works everywhere else.

### ADR-038: Bounded, persisted terminal scrollback with history recall
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: The terminal drawer unmounts on every toggle, so its scrollback and every command typed disappeared on reopen, and there was no recall or clear action. Repeated inspection of the same command meant retyping it.
- **Decision**: Add `src/terminalStore.ts` with `readTerminal`/`writeTerminal` over `atelier.terminal`, `boundOutput` (last 400 lines), `pushCommand` (60 entries, skips an immediate repeat, ignores blank input), and corruption/throwing-storage tolerance. `TerminalPanel` seeds state from the store once, persists on every output or history change, ArrowUp walks from the newest entry toward older ones and ArrowDown walks forward while remembering the unsent draft, resets the cursor on typing or submit, and offers a Clear action that resets the scrollback to the header while keeping history. A hint shows how many commands the history holds.
- **Consequences**: Reopening the panel resumes the same session view, and a long-running command list is bounded to tens of kilobytes per browser. Output written by another tab is not merged because the panel owns its last write; the durable event log, not this scrollback, remains the audit trail.

### ADR-039: A raised error can be dismissed and does not follow a conversation switch
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: The shell error banner rendered its What/Why/Fix lines with no way to close them, so a single blocked run or failed request stayed pinned above the conversation for the rest of the session. Selecting another conversation also kept the previous conversation's error on screen.
- **Decision**: Wrap the banner text in `.banner-copy` and add a `×` dismiss button (`aria-label="Dismiss error"`) that clears the error state. The active-conversation effect clears any raised error when the selection changes, alongside the message and approval resets it already performs.
- **Consequences**: A resolved error is one click away from gone, and an error raised by one conversation no longer bleeds into another. Dismissing hides the report only; the durable event log and the Task panel still hold the underlying run reason, so nothing is lost for diagnosis.

### ADR-040: Settings owns the default provider and model, and blocks explain themselves
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: `PUT /api/config` already accepted `defaults.provider` and `defaults.model`, and `server/runner.ts` falls back to `defaults.model ?? provider.defaultModel ?? catalogFor(provider)[0]`, but Settings only exposed role bindings. A custom endpoint (a local server, a proxy) usually lists no catalog models, so after adding its key the first message blocked with `no_model` and the UI offered no place to choose a model. The block surfaced the raw code as its explanation.
- **Decision**: Add a "Default model" card to Settings with a provider select and a model input backed by a datalist. Selecting a provider fetches `GET /api/models?provider=` and fills the datalist; a failed listing prints that a model id can be typed instead, and the typed value is always kept. Changing the provider clears the model, since a model id belongs to its provider. Save sends `PUT /api/config` with `defaults` and reports the saved pair. Map the runner's `no_provider`, `provider_missing` and `no_model` codes to human why/fix text in the shell error banner; unknown reasons still pass through verbatim.
- **Consequences**: The first-run path is complete inside the UI: add provider with key, choose it as default, pick or type a model, send. Model suggestions cost one provider request per default-provider change and never block typing. The error banner now names the missing step rather than a machine code, while the raw reason stays in the durable `run.blocked` event for diagnosis.

### ADR-041: A keyboard-complete command palette
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: The palette already had a `data-active` row style and a `<kbd>` hint per action, but nothing ever set the active row and no key rerouted or ran a selection, so every command needed the mouse. The hints (N, S, T, C) named shortcuts that were never bound, and the only path to a workspace panel was the tab strip.
- **Decision**: Add `paletteIndex` state that resets to zero together with the query each time the palette opens. The query filters case-insensitively, the input handles ArrowDown/ArrowUp by clamping the index and Enter by running the active action, and rows expose `role="option"`, `aria-selected` and `data-active`, with the active row scrolled into view when the platform supports it. Generate a `Go to <panel>` action for every entry in the workspace tab list, and render a hint only where a real binding exists (terminal, Cmd/Ctrl+J). An empty result set renders a line naming the query.
- **Consequences**: Cmd/Ctrl+K plus a few characters and Enter reaches any panel, a new conversation, the theme toggle, the terminal or the composer without the mouse. The listbox roles and `aria-activedescendant` expose the active row to assistive technology. The palette no longer claims shortcuts it lacks, and its rows are discovered through `WORKSPACE_TABS`, so a new panel appears there automatically.

### ADR-042: The Git panel exposes staged and worktree state separately
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: `gitStatus` reduced `git status --porcelain=v1` to a single trimmed status letter, so a fully staged file looked identical to a modified one. `POST /api/git/unstage` and `GET /api/git/diff?staged=1` existed but no UI called them, and Commit was offered whenever a message was typed, failing inside git when the index was empty.
- **Decision**: Return `index` and `worktree` alongside `status` from `gitStatus` without removing the existing field. The Git panel renders both columns, enables Stage only when a worktree change exists and Unstage only when the index column holds a real status, adds a Stage all action that stages each pending path sequentially and refreshes once, requests the staged diff for a file that is staged with no worktree changes (and labels the diff header `· staged`), adds a Refresh button, and disables Commit unless a message exists and at least one change is staged, with a hint explaining the gate.
- **Consequences**: Staged versus unstaged work is visible, both directions are reachable per file, and Commit can no longer be pressed into a guaranteed git failure. Stage all makes one request per pending file, which keeps the existing single-path contract; a repository with hundreds of dirty files would issue hundreds of quick requests and would deserve a server-side bulk route.

### ADR-043: Performance percentiles aggregate time-ordered batches
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: `scripts/agent-perf.ts` measured p95 over one uninterrupted run of samples. On a development machine shared with an editor and launcher (32% CPU observed), a single scheduler stall inside a 40-run, ~0.6 s measurement moved `agentRunP95Ms` from ~20 ms to 36 ms, and a stall in the 200-sample commit loop pushed `commitP95Ms` to 5.18 ms against a 5 ms budget, failing gates that passed seconds later unchanged. Every such failure cost a full 10-gate rerun.
- **Decision**: Keep every budget and the baseline +50% rule exactly as they were, but report `agentRunP95Ms`, `toolDispatchP95Ms` and `commitP95Ms` as the median of the p95 values of consecutive time-ordered batches (3 batches of 42 after 3 warmup runs, 4 batches of 25, and 4 batches of 50). A regression that raises the distribution raises every batch and still fails; a single stall now inflates one batch and is rejected by the median. This is a measurement change only: no budget was relaxed and no failing condition was removed, and `compactionP95Ms` and `sessionSwitchP95Ms` stay excluded from the baseline comparison as before.
- **Consequences**: The gate is stable on a busy workstation without hiding a real slowdown, and a failure now means a broad shift rather than one stall. Because the change touches a gate, this ADR names it explicitly for PRINCIPLE-014 R1 awareness; reviewers can compare batch p95 values by rerunning the script, which still prints the aggregate numbers.

### ADR-044: Preview controls for reload, real-tab open, close and port detection
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: The Preview panel took a loopback URL, created one proxy session and rendered an iframe, then forgot everything: the URL reset to a hard-coded default on every remount, a stale page could only be refreshed by retyping the URL, the sandboxed frame could not be handed to a real browser tab, the frame could not be closed, and the user had to know which port their dev server listens on.
- **Decision**: Remember the URL in `atelier.preview.url`. Add Reload, which re-creates the session and bumps a `nonce` used as the iframe `key` and a `?r=` query so the frame remounts instead of serving a cached document (the preview proxy already sends `Cache-Control: no-store`, so the key only guarantees a fresh mount). Add Open in new tab through `window.open(prefix, "_blank", "noopener,noreferrer")`; the proxy URL is a same-origin GET, so the browser sends the session cookie and no new auth path is needed. Add Close to drop the frame. Add Detect, which probes `http://127.0.0.1:{3000,5173,4173,8080,8000}/` in order by creating a preview session and issuing one bounded GET to the proxy prefix, cancelling the body, and loading the first answer; when nothing answers the panel says which ports were tried.
- **Consequences**: A preview survives panel switches, can be refreshed, promoted to a full tab or dismissed, and one click finds a running dev server. Detection costs at most one session request plus one GET per candidate, stops at the first live port, and cannot reach any non-loopback host because the existing session validation refuses it. Open in new tab keeps `noopener` so the proxied page cannot reach back into the app window.

### ADR-045: A deliberate run stop is a neutral outcome, not an error
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: `POST /api/sessions/:id/stop` aborts the active run, marks it `blocked` with `blockedReason: "stopped"` and appends `run.blocked { reason: "stopped" }`. The conversation header already had a Stop button, but it set the client status to `blocked`, and the `run.blocked` handler mapped every reason through the error path, so the user's own stop produced a red "Run blocked — stopped" banner and a red status bar.
- **Decision**: Treat `stopped` as a deliberate outcome. The header Stop disables itself while the request is in flight, then sets the status to idle, clears any error and shows a dismissible `banner-ok` notice ("Run stopped."). The `run.blocked` listener branches on the reason first: `stopped` takes the same neutral path, every other reason keeps the mapped error banner. The notice clears when a message is sent, when the conversation changes, or on its own dismiss button.
- **Consequences**: A stop reads as a successful user action and leaves no lingering red state, while genuine blocks (missing provider, missing model, provider failure) still explain themselves. The durable `run.blocked` event with reason `stopped` remains the audit record, so the neutral UI does not hide what happened from the log or the Task panel.

### ADR-046: Approval decisions can carry a note and cannot be double-submitted
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: `POST /api/runs/:id/approvals/:approvalId` accepts `{ decision, reason? }` with a 500-character reason, but the approval dock sent only the decision, so a denial left no human explanation in the record. Both buttons also stayed enabled while the request was in flight, and a second click would post a decision for an approval that was already resolved.
- **Decision**: Give each pending approval an optional note input (`maxLength` 500) bound by approval id in `approvalNotes`. A decision sends `{ decision, reason }` with the trimmed note, or `{ decision }` alone when the note is blank. A per-approval `approvalBusy` id list disables both buttons for that card while its request runs, leaving other cards actionable. A success removes the card and its note; a failure keeps both and shows the error banner. Both lists reset when the conversation changes or the pending list reloads.
- **Consequences**: A deny can explain itself, and an approval cannot be decided twice from an impatient double-click. The note is transient UI state that lives only until the decision is posted; the durable record is the approval row and its resolution event, which already carry the reason.

### ADR-047: Conversations can be pinned and archived from the rail
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: The sessions table has had `pinned` and `archived` columns since schema v1, `listSessions` already sorted by pinned first and hid archived rows, and `PATCH /api/sessions/:id` accepted both flags. But the select never returned them, `GET /api/sessions` had no way to ask for archived rows, and the rail offered only rename and delete, so archiving was unreachable (and effectively equivalent to deletion) and pinning did nothing visible.
- **Decision**: `SessionRow` and the `Session` type carry `pinned` and `archived`; `listSessions(handle, { archived })` selects them and filters on the requested side; `GET /api/sessions?archived=1` returns the archived set. The rail gains a Show archived toggle (with an "empty" line for that view), a star prefix on pinned rows, and Pin/Unpin plus Archive/Unarchive actions per row. Archiving from the active view drops the row and moves the selection to the next conversation; archiving from the archived view removes it from that list. Either action leaves a dismissible notice, and the notice is no longer cleared by a conversation switch so the confirmation survives the selection change.
- **Consequences**: Frequently used conversations stay pinned at the top, finished ones leave the active list without losing their messages, and an archived conversation can be found and restored. Archiving is one click and reversible, so it sits next to the guarded delete without needing its own confirmation. The rail's action cluster grows to four icons, revealed on hover or focus.

### ADR-048: A conversation can be exported as a markdown transcript
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: `GET /api/sessions/:id/export` can stream a session as ndjson, but nothing in the UI calls it, and an ndjson event dump is a developer artifact rather than something a user can keep or share. Once a session ends there was no way to take the conversation out of the app.
- **Decision**: Add `src/transcript.ts` with a pure `conversationMarkdown(title, messages, exportedAt)` that puts the title in an H1, attributes each message under `## You` or `## Atelier`, notes an empty conversation, and ends with an ISO export stamp; a `transcriptFilename` that NFKD-normalizes, strips characters unsafe for a filename, collapses whitespace to hyphens and caps the base name at 60 characters; and `downloadTranscript`, which builds a `text/markdown` Blob, creates an object URL, clicks an anchor with the derived download name, and revokes the URL, reporting `false` instead of throwing when the browser blocks it. The conversation header gains an Export control enabled only when messages exist, and the command palette gains an Export transcript action; both raise the standard dismissible notice on success and a What/Why/Fix error on failure.
- **Consequences**: A finished conversation can be saved as a readable file from the header or the keyboard palette. The helper takes injectable download dependencies, so its formatting and failure paths are unit tested without a real browser download; the app keeps the existing ndjson endpoint for full-fidelity event export.

### ADR-049: Run state belongs to the active conversation
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: `runStatus`, `stopping` and the elapsed timer were app-wide state set by sending a message and by the active session's event stream. Selecting another conversation never cleared them, so a conversation with no run inherited "running": the working row kept counting, the header offered Stop, and pressing it posted to a session with no active run and surfaced a 404 error.
- **Decision**: Reset `runStatus` to idle and `stopping` to false at the start of the active-conversation effect, before the per-session fetch and event stream are set up. Because the stream replays the session's own history, a conversation whose latest run is still running re-establishes the running state through its replayed `run.started`, while one with a finished run ends at idle and one with no runs stays idle.
- **Consequences**: The working indicator, elapsed counter and Stop control always describe the conversation on screen, and Stop can no longer target the wrong session. The reset is client-side only; durable run rows remain the authority for the Task panel.

### ADR-050: The tab title announces work and pending approvals
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: The document title was the constant "atelier". A run keeps working after the send click and an approval blocks the loop until decided, but with the tab backgrounded a user could not tell from the tab strip whether the agent was busy or waiting on them, which are the two states that need attention.
- **Decision**: A derived effect sets `document.title` from the active conversation title, `runStatus` and the pending approval count. With nothing pending it is `<conversation> · atelier` (or `atelier` with no conversation); while running it is `● Working · <conversation>`; while any approval is pending it is `● Approval needed · <conversation>`, taking precedence over working because it is the state that blocks progress. The effect reads only existing state and does not persist anything.
- **Consequences**: A glance at the tab strip now shows the open conversation and whether the agent is working or blocked on a decision. The leading dot is a plain text marker rather than a favicon change, so it works in every browser and screen reader without extra permission prompts, and the title resets automatically when a run finishes or the approval is decided.

### ADR-051: One agent run per conversation at a time
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: `startSessionRun` appended the user message and started `executeRun` without checking for an already-running run, and `stopSessionRun` aborts only the newest running run in the session. Sending a second message mid-run therefore executed two agents against one conversation: interleaved assistant messages, two leases, two event streams, and a Stop that left the older run alive.
- **Decision**: `startSessionRun` first looks for a `running` run in the session and refuses with `AtelierError("RUN_ACTIVE", ...)` naming the active run and telling the user to stop it or wait. The Hono error handler maps `RUN_ACTIVE` to 409 (the first non-404/400 mapping). The client returns early from `sendMessage` with a dismissible notice when `runStatus` is running, disables the Send button for the duration and changes the composer hint to "Run in progress: Stop to send another message", so the Cmd/Ctrl+Enter path and the button agree.
- **Consequences**: A conversation has at most one agent, so Stop always controls the process that is producing output and messages cannot interleave. A second send is refused before a message is appended, so the durable log gains no orphan user message. The client-side lock is a courtesy that follows the same event stream as the working indicator; the server guard is authoritative and also covers another tab.

### ADR-052: Providers can be edited in place
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: Settings could add and remove a provider but not change one. Correcting a typo, moving a local endpoint to another port, switching protocol or rotating a key required deleting the provider and adding it again; deleting also drops its derived id, so any `defaults.provider` or role binding that referenced it silently points at nothing. `PROVIDER_NOT_FOUND` also surfaced as a 500.
- **Decision**: Add `PUT /api/providers/:id`, validated by the same `providerInput` schema plus an optional `clearKey` flag. The route keeps the path id (so the id and its bindings survive), preserves any advanced fields the client does not send (`apiKeyEnv`, `defaultModel`, `fallbackId`, `headers`, `timeoutMs`), replaces the stored key only when `apiKey` is present, and deletes it only when `clearKey` is true. The Settings provider row gains an Edit action that swaps the summary for an inline form (name, protocol, base URL, optional replacement key, clear-stored-key), with Save and Cancel. `PROVIDER_NOT_FOUND` now maps to 404.
- **Consequences**: An endpoint, protocol, name or key can be corrected without losing the provider's identity or the bindings that point at it, and a stale stored key can be removed while keeping an environment-based key. Secrets still never render: the update response carries only SET/MISSING and the source. Editing is per row and disabled while saving, and the inline form replaces the row rather than stacking under it.

### ADR-053: The rail refreshes its session order when a run finishes
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: `appendMessage` bumps `sessions.updated` and `listSessions` orders by pinned then updated, but the client loaded sessions only at boot, when creating a conversation, or when a PATCH returned the list. After a run produced output, the conversation kept its old rail position and its relative time stayed frozen at page load, so the most recently active conversation could appear below stale ones.
- **Decision**: On `run.finished`, call a quiet refresh that re-reads `/api/sessions` for the current view and replaces the list. The view flag is read from a ref so the stream handler does not need to reconnect when the Archived toggle changes, and a failed refresh is swallowed because the durable log and the next boot remain authoritative. The reload keeps `activeId`, since it is about ordering rather than selection.
- **Consequences**: The rail follows server order and relative times after every completed run at the cost of one small GET per run. If another tab archived the active conversation, the refreshed active list no longer contains it; the messages still load, and the next boot or an archives toggle reconciles the selection.

### ADR-054: The event stream follows tab visibility and resumes from the last id
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: Every open tab held an SSE connection whose server loop polls the event table every 250 ms for its lifetime, including while the tab was hidden, and every stream opened with `after=0`, so each reconnect replayed the whole session. A window left in the background therefore kept a CPU-waking poll running and a reconnect re-read history it had already applied.
- **Decision**: Track the highest `lastEventId` seen by any listener in a ref and open the stream with `after=<that id>`, resetting it to zero when the conversation changes. Watch `visibilitychange` and keep the EventSource open only while the document is visible: hiding closes it and reports the stream as idle, showing reopens it from the stored id, so nothing is missed and no polling happens in the background. The visibility state lives in a dedicated effect so the stream effect can depend on it without re-registering handlers.
- **Consequences**: A background window stops waking the server and SQLite entirely, and a reopen catches up from the exact last applied event instead of replaying the session. Because the id is per conversation and reset on switch, a resumed stream never skips another session's events. If events are pruned from the log between hide and show, the replay starts at the requested id and simply returns the rows that remain.

### ADR-055: MCP servers are configured from Settings
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: The config schema has carried `mcpServers`, `GET/PUT /api/config` read and wrote it, and `agent.ts` opens an `McpHub` over that list when the profile includes `mcp`. Settings exposed providers, a default model and role bindings but no MCP surface at all, so the only way to add a server was to hand-edit config.json. Config validation errors also surfaced as 500 rather than 400.
- **Decision**: Add `McpServerConfig`/`McpTransport` to the client types and an "MCP servers" card to Settings. The card lists each server with its id, transport and target, adds a stdio server from a name, command and one argument per line (arguments may contain spaces), adds an http/sse server from a URL, and removes one only after a confirming second click. Every change PUTs the whole `mcpServers` array and adopts the array the server returns. `CONFIG_INVALID`, `CONFIG_PROVIDER` and `PROVIDER_INVALID` now map to 400 so a malformed entry reads as a client error.
- **Consequences**: MCP servers can be added, inspected and removed from the app with the same validation the API enforces, and the next agent run opens the saved list. Because the whole array is replaced per save, two tabs editing MCP at once last-write-wins, which matches the existing config contract. Secrets in server env/headers are stored in config.json as before; the card shows the target but never expands env or header values in the list.

### ADR-056: UI changes are compared with paired before and after screenshots
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: G-006 asked UI changes to refresh before/after screenshots, but nothing required the pair to be inspected, and `npm run ui:shots` overwrote the same five files on every run. The pre-change image was therefore destroyed at the moment it was needed, so a layout defect could ship with "screenshots refreshed" recorded as evidence. The first use of the new flow immediately found one: the workspace tab strip clipped its last two tabs at 1440 because it scrolled horizontally instead of wrapping.
- **Decision**: Add project rule **G-007** (source: user): every UI change runs `npm run ui:before` on the unchanged tree, makes the change, runs `npm run ui:after`, inspects each pair at 390/768/1440 for clipping, overlap, contrast and stale copy, and records the finding in the task checkpoint. Back it with tooling: `scripts/ui-shots.mjs` accepts an optional validated label and writes into `shots/<label>/`, naming the two document states `empty` and `conversation`; the unlabeled path keeps the exact legacy filenames for `ui:shots`; `package.json` adds `ui:before` and `ui:after`. The tab strip now wraps instead of scrolling, so all nine panels are reachable without a hidden overflow.
- **Consequences**: A UI change has a durable pre-change capture that survives the edit, and its checkpoint can cite the comparison instead of a refresh. The paired run doubles screenshot time when both are taken, which is acceptable because it is bounded and explicit. Shots stay gitignored, so the evidence is the recorded finding plus a rerun rather than committed binaries.

### ADR-057: Recovery reports only real actions, in the right unit
- **Date**: 2026-11-11
- **Status**: Accepted
- **Context**: The `ui:before` capture of a brand-new temp home still showed "Recovered 1 run(s)" above an otherwise empty state. `recoverOnBoot` pushed a `projection rebuilt (0 message event(s))` action whenever the version marker was absent, which is every fresh database, and the banner rendered `actionCount` as "run(s)" even when the actions were expired leases, unknown effects or a projection rebuild.
- **Decision**: Record the projection rebuild action only when it actually projected at least one message, while still setting the `projection_version` marker so the next boot is clean. Change the banner to "Recovered N action(s)" and keep its existing What/Why/Fix and dismiss behavior. The boot DB test now asserts a fresh boot is clean with the marker set, that a rebuild over one assistant message records `projection rebuilt (1 message event(s))`, and that the following boot is clean; a shell test asserts the action wording.
- **Consequences**: A first start is silent unless something was genuinely recovered, and a real recovery describes its actions honestly instead of calling every action a run. The recovery log still records every boot, so the history remains auditable even when the result is clean.

### ADR-058: Aesthetic and ease-of-use rule with machine-checkable style invariants
- **Date**: 2026-11-12
- **Status**: Accepted
- **Context**: The UI had rules for speed, compatibility, testability and screenshot evidence, but none for whether it looks and feels good. The header and status bar also displayed a fixed "profile: full" even though profiles are not selectable and runs execute the plan/build mode, so the interface asserted something untrue in its two densest strips, and one panel carried an inline margin instead of a theme-driven class.
- **Decision**: Add project rule **G-008** (source: user): colors, spacing and type come from theme tokens rather than raw values; controls share one visual grammar with a visible focus state; each surface has one obvious primary action and destructive actions are tinted and confirmed; labels name real behavior; nothing is clipped, overlapping or unreachable at 390/768/1440; the G-007 before/after pair is the review evidence. Back it with `tests/integration/aesthetic.test.ts`, which fails on raw hex colors in components, a missing global focus-visible treatment, a resurrected static profile label, or a layout margin in an inline style. Apply it: remove the static profile pill and status segment, and replace the Preview panel's inline margin with a `.panel-gap` class. README's binding rules now list six.
- **Consequences**: The aesthetic expectations are explicit and partly machine-checked, so a component cannot drift back to hardcoded colors or inline spacing unnoticed. Removing the profile label makes the header and status bar truthful and slightly quieter; the space it used is now available to the mode group and header controls. The remaining checks are structural proxies for taste, so the paired screenshots remain the human review; the guard exists to catch drift, not to judge design.

### ADR-059: Panel chords and a truthful status bar
- **Date**: 2026-11-12
- **Status**: Accepted
- **Context**: G-008 requires labels to name real behavior and controls to be easy to use. The status bar printed a fixed "main" that no code ever verified against the workspace's actual branch, and the nine workspace panels could only be reached by clicking the tab strip or opening the palette and typing, even though the palette already presented per-row hints.
- **Decision**: Capture Alt+1..9 in the global key handler and switch to the corresponding panel from the single WORKSPACE_TABS list, opening the workspace drawer so the jump is visible on narrow layouts; the chord is ignored when the event originates in an input, textarea, select or contentEditable field, and modifiers that include Ctrl or Cmd are left alone. Give every palette Go to row its Alt+digit hint. Remove the hardcoded "main" segment from the status bar; real branch state remains available through the Git panel, which reads it from git.
- **Consequences**: Every panel is one chord away and the palette teaches the chord, while a digit typed into a field is never intercepted. The status bar no longer asserts a branch it never read, which is the truthful-label half of G-008; the Git panel remains the single source for branch data.

### ADR-060: A per-panel screenshot sweep, and a truthful Evals compare card
- **Date**: 2026-11-12
- **Status**: Accepted
- **Context**: G-007 required before/after evidence, but ui:shots only captured the default Files view, so the other eight workspace panels were never reviewed. The first sweep found the Evals Compare row rendering two unlabelled selects in a pill row: with no baselines or runs they showed only a bare chevron and looked broken, and Compare was clickable with no candidate.
- **Decision**: Add `scripts/ui-panels.mjs` and `npm run ui:panels`, which starts a temporary UI, creates one conversation so session-scoped panels render, then clicks each tab and captures a full-page shot into shots/panels (or shots/panels/<label> when given before or after, with the same validated-label guard as ui-shots). Guard its npm binding in the workflow test and document it in the README. Fix the Compare card found by that sweep: baseline and candidate become labelled fields in the shared role grid, each select shows an explanatory "No baselines yet" or "No harness runs yet" option and disables when empty, and Compare is disabled until a candidate exists. Two component tests pin the labelled and empty states.
- **Consequences**: Every panel now has reviewable evidence, and the same labeled mode gives true before/after pairs per panel. The Compare card reads correctly before any eval exists instead of looking like a rendering bug. The sweep adds nine screenshots per run, which is bounded and only used during UI work.

### ADR-061: UI review is measurement-based because this agent cannot see images
- **Date**: 2026-11-12
- **Status**: Accepted
- **Context**: G-007 requires inspecting before and after screenshots, but every image read in this session returned that the model cannot accept image input. The review step had therefore been resting on code and DOM inferences rather than observation, which risks asserting a visual defect that was never observed and missing one that was. Screenshot files remain useful to a human reviewer, but an agent without vision needs executable assertions.
- **Decision**: Add `scripts/ui-audit.mjs` and `npm run ui:audit`. It starts a temporary UI and, at 390, 768 and 1440, records page-level horizontal overflow, every workspace tab's rectangles and whether each stays inside the workspace, visible controls smaller than 24x24, and labels whose content is clipped, writing a JSON report to shots/audit/report.json. It exits non-zero on page overflow or a tab outside the workspace. The workflow guard test asserts the npm binding. Findings from the first run were fixed: the Archived toggle measured 23 px tall and now has a 24 px minimum, and the long workspace path already ellipsized now carries a title with the full path. The rerun reports zero undersized controls and zero overflow at all three widths.
- **Consequences**: Layout claims can cite numbers instead of impressions, and a future agent can review UI without image support. The audit covers measurable properties only; hierarchy, tone and visual polish still need a human or a vision-capable reviewer, and the generated screenshots remain the artifact for that pass. Clipped labels are reported as information because ellipsis is intentional in some places.

### ADR-062: Per-panel audit, wrapping help prose, and title-aware clipping
- **Date**: 2026-11-12
- **Status**: Accepted
- **Context**: The audit measured only the default view, and it flagged two clipped labels that turned out to be full help sentences rendered with `.provider-meta`, a class that forces a single line with ellipsis. It also reported the header's intentional ellipsis (which has a title with the full path) as if it were a defect, so real clipping and deliberate truncation were indistinguishable.
- **Decision**: Extend `ui-audit.mjs` to click through all nine workspace tabs at 1440 and record page overflow, visible controls under 24x24 and clipped labels for each panel in the report's `panels` array. Treat an element with a non-empty title as intentional truncation and exclude it from clipped counts. Let paragraphs carrying `.provider-meta` wrap (`white-space: normal`, `overflow-wrap: anywhere`) while spans keep the single-line metadata style. The rerun reports zero clipped labels in every panel and at all three widths.
- **Consequences**: Every panel now has measured layout evidence, and hidden help text is no longer possible in that class. The audit distinguishes a deliberately ellipsized label from an accidentally hidden one by requiring a title, which also nudges future truncation toward being self-explaining. Screenshot artifacts are refreshed for human review; the numbers are the agent-checkable part.

### ADR-063: The workspace tab strip follows the ARIA tabs keyboard model
- **Date**: 2026-11-12
- **Status**: Accepted
- **Context**: The strip declared `role="tablist"` and `role="tab"` but every tab was its own tab stop and arrow keys did nothing. A keyboard user had to Tab through nine buttons to leave the strip, which contradicts the interaction the roles promise, and the panel had no programmatic link back to its tab.
- **Decision**: Give the tabs roving tabindex, with `0` only on the selected tab and `-1` on the rest; handle ArrowRight and ArrowLeft with wrap-around, plus Home and End, on each tab, moving selection and focus together; and wire `aria-controls="workspace-panel"` from every tab to a panel that carries `aria-labelledby` pointing at the selected tab's id. Alt+1..9 remains as a direct jump. A shell test presses each key, asserts the resulting panel, the focused element and the roving tabindex.
- **Consequences**: The strip now matches the standard tabs pattern: one tab stop, arrows within the strip, Home/End at the edges, and the panel is nameable by assistive technology from its tab. The change is keyboard-only, so the before/after screenshots are byte-identical at all three widths and are recorded that way; the DOM test is the evidence of behaviour. Adding a tenth panel keeps working because everything derives from WORKSPACE_TABS.

### ADR-064: commitP95Ms samples a thousand commits so checkpoint timing stops deciding the gate
- **Date**: 2026-11-12
- **Status**: Accepted
- **Context**: `commitP95Ms` measured 200 `appendSessionEvent` calls and compared the p95 against a 5 ms budget. Because SQLite checkpoints the WAL periodically, a checkpoint that lands inside the 200-sample window lifts a small number of commits toward the spike value and moves the p95 to about 5 ms; a window without one measures about 3.6 ms. The gate therefore passed or failed depending on checkpoint timing, and it did fail once at exactly 5.0 with no code change behind it.
- **Decision**: Raise the commit sample to 1000 inserts and aggregate the metric as the median of five consecutive batch p95 values, keeping the 5 ms budget and the existing baseline and +50% rule exactly as they were. With 1000 samples a handful of checkpoint-affected commits fall below the 95th percentile, so the metric reports steady commit latency while still reacting to a broad slowdown. This is a measurement change; no threshold moved.
- **Consequences**: Three consecutive runs reported 3.55, 3.60 and 3.76 ms, leaving real headroom under the unchanged 5 ms budget, and the gate no longer flips on checkpoint timing. The perf gate takes roughly two seconds longer, which is acceptable for a gate that runs before delivery. A genuine regression that affects ordinary commits still raises every batch and fails the median.

### ADR-065: One shell grammar from radius, spacing and glow tokens
- **Date**: 2026-11-12
- **Status**: Accepted
- **Context**: The shell mixed radii (6, 7, 8, 9, 10, 12, 14 px) and raw light-theme values: `body` painted the same dark blue radial glows in both themes, so the light workspace opened under an unintended dark wash. The workspace tabs were folder-style tabs that looked broken once they wrapped into a second row, `select` had no global focus ring, and the approval dock declared `display`/`gap` twice.
- **Decision**: Add radius, spacing, control-height, easing, glow and scrim tokens to `:root`, override the glow and scrim in `[data-theme="light"]`, and point the body background, scrim, radii and shared control transitions at them. Replace the folder tabs with an even auto-fit grid of pill tabs so a wrapped row still looks deliberate, add a hover state and an accent-tinted selected state. Add `select:focus-visible` to the one global focus rule, add hover/feedback to send and approval buttons, a `:focus-within` accent ring on the composer, tabular numerals in the status bar, token-driven scrollbars, and remove the duplicated declarations. Extend `tests/integration/aesthetic.test.ts` to require the new tokens, the body glow binding and the light-theme override.
- **Consequences**: Dark and light themes now share one visual grammar, and the light theme no longer inherits dark glows. Controls change state consistently on hover and focus, and every interactive element including selects shows the same visible ring. The tab strip keeps all nine panels reachable at 390/768/1440 while gaining an even, calmer shape; it still wraps to two rows at 390 and at a 420 px workspace, which `ui:audit` confirms fits without overflow. The test pins the token layer so a future edit cannot silently drop it, but taste remains a human review item.

### ADR-066: Atelier opens in its own app window, not a browser tab
- **Date**: 2026-11-12
- **Status**: Accepted
- **Context**: `start.bat`, `start.sh` and `npm start` finished by calling the OS file handler, so atelier appeared as a normal browser tab complete with tab strip, address bar and bookmarks. The app is a single-purpose local workspace, and modelduck already launches its UI as a `--app` window; the user asked for the same.
- **Decision**: `server/browser.ts` now resolves a Chromium-based executable (Edge first, then Chrome, then Chromium; `ATELIER_BROWSER` overrides it) and launches it with `--app=<url> --window-size=1440,900 --no-first-run`, which renders the UI in a window with no browser chrome. Resolution is per platform (Program Files and LOCALAPPDATA on Windows, app bundles on macOS, PATH lookup on Linux) and entirely injectable (`platform`, `env`, `exists`) so tests never open a browser. When nothing is found, the previous file-handler launch is used unchanged; `--no-open` and the `open` option used by every test and script still bypass launching, and `browserLaunch(..., { appWindow: false })` forces the old behaviour. The launcher message and README now describe the window rather than a browser.
- **Consequences**: Double-clicking `start.bat` yields a desktop-feeling atelier window, and the same command still works headlessly. The window is owned by the user's installed Edge/Chrome process, so it shares that browser profile; no extra dependency or bundled runtime is introduced. Anything that prefers a tab can set `ATELIER_BROWSER` to a browser that ignores `--app`, or pass `--no-open` and open the printed URL.

### ADR-067: Agent tool parity — durable search, multi-edit, native tool turns, and a real system prompt
- **Date**: 2026-11-12
- **Status**: Accepted
- **Context**: The agent had a broad tool list but four gaps against Claude Code, opencode and command code: `ripgrep` failed outright when `rg` was not installed (this machine has no `rg`), `edit_file` could only replace one unique occurrence and there was no multi-edit, the follow-up request after a tool call dropped the assistant's tool-call items so OpenAI-family and Anthropic conversations could not legally continue, and `promptVersion: "agents-md-v1"` claimed a prompt that did not exist — no system message and no workspace instructions were ever sent.
- **Decision**: (1) Add `server/search.ts` with a bounded workspace walker that skips `node_modules`, `.git`, build output and caches, a `**`-aware glob matcher, and a binary-safe text search honoring `include`, `ignoreCase`, `fixed` and hit caps; `ripgrep` keeps `rg` when present and falls back to it otherwise, and `glob`/`list_dir` reuse the same walker with caps. (2) `edit_file` gains `replaceAll`; new `multi_edit` validates every edit against the evolving text and writes once, so a failed edit leaves the file untouched. (3) `bash` gains `timeoutMs` (1 s to 10 min) and a real asynchronous runner whose timeout kills the whole process tree, because a sync child left orphaned grandchild processes holding the workspace directory locked on Windows. (4) `ChatMessage` carries `toolCalls`; the agent records the assistant tool-call turn before tool results, and each adapter sends it natively — OpenAI `tool_calls`, Responses `function_call`/`function_call_output`, Anthropic `tool_use` blocks with merged `tool_result` user blocks, Gemini `functionCall`/`functionResponse`. (5) New `server/prompt.ts` builds the system prompt from a tool contract plus `AGENTS.md`/`CLAUDE.md` (8,000 character cap), and the agent keeps that system message outside compaction. The full harness profile moves to 40 steps and a 24,000-token compaction budget, and approval gating derives from each tool's declared action instead of a hardcoded name list.
- **Consequences**: The agent can search and edit on a machine with no external tools, multi-step tool use is valid for all four protocols instead of only working with the fixture adapter, and project instructions actually reach the model. Tests pin the wire format per protocol, the prompt injection and cap, multi-edit atomicity, the built-in search, and the timeout path. The larger step and context budgets cost more tokens per hard task; `eval:gate` and `eval:quality:gate` stayed at mean 1.000 with the existing baselines, so no task regressed.

### ADR-068: A live tool-activity feed inside the conversation
- **Date**: 2026-11-13
- **Status**: Accepted
- **Context**: A run could spend forty steps reading, searching and editing, and the conversation showed only a "working" dots row and an elapsed timer until the final answer arrived. Claude Code and opencode both stream tool activity inline, so the agent looked stuck and a wrong tool call was invisible until it was too late to stop it. The durable `tool.result` event existed but carried no human-readable target, and the transcript only rendered messages.
- **Decision**: Record a bounded `detail` (the resource already computed for approval decisions) on every `tool.result` event. Add `src/ActivityFeed.tsx`, rendered between the transcript and the composer: it subscribes to the existing session SSE stream, resets on `run.started` and on conversation switch, folds duplicate call ids, keeps the newest 40 items in state and shows the latest six, labels each tool through a small map (Read, Edited, Ran, Searched, Delegated, or `Called <server> · <tool>` for MCP), and marks `ok`/`failed`. `Details` selects the Task panel and opens the workspace drawer; a finished run keeps its "Last run" feed until it is dismissed. The feed is pure presentation: replaying the durable event log repopulates it after a reload, and nothing new is persisted.
- **Consequences**: Tool work is visible while it happens, so a run can be stopped before it does damage and a failure is legible without opening the Task panel. The feed is advisory UI: the durable log and the Task panel remain the record. Measured at 390/768/1440 with six rows: the feed stays at the 18 px conversation inset, every row is a single line, no row overflows its box and the page has no horizontal overflow; screenshots are in shots/activity. The CSS was initially inserted inside the 560 px media query, which the measurement caught (margin collapsed to 0 at 768 and 1440) and the rule now lives at top level.

### ADR-069: A durable, UI-visible task list the agent maintains itself
- **Date**: 2026-11-13
- **Status**: Accepted
- **Context**: On multi-step work the agent reported only tool chatter; the user could not see the intended plan, what was done, or which step was current, and after a reload even the activity feed was gone. Claude Code exposes a maintained todo list, and the existing Plans tab only stores one-shot plan documents from plan mode.
- **Decision**: Add a `todo_write` tool that replaces the conversation's task list as a durable `todo.updated` session event, `server/todos.ts` to validate it (at most 20 items, text <= 200 characters, unique ids, statuses `pending|in_progress|completed`, at most one in progress, deterministic `todo-N` ids when omitted, throwing `AtelierError` with what/why/fix on violation), and `GET /api/sessions/:id/todos` returning the newest list. The agent intercepts `todo_write` in its loop — it is a cheap, read-action metadata write, so it is neither approval-gated nor sent through the file tool path — returns a one-line summary (`1/3 complete; now: …`) so the model sees state immediately, and the tool is part of the full profile and the system prompt. `src/TodoStrip.tsx` renders the list above the activity feed with a progress bar, count, current item, strikethrough completions, `max-height` scroll, and it loads from the API on conversation switch and is replaced live by the `todo.updated` SSE event.
- **Consequences**: The user can see the plan and progress while the run is in flight, and the list survives reloads and restarts because it lives in the event log rather than component state. The list is advisory: the agent may finish without one for short tasks, and it never blocks a tool call. Measured at 390/768/1440 with four items: 18 px inset at every width, no clipped item text, no page overflow, and the strip clears the composer at every size; screenshots in shots/todos. Validation tests cover normalization, every rejection, persistence of the newest list, the agent interception event and summary, the component states, and the live-stream replacement.

### ADR-070: Edit approvals show the exact diff before anything is written
- **Date**: 2026-11-13
- **Status**: Accepted
- **Context**: Build mode paused every write for approval, but the dock only named the tool, the path and a generic reason. The user had to approve blind, then read the result in the Files tab or the activity feed after the file was already changed. Claude Code and opencode both show the pending change before it applies. The edit logic also lived inline in two tool bodies, so a preview could drift from what execution actually did.
- **Decision**: Extract the exact-string edit semantics into pure functions in `server/edits.ts` (`applyTextEdit`, `applyMultiEdit`) and make `edit_file`, `multi_edit` and `server/editPreview.ts` call them, so preview and execution cannot diverge. Add `server/diff.ts` with a bounded LCS line diff (context-trimmed to three lines, capped at 400 rendered lines, with an O(n·m) guard that degrades to whole-file replace) and `renderDiff`. Add `server/editPreview.ts` which resolves the path through the same workspace jail, reads the current file, applies the edit in memory, and returns `{ path, tool, diff, added, removed, truncated, created }` capped at 8,000 characters. Schema 9 adds `approvals.preview`; `requestApproval` persists it and includes it in the `approval.request` event, the agent computes it only for `edit` actions in build mode, and `src/DiffView.tsx` renders it in the dock as a `<details>` open by default with `+n/−n` stats and per-line colouring.
- **Consequences**: A write cannot happen without the user seeing precisely what changes, including a newly created file, and the diff is recomputed from the same code path that will run. Preview work happens once per approval, in memory, before the tool executes; a failed or ambiguous edit yields an empty preview rather than an error, and the approval still proceeds to the normal tool error. Measured at 390/768/1440: the diff spans the dock width on its own row (328/706/710 px), the panel is open with the expected stats, a long line scrolls inside the pre without page overflow (0 px), and screenshots are in shots/diff. Tests cover diff counting, context trimming, path jailing, new-file previews, the approval row and event payload, the empty preview for command approvals, and the component states.

### ADR-071: Scriptable headless runs with honest exit codes
- **Date**: 2026-11-13
- **Status**: Accepted
- **Context**: Every run went through the HTTP server and the workspace window, so atelier could not be used from a script, a CI job or a shell pipeline. Claude Code and opencode both accept a one-shot prompt and print the result, and users asked for atelier quality and features on that level.
- **Decision**: Add an `atelier run <prompt>` command. Flag parsing and run validation move to `server/cli.ts` (pure, testable: positionals, `--mode`, `--session`, `--yes`, `--json`, a `--` terminator, and a what/why/fix validator). `server/headless.ts` resolves the home, opens the database, recovers, creates or resumes a conversation, records the user message and run, and executes it through the same `executeRun` path as the server by passing an options object with an `approve` callback and an optional adapter override. The default mode is plan (read-only); build mode has no approver, so the callback throws a specific `HEADLESS_APPROVAL` error and the run blocks immediately instead of waiting out the 60 s approval timer, unless `--yes` is passed, which approves everything and prints a warning to stderr. Output is the assistant text on stdout plus a summary on stderr, or one JSON object with status, text, run/session ids, step and tool counts and usage. Exit codes are 0 finished, 1 blocked and 2 invalid usage. `server/runner.ts` gains an optional `ExecuteOptions` pass-through; the server path is unchanged.
- **Consequences**: atelier can now be scripted (`atelier run "fix the failing test" --mode build --yes`) and fails loudly and quickly when a build run cannot be approved rather than hanging a pipeline. `--yes` is deliberately explicit, warned about on stderr, and it cannot be combined with plan mode. Verified end to end against a local OpenAI-compatible server: a plan run printed the answer with exit 0, a build run without `--yes` exited 1 with the approval reason and wrote nothing, a build run with `--yes` exited 0 and wrote the file, and an unknown mode exited 2 with the error triad. Unit tests pin parse and validation; integration tests cover plan, session continuation, blocked approval, auto-approval, empty prompts and unknown sessions.

### ADR-072: Slash commands and prompt files in the composer
- **Date**: 2026-11-14
- **Status**: Accepted
- **Context**: The composer only sent text. Claude Code and opencode offer typed commands and reusable prompts, and switching mode, starting a conversation or exporting needed the mouse. Recorded retroactively: this and the following ADRs describe contract changes made earlier in the 2026-11-13/14 work and not written down at the time (PRINCIPLE-004 R4).
- **Decision**: Typing `/` opens a menu of built-in commands (`/plan`, `/build`, `/new`, `/compact`, `/fork`, `/undo`, `/init`, `/instructions`, `/model`, `/skills`, `/skill-new`, `/export`, `/terminal`, `/theme`) and of prompt files. A prompt file is a markdown file in `.atelier/commands/` or `.claude/commands/` (`.atelier` wins a name clash), optionally with a `description:` frontmatter line; `$ARGUMENTS` is replaced by the text after the command, or the text is appended when absent. At most 100 files of 20 KB each. `GET /api/commands` serves them. An unknown `/name` is refused with a notice and never sent to the model; Enter runs a line whose first word is a known command. Pure parsing lives in `src/slash.ts`, discovery in `server/commands.ts`.
- **Consequences**: Prompt files written for Claude Code work unchanged. The command set and file locations are now a public contract; renaming a built-in breaks muscle memory and scripts that rely on it. Commands load once at start and are refreshed by `/skills` and `/skill-new`.

### ADR-073: Skills as on-demand SKILL.md bundles
- **Date**: 2026-11-14
- **Status**: Accepted
- **Context**: Flat prompt files cannot carry a procedure the agent should follow only when it applies. Claude Code, Codex, Antigravity and Vibe all use a `SKILL.md` folder convention.
- **Decision**: A skill is `.atelier/skills/<name>/SKILL.md` or `.claude/skills/<name>/SKILL.md` (`.atelier` wins) with optional `name:` and `description:` frontmatter, at most 30 skills of 50 KB, descriptions cut at 200 characters. The system prompt lists each skill's name, description and path and tells the agent to read one with `read_file` only when it clearly matches, so nothing is loaded up front and there is no new tool. Every skill is also a `/name` command; an explicit command file wins a clash. `GET /api/skills` lists them and `POST /api/skills` (`/skill-new`) scaffolds one from a template without ever overwriting (409 `SKILL_EXISTS`, 400 for a bad name or a multi-line description).
- **Consequences**: Skills stay inside the existing permission model because reading one is an ordinary file read. The prompt grows by one line per skill. Skill files are instructions the agent follows, so a writable skill folder is an attack surface, which ADR-078 addresses.

### ADR-074: Attachments are stored as markers, images as content-addressed blobs
- **Date**: 2026-11-14
- **Status**: Accepted
- **Context**: Users wanted to point the agent at files (`@path`) and screenshots, and the stored message text is replayed to the model, exported and summarised, so how an attachment is represented is a data format.
- **Decision**: On send, the server appends the contents of mentioned workspace files (at most 5, 12,000 characters each, secret-named files skipped) as `<attached_file path="...">` blocks to the stored user message. Images are uploaded with `POST /api/images` (`{mediaType, data}`; png, jpeg, gif or webp, 5 MB, magic bytes checked), stored once under `blobs/img_<first 16 hex of sha256>.<ext>`, written through a temp file, fsync and rename and verified against the hash on read, and referenced from the message only by `<attached_image id="..."/>`; `GET /api/images/:id` serves them. A run takes an optional `images` id list (at most 4). Each provider adapter maps images to its wire format. A model the catalog marks `vision: false` is refused before any provider call. The CLI gains `--image <file>` (repeatable). The transcript and exports show attachments as chips or names, never their bytes.
- **Consequences**: Messages stay small and replayable and a torn write cannot leave a corrupt image trusted forever. The two marker formats are now part of stored history and must stay parseable. A model without a declared vision flag is sent the image and any provider error is shown as is.

### ADR-075: Tool hooks with a veto
- **Date**: 2026-11-14
- **Status**: Accepted
- **Context**: Teams want deterministic guardrails and automation around tool calls without changing the agent. Claude Code and Command Code offer hooks.
- **Decision**: Config gains `hooks: [{ id, event: "pre_tool" | "post_tool", match, command, timeoutMs }]` (`match` is a regular expression over the tool name, default `.*`; timeout 100 ms to 60 s, default 10 s). A hook runs in the workspace with `ATELIER_HOOK_EVENT`, `ATELIER_TOOL`, `ATELIER_TOOL_INPUT` (first 8,000 characters), `ATELIER_RUN_ID` and `ATELIER_SESSION_ID`, plus `ATELIER_TOOL_OK` and `ATELIER_TOOL_OUTPUT` for `post_tool`. A `pre_tool` hook that exits 2 vetoes the call before any approval prompt and its output goes to the model as `Blocked by hook <id>: ...`; any other exit code, a timeout or a failure to start is recorded only; `post_tool` never blocks. Every result is stored as a `hook.result` event. Hooks keep the server's environment because the user wrote them (ADR-077).
- **Consequences**: The environment variable names, the exit-code convention and the `hook.result` event are a contract for hook authors. Hooks run sequentially inside the tool loop, so a slow hook delays that call up to its timeout. Only two events exist; richer events and structured decisions are future work.

### ADR-076: Permission rules decide whether to ask, never whether something is safe
- **Date**: 2026-11-14
- **Status**: Accepted
- **Context**: In Build mode every edit and command prompted. Peers let users pre-approve routine actions and pre-refuse risky ones.
- **Decision**: Config gains `rules: [{ id, action: "exec" | "edit", match, decision: "allow" | "deny" }]`; `match` is literal text with `*` as a wildcard over the whole command or path. A matching deny always wins and refuses without asking, even with `--yes`; otherwise the first matching allow skips the prompt. An allow never covers a command containing `&&`, `||`, `;`, `|`, `&`, redirection, backticks, `$(` or a newline, nor an edit path that climbs out with `..`. Edit paths are normalised before matching (separators, `./`, `//`, `..`, lower case on Windows) and commands have whitespace collapsed, with denies also ignoring case on Windows, so spelling cannot dodge a deny. Rules only decide whether to prompt: the checks in `executeTool` (secrets, paths outside the workspace, destructive commands) still run afterwards. Each decision is an `access.decision` event naming the rule, and the approval dock's Always allow saves an exact-match allow rule.
- **Consequences**: Command rules are text matches, not parsed commands, and are documented as not a security boundary. There is no `ask` rule type yet, so a deny and an allow are the only outcomes besides the default prompt.

### ADR-077: Commands the agent runs get a scrubbed environment
- **Date**: 2026-11-14
- **Status**: Accepted
- **Context**: Verified on 2026-11-14 by running the real tools with fabricated keys: the `bash` tool, the terminal and hook commands all inherited the server's whole environment, so any approved or injected command could print provider keys. MCP stdio servers received `{ ...process.env, ...server.env }`, including after a crash and restart.
- **Decision**: The agent's `bash` tool and MCP stdio servers (first start and restart) get the server's environment without secret-shaped variables: a name where KEY, TOKEN, SECRET, PASSWORD, PASSWD or CREDENTIAL(S) is a whole word or a joined form such as APIKEY ends the name, plus every provider's `apiKeyEnv` variable. Config gains `shellEnvPassthrough: string[]` (variable names, case-insensitive), carried by `GET` and `PUT /api/config`, to let chosen variables through. A server's own `env` entries are always passed. Hooks and the user's terminal panel keep the full environment because the user wrote or runs them. Implemented in `server/shellEnv.ts`.
- **Consequences**: Legitimate commands that need `GITHUB_TOKEN`, `NPM_TOKEN` or `AWS_*` fail until those names are listed. This narrows one leak and is not a sandbox: the same user's files, including `~/.atelier/secrets.json`, remain readable by an approved command, so the shell must still be treated as unsandboxed.

### ADR-078: The agent's own configuration is never auto-approved
- **Date**: 2026-11-14
- **Status**: Accepted
- **Context**: Instruction files, skills, commands and settings are injected into every later run, so a prompt injection that can write one persists. Only `.git` and secret-named files were protected; verified on 2026-11-14 that `.atelier/`, `.claude/`, `.agents/`, `AGENTS.md` and `CLAUDE.md` could be edited with an ordinary approval or covered by an allow rule.
- **Decision**: A path is protected when it is, or sits under, a `.atelier`, `.claude` or `.agents` directory, or is named `AGENTS.md` or `CLAUDE.md`, at any depth and in any spelling or case. An edit of a protected path is never auto-allowed by a rule (a deny still applies), and headless `--yes` refuses it for that call. An interactive approval by a person still works. Implemented as `isProtectedConfigPath` in `server/rules.ts` and the headless approver.
- **Consequences**: `/init` and any agent change to these files always need a person. The approval dock still offers Always allow for such a path, which is harmless because the rule cannot take effect; hiding the button is deferred to the next UI batch.

### ADR-079: Conversation operations and hidden delegate conversations
- **Date**: 2026-11-14
- **Status**: Accepted
- **Context**: Long conversations degrade and users want to branch or revert. A delegate call also created internal helper conversations that cluttered lists and search, and `atelier run --continue` could pick one.
- **Decision**: `POST /api/sessions/:id/compact` summarises the newest 16,000 characters of a conversation (attachment bodies reduced to names, 120 s timeout, never memoised) with the configured provider and opens a new conversation titled `Compacted: <title>` seeded with the summary; 400 `COMPACT_EMPTY`, 502 `COMPACT_FAILED`. `POST /api/sessions/:id/fork` copies the messages up to and including an optional `messageId` into a new conversation in one transaction; 400 `FORK_EMPTY`. `/undo` restores the newest checkpoint through the existing restore route, and a second `/undo` redoes it because a restore snapshots first. Delegate helper sessions, identified by a run with a parent run id (`DELEGATE_SESSIONS_SQL`), are excluded from the conversation list, search and the CLI sessions list but stay readable by id.
- **Consequences**: Compact and fork never modify the original. Hiding delegates changes what `GET /api/sessions` and `/api/search` return. A conversation's usage totals now include its delegates (ADR-083).

### ADR-080: CLI additions for resuming, listing and images
- **Date**: 2026-11-14
- **Status**: Accepted
- **Context**: `atelier run` could continue a conversation only by id and could not list conversations or attach images, unlike Claude Code's `-c` and Kilo's session commands.
- **Decision**: `atelier run` gains `--continue` / `-c` (the most recent conversation, an error when there is none, not combinable with `--session`) and a repeatable `--image <file>` (png, jpeg, gif or webp, at most 4, validated before any conversation is created). `atelier sessions [--json]` lists conversations newest first. `@path` mentions in a headless prompt attach file contents as in the UI. Exit codes stay 0 (finished), 1 (blocked or failed) and 2 (invalid usage), each with a What/Why/Fix message.
- **Consequences**: The new flags and the `sessions` output are a scripting contract. Output remains a single JSON object with `--json`; streaming output and turn or budget caps are not provided yet.

### ADR-081: Only local Host headers are answered
- **Date**: 2026-11-14
- **Status**: Accepted
- **Context**: The server issued a session cookie and a script-readable CSRF cookie from an unauthenticated bootstrap route and never inspected the Host header, so a page on an attacker's domain rebound to 127.0.0.1 could obtain both and reach the whole API, including the terminal.
- **Decision**: Every request, including the page and the cookie bootstrap, must carry a Host naming `localhost`, a `*.localhost` name or an IP literal (IPv4, or IPv6 in brackets, any port), or a plain DNS name listed in the new environment variable `ATELIER_ALLOWED_HOSTS` (comma separated; wildcards, ports and paths are ignored). Anything else gets `421 HOST_REJECTED` before any cookie is set. When no Host header is present the request URL's host is used. Implemented in `server/hosts.ts` as the first middleware.
- **Consequences**: A reverse proxy or custom name needs `ATELIER_ALLOWED_HOSTS`. LAN access by IP address keeps working. The error response tells the user the fix.

### ADR-082: The path jail follows links
- **Date**: 2026-11-14
- **Status**: Accepted
- **Context**: `resolveInside` checked paths lexically, so a symlink or junction inside the workspace could read or create files outside it; verified with a real junction on 2026-11-14.
- **Decision**: After the lexical check, the nearest existing ancestor of the path is resolved with `realpath` and must lie inside the real workspace; a path that cannot be resolved is refused (fail closed). `@` mentions also skip secret-named files.
- **Consequences**: A workspace that relies on a link to a folder outside it loses that access through the file tools. The extra `realpath` call per file operation measured within noise (tool dispatch P95 4.56 ms with, 4.65 ms without).

### ADR-083: Usage totals include delegates and expose the context window
- **Date**: 2026-11-14
- **Status**: Accepted
- **Context**: A delegate's spend was invisible in its parent conversation, and users could not see how full the context window was.
- **Decision**: `GET /api/usage?session=` adds the usage of the conversation's delegate sessions to its totals and reports them separately as `delegated: { requests, costUsd }`; the all-conversations view does not add them again. It also returns `last` (the latest billed request) and `context: { providerId, model, usedTokens, windowTokens | null }`, with the window taken from the catalog or the provider's own model list. The status bar shows `ctx N%`, amber from 70% and red from 90% with a `/compact` hint, and a plain token count when the window is unknown. Usage events are read in order.
- **Consequences**: Cost for a conversation is now the cost of everything it triggered. The meter reflects the latest request's prompt size, which already includes automatic compaction.

### ADR-084: Skills are also read from .agents/skills
- **Date**: 2026-11-14
- **Status**: Accepted
- **Context**: ADR-073 read skills from `.atelier/skills` and `.claude/skills`. Codex, Antigravity and Vibe use `.agents/skills`, so skills written for those tools did not appear in atelier.
- **Decision**: `loadSkills` also reads `.agents/skills/<name>/SKILL.md`. When a name exists in more than one folder, `.atelier` wins over `.agents`, which wins over `.claude`. All three share the cap of 30 skills, and `/skill-new` refuses a name defined in any of them. ADR-073 is otherwise unchanged and is not edited.
- **Consequences**: A repository can share one skills folder across tools. `.agents/` was already a protected configuration folder under ADR-078, so the agent still cannot add a skill there without a person approving it.

### ADR-085: Permission rules gain an ask decision
- **Date**: 2026-11-14
- **Status**: Accepted
- **Context**: ADR-076 had only allow and deny, so a broad allow rule such as `git *` could not exclude one dangerous subcommand. Claude Code, Kilo, Command Code and Antigravity all order rules deny, then ask, then allow.
- **Decision**: A rule's `decision` may be `"ask"`. The order is deny, then ask, then allow. An ask rule matches the way a deny does (normalised paths, collapsed whitespace, case folded on Windows, chained commands included) because asking is the safe direction. A matched ask always reaches a person: the approval prompt names the rule, and the approver callback receives an `explicitAsk` flag so that headless `--yes` refuses the call. The `approve` callback type in `server/runner.ts` and `server/agent.ts` gains that fourth parameter.
- **Consequences**: Existing `rules` files load unchanged. The Settings card and the client type still offer only allow and deny; ask rules are written in `config.json` or through `PUT /api/config` until the next UI batch. The callback signature change affects any caller that passes its own approver.

### ADR-086: Live token deltas travel on an in-memory channel, not in the event log
- **Date**: 2026-11-14
- **Status**: Accepted
- **Context**: Provider output was collected whole and stored as one message, so a client saw an answer only when it was finished. Writing every token to the durable event log would duplicate each answer in the log, add a synchronous database write per flush, and make the log's replay semantics depend on a transient stream.
- **Decision**: Add `server/liveStream.ts`, a per-session in-memory publish and subscribe channel, and an `onEvent` observer on `collectProvider`. The agent loop publishes each provider `text-delta` as `{ type: "text.delta", runId, step, text }`. `GET /api/sessions/:id/events` forwards live events to its subscriber as `event: text.delta` frames carrying no `id:` line, serialised with the durable frames on the same stream, so a reconnect with `Last-Event-ID` still resumes from durable events only. Deltas are never stored; the finished message and `run.finished` remain the durable record. A throwing subscriber or observer cannot affect a run.
- **Consequences**: A client that connects late or reconnects mid-answer misses earlier deltas and receives the complete message when the run ends. A replayed (memoised) request produces no deltas. The browser UI does not yet draw deltas; that is part of the planned UI batch. An ACP agent running in the same process can subscribe directly. Measured cost: 3.5 ns per delta with no subscriber, 20 ns with one.
