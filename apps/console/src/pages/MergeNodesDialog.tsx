import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Modal } from '../components/Modal.js';
import { apiFetch } from '../api.js';
import { sensitivityBadgeClass, typeBadgeClass } from './kg-types.js';
import type { ApiKgNode } from './kg-types.js';
import type {
  FactChoice,
  MergeCandidate,
  MergeFactSummary,
  NearDuplicateChoice,
  NodeMergePreview,
  NodeMergeResolutions,
  NodeMergeResult,
  Side,
} from './kg-merge-types.js';
import {
  CANDIDATE_LIMIT,
  SEARCH_DEBOUNCE_MS,
  STALE_PREVIEW_NOTICE,
  applyButtonLabel,
  applyHint,
  buildApplyRequest,
  buildPreviewRequest,
  canApply,
  candidateReasonLabel,
  cardFor,
  classifyApplyError,
  classifyMergeError,
  contactPlanSentence,
  crossTypeBanner,
  displayAliases,
  filterCandidates,
  filterSearchResults,
  formatConfidence,
  formatDay,
  formatValue,
  hasContactSection,
  isLabelAllowed,
  isNodeMergePreview,
  isNodeMergeResult,
  isRetryable,
  labelCollisionReason,
  labelsDiffer,
  mergeResolutions,
  outcomeUnknownError,
  plural,
  quoted,
  resultAliases,
  retainAcknowledgements,
  retainValidChoices,
  searchUrl,
  suggestionText,
  summaryLines,
  swapResolutions,
  toggleAcknowledgement,
} from './kg-merge-utils.js';
import type { MergeCardData, MergeError } from './kg-merge-utils.js';

// Two-step merge dialog for knowledge-graph nodes (design §10.2–10.3).
// Step 1 picks the other node; step 2 reviews the server's dry-run preview and
// applies it. All decisions live in kg-merge-utils.ts; this file renders.

export interface MergeNodesDialogProps {
  /** The node the user started from. It is the survivor until they swap. */
  node: ApiKgNode;
  onClose: () => void;
  /** Called after a successful apply. The parent closes the dialog. */
  onMerged: (result: NodeMergeResult, labels: { absorbed: string; survivor: string }) => void;
  /**
   * Called when the apply request may or may not have committed (network or
   * gateway error, unreadable response). The dialog stays open with a notice;
   * the parent should refresh what it shows so the user can check.
   */
  onOutcomeUnknown: () => void;
}

type Pair = { survivorId: string; absorbedId: string };
type ChoiceSection = 'properties' | 'facts' | 'nearDuplicateFacts' | 'contactFields' | 'authOverrides';

interface ListState<T> {
  status: 'loading' | 'ready' | 'error';
  items: T[];
  error?: string;
  /** The server has no merge service (503 `unavailable`). */
  unavailable?: boolean;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

async function readJson(res: Response): Promise<unknown> {
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) return null;
  try {
    return await res.json() as unknown;
  } catch (err) {
    console.error('[MergeNodesDialog] failed to parse JSON body:', err);
    return null;
  }
}

function errorText(body: unknown, status: number): string {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const e = (body as { error: unknown }).error;
    if (typeof e === 'string' && e.trim()) return e;
  }
  return `HTTP ${status}`;
}

// ── Small presentational pieces ─────────────────────────────────────────────

function SwapIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 4 3 8l4 4" /><path d="M3 8h14" /><path d="m17 20 4-4-4-4" /><path d="M21 16H7" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function AliasLine({ aliases, max = 3 }: { aliases: readonly string[] | undefined; max?: number }) {
  const { shown, more } = displayAliases(aliases, max);
  if (shown.length === 0) return null;
  return (
    <span className="kg-merge-aliases-inline">
      also {shown.join(', ')}{more > 0 ? ` +${more}` : ''}
    </span>
  );
}

function NodeCard({ role, card }: { role: 'keep' | 'absorb'; card: MergeCardData | null }) {
  const eyebrow = role === 'keep' ? 'Keep' : 'Merge in';
  if (!card) {
    return (
      <div className={`kg-merge-card kg-merge-card-${role} is-placeholder`}>
        <div className="kg-merge-card-eyebrow">{eyebrow}</div>
        <div className="kg-merge-card-label">Loading…</div>
      </div>
    );
  }
  return (
    <div className={`kg-merge-card kg-merge-card-${role}`}>
      <div className="kg-merge-card-eyebrow">{eyebrow}</div>
      <div className="kg-merge-card-badges">
        <span className={typeBadgeClass(card.type)}>{card.type}</span>
        {card.sensitivity && <span className={sensitivityBadgeClass(card.sensitivity)}>{card.sensitivity}</span>}
      </div>
      <div className="kg-merge-card-label">{card.label || '(no label)'}</div>
      <AliasLine aliases={card.aliases} />
      {card.stats && <div className="kg-merge-card-stats">{card.stats}</div>}
      {card.contacts.length > 0 && (
        <ul className="kg-merge-card-contacts" aria-label="Linked contacts">
          {card.contacts.map(c => <li key={c}>{c}</li>)}
        </ul>
      )}
      {role === 'absorb' && <div className="kg-merge-card-note">Archived after the merge</div>}
    </div>
  );
}

function Section({ title, count, hint, children }: { title: string; count?: number; hint?: string; children: ReactNode }) {
  return (
    <section className="kg-merge-section">
      <h3 className="kg-merge-section-title">
        {title}
        {count !== undefined && <span className="kg-merge-count">{count}</span>}
      </h3>
      {hint && <p className="kg-merge-section-hint">{hint}</p>}
      {children}
    </section>
  );
}

/** Coloured tag naming which node a value comes from. */
function SideTag({ side, label }: { side: Side; label: string }) {
  return <span className={`kg-merge-side kg-merge-side-${side}`} title={label}>{label || '(no label)'}</span>;
}

interface OptionProps {
  name: string;
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
  children: ReactNode;
  wide?: boolean;
  /** Set when this option cannot be chosen at all (not merely busy); shown as the tooltip. */
  unavailableReason?: string | null;
}

function Option({ name, checked, disabled, onSelect, children, wide, unavailableReason }: OptionProps) {
  const cls = `kg-merge-option${checked ? ' is-selected' : ''}${wide ? ' is-wide' : ''}`
    + `${unavailableReason ? ' is-unavailable' : ''}`;
  return (
    <label className={cls} title={unavailableReason ?? undefined}>
      <input type="radio" name={name} checked={checked} disabled={disabled || !!unavailableReason} onChange={onSelect} />
      <span className="kg-merge-option-body">{children}</span>
    </label>
  );
}

function FactBody({ fact }: { fact: MergeFactSummary }) {
  return (
    <>
      <span className="kg-merge-fact-label">{fact.label}</span>
      <span className="kg-merge-meta">
        {fact.value !== null && <>Value <strong>{fact.value}</strong> · </>}
        Confidence {formatConfidence(fact.confidence)} · Confirmed {formatDay(fact.lastConfirmedAt)}
      </span>
    </>
  );
}

// ── Dialog ──────────────────────────────────────────────────────────────────

export function MergeNodesDialog({ node, onClose, onMerged, onOutcomeUnknown }: MergeNodesDialogProps) {
  const uid = useId();
  const [step, setStep] = useState<'pick' | 'review'>('pick');

  // Step 1
  const [candidates, setCandidates] = useState<ListState<MergeCandidate>>({ status: 'loading', items: [] });
  const [query, setQuery] = useState('');
  const [searchState, setSearchState] = useState<(ListState<ApiKgNode> & { query: string }) | null>(null);
  const [other, setOther] = useState<ApiKgNode | null>(null);

  // Step 2
  const [pair, setPair] = useState<Pair | null>(null);
  const [preview, setPreview] = useState<NodeMergePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<MergeError | null>(null);
  // Only the user's explicit choices; defaults come from the preview.
  const [choices, setChoices] = useState<NodeMergeResolutions>({});
  const [acks, setAcks] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<MergeError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const previewAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const reviewRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      previewAbortRef.current?.abort();
    };
  }, []);

  // Move focus with the step so keyboard users land on the new content
  // instead of on <body> when the clicked row unmounts.
  useEffect(() => {
    if (step === 'review') reviewRef.current?.focus();
    else searchInputRef.current?.focus();
  }, [step]);

  // ── Step 1: likely duplicates ────────────────────────────────────────────

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await apiFetch(
          `/api/kg/nodes/${encodeURIComponent(node.id)}/merge-candidates?limit=${CANDIDATE_LIMIT}`,
          { signal: controller.signal },
        );
        const body = await readJson(res);
        if (controller.signal.aborted) return;
        if (!res.ok) {
          const failure = classifyMergeError(res.status, body);
          if (failure.kind === 'unavailable') {
            setCandidates({ status: 'error', items: [], error: failure.message, unavailable: true });
            return;
          }
          throw new Error(errorText(body, res.status));
        }
        const list = (body as { candidates?: unknown } | null)?.candidates;
        setCandidates({
          status: 'ready',
          items: Array.isArray(list) ? filterCandidates(list as MergeCandidate[], node.id) : [],
        });
      } catch (err) {
        if (isAbort(err) || controller.signal.aborted) return;
        console.error('[MergeNodesDialog] candidates load failed:', err);
        setCandidates({ status: 'error', items: [], error: err instanceof Error ? err.message : 'Failed to load' });
      }
    })();
    return () => controller.abort();
  }, [node.id]);

  // ── Step 1: debounced search ─────────────────────────────────────────────

  const trimmed = query.trim();
  useEffect(() => {
    if (!trimmed) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearchState({ query: trimmed, status: 'loading', items: [] });
      void (async () => {
        try {
          const res = await apiFetch(searchUrl(trimmed), { signal: controller.signal });
          const body = await readJson(res);
          if (controller.signal.aborted) return;
          if (!res.ok) throw new Error(errorText(body, res.status));
          const nodes = (body as { nodes?: unknown } | null)?.nodes;
          setSearchState({
            query: trimmed,
            status: 'ready',
            items: Array.isArray(nodes) ? filterSearchResults(nodes as ApiKgNode[], node.id) : [],
          });
        } catch (err) {
          if (isAbort(err) || controller.signal.aborted) return;
          console.error('[MergeNodesDialog] search failed:', err);
          setSearchState({
            query: trimmed, status: 'error', items: [],
            error: err instanceof Error ? err.message : 'Search failed',
          });
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, node.id]);

  // ── Step 2: preview ──────────────────────────────────────────────────────

  async function loadPreview(target: Pair, onLoaded?: (next: NodeMergePreview) => void) {
    previewAbortRef.current?.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await apiFetch('/api/kg/nodes/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPreviewRequest(target.survivorId, target.absorbedId)),
        signal: controller.signal,
      });
      const body = await readJson(res);
      if (controller.signal.aborted) return;
      if (!res.ok) {
        setPreviewError(classifyMergeError(res.status, body));
        return;
      }
      if (!isNodeMergePreview(body)) {
        console.error('[MergeNodesDialog] unexpected preview response:', body);
        setPreviewError({ kind: 'server', code: null, message: 'The server sent an unexpected preview.', blockers: [] });
        return;
      }
      setPreview(body);
      onLoaded?.(body);
    } catch (err) {
      if (isAbort(err) || controller.signal.aborted) return;
      console.error('[MergeNodesDialog] preview failed:', err);
      setPreviewError({
        kind: 'server', code: null, blockers: [],
        message: err instanceof Error ? err.message : 'Failed to load the preview',
      });
    } finally {
      // An aborted load was superseded (or the dialog closed); the newer load owns the flag.
      if (!controller.signal.aborted) setPreviewLoading(false);
    }
  }

  function choose(picked: ApiKgNode) {
    const next = { survivorId: node.id, absorbedId: picked.id };
    setOther(picked);
    setPair(next);
    setPreview(null);
    setChoices({});
    setAcks([]);
    setNotice(null);
    setApplyError(null);
    setStep('review');
    void loadPreview(next);
  }

  function handleBack() {
    previewAbortRef.current?.abort();
    setPreviewLoading(false);
    setPreviewError(null);
    setPreview(null);
    setPair(null);
    setNotice(null);
    setApplyError(null);
    setStep('pick');
  }

  function handleSwap() {
    if (!pair || applying) return;
    const next = { survivorId: pair.absorbedId, absorbedId: pair.survivorId };
    setPair(next);
    setChoices(prev => swapResolutions(prev));
    setAcks([]);
    setNotice(null);
    setApplyError(null);
    void loadPreview(next);
  }

  function retryPreview() {
    if (pair) void loadPreview(pair);
  }

  // The preview only describes the current direction once it has caught up with a swap.
  const current = preview && pair
    && preview.survivor.id === pair.survivorId && preview.absorbed.id === pair.absorbedId
    ? preview
    : null;
  const effective = current ? mergeResolutions(choices, current) : null;

  function setChoice<K extends ChoiceSection>(section: K, id: string, value: string) {
    setChoices(prev => ({ ...prev, [section]: { ...(prev[section] ?? {}), [id]: value } }) as NodeMergeResolutions);
    setApplyError(null);
  }

  async function handleApply() {
    if (!current || !effective || applying || !canApply(current, acks)) return;
    const reviewed = current;
    setApplying(true);
    setApplyError(null);
    setNotice(null);
    try {
      const res = await apiFetch('/api/kg/nodes/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildApplyRequest(reviewed, choices, acks)),
      });
      const body = await readJson(res);
      if (!mountedRef.current) return;
      if (res.ok) {
        if (isNodeMergeResult(body)) {
          onMerged(body, { absorbed: reviewed.absorbed.label, survivor: body.node.label || reviewed.survivor.label });
          return;
        }
        // A 2xx we cannot read: the merge probably committed.
        console.error('[MergeNodesDialog] unexpected apply response:', body);
        setApplyError(outcomeUnknownError());
        onOutcomeUnknown();
        return;
      }
      const error = classifyApplyError(res.status, body);
      if (error.kind === 'unknown') {
        console.error('[MergeNodesDialog] apply outcome unknown: HTTP', res.status, body);
        setApplyError(error);
        onOutcomeUnknown();
        return;
      }
      if (error.kind === 'stale') {
        // Re-preview the same direction, keeping still-valid choices and acks.
        setNotice(STALE_PREVIEW_NOTICE);
        void loadPreview({ survivorId: reviewed.survivor.id, absorbedId: reviewed.absorbed.id }, next => {
          setChoices(prev => retainValidChoices(prev, next));
          setAcks(prev => retainAcknowledgements(prev, reviewed, next));
        });
        return;
      }
      setApplyError(error);
    } catch (err) {
      // fetch rejected (network error, dropped connection): the request may
      // still have reached the server and committed.
      console.error('[MergeNodesDialog] apply failed, outcome unknown:', err);
      if (mountedRef.current) {
        setApplyError(outcomeUnknownError());
        onOutcomeUnknown();
      }
    } finally {
      if (mountedRef.current) setApplying(false);
    }
  }

  // ── Render: step 1 ───────────────────────────────────────────────────────

  function renderPickRow(n: ApiKgNode, reasons?: MergeCandidate['reasons']) {
    return (
      <li key={n.id}>
        <button type="button" className="kg-merge-pick-row" onClick={() => choose(n)}>
          <span className={typeBadgeClass(n.type)}>{n.type}</span>
          <span className="kg-merge-pick-main">
            <span className="kg-merge-pick-label">{n.label || '(no label)'}</span>
            <AliasLine aliases={n.aliases} />
          </span>
          {reasons && reasons.length > 0 && (
            <span className="kg-merge-chips">
              {reasons.map(r => <span key={r} className="kg-merge-chip">{candidateReasonLabel(r)}</span>)}
            </span>
          )}
          <span className="kg-merge-pick-chevron"><ChevronIcon /></span>
        </button>
      </li>
    );
  }

  function renderPick() {
    const search = trimmed && searchState?.query === trimmed ? searchState : null;
    return (
      <div className="kg-merge-pick">
        <div className="kg-merge-start">
          <div className="kg-merge-label-sm">Starting from</div>
          <div className="kg-merge-start-row">
            <span className={typeBadgeClass(node.type)}>{node.type}</span>
            <span className="kg-merge-pick-main">
              <span className="kg-merge-pick-label">{node.label || '(no label)'}</span>
              <AliasLine aliases={node.aliases} />
            </span>
          </div>
        </div>

        <div className="kg-merge-search">
          <label htmlFor={`${uid}-search`} className="kg-merge-label-sm">Find the duplicate</label>
          <input
            id={`${uid}-search`}
            ref={searchInputRef}
            type="text"
            data-autofocus
            autoComplete="off"
            placeholder="Search by name or alias…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>

        {trimmed ? (
          <section className="kg-merge-section" aria-live="polite">
            <h3 className="kg-merge-section-title">
              Search results
              {search?.status === 'ready' && <span className="kg-merge-count">{search.items.length}</span>}
            </h3>
            {!search || search.status === 'loading' ? (
              <p className="kg-merge-empty">Searching…</p>
            ) : search.status === 'error' ? (
              <p className="kg-merge-empty is-error">Search failed: {search.error}</p>
            ) : search.items.length === 0 ? (
              <p className="kg-merge-empty">No other nodes match “{trimmed}”.</p>
            ) : (
              <ul className="kg-merge-pick-list">{search.items.map(n => renderPickRow(n))}</ul>
            )}
          </section>
        ) : (
          <section className="kg-merge-section">
            <h3 className="kg-merge-section-title">
              Likely duplicates
              {candidates.status === 'ready' && <span className="kg-merge-count">{candidates.items.length}</span>}
            </h3>
            {candidates.status === 'loading' ? (
              <p className="kg-merge-empty">Looking for likely duplicates…</p>
            ) : candidates.status === 'error' ? (
              <p className="kg-merge-empty is-error">
                {candidates.unavailable
                  ? candidates.error
                  : <>Couldn’t load suggestions ({candidates.error}). You can still search above.</>}
              </p>
            ) : candidates.items.length === 0 ? (
              <p className="kg-merge-empty">No likely duplicates found. Search above to pick a node.</p>
            ) : (
              <ul className="kg-merge-pick-list">{candidates.items.map(c => renderPickRow(c.node, c.reasons))}</ul>
            )}
          </section>
        )}
      </div>
    );
  }

  // ── Render: step 2 ───────────────────────────────────────────────────────

  function renderReviewBody(p: NodeMergePreview, r: NodeMergeResolutions) {
    const disabled = applying || previewLoading;
    const sLabel = p.survivor.label;
    const aLabel = p.absorbed.label;
    const suggestion = suggestionText(p);
    const banner = crossTypeBanner(p);
    const labelChoice: Side = r.label ?? p.result.defaultLabel;
    const { aliases, dropped } = resultAliases(p, labelChoice);
    const c = p.conflicts;
    const plan = p.contactPlan;
    const contactSentence = contactPlanSentence(p);

    return (
      <>
        {suggestion && (
          <div className="kg-merge-callout kg-merge-callout-info">
            <span>{suggestion}</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={handleSwap} disabled={disabled}>
              Swap
            </button>
          </div>
        )}
        {banner && <div className="kg-merge-callout kg-merge-callout-neutral">{banner}</div>}

        {p.blockers.length > 0 && (
          <div className="kg-merge-callout kg-merge-callout-danger" role="alert">
            <strong>This merge can’t go ahead</strong>
            <ul className="kg-merge-callout-list">
              {p.blockers.map(b => <li key={b.code}>{b.message}</li>)}
            </ul>
          </div>
        )}

        {p.warnings.length > 0 && (
          <div className="kg-merge-callout kg-merge-callout-warn">
            <strong>Before you merge</strong>
            {p.warnings.map(w => (
              <div key={w.code} className="kg-merge-warning">
                {w.requiresAck ? (
                  <label className="kg-merge-ack">
                    <input
                      type="checkbox"
                      checked={acks.includes(w.code)}
                      disabled={disabled}
                      onChange={e => setAcks(prev => toggleAcknowledgement(prev, w.code, e.target.checked))}
                    />
                    <span>{w.message}</span>
                  </label>
                ) : (
                  <p className="kg-merge-warning-text">{w.message}</p>
                )}
                {w.details && w.details.length > 0 && (
                  <ul className="kg-merge-callout-list kg-merge-details">
                    {w.details.map(d => <li key={d}>{d}</li>)}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}

        <Section title="Name">
          {labelsDiffer(p) ? (
            <fieldset className="kg-merge-choice">
              <legend className="kg-merge-sr-only">Name of the merged node</legend>
              <div className="kg-merge-options">
                {(['survivor', 'absorbed'] as const).map(side => {
                  const blockedReason = isLabelAllowed(p, side) ? null : labelCollisionReason(p);
                  return (
                    <Option
                      key={side}
                      name={`${uid}-label`}
                      checked={labelChoice === side}
                      disabled={disabled}
                      unavailableReason={blockedReason}
                      onSelect={() => { setChoices(prev => ({ ...prev, label: side })); setApplyError(null); }}
                    >
                      <span className={`kg-merge-option-value kg-merge-name kg-merge-side-${side}`}>
                        {p.result.labels[side]}
                      </span>
                      <span className="kg-merge-meta">{side === 'survivor' ? 'Kept node’s name' : 'Merged-in node’s name'}</span>
                      {blockedReason && <span className="kg-merge-meta kg-merge-option-why">{blockedReason}</span>}
                    </Option>
                  );
                })}
              </div>
            </fieldset>
          ) : (
            <p className="kg-merge-plain">Both nodes are named {quoted(p.result.labels.survivor)}.</p>
          )}
          <div className="kg-merge-alias-block">
            <span className="kg-merge-label-sm">Aliases after the merge</span>
            {aliases.length > 0 ? (
              <div className="kg-merge-alias-chips">
                {aliases.map(a => <span key={a} className="kg-merge-chip">{a}</span>)}
              </div>
            ) : (
              <span className="kg-merge-meta">None</span>
            )}
            {dropped.length > 0 && (
              <p className="kg-merge-meta kg-merge-dropped">
                Over the limit of 10, so not kept: {dropped.join(', ')}
              </p>
            )}
          </div>
        </Section>

        {c.properties.length > 0 && (
          <Section title="Properties" count={c.properties.length} hint="Both nodes set these differently. Choose the value to keep.">
            {c.properties.map(prop => (
              <fieldset key={prop.key} className="kg-merge-choice">
                <legend className="kg-merge-choice-legend kg-merge-mono">{prop.key}</legend>
                <div className="kg-merge-options">
                  {(['survivor', 'absorbed'] as const).map(side => (
                    <Option
                      key={side}
                      name={`${uid}-prop-${prop.key}`}
                      checked={r.properties?.[prop.key] === side}
                      disabled={disabled}
                      onSelect={() => setChoice('properties', prop.key, side)}
                    >
                      <SideTag side={side} label={side === 'survivor' ? sLabel : aLabel} />
                      <span className="kg-merge-value">
                        {formatValue(side === 'survivor' ? prop.survivorValue : prop.absorbedValue)}
                      </span>
                    </Option>
                  ))}
                </div>
              </fieldset>
            ))}
          </Section>
        )}

        {c.facts.length > 0 && (
          <Section title="Conflicting facts" count={c.facts.length} hint="Same attribute, different values. The dropped value is kept in the fact’s history.">
            {c.facts.map(f => {
              const choice: FactChoice | undefined = r.facts?.[f.id];
              return (
                <fieldset key={f.id} className="kg-merge-choice">
                  <legend className="kg-merge-choice-legend">{f.attribute}</legend>
                  <div className="kg-merge-options">
                    {(['survivor', 'absorbed'] as const).map(side => (
                      <Option
                        key={side}
                        name={`${uid}-fact-${f.id}`}
                        checked={choice === side}
                        disabled={disabled}
                        onSelect={() => setChoice('facts', f.id, side)}
                      >
                        <SideTag side={side} label={side === 'survivor' ? sLabel : aLabel} />
                        <FactBody fact={side === 'survivor' ? f.survivor : f.absorbed} />
                      </Option>
                    ))}
                    <Option
                      name={`${uid}-fact-${f.id}`}
                      checked={choice === 'both'}
                      disabled={disabled}
                      onSelect={() => setChoice('facts', f.id, 'both')}
                      wide
                    >
                      <span className="kg-merge-option-value">Keep both</span>
                      <span className="kg-merge-meta">Both facts stay on the merged node.</span>
                    </Option>
                  </div>
                </fieldset>
              );
            })}
          </Section>
        )}

        {c.nearDuplicateFacts.length > 0 && (
          <Section title="Possible duplicate facts" count={c.nearDuplicateFacts.length} hint="These read almost the same. Combining keeps the more confident one.">
            {c.nearDuplicateFacts.map(n => {
              const choice: NearDuplicateChoice | undefined = r.nearDuplicateFacts?.[n.id];
              return (
                <div key={n.id} className="kg-merge-near">
                  <div className="kg-merge-near-pair">
                    <div className="kg-merge-near-fact">
                      <SideTag side="survivor" label={sLabel} />
                      <FactBody fact={n.survivor} />
                    </div>
                    <div className="kg-merge-near-fact">
                      <SideTag side="absorbed" label={aLabel} />
                      <FactBody fact={n.absorbed} />
                    </div>
                  </div>
                  <label className="kg-merge-ack kg-merge-near-toggle">
                    <input
                      type="checkbox"
                      checked={choice === 'merge'}
                      disabled={disabled}
                      onChange={e => setChoice('nearDuplicateFacts', n.id, e.target.checked ? 'merge' : 'keep_both')}
                    />
                    <span>Combine</span>
                    <span className="kg-merge-meta">{Math.round(n.similarity * 100)}% similar</span>
                  </label>
                </div>
              );
            })}
          </Section>
        )}

        {hasContactSection(p) && (
          <Section
            title="Contact record"
            count={c.contactFields.length + c.authOverrides.length || undefined}
          >
            {contactSentence && <p className="kg-merge-plain">{contactSentence}</p>}

            {c.contactFields.map(f => (
              <fieldset key={f.field} className="kg-merge-choice">
                <legend className="kg-merge-choice-legend">{f.label}</legend>
                <div className="kg-merge-options">
                  {(['survivor', 'absorbed'] as const).map(side => (
                    <Option
                      key={side}
                      name={`${uid}-cf-${f.field}`}
                      checked={r.contactFields?.[f.field] === side}
                      disabled={disabled}
                      onSelect={() => setChoice('contactFields', f.field, side)}
                    >
                      <SideTag side={side} label={side === 'survivor' ? sLabel : aLabel} />
                      <span className="kg-merge-value">
                        {formatValue(side === 'survivor' ? f.survivorValue : f.absorbedValue)}
                      </span>
                    </Option>
                  ))}
                </div>
              </fieldset>
            ))}

            {c.authOverrides.map(o => (
              <fieldset key={o.permission} className="kg-merge-choice">
                <legend className="kg-merge-choice-legend">
                  Permission <span className="kg-merge-mono">{o.permission}</span>
                </legend>
                <div className="kg-merge-options">
                  {(['survivor', 'absorbed'] as const).map(side => {
                    const granted = side === 'survivor' ? o.survivorGranted : o.absorbedGranted;
                    return (
                      <Option
                        key={side}
                        name={`${uid}-ao-${o.permission}`}
                        checked={r.authOverrides?.[o.permission] === side}
                        disabled={disabled}
                        onSelect={() => setChoice('authOverrides', o.permission, side)}
                      >
                        <SideTag side={side} label={side === 'survivor' ? sLabel : aLabel} />
                        <span className={`kg-merge-grant${granted ? ' is-granted' : ' is-denied'}`}>
                          {granted ? 'Granted' : 'Denied'}
                        </span>
                      </Option>
                    );
                  })}
                </div>
              </fieldset>
            ))}

            {plan.identities.length > 0 && (
              <div className="kg-merge-identities">
                <span className="kg-merge-label-sm">
                  Channel identities · {plural(plan.identities.filter(i => !i.duplicate).length, 'identity', 'identities')} kept
                </span>
                <ul>
                  {plan.identities.map(i => (
                    <li
                      key={`${i.from}:${i.channel}:${i.identifier}`}
                      className={i.duplicate ? 'is-duplicate' : undefined}
                    >
                      <span className="kg-merge-identity-channel">{i.channel}</span>
                      <span className="kg-merge-identity-id">{i.identifier}</span>
                      <span className="kg-merge-identity-tags">
                        <SideTag side={i.from} label={i.from === 'survivor' ? sLabel : aLabel} />
                        {i.verified && <span className="kg-merge-tag is-verified">Verified</span>}
                        {i.duplicate && <span className="kg-merge-tag">Duplicate · dropped</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Section>
        )}

        <Section title="What happens">
          <ul className="kg-merge-summary">
            {summaryLines(p).map(line => <li key={line}>{line.charAt(0).toUpperCase() + line.slice(1)}</li>)}
          </ul>
        </Section>
      </>
    );
  }

  function renderReview() {
    const known = other ? [node, other] : [node];
    const keepCard = pair ? cardFor(pair.survivorId, preview, known) : null;
    const absorbCard = pair ? cardFor(pair.absorbedId, preview, known) : null;
    return (
      <div
        className={`kg-merge-review${previewLoading && current ? ' is-busy' : ''}`}
        ref={reviewRef}
        tabIndex={-1}
        aria-busy={previewLoading}
        aria-label="Review the merge"
      >
        <div className="kg-merge-pair">
          <NodeCard role="keep" card={keepCard} />
          <button
            type="button"
            className="kg-merge-swap"
            onClick={handleSwap}
            disabled={!pair || applying || previewLoading}
            aria-label="Swap which node is kept"
            title="Swap which node is kept"
          >
            <SwapIcon />
            <span className="kg-merge-swap-text">Swap</span>
          </button>
          <NodeCard role="absorb" card={absorbCard} />
        </div>

        {notice && <div className="kg-merge-callout kg-merge-callout-warn" role="status">{notice}</div>}

        {applyError && (
          // An unknown outcome is not a failure — the merge may have committed.
          <div
            className={`kg-merge-callout ${applyError.kind === 'unknown' ? 'kg-merge-callout-warn' : 'kg-merge-callout-danger'}`}
            role="alert"
          >
            <strong>{applyError.message}</strong>
            {applyError.blockers.length > 0 && (
              <ul className="kg-merge-callout-list">
                {applyError.blockers.map(b => <li key={b.code}>{b.message}</li>)}
              </ul>
            )}
          </div>
        )}

        {previewError && (
          <div className="kg-merge-callout kg-merge-callout-danger" role="alert">
            <strong>Couldn’t preview this merge</strong>
            <span>{previewError.message}</span>
            {previewError.blockers.length > 0 && (
              <ul className="kg-merge-callout-list">
                {previewError.blockers.map(b => <li key={b.code}>{b.message}</li>)}
              </ul>
            )}
            {isRetryable(previewError) && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={retryPreview} disabled={previewLoading}>
                Try again
              </button>
            )}
          </div>
        )}

        {!current && previewLoading && <p className="kg-merge-empty">Preparing the preview…</p>}
        {current && effective && renderReviewBody(current, effective)}
      </div>
    );
  }

  // ── Footer ───────────────────────────────────────────────────────────────

  // Retrying cannot help a blocked, missing, unavailable or unknown-outcome
  // apply. A label-collision block unlocks as soon as the user picks the other
  // name, because changing the Name radio clears applyError.
  const applyLocked = !!applyError && !isRetryable(applyError);
  const applyEnabled = !!current && !previewLoading && !applying && !applyLocked && canApply(current, acks);
  // The footer repeats outcomes that are shown at the top of the body, since the
  // user usually clicks Merge with the body scrolled to the bottom.
  let status: ReactNode = null;
  if (step === 'review' && !applying) {
    if (applyError) {
      const cls = applyError.kind === 'unknown' ? 'kg-merge-status-warn' : 'kg-merge-status-error';
      status = <span className={cls}>{applyError.message}</span>;
    } else if (current && !previewLoading) {
      const hint = applyHint(current, acks);
      if (hint) status = hint;
      else if (notice) status = <span className="kg-merge-status-warn">{notice}</span>;
      else status = <span className="kg-merge-ready">Ready to merge</span>;
    }
  }

  const footer = (
    <div className="kg-merge-footer">
      <div className="kg-merge-footer-status" aria-live="polite">{status}</div>
      <div className="kg-merge-footer-actions">
        {step === 'review' && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={handleBack} disabled={applying}>
            Back
          </button>
        )}
        <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} disabled={applying}>
          Cancel
        </button>
        {step === 'review' && (
          <button
            type="button"
            className="btn btn-primary btn-sm kg-merge-apply"
            onClick={() => void handleApply()}
            disabled={!applyEnabled}
          >
            {current ? applyButtonLabel(current, applying) : 'Merge'}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <Modal
      title={step === 'pick' ? `Merge ${quoted(node.label)} with…` : 'Review merge'}
      eyebrow={step === 'pick' ? 'Step 1 of 2 · Choose a node' : 'Step 2 of 2 · Review'}
      onClose={onClose}
      dismissible={!applying}
      size="lg"
      className="kg-merge-dialog"
      footer={footer}
    >
      {step === 'pick' ? renderPick() : renderReview()}
    </Modal>
  );
}
