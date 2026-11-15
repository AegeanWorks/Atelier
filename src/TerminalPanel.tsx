import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, ApiError } from "./api";
import {
  TERMINAL_HEADER,
  pushCommand,
  readTerminal,
  writeTerminal,
  type TerminalState,
} from "./terminalStore";

interface ExecResult {
  output: string;
  exitCode: number | null;
  durationMs: number;
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} ${error.fix}`;
  return error instanceof Error ? error.message : String(error);
}

export default function TerminalPanel(): React.JSX.Element {
  const [initial] = useState<TerminalState>(() => readTerminal());
  const [command, setCommand] = useState("");
  const [output, setOutput] = useState(initial.output);
  const [history, setHistory] = useState<string[]>(initial.history);
  const [cursor, setCursor] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingDraft = useRef("");

  useEffect(() => {
    writeTerminal({ output, history });
  }, [output, history]);

  async function run(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    const trimmed = command.trim();
    if (trimmed.length === 0 || running) return;
    setRunning(true);
    setError(null);
    setOutput((current) => `${current}\n$ ${trimmed}`);
    setHistory((current) => pushCommand(current, trimmed));
    setCursor(null);
    pendingDraft.current = "";
    setCommand("");
    try {
      const result = await api<ExecResult>("/api/terminal/exec", { method: "POST", body: JSON.stringify({ command: trimmed }) });
      setOutput((current) => `${current}\n${result.output}\n[exit ${result.exitCode ?? "timeout"} · ${result.durationMs} ms]`);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setRunning(false);
    }
  }

  async function stop(): Promise<void> {
    try {
      await api("/api/terminal/stop", { method: "POST" });
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  function recall(direction: "up" | "down"): void {
    if (history.length === 0) return;
    if (direction === "up") {
      if (cursor === null) {
        pendingDraft.current = command;
        const next = history.length - 1;
        setCursor(next);
        setCommand(history[next] ?? "");
        return;
      }
      if (cursor === 0) return;
      const next = cursor - 1;
      setCursor(next);
      setCommand(history[next] ?? "");
      return;
    }
    if (cursor === null) return;
    if (cursor >= history.length - 1) {
      setCursor(null);
      setCommand(pendingDraft.current);
      return;
    }
    const next = cursor + 1;
    setCursor(next);
    setCommand(history[next] ?? "");
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      recall("up");
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      recall("down");
    }
  }

  return (
    <div className="terminal-panel" data-testid="terminal-panel">
      <pre className="terminal-output" data-testid="terminal-output">{output}</pre>
      <form className="terminal-form" onSubmit={(event) => void run(event)}>
        <input
          value={command}
          onChange={(event) => {
            setCursor(null);
            setCommand(event.target.value);
          }}
          onKeyDown={onInputKeyDown}
          placeholder="command · ↑ recalls history"
          aria-label="Terminal command"
          data-testid="terminal-input"
        />
        <button className="small-button" type="submit" disabled={running || command.trim().length === 0} data-testid="terminal-run">{running ? "Running…" : "Run"}</button>
        <button className="small-button danger" type="button" onClick={() => void stop()} disabled={!running} data-testid="terminal-stop">Stop</button>
        <button
          className="small-button"
          type="button"
          onClick={() => {
            setOutput(TERMINAL_HEADER);
            setError(null);
          }}
          disabled={output === TERMINAL_HEADER || running}
          data-testid="terminal-clear"
        >
          Clear
        </button>
      </form>
      {history.length > 0 ? (
        <p className="terminal-hint" data-testid="terminal-history-count">
          {history.length} command{history.length === 1 ? "" : "s"} in history · ↑/↓ to recall
        </p>
      ) : null}
      {error !== null ? <div className="banner-error" role="alert" data-testid="terminal-error">{error}</div> : null}
    </div>
  );
}
