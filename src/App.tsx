import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, ensureAuth, ApiError } from "./api";
import type { Approval, Boot, Message, CheckpointEntry, RuleConfig, Session, UsageSummary } from "./types";
import type { TodoItem } from "./TodoStrip";
import RailConversations, { type SearchHit } from "./RailConversations";
import Markdown from "./Markdown";
import { downloadTranscript } from "./transcript";
import { splitAttachments } from "./attachments";
import { imageProblem, readBase64 } from "./images";
import { alwaysAllowRule, isProtectedConfigPath } from "./rules";
import { applyLiveEvent, type LiveText } from "./live";
import { contextView } from "./context";
import { activeMention, applyMention, rankFiles } from "./mention";
import { BUILTIN_COMMANDS, INIT_PROMPT, expandTemplate, matchCommands, parseSlash, type SlashCommand } from "./slash";
import SettingsPanel from "./SettingsPanel";
import FilesPanel, { type OpenRequest } from "./FilesPanel";
import GitPanel from "./GitPanel";
import TerminalPanel from "./TerminalPanel";
import EvalsPanel from "./EvalsPanel";
import PreviewPanel from "./PreviewPanel";
import UsagePanel from "./UsagePanel";
import PlansPanel from "./PlansPanel";
import TaskPanel from "./TaskPanel";
import HistoryPanel from "./HistoryPanel";
import ActivityFeed, { appendActivity, type ActivityItem } from "./ActivityFeed";
import TodoStrip from "./TodoStrip";
import DiffView from "./DiffView";

type Mode = "plan" | "build";
type WorkspaceTab = "files" | "git" | "history" | "plans" | "preview" | "task" | "usage" | "settings" | "evals";
type Theme = "dark" | "light";

interface ErrorState {
  what: string;
  why: string;
  fix: string;
}

const WORKSPACE_TABS: ReadonlyArray<{ id: WorkspaceTab; label: string }> = [
  { id: "files", label: "Files" },
  { id: "git", label: "Git" },
  { id: "history", label: "History" },
  { id: "plans", label: "Plans" },
  { id: "preview", label: "Preview" },
  { id: "task", label: "Task" },
  { id: "usage", label: "Usage" },
  { id: "settings", label: "Settings" },
  { id: "evals", label: "Evals" },
];

const QUICK_PROMPTS: ReadonlyArray<{ title: string; prompt: string }> = [
  { title: "Explain this repository", prompt: "Map this repository and explain its architecture." },
  { title: "Fix a failing test", prompt: "Run the test suite, find the first failure, and fix it." },
  { title: "Review my changes", prompt: "Review the current diff for correctness and regressions." },
  { title: "Write a plan", prompt: "Write a short implementation plan for the next feature." },
];

function toErrorState(error: unknown): ErrorState {
  if (error instanceof ApiError) return { what: error.message, why: error.why, fix: error.fix };
  return {
    what: error instanceof Error ? error.message : String(error),
    why: "The request did not complete.",
    fix: "Check that the atelier server is running, then retry.",
  };
}

function providerMissing(boot: Boot | null): boolean {
  return boot !== null && boot.providers.every((provider) => provider.key.source === "missing");
}

const BLOCKED_REASONS: Record<string, { why: string; fix: string }> = {
  no_provider: {
    why: "No provider is configured yet.",
    fix: "Open Settings, add a provider with its key, set it as the default, then send again.",
  },
  provider_missing: {
    why: "The configured provider no longer exists.",
    fix: "Open Settings and choose a default provider that is still listed.",
  },
  no_model: {
    why: "The default provider has no model to call.",
    fix: "Open Settings and set a default model for the provider.",
  },
};

function blockedReasonError(reason: string | undefined): ErrorState {
  const known = reason === undefined ? undefined : BLOCKED_REASONS[reason];
  return {
    what: "Run blocked",
    why: known?.why ?? reason ?? "The provider did not finish.",
    fix: known?.fix ?? "Open Settings or resume the run from the recovery panel.",
  };
}

function UserText({ text }: { text: string }): React.JSX.Element {
  const { text: typed, files, images } = splitAttachments(text);
  return (
    <>
      {typed}
      {images.length > 0 ? (
        <span className="attachment-row">
          {images.map((id) => (
            <img key={id} className="message-image" src={`/api/images/${id}`} alt="Attached image" loading="lazy" data-testid="message-image" />
          ))}
        </span>
      ) : null}
      {files.length > 0 ? (
        <span className="attachment-row" data-testid="attachment-row">
          {files.map((file) => (
            <kbd key={file} title="Contents were sent to the agent">{file}</kbd>
          ))}
        </span>
      ) : null}
    </>
  );
}

function readDrafts(): Record<string, string> {
  try {
    const stored = JSON.parse(localStorage.getItem("atelier.drafts") ?? "{}") as unknown;
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};
    const drafts: Record<string, string> = {};
    for (const [key, value] of Object.entries(stored)) {
      if (typeof value === "string") drafts[key] = value;
    }
    return drafts;
  } catch {
    return {};
  }
}

export default function App(): React.JSX.Element {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [archivedView, setArchivedView] = useState(false);
  const archivedViewRef = useRef(archivedView);
  archivedViewRef.current = archivedView;
  const [visible, setVisible] = useState(() => (typeof document === "undefined" ? true : !document.hidden));
  const lastSeqRef = useRef(0);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    lastSeqRef.current = 0;
    setActivity([]);
    setTodos([]);
  }, [activeId]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>(readDrafts);
  const draftKey = activeId ?? "new";
  const draft = drafts[draftKey] ?? "";
  const setDraft = (value: string): void => {
    setDrafts((current) => ({ ...current, [draftKey]: value }));
  };
  const [mode, setMode] = useState<Mode>("build");
  const [tab, setTab] = useState<WorkspaceTab>("files");
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("atelier.theme") === "light" ? "light" : "dark"));
  const [error, setError] = useState<ErrorState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [customCommands, setCustomCommands] = useState<SlashCommand[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [caret, setCaret] = useState(0);
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [openRequest, setOpenRequest] = useState<OpenRequest | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<string[] | null>(null);
  const [mentionDismissed, setMentionDismissed] = useState<string | null>(null);
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [sending, setSending] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [live, setLive] = useState(false);
  const [stick, setStick] = useState(true);
  const [showJump, setShowJump] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [runStatus, setRunStatus] = useState<"idle" | "running" | "blocked">("idle");
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [usageTick, setUsageTick] = useState(0);
  const [planTick, setPlanTick] = useState(0);
  const [taskTick, setTaskTick] = useState(0);
  const [historyTick, setHistoryTick] = useState(0);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [liveText, setLiveText] = useState<LiveText | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [approvalNotes, setApprovalNotes] = useState<Record<string, string>>({});
  const [approvalBusy, setApprovalBusy] = useState<string[]>([]);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const paletteInputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeSession = sessions.find((session) => session.id === activeId) ?? null;

  useEffect(() => {
    const name = activeSession?.title ?? null;
    const marker = approvals.length > 0 ? "● Approval needed" : runStatus === "running" ? "● Working" : "";
    if (marker.length > 0) document.title = `${marker} · ${name ?? "atelier"}`;
    else document.title = name === null ? "atelier" : `${name} · atelier`;
  }, [activeSession?.title, approvals.length, runStatus]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("atelier.theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("atelier.drafts", JSON.stringify(drafts));
  }, [drafts]);

  useEffect(() => {
    const node = composerRef.current;
    if (node === null || node.scrollHeight <= 0) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 240)}px`;
  }, [draft]);

  useEffect(() => {
    setStick(true);
    setShowJump(false);
    const node = messagesRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [activeId]);

  useEffect(() => {
    const node = messagesRef.current;
    if (node !== null && stick) node.scrollTop = node.scrollHeight;
  }, [messages, stick]);

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    };
  }, []);

  useEffect(() => {
    if (runStatus !== "running") {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [runStatus]);

  function onMessagesScroll(): void {
    const node = messagesRef.current;
    if (node === null) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    setStick(distance < 80);
    setShowJump(distance >= 240);
  }

  async function copyMessage(message: Message): Promise<void> {
    try {
      await navigator.clipboard.writeText(message.text);
    } catch {
      return;
    }
    setCopiedId(message.id);
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopiedId(null), 1500);
  }

  async function copyCode(code: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      return;
    }
    setCopiedCode(code);
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopiedCode(null), 1500);
  }

  async function loadSessions(showArchived: boolean): Promise<Session[]> {
    const data = await api<{ sessions: Session[] }>(showArchived ? "/api/sessions?archived=1" : "/api/sessions");
    setSessions(data.sessions);
    return data.sessions;
  }

  async function refreshSessionsQuietly(): Promise<void> {
    try {
      await loadSessions(archivedViewRef.current);
    } catch {
      // The stream keeps working; the next boot or action reconciles the list.
    }
  }

  async function toggleArchivedView(): Promise<void> {
    const next = !archivedView;
    setArchivedView(next);
    try {
      const list = await loadSessions(next);
      if (next) setActiveId(list[0]?.id ?? null);
    } catch (caught) {
      setError(toErrorState(caught));
    }
  }

  async function setPinned(id: string, pinned: boolean): Promise<void> {
    try {
      const data = await api<{ sessions: Session[] }>(`/api/sessions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ pinned }),
      });
      setSessions(data.sessions);
    } catch (caught) {
      setError(toErrorState(caught));
    }
  }

  async function setArchived(id: string, archived: boolean): Promise<void> {
    try {
      const data = await api<{ sessions: Session[] }>(`/api/sessions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ archived }),
      });
      if (!archivedView) {
        const next = data.sessions.filter((session) => session.archived === 0);
        setSessions(next);
        if (activeId === id) setActiveId(next[0]?.id ?? null);
      } else {
        setSessions(data.sessions.filter((session) => session.archived === 1));
        if (activeId === id) setActiveId(null);
      }
      setNotice(archived ? "Conversation archived." : "Conversation restored.");
    } catch (caught) {
      setError(toErrorState(caught));
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await ensureAuth();
        const data = await api<Boot>("/api/boot");
        if (cancelled) return;
        setBoot(data);
        setSessions(data.sessions);
        setActiveId(data.sessions[0]?.id ?? null);
        try {
          const found = await api<{ commands: SlashCommand[] }>("/api/commands");
          if (!cancelled) setCustomCommands(found.commands);
        } catch {
          // custom commands are optional; built-ins keep working
        }
      } catch (caught) {
        if (!cancelled) setError(toErrorState(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setRunStatus("idle");
    setStopping(false);
    if (activeId === null) {
      setMessages([]);
      setApprovals([]);
      setApprovalNotes({});
      setApprovalBusy([]);
      setLiveText(null);
      return;
    }
    setError(null);
    let cancelled = false;
    void (async () => {
      try {
        const data = await api<{ approvals: Approval[] }>(`/api/sessions/${activeId}/approvals?pending=1`);
        if (!cancelled) {
          setApprovals(data.approvals);
          setApprovalBusy([]);
        }
      } catch {
        if (!cancelled) setApprovals([]);
      }
    })();
    void (async () => {
      try {
        const data = await api<{ messages: Message[] }>(`/api/sessions/${activeId}/messages`);
        if (!cancelled) setMessages(data.messages);
      } catch (caught) {
        if (!cancelled) setError(toErrorState(caught));
      }
    })();
    void (async () => {
      try {
        const data = await api<{ todos: TodoItem[] }>(`/api/sessions/${activeId}/todos`);
        if (!cancelled) setTodos(data.todos);
      } catch {
        if (!cancelled) setTodos([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  useEffect(() => {
    if (activeId === null) {
      setUsage(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const data = await api<UsageSummary>(`/api/usage?session=${encodeURIComponent(activeId)}`);
        if (!cancelled) setUsage(data);
      } catch {
        if (!cancelled) setUsage(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId, usageTick]);

  useEffect(() => {
    const onVisibility = (): void => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (activeId === null || !visible) {
      setLive(false);
      return;
    }
    const source = new EventSource(`/api/sessions/${activeId}/events?after=${lastSeqRef.current}`);
    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false);
    const on = (type: string, handler: (event: MessageEvent) => void): void => {
      source.addEventListener(type, (event) => {
        const seq = Number((event as MessageEvent).lastEventId);
        if (Number.isFinite(seq) && seq > lastSeqRef.current) lastSeqRef.current = seq;
        handler(event as MessageEvent);
      });
    };
    // Live text is drawn while the answer is written and dropped as soon as the run starts, finishes or blocks.
    on("text.delta", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as unknown;
        setLiveText((current) => applyLiveEvent(current, "text.delta", data));
      } catch {
        // A malformed delta is skipped; the saved message is authoritative.
      }
    });
    on("run.started", () => {
      setLiveText(null);
      setRunStatus("running");
      setActivity([]);
      setTaskTick((tick) => tick + 1);
    });
    on("tool.result", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { callId?: string; name?: string; ok?: boolean; detail?: string };
        if (typeof data.callId !== "string" || typeof data.name !== "string") return;
        const item: ActivityItem = {
          id: data.callId,
          tool: data.name,
          detail: typeof data.detail === "string" ? data.detail : "",
          ok: data.ok !== false,
          at: Date.now(),
        };
        setActivity((current) => (current.some((entry) => entry.id === item.id) ? current : appendActivity(current, item)));
      } catch {
        // Malformed events are ignored; the durable run log is authoritative.
      }
    });
    on("approval.request", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { approvalId?: string; runId?: string; callId?: string; tool?: string; action?: string; resource?: string; reason?: string; preview?: string | null };
        const approvalId = data.approvalId;
        const runId = data.runId;
        const tool = data.tool;
        if (typeof approvalId !== "string" || typeof runId !== "string" || typeof tool !== "string") return;
        setApprovals((current) => current.some((item) => item.id === approvalId) ? current : [{
          id: approvalId,
          run_id: runId,
          session_id: activeId,
          call_id: data.callId ?? "",
          tool,
          action: data.action ?? "edit",
          resource: data.resource ?? "",
          reason: data.reason ?? "approval required",
          preview: typeof data.preview === "string" ? data.preview : null,
          status: "pending",
          created: Date.now(),
        }, ...current]);
      } catch {
        // Malformed approval events are ignored.
      }
    });
    on("approval.resolved", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { approvalId?: string };
        if (typeof data.approvalId !== "string") return;
        setApprovals((current) => current.filter((item) => item.id !== data.approvalId));
      } catch {
        // Malformed approval events are ignored.
      }
    });
    on("run.finished", () => {
      setLiveText(null);
      setRunStatus("idle");
      setUsageTick((tick) => tick + 1);
      setPlanTick((tick) => tick + 1);
      setTaskTick((tick) => tick + 1);
      void refreshSessionsQuietly();
    });
    on("todo.updated", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { todos?: TodoItem[] };
        setTodos(Array.isArray(data.todos) ? data.todos : []);
      } catch {
        // Malformed events are ignored; the durable todo event is authoritative.
      }
    });
    on("run.resumed", () => setTaskTick((tick) => tick + 1));
    on("run.forked", () => setTaskTick((tick) => tick + 1));
    on("checkpoint.created", () => setHistoryTick((tick) => tick + 1));
    on("plan.created", () => setPlanTick((tick) => tick + 1));
    on("plan.updated", () => setPlanTick((tick) => tick + 1));
    on("plan.deleted", () => setPlanTick((tick) => tick + 1));
    on("text.ended", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { messageId?: string; text?: string };
        if (typeof data.messageId !== "string" || typeof data.text !== "string") return;
        const message = { id: data.messageId, session_id: activeId, seq: 0, role: "assistant" as const, text: data.text, client_id: null, created: Date.now() };
        setMessages((current) => (current.some((entry) => entry.id === message.id) ? current : [...current, message]));
      } catch {
        // Malformed events are ignored; the durable projection is authoritative.
      }
    });
    on("run.blocked", (event) => {
      setLiveText(null);
      setUsageTick((tick) => tick + 1);
      setTaskTick((tick) => tick + 1);
      let reason: string | undefined;
      try {
        reason = (JSON.parse((event as MessageEvent).data) as { reason?: string }).reason;
      } catch {
        reason = undefined;
      }
      if (reason === "stopped") {
        setRunStatus("idle");
        setError(null);
        setNotice("Run stopped.");
        return;
      }
      setRunStatus("blocked");
      setError(blockedReasonError(reason));
    });
    return () => source.close();
  }, [activeId, visible]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (modifier && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setTerminalOpen((open) => !open);
      } else if (event.altKey && !modifier && /^[1-9]$/.test(event.key)) {
        const target = event.target as HTMLElement | null;
        const typing = target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
        if (typing) return;
        const next = WORKSPACE_TABS[Number(event.key) - 1];
        if (next !== undefined) {
          event.preventDefault();
          setTab(next.id);
          setWorkspaceOpen(true);
        }
      } else if (event.key === "Escape") {
        setPaletteOpen(false);
        setTerminalOpen(false);
        setWorkspaceOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (paletteOpen) {
      setPaletteQuery("");
      setPaletteIndex(0);
      paletteInputRef.current?.focus();
    }
  }, [paletteOpen]);

  async function createConversation(): Promise<void> {
    try {
      setError(null);
      const data = await api<{ session: Session }>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ title: "New conversation" }),
      });
      setSessions((current) => [data.session, ...current]);
      setActiveId(data.session.id);
      setRailOpen(false);
      composerRef.current?.focus();
    } catch (caught) {
      setError(toErrorState(caught));
    }
  }

  const searchMessages = useCallback(async (query: string): Promise<SearchHit[]> => {
    const data = await api<{ messages: SearchHit[] }>(`/api/search?q=${encodeURIComponent(query)}`);
    return data.messages;
  }, []);

  async function renameSession(id: string, title: string): Promise<void> {
    try {
      const data = await api<{ sessions: Session[] }>(`/api/sessions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      setSessions(data.sessions);
    } catch (caught) {
      setError(toErrorState(caught));
    }
  }

  async function deleteSession(id: string): Promise<void> {
    try {
      await api(`/api/sessions/${id}`, { method: "DELETE" });
      const next = sessions.filter((session) => session.id !== id);
      setSessions(next);
      if (activeId === id) setActiveId(next[0]?.id ?? null);
    } catch (caught) {
      setError(toErrorState(caught));
    }
  }

  async function sendMessage(event?: FormEvent, override?: { text: string; mode: Mode }): Promise<void> {
    event?.preventDefault();
    const sendMode = override?.mode ?? mode;
    const sendImages = override === undefined ? pendingImages : [];
    let text = (override?.text ?? draft).trim();
    if (text.length === 0 && sendImages.length > 0) text = "See the attached image.";
    if (text.length === 0 || sending) return;
    const slash = override === undefined ? parseSlash(text) : null;
    if (slash !== null) {
      const builtin = BUILTIN_COMMANDS.find((command) => command.name === slash.name);
      const custom = customCommands.find((command) => command.name === slash.name);
      if (builtin !== undefined) {
        runBuiltin(builtin.name, slash.args);
        return;
      }
      if (custom?.template !== undefined) {
        text = expandTemplate(custom.template, slash.args).trim();
        if (text.length === 0) return;
      } else {
        setNotice(`Unknown command /${slash.name}. Type / to see what is available.`);
        return;
      }
    }
    if (runStatus === "running") {
      setNotice("A run is already working. Stop it or wait for it to finish.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      let sessionId = activeId;
      if (sessionId === null) {
        const created = await api<{ session: Session }>("/api/sessions", {
          method: "POST",
          body: JSON.stringify({ title: text.slice(0, 60) }),
        });
        sessionId = created.session.id;
        setSessions((current) => [created.session, ...current]);
        setActiveId(created.session.id);
      }
      const data = await api<{ run: { id: string; status: string }; message: Message }>(`/api/sessions/${sessionId}/runs`, {
        method: "POST",
        body: JSON.stringify({ prompt: text, clientId: crypto.randomUUID(), mode: sendMode, ...(sendImages.length > 0 ? { images: sendImages } : {}) }),
      });
      setMessages((current) => [...current, data.message]);
      setRunStatus("running");
      setNotice(null);
      if (override === undefined) {
        setDraft("");
        setPendingImages([]);
      }
      const current = sessions.find((session) => session.id === sessionId);
      if (current?.title === "New conversation") void renameSession(sessionId, text.slice(0, 60));
    } catch (caught) {
      setError(toErrorState(caught));
    } finally {
      setSending(false);
    }
  }

  async function stopRun(): Promise<void> {
    if (activeId === null || stopping) return;
    setStopping(true);
    try {
      await api(`/api/sessions/${activeId}/stop`, { method: "POST" });
      setRunStatus("idle");
      setError(null);
      setNotice("Run stopped.");
    } catch (caught) {
      setError(toErrorState(caught));
    } finally {
      setStopping(false);
    }
  }

  const canHandoff = mode === "plan" && runStatus === "idle" && activeId !== null && messages[messages.length - 1]?.role === "assistant";

  function buildThisPlan(): void {
    setMode("build");
    void sendMessage(undefined, { text: "Implement the plan above. Follow it step by step and verify with the project's tests.", mode: "build" });
  }

  async function listSkills(): Promise<void> {
    try {
      const data = await api<{ skills: Array<{ name: string; description: string }> }>("/api/skills");
      const refreshed = await api<{ commands: SlashCommand[] }>("/api/commands").catch(() => null);
      if (refreshed !== null) setCustomCommands(refreshed.commands);
      if (data.skills.length === 0) {
        setNotice("No skills yet. Add one as .atelier/skills/<name>/SKILL.md (or .claude/skills/<name>/SKILL.md) and it appears here and as a /command.");
        return;
      }
      setNotice(`${data.skills.length} skill${data.skills.length === 1 ? "" : "s"}: ${data.skills.map((skill) => `/${skill.name} (${skill.description})`).join(", ")}`);
    } catch (caught) {
      setError(toErrorState(caught));
    }
  }

  async function openInstructions(): Promise<void> {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      try {
        await api(`/api/workspace/file?path=${encodeURIComponent(name)}`);
      } catch {
        continue;
      }
      setOpenRequest({ path: name, nonce: Date.now() });
      setTab("files");
      setWorkspaceOpen(true);
      return;
    }
    setNotice("This project has no AGENTS.md or CLAUDE.md yet. Run /init to have the agent write one.");
  }

  async function forkConversation(messageId?: string): Promise<void> {
    if (activeId === null || messages.length === 0) {
      setNotice("Nothing to fork yet.");
      return;
    }
    setError(null);
    try {
      const data = await api<{ session: Session }>(`/api/sessions/${activeId}/fork`, { method: "POST", body: JSON.stringify(messageId === undefined ? {} : { messageId }) });
      setSessions((current) => [data.session, ...current]);
      setActiveId(data.session.id);
      setNotice(messageId === undefined ? "Forked the conversation. The original is unchanged." : "Forked from that message. The original is unchanged.");
    } catch (caught) {
      setError(toErrorState(caught));
    }
  }

  async function compactConversation(): Promise<void> {
    if (activeId === null || messages.length === 0) {
      setNotice("Nothing to compact yet.");
      return;
    }
    if (runStatus === "running") {
      setNotice("A run is working. Stop it or wait for it to finish before compacting.");
      return;
    }
    setNotice("Summarising this conversation…");
    setError(null);
    try {
      const data = await api<{ session: Session }>(`/api/sessions/${activeId}/compact`, { method: "POST" });
      setSessions((current) => [data.session, ...current]);
      setActiveId(data.session.id);
      setNotice("Started a new conversation from a summary of the old one. The old one is unchanged.");
    } catch (caught) {
      setNotice(null);
      setError(toErrorState(caught));
    }
  }

  async function attachImageFiles(files: File[]): Promise<void> {
    let count = pendingImages.length;
    const added: string[] = [];
    for (const file of files) {
      const problem = imageProblem(file, count);
      if (problem !== null) {
        setNotice(problem);
        break;
      }
      try {
        const stored = await api<{ id: string }>("/api/images", { method: "POST", body: JSON.stringify({ mediaType: file.type, data: await readBase64(file) }) });
        if (!added.includes(stored.id) && !pendingImages.includes(stored.id)) {
          added.push(stored.id);
          count += 1;
        }
      } catch (caught) {
        setError(toErrorState(caught));
        break;
      }
    }
    if (added.length > 0) setPendingImages((current) => [...current, ...added.filter((id) => !current.includes(id))]);
  }

  function onComposerPaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    void attachImageFiles(files);
  }

  async function modelCommand(wanted: string): Promise<void> {
    try {
      const [config, listing] = await Promise.all([
        api<{ defaults?: { provider: string | null; model: string | null } }>("/api/config"),
        api<{ models: Array<{ id: string; providerId?: string }> }>("/api/models"),
      ]);
      const current = config.defaults ?? { provider: null, model: null };
      if (listing.models.length === 0) {
        setNotice("No models are listed yet. Add a provider in Settings first.");
        return;
      }
      if (wanted.length === 0) {
        const ids = [...new Set(listing.models.map((model) => model.id))];
        setNotice(`Current model: ${current.model ?? "none set"}. Switch with /model <id>. Available: ${ids.join(", ")}`);
        return;
      }
      const matches = listing.models.filter((model) => model.id === wanted);
      const chosen = matches.find((model) => model.providerId === current.provider) ?? matches[0];
      if (chosen === undefined || chosen.providerId === undefined) {
        setNotice(`${wanted} is not in the model list. Type /model to see what is available, or set any id in Settings.`);
        return;
      }
      await api("/api/config", { method: "PUT", body: JSON.stringify({ defaults: { provider: chosen.providerId, model: chosen.id } }) });
      setNotice(`Model set to ${chosen.id} (${chosen.providerId}). It applies to the next message.`);
    } catch (caught) {
      setError(toErrorState(caught));
    }
  }

  async function undoLastEdit(): Promise<void> {
    if (runStatus === "running") {
      setNotice("A run is working. Stop it or wait for it to finish before undoing.");
      return;
    }
    try {
      const data = await api<{ checkpoints: CheckpointEntry[] }>("/api/checkpoints");
      const latest = data.checkpoints[0];
      if (latest === undefined) {
        setNotice("No edits to undo yet.");
        return;
      }
      await api("/api/checkpoints/restore", { method: "POST", body: JSON.stringify({ commit: latest.commit, path: latest.path }) });
      setHistoryTick((tick) => tick + 1);
      setNotice(`Restored ${latest.path} to how it was before the agent's last edit. Run /undo again to put the edit back.`);
    } catch (caught) {
      setError(toErrorState(caught));
    }
  }

  async function newSkill(args: string): Promise<void> {
    const [name, ...rest] = args.trim().split(/\s+/);
    if (name === undefined || name.length === 0) {
      setNotice("Usage: /skill-new <name> [one-line description]. It creates .atelier/skills/<name>/SKILL.md from a template and opens it.");
      return;
    }
    const description = rest.join(" ").trim();
    try {
      const data = await api<{ skill: { path: string } }>("/api/skills", { method: "POST", body: JSON.stringify(description.length > 0 ? { name, description } : { name }) });
      const refreshed = await api<{ commands: SlashCommand[] }>("/api/commands").catch(() => null);
      if (refreshed !== null) setCustomCommands(refreshed.commands);
      setOpenRequest({ path: data.skill.path, nonce: Date.now() });
      setTab("files");
      setWorkspaceOpen(true);
      setNotice(`Created ${data.skill.path}. Edit it and save, then use /${name}.`);
    } catch (caught) {
      setError(toErrorState(caught));
    }
  }

  function runBuiltin(name: string, args = ""): void {
    setDraft("");
    if (name === "plan") setMode("plan");
    else if (name === "build") setMode("build");
    else if (name === "compact") void compactConversation();
    else if (name === "init") void sendMessage(undefined, { text: INIT_PROMPT, mode: "build" });
    else if (name === "instructions") void openInstructions();
    else if (name === "skills") void listSkills();
    else if (name === "model") void modelCommand(args.trim());
    else if (name === "undo") void undoLastEdit();
    else if (name === "skill-new") void newSkill(args);
    else if (name === "fork") void forkConversation();
    else if (name === "new") void createConversation();
    else if (name === "terminal") setTerminalOpen((open) => !open);
    else if (name === "theme") setTheme(theme === "dark" ? "light" : "dark");
    else if (name === "export") {
      if (activeSession === null || messages.length === 0) setNotice("Nothing to export yet.");
      else setNotice(downloadTranscript(activeSession.title, messages) ? "Transcript downloaded." : "Export failed: this browser blocked the download.");
    }
  }

  const slashMatches = slashDismissed === draft ? [] : matchCommands([...BUILTIN_COMMANDS, ...customCommands], draft);
  const slashActive = Math.min(slashIndex, Math.max(slashMatches.length - 1, 0));

  const mention = slashMatches.length > 0 || mentionDismissed === draft ? null : activeMention(draft, caret);
  const mentionMatches = mention === null || workspaceFiles === null ? [] : rankFiles(workspaceFiles, mention.query, 8);
  const mentionActive = Math.min(slashIndex, Math.max(mentionMatches.length - 1, 0));

  useEffect(() => {
    if (mention === null || workspaceFiles !== null) return;
    let cancelled = false;
    void api<{ files: string[] }>("/api/workspace/files")
      .then((found) => { if (!cancelled) setWorkspaceFiles(found.files); })
      .catch(() => { if (!cancelled) setWorkspaceFiles([]); });
    return () => { cancelled = true; };
  }, [mention === null, workspaceFiles === null]);

  function chooseMention(path: string): void {
    if (mention === null) return;
    const next = applyMention(draft, mention, path);
    setDraft(next.text);
    setCaret(next.caret);
    setSlashIndex(0);
    requestAnimationFrame(() => composerRef.current?.setSelectionRange(next.caret, next.caret));
    composerRef.current?.focus();
  }

  function chooseSlash(command: SlashCommand): void {
    if (command.kind === "builtin" && command.takesArgs !== true) {
      runBuiltin(command.name);
    } else if (command.kind === "builtin") {
      setDraft(`/${command.name} `);
    } else {
      setDraft(`/${command.name} `);
    }
    setSlashIndex(0);
    composerRef.current?.focus();
  }

  function isKnownCommand(text: string): boolean {
    const parsed = parseSlash(text);
    if (parsed === null || text.includes("\n")) return false;
    return BUILTIN_COMMANDS.some((command) => command.name === parsed.name) || customCommands.some((command) => command.name === parsed.name);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (mentionMatches.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex(Math.min(mentionActive + 1, mentionMatches.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex(Math.max(mentionActive - 1, 0));
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionDismissed(draft);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) || event.key === "Tab") {
        const path = mentionMatches[mentionActive];
        if (path !== undefined) {
          event.preventDefault();
          chooseMention(path);
          return;
        }
      }
    }
    if (slashMatches.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex(Math.min(slashActive + 1, slashMatches.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex(Math.max(slashActive - 1, 0));
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashDismissed(draft);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) || event.key === "Tab") {
        const command = slashMatches[slashActive];
        if (command !== undefined) {
          event.preventDefault();
          chooseSlash(command);
          return;
        }
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void sendMessage();
    } else if (event.key === "Enter" && !event.shiftKey && !event.altKey && isKnownCommand(draft.trim())) {
      event.preventDefault();
      void sendMessage();
    }
  }

  async function approveAlways(approval: Approval): Promise<void> {
    if (approvalBusy.includes(approval.id)) return;
    setApprovalBusy((current) => [...current, approval.id]);
    try {
      const current = await api<{ rules?: RuleConfig[] }>("/api/config");
      const existing = current.rules ?? [];
      const rule = alwaysAllowRule(approval, existing);
      if (rule !== null) await api("/api/config", { method: "PUT", body: JSON.stringify({ rules: [...existing, rule] }) });
    } catch (caught) {
      setApprovalBusy((busy) => busy.filter((id) => id !== approval.id));
      setError(toErrorState(caught));
      return;
    }
    setApprovalBusy((busy) => busy.filter((id) => id !== approval.id));
    await decideApproval(approval, "approve");
  }

  async function decideApproval(approval: Approval, decision: "approve" | "deny"): Promise<void> {
    if (approvalBusy.includes(approval.id)) return;
    const note = approvalNotes[approval.id]?.trim() ?? "";
    setApprovalBusy((current) => [...current, approval.id]);
    try {
      await api(`/api/runs/${approval.run_id}/approvals/${approval.id}`, {
        method: "POST",
        body: JSON.stringify(note.length === 0 ? { decision } : { decision, reason: note }),
      });
      setApprovals((current) => current.filter((item) => item.id !== approval.id));
      setApprovalNotes((current) => {
        const rest = { ...current };
        delete rest[approval.id];
        return rest;
      });
    } catch (caught) {
      setError(toErrorState(caught));
    } finally {
      setApprovalBusy((current) => current.filter((id) => id !== approval.id));
    }
  }

  const paletteActions: Array<{ id: string; label: string; hint?: string; run: () => void }> = [
    { id: "new", label: "New conversation", run: () => void createConversation() },
    ...WORKSPACE_TABS.map((item, index) => ({
      id: `go-${item.id}`,
      label: `Go to ${item.label}`,
      hint: `Alt+${index + 1}`,
      run: () => setTab(item.id),
    })),
    { id: "terminal", label: terminalOpen ? "Hide terminal" : "Show terminal", hint: "⌘J", run: () => setTerminalOpen((open) => !open) },
    { id: "export", label: "Export transcript as markdown", run: () => {
      if (activeSession === null || messages.length === 0) return;
      const ok = downloadTranscript(activeSession.title, messages);
      setNotice(ok ? "Transcript downloaded." : null);
      if (!ok) setError({ what: "Export failed", why: "This browser blocked the download.", fix: "Try a different browser, or copy the messages by hand." });
    } },
    { id: "theme", label: `Use ${theme === "dark" ? "light" : "dark"} theme`, run: () => setTheme(theme === "dark" ? "light" : "dark") },
    { id: "composer", label: "Focus composer", run: () => composerRef.current?.focus() },
  ].filter((action) => action.label.toLowerCase().includes(paletteQuery.trim().toLowerCase()));

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    const index = WORKSPACE_TABS.findIndex((item) => item.id === tab);
    if (index < 0) return;
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % WORKSPACE_TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + WORKSPACE_TABS.length) % WORKSPACE_TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = WORKSPACE_TABS.length - 1;
    else return;
    event.preventDefault();
    const target = WORKSPACE_TABS[next];
    if (target === undefined) return;
    setTab(target.id);
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[next]?.focus();
  }

  function runPaletteAction(action: { run: () => void }): void {
    action.run();
    setPaletteOpen(false);
  }

  function onPaletteKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setPaletteIndex((index) => Math.min(index + 1, paletteActions.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setPaletteIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const action = paletteActions[paletteIndex];
      if (action !== undefined) runPaletteAction(action);
    }
  }

  const needsProvider = providerMissing(boot);

  return (
    <>
      <a className="skip-link" href="#composer">
        Skip to composer
      </a>
      <div className="app-shell" data-testid="app-shell">
        <aside className="rail" data-open={railOpen} aria-label="Conversations" data-testid="rail">
          <div className="brand-row">
            <span className="brand-mark" aria-hidden="true">A</span>
            <span className="brand">atelier</span>
            <span className="brand-version">{boot?.version ?? "0.1.0"}</span>
          </div>
          <div className="rail-section">
            <div className="rail-label">
              <span>Conversations</span>
              <span>{sessions.length}</span>
            </div>
            <button className="new-conversation" type="button" onClick={() => void createConversation()} data-testid="new-conversation">
              <span aria-hidden="true">+</span> New conversation
            </button>
          </div>
          <RailConversations
            sessions={sessions}
            activeId={activeId}
            archived={archivedView}
            onToggleArchived={() => void toggleArchivedView()}
            onSelect={(id) => {
              setActiveId(id);
              setRailOpen(false);
            }}
            onRename={(id, title) => void renameSession(id, title)}
            onDelete={(id) => void deleteSession(id)}
            onPin={(id, pinned) => void setPinned(id, pinned)}
            onArchive={(id, archived) => void setArchived(id, archived)}
            onSearch={searchMessages}
          />
          <div className="rail-footer">
            <button type="button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
              <span aria-hidden="true">{theme === "dark" ? "◐" : "◑"}</span> {theme === "dark" ? "Light theme" : "Dark theme"}
            </button>
            <button type="button" onClick={() => setPaletteOpen(true)}>
              <span aria-hidden="true">⌘</span> Command palette
            </button>
          </div>
        </aside>

        <main className="conversation" aria-label="Conversation">
          <header className="conversation-header" data-testid="conversation-header">
            <button className="icon-button mobile-only" type="button" aria-label="Open conversations" onClick={() => setRailOpen(true)}>
              ☰
            </button>
            <div className="header-title">
              <h1>{activeSession?.title ?? "New conversation"}</h1>
              <div className="header-sub" title={boot?.workspace ?? "workspace"}>{boot?.workspace ?? "workspace"} · local</div>
            </div>
            <div className="header-spacer" />
            <div className="mode-group" role="group" aria-label="Agent mode">
              <button type="button" aria-pressed={mode === "plan"} onClick={() => setMode("plan")}>Plan</button>
              <button type="button" aria-pressed={mode === "build"} onClick={() => setMode("build")}>Build</button>
            </div>
            {runStatus === "running" ? (
              <button className="small-button danger" type="button" onClick={() => void stopRun()} disabled={stopping} data-testid="stop-run">
                {stopping ? "Stopping…" : "Stop"}
              </button>
            ) : null}
            <button
              className="icon-button mobile-only"
              type="button"
              aria-label="Open workspace"
              title="Open workspace panels"
              aria-expanded={workspaceOpen}
              data-testid="open-workspace"
              onClick={() => setWorkspaceOpen(true)}
            >
              ▤
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="Export transcript"
              title="Download this conversation as markdown"
              disabled={activeSession === null || messages.length === 0}
              onClick={() => {
                if (activeSession === null) return;
                const ok = downloadTranscript(activeSession.title, messages);
                if (!ok) setError({ what: "Export failed", why: "This browser blocked the download.", fix: "Try a different browser, or copy the messages by hand." });
                else setNotice("Transcript downloaded.");
              }}
              data-testid="export-conversation"
            >
              ⤓
            </button>
            <button className="icon-button mobile-only" type="button" aria-label="⌘K command palette" onClick={() => setPaletteOpen(true)} data-testid="open-palette">
              ⌘K
            </button>
          </header>

          {error !== null ? (
            <div className="banner-error" role="alert" data-testid="error-banner">
              <div className="banner-copy">
                <strong>{error.what}</strong>
                <div>{error.why}</div>
                <div>{error.fix}</div>
              </div>
              <button
                type="button"
                className="banner-dismiss"
                aria-label="Dismiss error"
                onClick={() => setError(null)}
                data-testid="dismiss-error"
              >
                ×
              </button>
            </div>
          ) : null}

          {notice !== null ? (
            <div className="banner-ok inline" role="status" data-testid="run-notice">
              <span>{notice}</span>
              <button
                type="button"
                className="banner-dismiss"
                aria-label="Dismiss notice"
                onClick={() => setNotice(null)}
                data-testid="dismiss-notice"
              >
                ×
              </button>
            </div>
          ) : null}

          {boot?.recovery && boot.recovery.actionCount > 0 ? (
            <div className="banner-info" role="status" data-testid="recovery-banner">
              <strong>Recovered {boot.recovery.actionCount} action(s)</strong>
              <div>{boot.recovery.result} · the durable log is the source of truth.</div>
            </div>
          ) : null}

          {needsProvider ? (
            <div className="banner-hint" role="status" data-testid="provider-notice">
              <strong>No provider key yet</strong>
              <div>Add a provider and its key in Settings, or set the key in the atelier environment, before sending a message.</div>
              <button className="small-button" type="button" onClick={() => { setTab("settings"); setWorkspaceOpen(true); }} data-testid="provider-settings">
                Open Settings
              </button>
            </div>
          ) : null}

          <section
            className="messages"
            aria-label="Messages"
            aria-live="polite"
            data-testid="messages"
            ref={messagesRef}
            onScroll={onMessagesScroll}
          >
            {messages.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon" aria-hidden="true">◆</div>
                <h2>What are we building?</h2>
                <p>
                  Chat, files, git, terminal, preview and plans in one local workspace. Every message is durable,
                  and in Build mode each edit waits for your approval.
                </p>
                <div className="quick-grid">
                  {QUICK_PROMPTS.map((item) => (
                    <button
                      key={item.title}
                      className="quick-card"
                      type="button"
                      onClick={() => {
                        setDraft(item.prompt);
                        composerRef.current?.focus();
                      }}
                    >
                      {item.title}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((message) => (
                <article className="message" data-role={message.role} key={message.id} data-testid="message">
                  <div className="message-bubble">
                    {message.role === "assistant" ? (
                      <Markdown text={message.text} onCopyCode={(code) => void copyCode(code)} copiedCode={copiedCode} />
                    ) : (
                      <UserText text={message.text} />
                    )}
                  </div>
                  <div className="message-meta">
                    <span>{message.role} · seq {message.seq}</span>
                    <button
                      type="button"
                      className={copiedId === message.id ? "message-action copied" : "message-action"}
                      aria-label="Copy message"
                      data-testid="copy-message"
                      onClick={() => void copyMessage(message)}
                    >
                      {copiedId === message.id ? "Copied" : "Copy"}
                    </button>
                    <button
                      type="button"
                      className="message-action"
                      aria-label="Fork from this message"
                      title="Start a new conversation from here"
                      data-testid="fork-message"
                      disabled={runStatus === "running"}
                      onClick={() => void forkConversation(message.id)}
                    >
                      Fork
                    </button>
                  </div>
                </article>
              ))
            )}
            {runStatus === "running" && liveText !== null && liveText.text.length > 0 ? (
              <article className="message live" data-role="assistant" data-testid="live-message" aria-busy="true">
                <div className="message-bubble">{liveText.text}</div>
              </article>
            ) : null}
            {runStatus === "running" ? (
              <div className="working" role="status" data-testid="working" aria-live="polite">
                <span className="working-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>Agent is working</span>
                <span className="working-elapsed" data-testid="working-elapsed">{elapsed}s</span>
              </div>
            ) : null}
          </section>

          {showJump ? (
            <button
              type="button"
              className="jump-latest"
              onClick={() => {
                const node = messagesRef.current;
                if (node !== null) node.scrollTop = node.scrollHeight;
                setStick(true);
                setShowJump(false);
              }}
              data-testid="jump-latest"
            >
              ↓ Latest
            </button>
          ) : null}

          {approvals.length > 0 ? (
            <div className="approval-dock" role="region" aria-label="Approval required" aria-live="assertive" data-testid="approval-dock">
              {approvals.map((approval) => (
                <div className="approval-item" key={approval.id}>
                  <p>
                    <strong>{approval.tool}</strong> wants to {approval.action} <code>{approval.resource}</code>.
                    <span className="approval-reason">{approval.reason}</span>
                    {approval.action === "edit" && isProtectedConfigPath(approval.resource) ? (
                      <span className="approval-reason" data-testid="approval-protected">Protected configuration: no rule can cover this, only you can approve it.</span>
                    ) : null}
                  </p>
                  {approval.preview === null || approval.preview.length === 0 ? null : <DiffView diff={approval.preview} defaultOpen />}
                  <input
                    className="approval-note"
                    value={approvalNotes[approval.id] ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      setApprovalNotes((current) => ({ ...current, [approval.id]: value }));
                    }}
                    placeholder="Note (optional, max 500)"
                    maxLength={500}
                    aria-label={`Note for ${approval.tool} on ${approval.resource}`}
                    data-testid="approval-note"
                  />
                  <button
                    className="approval-approve"
                    type="button"
                    data-testid="approval-approve"
                    disabled={approvalBusy.includes(approval.id)}
                    onClick={() => void decideApproval(approval, "approve")}
                  >
                    Approve
                  </button>
                  {alwaysAllowRule(approval, []) !== null ? (
                    <button
                      className="small-button"
                      type="button"
                      data-testid="approval-always"
                      title="Approve this and stop asking for exactly this command or path"
                      disabled={approvalBusy.includes(approval.id)}
                      onClick={() => void approveAlways(approval)}
                    >
                      Always allow
                    </button>
                  ) : null}
                  <button
                    className="approval-deny"
                    type="button"
                    data-testid="approval-deny"
                    disabled={approvalBusy.includes(approval.id)}
                    onClick={() => void decideApproval(approval, "deny")}
                  >
                    Deny
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <TodoStrip todos={todos} onDismiss={() => setTodos([])} />

          <ActivityFeed
            items={activity}
            running={runStatus === "running"}
            onDismiss={() => setActivity([])}
            onOpenTask={() => {
              setTab("task");
              setWorkspaceOpen(true);
            }}
          />

          <form className="composer" onSubmit={(event) => void sendMessage(event)} data-testid="composer">
            {canHandoff ? (
              <div className="handoff" data-testid="handoff">
                <span>Plan ready. Review it, then let the agent make the changes.</span>
                <button type="button" className="send-button" onClick={buildThisPlan} data-testid="handoff-build">Build this plan</button>
              </div>
            ) : null}
            <label className="sr-only" htmlFor="composer-input">Message the agent</label>
            {mentionMatches.length > 0 ? (
              <ul className="slash-menu" id="mention-menu-list" role="listbox" aria-label="Files" data-testid="mention-menu">
                {mentionMatches.map((path, index) => (
                  <li key={path} role="option" aria-selected={index === mentionActive}>
                    <button type="button" tabIndex={-1} data-active={index === mentionActive} data-testid="mention-option" onMouseDown={(event) => { event.preventDefault(); chooseMention(path); }}>
                      <span><strong>{path.slice(path.lastIndexOf("/") + 1)}</strong> <em>{path}</em></span>
                      <kbd>file</kbd>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {slashMatches.length > 0 ? (
              <ul className="slash-menu" id="slash-menu-list" role="listbox" aria-label="Slash commands" data-testid="slash-menu">
                {slashMatches.map((command, index) => (
                  <li key={command.name} role="option" aria-selected={index === slashActive}>
                    <button type="button" tabIndex={-1} data-active={index === slashActive} data-testid="slash-option" onMouseDown={(event) => { event.preventDefault(); chooseSlash(command); }}>
                      <span><strong>/{command.name}</strong> <em>{command.description}</em></span>
                      <kbd>{command.kind === "custom" ? "prompt" : "action"}</kbd>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {pendingImages.length > 0 ? (
              <div className="image-tray" data-testid="image-tray">
                {pendingImages.map((id) => (
                  <span className="image-chip" key={id} data-testid="pending-image">
                    <img src={`/api/images/${id}`} alt="Attached image preview" />
                    <button type="button" aria-label="Remove image" data-testid="remove-image" onClick={() => setPendingImages((current) => current.filter((item) => item !== id))}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <textarea
              id="composer-input"
              ref={composerRef}
              value={draft}
              onChange={(event) => { setDraft(event.target.value); setCaret(event.target.selectionStart); setSlashIndex(0); }}
              onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
              onKeyDown={onComposerKeyDown}
              onPaste={onComposerPaste}
              aria-autocomplete="list"
              aria-controls={slashMatches.length > 0 ? "slash-menu-list" : mentionMatches.length > 0 ? "mention-menu-list" : undefined}
              placeholder="Ask, edit, run, or plan. / for commands, @ for files. Cmd/Ctrl+Enter sends."
              rows={1}
              data-testid="composer-input"
            />
            <div className="composer-actions">
              <span className="hint">{runStatus === "running" ? "Run in progress: Stop to send another message" : mode === "plan" ? "Plan mode: read-only" : "Build mode: edits require approval"}</span>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                hidden
                data-testid="image-input"
                onChange={(event) => {
                  void attachImageFiles(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
              <button className="icon-button" type="button" aria-label="Attach image" title="Attach an image (or paste one)" data-testid="attach-image" onClick={() => imageInputRef.current?.click()}>
                ▣
              </button>
              <button
                className="icon-button"
                type="button"
                aria-label="Toggle terminal"
                title="Toggle terminal (Ctrl+J)"
                aria-expanded={terminalOpen}
                data-testid="toggle-terminal"
                onClick={() => setTerminalOpen((open) => !open)}
              >
                &gt;_
              </button>
              <button className="send-button" type="submit" disabled={(draft.trim().length === 0 && pendingImages.length === 0) || sending || runStatus === "running"} title={runStatus === "running" ? "Stop the current run before sending another message" : "Send"} data-testid="send-button">
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </form>
        </main>

        <section className="workspace" data-open={workspaceOpen} aria-label="Workspace" data-testid="workspace">
          <button className="workspace-back mobile-only" type="button" onClick={() => setWorkspaceOpen(false)} data-testid="workspace-back">
            <span aria-hidden="true">←</span> Back to conversation
          </button>
          <div className="workspace-tabs" role="tablist" aria-label="Workspace panels" data-testid="workspace-tabs">
            {WORKSPACE_TABS.map((item) => (
              <button
                key={item.id}
                id={`workspace-tab-${item.id}`}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                aria-controls="workspace-panel"
                tabIndex={tab === item.id ? 0 : -1}
                onClick={() => setTab(item.id)}
                onKeyDown={onTabKeyDown}
                data-testid={`tab-${item.id}`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="workspace-panel" id="workspace-panel" role="tabpanel" aria-labelledby={`workspace-tab-${tab}`} data-testid="workspace-panel">
            {tab === "settings" ? <SettingsPanel /> : tab === "files" ? <FilesPanel openRequest={openRequest} /> : tab === "git" ? <GitPanel /> : tab === "evals" ? <EvalsPanel /> : tab === "preview" ? <PreviewPanel /> : tab === "usage" ? <UsagePanel sessionId={activeId} /> : tab === "history" ? <HistoryPanel refreshTick={historyTick} /> : tab === "plans" ? <PlansPanel sessionId={activeId} refreshTick={planTick} /> : <TaskPanel sessionId={activeId} refreshTick={taskTick} />}
          </div>
        </section>

        <footer className="statusbar" data-testid="statusbar">
          {(() => {
            const view = contextView(usage?.context);
            return view === null ? null : (
              <span className={view.level === "high" ? "status-bad" : view.level === "warn" ? "status-warn" : "status-ok"} title={view.title} data-testid="context-meter">{view.label}</span>
            );
          })()}
          <span className="hide-narrow">tokens {usage === null ? 0 : usage.promptTokens + usage.completionTokens}</span>
          <span className="hide-narrow">${(usage?.costUsd ?? 0).toFixed(6)}</span>
          <span className={live ? "status-ok" : "status-warn"}>{live ? "sse live" : "sse idle"}</span>
          <span className={runStatus === "running" ? "status-warn" : runStatus === "blocked" ? "status-bad" : "status-ok"}>{runStatus}</span>
          <span className="spacer" />
          <span className={boot?.recovery.result === "clean" ? "status-ok" : "status-warn"}>
            recovery {boot?.recovery.result ?? "unknown"}
          </span>
          <span className="hide-narrow">local · 127.0.0.1</span>
        </footer>
      </div>

      {terminalOpen ? (
        <section className="terminal-drawer" aria-label="Terminal" data-testid="terminal-drawer">
          <div className="terminal-head">
            <strong>terminal</strong>
            <span>pipe fallback · 30 s timeout</span>
            <span className="spacer" />
            <button className="icon-button" type="button" aria-label="Close terminal" onClick={() => setTerminalOpen(false)}>×</button>
          </div>
          <TerminalPanel />
        </section>
      ) : null}

      {paletteOpen ? (
        <div className="palette-backdrop" role="presentation" onMouseDown={() => setPaletteOpen(false)}>
          <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(event) => event.stopPropagation()} data-testid="command-palette">
            <input
              ref={paletteInputRef}
              value={paletteQuery}
              onChange={(event) => {
                setPaletteQuery(event.target.value);
                setPaletteIndex(0);
              }}
              onKeyDown={onPaletteKeyDown}
              placeholder="Type a command…"
              aria-label="Command"
              aria-controls="palette-actions"
              aria-activedescendant={paletteActions[paletteIndex] === undefined ? undefined : `palette-${paletteActions[paletteIndex]?.id}`}
              data-testid="palette-input"
            />
            <ul id="palette-actions" role="listbox" aria-label="Commands">
              {paletteActions.map((action, position) => (
                <li key={action.id} role="presentation">
                  <button
                    id={`palette-${action.id}`}
                    type="button"
                    role="option"
                    aria-selected={position === paletteIndex}
                    data-active={position === paletteIndex}
                    onMouseEnter={() => setPaletteIndex(position)}
                    onClick={() => runPaletteAction(action)}
                    ref={position === paletteIndex ? (node) => node?.scrollIntoView?.({ block: "nearest" }) : undefined}
                  >
                    <span>{action.label}</span>
                    {action.hint === undefined ? null : <kbd>{action.hint}</kbd>}
                  </button>
                </li>
              ))}
              {paletteActions.length === 0 ? (
                <li className="palette-empty" data-testid="palette-empty">No command matches “{paletteQuery.trim()}”.</li>
              ) : null}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
