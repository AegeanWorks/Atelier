import { useEffect, useState, type FormEvent } from "react";
import type { HookConfig, McpServerConfig, McpTransport, RuleConfig } from "./types";
import { api, ApiError } from "./api";
import type { ConfigView, Protocol, ProviderStatus } from "./types";

const PROTOCOLS: ReadonlyArray<{ id: Protocol; label: string; placeholder: string }> = [
  { id: "openai-chat", label: "OpenAI Chat", placeholder: "https://api.openai.com/v1" },
  { id: "openai-responses", label: "OpenAI Responses", placeholder: "https://api.openai.com/v1" },
  { id: "anthropic-messages", label: "Anthropic Messages", placeholder: "https://api.anthropic.com" },
  { id: "gemini", label: "Gemini", placeholder: "https://generativelanguage.googleapis.com/v1beta" },
];

interface Draft {
  name: string;
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
  apiKeyEnv: string;
}

const EMPTY: Draft = { name: "", protocol: "openai-chat", baseUrl: "", apiKey: "", apiKeyEnv: "" };

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} ${error.fix}`;
  return error instanceof Error ? error.message : String(error);
}

interface ModelOption {
  id: string;
}

export default function SettingsPanel(): React.JSX.Element {
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);

  const [mcp, setMcp] = useState({ name: "", transport: "stdio" as McpTransport, command: "", args: "", url: "" });
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpConfirm, setMcpConfirm] = useState<string | null>(null);
  const [hook, setHook] = useState({ name: "", event: "pre_tool" as HookConfig["event"], match: ".*", command: "" });
  const [hookBusy, setHookBusy] = useState(false);
  const [hookConfirm, setHookConfirm] = useState<string | null>(null);
  const [rule, setRule] = useState({ name: "", action: "exec" as RuleConfig["action"], match: "", decision: "allow" as RuleConfig["decision"] });
  const [ruleBusy, setRuleBusy] = useState(false);
  const [ruleConfirm, setRuleConfirm] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState({ name: "", protocol: "openai-chat" as Protocol, baseUrl: "", apiKey: "", clearKey: false });
  const [modelsState, setModelsState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    const data = await api<ConfigView>("/api/config");
    setConfig(data);
  }

  useEffect(() => {
    void refresh().catch((caught) => setError(messageOf(caught)));
  }, []);

  const defaultProvider = config?.defaults.provider ?? null;

  useEffect(() => {
    if (defaultProvider === null) {
      setModels([]);
      setModelsState("idle");
      return;
    }
    let cancelled = false;
    setModelsState("loading");
    void (async () => {
      try {
        const data = await api<{ models: ModelOption[] }>(`/api/models?provider=${encodeURIComponent(defaultProvider)}`);
        if (cancelled) return;
        setModels(data.models);
        setModelsState("ready");
      } catch {
        if (cancelled) return;
        setModels([]);
        setModelsState("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [defaultProvider]);

  async function addProvider(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const body: Record<string, string> = {
        name: draft.name.trim(),
        protocol: draft.protocol,
        baseUrl: draft.baseUrl.trim(),
      };
      if (draft.apiKey.trim().length > 0) body.apiKey = draft.apiKey.trim();
      if (draft.apiKeyEnv.trim().length > 0) body.apiKeyEnv = draft.apiKeyEnv.trim().toUpperCase();
      await api<{ provider: ProviderStatus }>("/api/providers", { method: "POST", body: JSON.stringify(body) });
      setDraft(EMPTY);
      setMessage(`Saved ${draft.name.trim()}.`);
      await refresh();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function testProvider(provider: ProviderStatus): Promise<void> {
    setTesting(provider.id);
    setError(null);
    setMessage(null);
    try {
      const result = await api<{ ok: boolean; modelCount?: number; latencyMs: number; error?: { what: string; fix: string } }>(
        `/api/providers/${provider.id}/test`,
        { method: "POST" },
      );
      setMessage(result.ok ? `${provider.name}: ${result.modelCount ?? 0} models in ${result.latencyMs} ms.` : `${provider.name}: ${result.error?.what ?? "test failed"} ${result.error?.fix ?? ""}`);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setTesting(null);
    }
  }

  function startEdit(provider: ProviderStatus): void {
    setEditingId(provider.id);
    setEdit({ name: provider.name, protocol: provider.protocol, baseUrl: provider.baseUrl, apiKey: "", clearKey: false });
    setError(null);
    setMessage(null);
  }

  async function saveEdit(event: FormEvent, provider: ProviderStatus): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const body: Record<string, unknown> = {
        name: edit.name.trim(),
        protocol: edit.protocol,
        baseUrl: edit.baseUrl.trim(),
      };
      if (edit.apiKey.trim().length > 0) body.apiKey = edit.apiKey.trim();
      if (edit.clearKey) body.clearKey = true;
      await api<{ provider: ProviderStatus }>(`/api/providers/${provider.id}`, { method: "PUT", body: JSON.stringify(body) });
      setEditingId(null);
      setMessage(`Updated ${edit.name.trim()}.`);
      await refresh();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  function mcpId(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "mcp";
  }

  function mcpArgs(text: string): string[] {
    return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  }

  async function saveMcp(servers: McpServerConfig[]): Promise<void> {
    setMcpBusy(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await api<{ mcpServers: McpServerConfig[] }>("/api/config", {
        method: "PUT",
        body: JSON.stringify({ mcpServers: servers }),
      });
      setConfig((current) => (current === null ? current : { ...current, mcpServers: saved.mcpServers }));
      return;
    } finally {
      setMcpBusy(false);
    }
  }

  async function addMcp(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (config === null) return;
    const name = mcp.name.trim();
    if (name.length === 0) return;
    const id = mcpId(name);
    if ((config.mcpServers ?? []).some((entry) => entry.id === id)) {
      setError(`An MCP server named ${name} already exists. Pick another name or remove the existing one first.`);
      return;
    }
    const server: McpServerConfig = mcp.transport === "stdio"
      ? { id, name, transport: "stdio", command: mcp.command.trim(), ...(mcpArgs(mcp.args).length === 0 ? {} : { args: mcpArgs(mcp.args) }) }
      : { id, name, transport: mcp.transport, url: mcp.url.trim() };
    try {
      await saveMcp([...(config.mcpServers ?? []), server]);
      setMcp({ name: "", transport: "stdio", command: "", args: "", url: "" });
      setMessage(`Saved MCP server ${name}.`);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function removeMcp(server: McpServerConfig): Promise<void> {
    if (config === null) return;
    try {
      await saveMcp((config.mcpServers ?? []).filter((entry) => entry.id !== server.id));
      setMcpConfirm(null);
      setMessage(`Removed MCP server ${server.name}.`);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function saveHooks(list: HookConfig[]): Promise<void> {
    setHookBusy(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await api<{ hooks: HookConfig[] }>("/api/config", { method: "PUT", body: JSON.stringify({ hooks: list }) });
      setConfig((current) => (current === null ? current : { ...current, hooks: saved.hooks }));
    } finally {
      setHookBusy(false);
    }
  }

  async function addHook(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (config === null) return;
    const name = hook.name.trim();
    const id = mcpId(name).replace(/^mcp$/, "hook");
    if (name.length === 0) return;
    try {
      new RegExp(hook.match);
    } catch {
      setError("Match must be a valid regular expression over the tool name, for example write_file|edit_file.");
      return;
    }
    if ((config.hooks ?? []).some((entry) => entry.id === id)) {
      setError(`A hook named ${name} already exists. Pick another name or remove the existing one first.`);
      return;
    }
    try {
      await saveHooks([...(config.hooks ?? []), { id, event: hook.event, match: hook.match, command: hook.command.trim() }]);
      setHook({ name: "", event: "pre_tool", match: ".*", command: "" });
      setMessage(`Saved hook ${name}.`);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function removeHook(target: HookConfig): Promise<void> {
    if (config === null) return;
    try {
      await saveHooks((config.hooks ?? []).filter((entry) => entry.id !== target.id));
      setHookConfirm(null);
      setMessage(`Removed hook ${target.id}.`);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function saveRules(list: RuleConfig[]): Promise<void> {
    setRuleBusy(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await api<{ rules: RuleConfig[] }>("/api/config", { method: "PUT", body: JSON.stringify({ rules: list }) });
      setConfig((current) => (current === null ? current : { ...current, rules: saved.rules }));
    } finally {
      setRuleBusy(false);
    }
  }

  async function addRule(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (config === null) return;
    const name = rule.name.trim();
    const match = rule.match.trim();
    if (name.length === 0 || match.length === 0) return;
    const id = mcpId(name).replace(/^mcp$/, "rule");
    if (rule.decision === "allow" && /^\*+$/.test(match)) {
      setError(`That allow rule is too broad: it would approve every ${rule.action === "exec" ? "command" : "edit"}. Name the command or path, for example ${rule.action === "exec" ? "npm test*" : "docs/*"}.`);
      return;
    }
    if ((config.rules ?? []).some((entry) => entry.id === id)) {
      setError(`A rule named ${name} already exists. Pick another name or remove the existing one first.`);
      return;
    }
    try {
      await saveRules([...(config.rules ?? []), { id, action: rule.action, match, decision: rule.decision }]);
      setRule({ name: "", action: "exec", match: "", decision: "allow" });
      setMessage(`Saved rule ${name}.`);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function removeRule(target: RuleConfig): Promise<void> {
    if (config === null) return;
    try {
      await saveRules((config.rules ?? []).filter((entry) => entry.id !== target.id));
      setRuleConfirm(null);
      setMessage(`Removed rule ${target.id}.`);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function removeProvider(provider: ProviderStatus): Promise<void> {
    setError(null);
    setMessage(null);
    try {
      await api(`/api/providers/${provider.id}`, { method: "DELETE" });
      setMessage(`Removed ${provider.name}.`);
      await refresh();
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function saveRoles(): Promise<void> {
    if (config === null) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await api<ConfigView["roles"]>("/api/config", {
        method: "PUT",
        body: JSON.stringify({ roles: config.roles }),
      });
      setConfig({ ...config, roles: saved });
      setMessage("Role bindings saved.");
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  function updateRole(role: keyof ConfigView["roles"], value: string): void {
    if (config === null) return;
    setConfig({ ...config, roles: { ...config.roles, [role]: value.length === 0 ? null : value } });
  }

  function updateDefault(field: "provider" | "model", value: string): void {
    setConfig((current) => {
      if (current === null) return current;
      if (field === "provider") {
        return { ...current, defaults: { provider: value.length === 0 ? null : value, model: null } };
      }
      return { ...current, defaults: { ...current.defaults, model: value.length === 0 ? null : value } };
    });
  }

  async function saveDefaults(): Promise<void> {
    if (config === null) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await api<{ defaults: ConfigView["defaults"] }>("/api/config", {
        method: "PUT",
        body: JSON.stringify({ defaults: config.defaults }),
      });
      setConfig({ ...config, defaults: saved.defaults });
      setMessage(saved.defaults.provider === null
        ? "Default provider cleared."
        : `Default is ${saved.defaults.provider}${saved.defaults.model === null ? "" : ` · ${saved.defaults.model}`}.`);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-panel" data-testid="settings-panel">
      <div className="panel-card">
        <h2>Providers</h2>
        <p>API keys stay on this machine; only set or missing is shown.</p>
        {config === null ? <p>Loading providers…</p> : null}
        {config !== null && config.providers.length === 0 ? <p>No providers yet. Add a compatible endpoint below.</p> : null}
        <ul className="provider-list" data-testid="provider-list">
          {(config?.providers ?? []).map((provider) => (
            <li className="provider-row" key={provider.id} data-testid="provider-row">
              {editingId === provider.id ? (
                <form className="provider-edit" onSubmit={(event) => void saveEdit(event, provider)} data-testid="provider-edit">
                  <label className="field">
                    <span>Name</span>
                    <input required value={edit.name} onChange={(event) => setEdit({ ...edit, name: event.target.value })} data-testid="edit-provider-name" />
                  </label>
                  <label className="field">
                    <span>Protocol</span>
                    <select value={edit.protocol} onChange={(event) => setEdit({ ...edit, protocol: event.target.value as Protocol })} data-testid="edit-provider-protocol">
                      {PROTOCOLS.map((protocol) => <option key={protocol.id} value={protocol.id}>{protocol.label}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <span>Base URL</span>
                    <input required value={edit.baseUrl} onChange={(event) => setEdit({ ...edit, baseUrl: event.target.value })} data-testid="edit-provider-url" />
                  </label>
                  <label className="field">
                    <span>Replace key (optional)</span>
                    <input type="password" value={edit.apiKey} onChange={(event) => setEdit({ ...edit, apiKey: event.target.value })} placeholder="Leave blank to keep the stored key" data-testid="edit-provider-key" autoComplete="off" />
                  </label>
                  <label className="inline-check">
                    <input type="checkbox" checked={edit.clearKey} onChange={(event) => setEdit({ ...edit, clearKey: event.target.checked })} data-testid="edit-provider-clear-key" />
                    <span>Clear the stored key</span>
                  </label>
                  <div className="provider-edit-actions">
                    <button className="small-button" type="submit" disabled={busy} data-testid="save-provider-edit">Save</button>
                    <button className="small-button" type="button" onClick={() => setEditingId(null)} data-testid="cancel-provider-edit">Cancel</button>
                  </div>
                </form>
              ) : (
              <>
              <div className="provider-main">
                <strong>{provider.name}</strong>
                <span className="provider-meta">{provider.protocol} · {provider.baseUrl}</span>
              </div>
              <span className={provider.key.set ? "key-badge key-set" : "key-badge key-missing"}>
                {provider.key.set ? `SET (${provider.key.source})` : "MISSING"}
              </span>
              <span className="provider-meta">{provider.modelCount} models</span>
              <button className="small-button" type="button" disabled={testing === provider.id} onClick={() => void testProvider(provider)} data-testid={`test-provider-${provider.id}`}>
                {testing === provider.id ? "Testing…" : "Test"}
              </button>
              <button className="small-button" type="button" onClick={() => startEdit(provider)} data-testid={`edit-provider-${provider.id}`}>
                Edit
              </button>
              <button className="small-button danger" type="button" onClick={() => void removeProvider(provider)} data-testid={`delete-provider-${provider.id}`}>
                Remove
              </button>
              </>
              )}
            </li>
          ))}
        </ul>
      </div>

      <form className="panel-card settings-form" onSubmit={(event) => void addProvider(event)} data-testid="add-provider">
        <h2>Add provider</h2>
        <label className="field">
          <span>Name</span>
          <input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="My provider" data-testid="provider-name" />
        </label>
        <label className="field">
          <span>Protocol</span>
          <select value={draft.protocol} onChange={(event) => setDraft({ ...draft, protocol: event.target.value as Protocol })} data-testid="provider-protocol">
            {PROTOCOLS.map((protocol) => <option key={protocol.id} value={protocol.id}>{protocol.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Base URL</span>
          <input required value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder={PROTOCOLS.find((entry) => entry.id === draft.protocol)?.placeholder} data-testid="provider-url" />
        </label>
        <label className="field">
          <span>Key (optional)</span>
          <input type="password" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder="Saved server-side; never rendered" data-testid="provider-key" autoComplete="off" />
        </label>
        <label className="field">
          <span>Key env var (optional)</span>
          <input value={draft.apiKeyEnv} onChange={(event) => setDraft({ ...draft, apiKeyEnv: event.target.value })} placeholder="OPENAI_API_KEY" data-testid="provider-key-env" />
        </label>
        <button className="send-button" type="submit" disabled={busy} data-testid="save-provider">{busy ? "Saving…" : "Add provider"}</button>
      </form>

      <div className="panel-card" data-testid="defaults-card">
        <h2>Default model</h2>
        <p>A new run uses this provider and model unless a role overrides them. Type any model id when the endpoint does not list models.</p>
        <div className="role-grid">
          <label className="field">
            <span>Provider</span>
            <select
              value={config?.defaults.provider ?? ""}
              onChange={(event) => updateDefault("provider", event.target.value)}
              data-testid="default-provider"
              disabled={config === null}
            >
              <option value="">unassigned</option>
              {(config?.providers ?? []).map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Model</span>
            <input
              value={config?.defaults.model ?? ""}
              onChange={(event) => updateDefault("model", event.target.value)}
              placeholder={modelsState === "loading" ? "loading models…" : "model id"}
              list="atelier-models"
              data-testid="default-model"
              disabled={config === null}
            />
            <datalist id="atelier-models">
              {models.map((model) => <option key={model.id} value={model.id} />)}
            </datalist>
          </label>
        </div>
        {modelsState === "ready" ? (
          <small data-testid="default-model-count">{models.length} model(s) listed by the provider.</small>
        ) : null}
        {modelsState === "failed" ? (
          <small data-testid="default-model-failed">The provider did not list models; type the model id explicitly.</small>
        ) : null}
        <button className="small-button" type="button" onClick={() => void saveDefaults()} disabled={busy || config === null} data-testid="save-defaults">Save default</button>
      </div>

      <div className="panel-card">
        <h2>Model roles</h2>
        <p>Each role resolves independently; leave a role unassigned to use the default.</p>
        <div className="role-grid">
          {(["executor", "manager", "auditor", "compactor"] as const).map((role) => (
            <label className="field" key={role}>
              <span>{role}</span>
              <select value={config?.roles[role] ?? ""} onChange={(event) => updateRole(role, event.target.value)} data-testid={`role-${role}`}>
                <option value="">unassigned</option>
                {(config?.providers ?? []).map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
              </select>
            </label>
          ))}
        </div>
        <button className="small-button" type="button" onClick={() => void saveRoles()} disabled={busy || config === null} data-testid="save-roles">Save roles</button>
      </div>

      <div className="panel-card" data-testid="mcp-card">
        <h2>MCP servers</h2>
        <p>Servers the agent may expose as tools. A stdio server needs a command; http and sse servers need a URL.</p>
        {(config?.mcpServers ?? []).length === 0 ? <p className="provider-meta">No MCP servers configured.</p> : null}
        <ul className="provider-list" data-testid="mcp-list">
          {(config?.mcpServers ?? []).map((server) => (
            <li className="provider-row mcp-row" key={server.id} data-testid="mcp-row">
              <div className="provider-main">
                <strong>{server.name}</strong>
                <span className="provider-meta">{server.id} · {server.transport} · {server.transport === "stdio" ? `${server.command ?? ""} ${(server.args ?? []).join(" ")}`.trim() : server.url ?? ""}</span>
              </div>
              <button
                className="small-button danger"
                type="button"
                disabled={mcpBusy}
                onClick={() => (mcpConfirm === server.id ? void removeMcp(server) : setMcpConfirm(server.id))}
                data-testid={mcpConfirm === server.id ? "mcp-remove-confirm" : "mcp-remove"}
              >
                {mcpConfirm === server.id ? "Remove?" : "Remove"}
              </button>
            </li>
          ))}
        </ul>
        <form className="settings-form" onSubmit={(event) => void addMcp(event)} data-testid="add-mcp">
          <label className="field">
            <span>Name</span>
            <input required value={mcp.name} onChange={(event) => setMcp({ ...mcp, name: event.target.value })} placeholder="Filesystem" data-testid="mcp-name" />
          </label>
          <label className="field">
            <span>Transport</span>
            <select value={mcp.transport} onChange={(event) => setMcp({ ...mcp, transport: event.target.value as McpTransport })} data-testid="mcp-transport">
              <option value="stdio">stdio</option>
              <option value="http">http</option>
              <option value="sse">sse</option>
            </select>
          </label>
          {mcp.transport === "stdio" ? (
            <>
              <label className="field">
                <span>Command</span>
                <input required value={mcp.command} onChange={(event) => setMcp({ ...mcp, command: event.target.value })} placeholder="npx" data-testid="mcp-command" />
              </label>
              <label className="field">
                <span>Arguments (one per line)</span>
                <textarea value={mcp.args} onChange={(event) => setMcp({ ...mcp, args: event.target.value })} rows={3} data-testid="mcp-args" />
              </label>
            </>
          ) : (
            <label className="field">
              <span>URL</span>
              <input required value={mcp.url} onChange={(event) => setMcp({ ...mcp, url: event.target.value })} placeholder="http://127.0.0.1:3001/mcp" data-testid="mcp-url" />
            </label>
          )}
          <button className="small-button" type="submit" disabled={mcpBusy || config === null} data-testid="save-mcp">Add MCP server</button>
        </form>
      </div>

      <div className="panel-card" data-testid="rules-card">
        <h2>Permission rules</h2>
        <p>Decide in advance what Build mode may do without asking. An allow rule skips the approval prompt for matching commands or paths; a deny rule refuses them even when you approve everything. * matches any text. A deny always wins, and an allow never covers a command that chains (&amp;&amp;, ;, |), redirects or substitutes, so those still ask. Secrets, paths outside the workspace and destructive commands stay blocked whatever the rules say.</p>
        {(config?.rules ?? []).length === 0 ? <p className="provider-meta">No rules yet, so every edit and command asks.</p> : null}
        <ul className="provider-list" data-testid="rules-list">
          {(config?.rules ?? []).map((entry) => (
            <li className="provider-row mcp-row" key={entry.id} data-testid="rule-row">
              <div className="provider-main">
                <strong>{entry.decision} · {entry.id}</strong>
                <span className="provider-meta">{entry.action === "exec" ? "command" : "edit"} · {entry.match}</span>
              </div>
              <button
                className="small-button danger"
                type="button"
                disabled={ruleBusy}
                onClick={() => (ruleConfirm === entry.id ? void removeRule(entry) : setRuleConfirm(entry.id))}
                data-testid={ruleConfirm === entry.id ? "rule-remove-confirm" : "rule-remove"}
              >
                {ruleConfirm === entry.id ? "Remove?" : "Remove"}
              </button>
            </li>
          ))}
        </ul>
        <form className="settings-form" onSubmit={(event) => void addRule(event)} data-testid="add-rule">
          <label className="field">
            <span>Name</span>
            <input required value={rule.name} onChange={(event) => setRule({ ...rule, name: event.target.value })} placeholder="Run tests" data-testid="rule-name" />
          </label>
          <label className="field">
            <span>Applies to</span>
            <select value={rule.action} onChange={(event) => setRule({ ...rule, action: event.target.value as RuleConfig["action"] })} data-testid="rule-action">
              <option value="exec">a command</option>
              <option value="edit">a file edit</option>
            </select>
          </label>
          <label className="field">
            <span>Matches (* is a wildcard)</span>
            <input required value={rule.match} onChange={(event) => setRule({ ...rule, match: event.target.value })} placeholder={rule.action === "exec" ? "npm test*" : "docs/*"} data-testid="rule-match" />
          </label>
          <label className="field">
            <span>Decision</span>
            <select value={rule.decision} onChange={(event) => setRule({ ...rule, decision: event.target.value as RuleConfig["decision"] })} data-testid="rule-decision">
              <option value="allow">allow without asking</option>
              <option value="deny">always refuse</option>
            </select>
          </label>
          <button className="small-button" type="submit" disabled={ruleBusy || config === null} data-testid="save-rule">Add rule</button>
        </form>
      </div>

      <div className="panel-card" data-testid="hooks-card">
        <h2>Hooks</h2>
        <p>Commands that run around the agent's tool calls, in the workspace. A pre_tool hook that exits with code 2 vetoes the call and its output is shown to the model; any other exit code only logs. Details reach the command as ATELIER_* environment variables.</p>
        {(config?.hooks ?? []).length === 0 ? <p className="provider-meta">No hooks configured.</p> : null}
        <ul className="provider-list" data-testid="hooks-list">
          {(config?.hooks ?? []).map((entry) => (
            <li className="provider-row mcp-row" key={entry.id} data-testid="hook-row">
              <div className="provider-main">
                <strong>{entry.id}</strong>
                <span className="provider-meta">{entry.event} · {entry.match} · {entry.command}</span>
              </div>
              <button
                className="small-button danger"
                type="button"
                disabled={hookBusy}
                onClick={() => (hookConfirm === entry.id ? void removeHook(entry) : setHookConfirm(entry.id))}
                data-testid={hookConfirm === entry.id ? "hook-remove-confirm" : "hook-remove"}
              >
                {hookConfirm === entry.id ? "Remove?" : "Remove"}
              </button>
            </li>
          ))}
        </ul>
        <form className="settings-form" onSubmit={(event) => void addHook(event)} data-testid="add-hook">
          <label className="field">
            <span>Name</span>
            <input required value={hook.name} onChange={(event) => setHook({ ...hook, name: event.target.value })} placeholder="Block writes" data-testid="hook-name" />
          </label>
          <label className="field">
            <span>Runs</span>
            <select value={hook.event} onChange={(event) => setHook({ ...hook, event: event.target.value as HookConfig["event"] })} data-testid="hook-event">
              <option value="pre_tool">before a tool (can veto)</option>
              <option value="post_tool">after a tool</option>
            </select>
          </label>
          <label className="field">
            <span>Tools (regular expression)</span>
            <input value={hook.match} onChange={(event) => setHook({ ...hook, match: event.target.value })} placeholder="write_file|edit_file" data-testid="hook-match" />
          </label>
          <label className="field">
            <span>Command</span>
            <input required value={hook.command} onChange={(event) => setHook({ ...hook, command: event.target.value })} placeholder="node scripts/check.js" data-testid="hook-command" />
          </label>
          <button className="small-button" type="submit" disabled={hookBusy || config === null} data-testid="save-hook">Add hook</button>
        </form>
      </div>

      {message !== null ? <div className="banner-ok" role="status" data-testid="settings-message">{message}</div> : null}
      {error !== null ? <div className="banner-error" role="alert" data-testid="settings-error">{error}</div> : null}
    </div>
  );
}
