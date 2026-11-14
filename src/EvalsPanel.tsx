import { useEffect, useState } from "react";
import { api, ApiError } from "./api";

interface EvalRun {
  id: string;
  suite: string;
  split: string;
  model: string;
  profile: { id?: string };
  status: string;
  created: number;
  metrics: { mean?: number; r1?: number; csr?: number; integrity?: string; p95Ms?: number };
}

interface EvalDetail {
  run: EvalRun;
  results: Array<{ taskId: string; repeat: number; ok: boolean; findings: Array<{ code: string; message: string }> }>;
}

interface Baseline {
  label: string;
  suite: string;
  split: string;
  harnessVersion: string;
}

interface CompareResult {
  ok: boolean;
  delta: { mean: number; low: number; high: number };
  mcnemar: number;
  flips: { improved: string[]; lost: string[]; unchanged: string[] };
  failures: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} ${error.fix}`;
  return error instanceof Error ? error.message : String(error);
}

export default function EvalsPanel(): React.JSX.Element {
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [baselines, setBaselines] = useState<Baseline[]>([]);
  const [detail, setDetail] = useState<EvalDetail | null>(null);
  const [candidate, setCandidate] = useState("");
  const [baseline, setBaseline] = useState("");
  const [comparison, setComparison] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    const [runData, baselineData] = await Promise.all([
      api<{ runs: EvalRun[] }>("/api/evals/runs"),
      api<{ baselines: Baseline[] }>("/api/evals/baselines"),
    ]);
    setRuns(runData.runs);
    setBaselines(baselineData.baselines);
    setCandidate((current) => current || runData.runs[0]?.id || "");
    setBaseline((current) => current || baselineData.baselines[0]?.label || "");
    setError(null);
  }

  async function open(id: string): Promise<void> {
    try {
      setDetail(await api<EvalDetail>(`/api/evals/runs/${id}`));
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function compare(): Promise<void> {
    if (candidate.length === 0) return;
    try {
      const query = new URLSearchParams({ candidate });
      if (baseline.length > 0) query.set("baseline", baseline);
      setComparison(await api<CompareResult>(`/api/evals/compare?${query.toString()}`));
      setError(null);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  useEffect(() => {
    void refresh().catch((caught) => setError(messageOf(caught)));
  }, []);

  return (
    <div className="evals-panel" data-testid="evals-panel">
      <div className="panel-card">
        <div className="file-head">
          <h2>Harness runs</h2>
          <button className="small-button" type="button" onClick={() => void refresh()} data-testid="evals-refresh">Refresh</button>
        </div>
        <p>Fixture runs are paired to an immutable baseline; the test split is release-only.</p>
        <ul className="provider-list" data-testid="evals-runs">
          {runs.length === 0 ? <li className="provider-row"><span className="provider-meta">No eval runs yet. Use `npm run eval`.</span></li> : null}
          {runs.map((run) => (
            <li className="provider-row" key={run.id} data-testid="eval-run">
              <button type="button" className="file-item" onClick={() => void open(run.id)}>
                {run.suite} · {run.split} · {run.profile.id ?? "profile"}
              </button>
              <span className={run.metrics.integrity === "clean" ? "key-badge key-set" : "key-badge key-missing"}>
                {run.metrics.integrity ?? "unknown"}
              </span>
              <span className="provider-meta">mean {run.metrics.mean?.toFixed(2) ?? "?"}</span>
              <span className="provider-meta">csr {run.metrics.csr?.toFixed(2) ?? "?"}</span>
              <span className="provider-meta">p95 {run.metrics.p95Ms ?? 0} ms</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="panel-card">
        <h2>Compare</h2>
        <div className="role-grid">
          <label className="field">
            <span>Baseline</span>
            <select
              value={baseline}
              onChange={(event) => setBaseline(event.target.value)}
              aria-label="Baseline"
              data-testid="eval-baseline"
              disabled={baselines.length === 0}
            >
              {baselines.length === 0 ? <option value="">No baselines yet</option> : null}
              {baselines.map((entry) => <option key={entry.label} value={entry.label}>{entry.label} · {entry.suite}/{entry.split}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Candidate run</span>
            <select
              value={candidate}
              onChange={(event) => setCandidate(event.target.value)}
              aria-label="Candidate run"
              data-testid="eval-candidate"
              disabled={runs.length === 0}
            >
              {runs.length === 0 ? <option value="">No harness runs yet</option> : null}
              {runs.map((run) => <option key={run.id} value={run.id}>{run.id} · {run.profile.id ?? "profile"}</option>)}
            </select>
          </label>
        </div>
        <button
          className="small-button"
          type="button"
          onClick={() => void compare()}
          disabled={candidate.length === 0}
          data-testid="eval-compare-run"
        >
          Compare
        </button>
        {comparison !== null ? (
          <div data-testid="eval-compare">
            <p className={comparison.ok ? "status-ok" : "status-bad"}>
              {comparison.ok ? "PASS" : "FAIL"} · delta {comparison.delta.mean.toFixed(3)} · CI [{comparison.delta.low.toFixed(3)}, {comparison.delta.high.toFixed(3)}] · McNemar {comparison.mcnemar.toFixed(3)}
            </p>
            <p className="provider-meta">improved {comparison.flips.improved.length} · lost {comparison.flips.lost.length} · unchanged {comparison.flips.unchanged.length}</p>
            {comparison.failures.map((failure) => <p key={failure.code} className="status-bad">{failure.code}: {failure.message}</p>)}
            {comparison.warnings.map((warning) => <p key={warning.code} className="status-warn">{warning.code}: {warning.message}</p>)}
          </div>
        ) : null}
      </div>

      <div className="panel-card" data-testid="eval-pareto">
        <h2>Pareto: mean vs p95</h2>
        {runs.map((run) => (
          <div className="git-change" key={run.id}>
            <span className="provider-meta">{run.id.slice(0, 18)}</span>
            <div className="pbar"><i style={{ width: `${Math.round((run.metrics.mean ?? 0) * 100)}%` }} /></div>
            <span className="provider-meta">mean {run.metrics.mean?.toFixed(2) ?? "?"} · p95 {run.metrics.p95Ms ?? 0} ms</span>
          </div>
        ))}
      </div>

      {detail !== null ? (
        <div className="panel-card" data-testid="eval-detail">
          <h2>Run {detail.run.id}</h2>
          <p className="provider-meta">mean {detail.run.metrics.mean?.toFixed(3) ?? "?"} · csr {detail.run.metrics.csr?.toFixed(3) ?? "?"} · {detail.run.metrics.integrity ?? "unknown"}</p>
          <ul className="file-tree">
            {detail.results.map((result) => (
              <li key={`${result.taskId}-${result.repeat}`} className="git-change">
                <span className="provider-meta">{result.taskId}#{result.repeat}</span>
                <span className={result.ok ? "key-badge key-set" : "key-badge key-missing"}>{result.ok ? "PASS" : "FAIL"}</span>
                <span className="provider-meta">{result.findings.map((finding) => finding.code).join(", ") || "clean"}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error !== null ? <div className="banner-error" role="alert" data-testid="evals-error">{error}</div> : null}
    </div>
  );
}
