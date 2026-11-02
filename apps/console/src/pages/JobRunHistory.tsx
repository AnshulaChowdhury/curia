import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api.js';

// A job's run history: each run, and for the one you open, every step with its input, output and any API codes.
// Read-only. The data comes from the audit log (GET /api/jobs/:id/runs); secret-looking fields are blanked server-side.

export interface StepCode { label: string; value: string; inferred?: boolean }

export interface RunStep {
  id: string;
  at: string;
  offsetMs: number;
  kind: 'task' | 'llm' | 'tool' | 'response' | 'error' | 'blocked';
  title: string;
  status: 'ok' | 'error' | null;
  durationMs: number | null;
  input: unknown;
  output: unknown;
  codes: StepCode[];
}

export interface RunSummary {
  runId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  outcome: 'completed' | 'failed' | 'incomplete';
  toolCalls: number;
  toolFailures: number;
  llmCalls: number;
  errors: number;
  costUsd: number;
}

export interface RunDetail extends RunSummary { steps: RunStep[]; cutOff: boolean }

type Detail = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; run: RunDetail };

const KIND_LABEL: Record<RunStep['kind'], string> = {
  task: 'task', llm: 'model', tool: 'tool', response: 'reply', error: 'error', blocked: 'blocked',
};

// Status-pill classes the stylesheet already has: green, red, amber.
const OUTCOME_PILL: Record<RunSummary['outcome'], { cls: string; label: string }> = {
  completed: { cls: 'completed', label: 'completed' },
  failed: { cls: 'failed', label: 'failed' },
  incomplete: { cls: 'timed_out', label: 'no result' },
};

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

/** "+2.0 s": how long after the run started a step happened. */
export function formatOffset(ms: number): string {
  return `+${(ms / 1000).toFixed(1)} s`;
}

function show(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function StepView({ step }: { step: RunStep }) {
  const hasBody = step.input !== null && step.input !== undefined || step.output !== null && step.output !== undefined;
  return (
    <details className={`run-step${step.status === 'error' ? ' run-step-error' : ''}`} open={step.status === 'error'}>
      <summary className="run-step-head">
        <span className="run-step-time">{formatOffset(step.offsetMs)}</span>
        <span className={`run-step-kind run-kind-${step.kind}`}>{KIND_LABEL[step.kind]}</span>
        <span className="run-step-title">{step.title}</span>
        {step.status && <span className={`run-step-status ${step.status}`}>{step.status === 'ok' ? 'ok' : 'failed'}</span>}
        {step.durationMs !== null && <span className="run-step-duration">{formatDuration(step.durationMs)}</span>}
      </summary>
      {step.codes.length > 0 && (
        <div className="run-codes">
          {step.codes.map((c, i) => (
            <span
              key={`${c.label}-${c.value}-${i}`}
              className={`run-code${c.inferred ? ' run-code-inferred' : ''}`}
              title={c.inferred ? "Inferred from the error type: the provider's own response is not recorded" : undefined}
            >
              {c.label}: {c.value}{c.inferred ? ' (inferred)' : ''}
            </span>
          ))}
        </div>
      )}
      {step.input !== null && step.input !== undefined && (
        <div className="run-io"><div className="run-io-label">Input</div><pre className="run-io-body">{show(step.input)}</pre></div>
      )}
      {step.output !== null && step.output !== undefined && (
        <div className="run-io"><div className="run-io-label">Output</div><pre className="run-io-body">{show(step.output)}</pre></div>
      )}
      {!hasBody && step.codes.length === 0 && <div className="run-step-empty">No input or output was recorded for this step.</div>}
    </details>
  );
}

export function JobRunHistory({ jobId }: { jobId: string }) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, Detail>>({});

  const loadRuns = useCallback(async (signal?: AbortSignal) => {
    setError(null);
    try {
      const res = await apiFetch(`/api/jobs/${jobId}/runs`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRuns(((await res.json()) as { runs: RunSummary[] }).runs);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('[JobRunHistory] load failed:', err);
      setError('Run history could not be loaded.');
    }
  }, [jobId]);

  useEffect(() => {
    setRuns(null);
    setOpen(null);
    setDetails({});
    const controller = new AbortController();
    void loadRuns(controller.signal);
    return () => controller.abort();
  }, [loadRuns]);

  async function toggle(runId: string) {
    if (open === runId) { setOpen(null); return; }
    setOpen(runId);
    if (details[runId]?.state === 'ready') return;
    setDetails(d => ({ ...d, [runId]: { state: 'loading' } }));
    try {
      const res = await apiFetch(`/api/jobs/${jobId}/runs/${runId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { run: RunDetail };
      setDetails(d => ({ ...d, [runId]: { state: 'ready', run: body.run } }));
    } catch (err) {
      console.error('[JobRunHistory] run load failed:', err);
      setDetails(d => ({ ...d, [runId]: { state: 'error', message: 'This run could not be loaded.' } }));
    }
  }

  return (
    <section className="run-history" aria-label="Run history">
      <div className="run-history-head">
        <h3 className="run-history-title">Run history</h3>
        <button className="btn btn-secondary btn-sm" onClick={() => void loadRuns()}>Refresh</button>
      </div>

      {error && <p className="run-history-note run-history-error">{error}</p>}
      {!error && runs === null && <p className="run-history-note">Loading…</p>}
      {runs !== null && runs.length === 0 && (
        <p className="run-history-note">No runs recorded yet. A run appears here after the job fires.</p>
      )}

      {runs !== null && runs.length > 0 && (
        <ul className="run-list">
          {runs.map(r => {
            const pill = OUTCOME_PILL[r.outcome];
            const detail = details[r.runId];
            return (
              <li key={r.runId} className="run-item">
                <button className="run-row" aria-expanded={open === r.runId} onClick={() => void toggle(r.runId)}>
                  <span className={`status-pill ${pill.cls}`}>{pill.label}</span>
                  <span className="run-when">{new Date(r.startedAt).toLocaleString()}</span>
                  <span className="run-meta">
                    {r.toolCalls} tool call{r.toolCalls === 1 ? '' : 's'}
                    {r.toolFailures > 0 ? ` (${r.toolFailures} failed)` : ''} · {r.llmCalls} model call{r.llmCalls === 1 ? '' : 's'} · {formatDuration(r.durationMs)}
                    {r.costUsd > 0 ? ` · $${r.costUsd.toFixed(4)}` : ''}
                  </span>
                </button>
                {open === r.runId && (
                  <div className="run-detail">
                    {(!detail || detail.state === 'loading') && <p className="run-history-note">Loading steps…</p>}
                    {detail?.state === 'error' && <p className="run-history-note run-history-error">{detail.message}</p>}
                    {detail?.state === 'ready' && (
                      <>
                        {detail.run.cutOff && <p className="run-history-note">This run has more steps than are shown; the end is missing.</p>}
                        {detail.run.steps.map(s => <StepView key={s.id} step={s} />)}
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
