// Settings → History: every action by every agent, with its inputs and outputs. Read only.

import { useCallback, useEffect, useRef, useState } from 'react';
import { SettingsLayout } from './SettingsPage';
import {
  conversationTitle, defaultFilters, listPath, read, stepsPath,
  type Conversation, type ConversationList, type Detail, type Filters, type Step, type StepPage,
} from './history/history-client.js';
import { ConversationRows, DetailView, FilterBar, StepRows } from './history/HistoryViews.js';

const message = (err: unknown): string => (err instanceof Error ? err.message : 'Failed to load history');

/**
 * Loads one page for `path`, and appends more on request. An answer for filters that have since changed is dropped.
 */
function usePaged<T>(path: string, merge: (held: T, more: T) => T) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = useRef(path);

  useEffect(() => {
    current.current = path;
    setData(null);
    setError(null);
    read<T>(path).then(
      next => { if (current.current === path) setData(next); },
      err => { if (current.current === path) setError(message(err)); },
    );
  }, [path]);

  const more = useCallback(async (morePath: string) => {
    const asked = current.current;
    setBusy(true);
    try {
      const next = await read<T>(morePath);
      if (current.current === asked) setData(held => (held ? merge(held, next) : next));
    } catch (err) {
      if (current.current === asked) setError(message(err));
    } finally { setBusy(false); }
  }, [merge]);

  return { data, error, busy, more };
}

const appendConversations = (held: ConversationList, next: ConversationList): ConversationList =>
  ({ ...next, conversations: [...held.conversations, ...next.conversations.filter(c => !held.conversations.some(h => h.id === c.id))] });
const prependSteps = (held: StepPage, earlier: StepPage): StepPage =>
  ({ hasEarlier: earlier.hasEarlier, steps: [...earlier.steps, ...held.steps] });

function StepDetail({ step }: { step: Step }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    read<Detail>(`/api/history/events/${step.id}`).then(setDetail, err => setError(message(err)));
  }, [step.id]);
  if (error) return <p className="autonomy-error">{error}</p>;
  return detail ? <DetailView detail={detail} /> : <p className="settings-muted-hint">Loading…</p>;
}

function ConversationSteps({ filters, conversation, onBack }: { filters: Filters; conversation: Conversation; onBack: () => void }) {
  const { data, error, busy, more } = usePaged<StepPage>(stepsPath(filters, conversation.id), prependSteps);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (step: Step) => setOpen(held => {
    const next = new Set(held);
    if (!next.delete(step.id)) next.add(step.id);
    return next;
  });
  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onBack}>‹ All conversations</button>
      <h3 className="hist-heading">{conversationTitle(conversation)}</h3>
      {error && <p className="autonomy-error" role="alert">{error}</p>}
      {!data && !error && <p className="settings-muted-hint" role="status">Loading…</p>}
      {data && (
        <>
          {data.hasEarlier && data.steps[0] && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
              onClick={() => void more(stepsPath(filters, conversation.id, data.steps[0]!.seq))}>Show earlier steps</button>
          )}
          <StepRows steps={data.steps} open={open} onToggle={toggle} detail={step => <StepDetail step={step} />} />
        </>
      )}
    </>
  );
}

function HistorySection() {
  const [filters, setFilters] = useState<Filters>(() => defaultFilters());
  const [chosen, setChosen] = useState<Conversation | null>(null);
  const { data, error, busy, more } = usePaged<ConversationList>(listPath(filters, 0), appendConversations);
  // Kept while the next list loads, so the filter menus do not empty under the pointer.
  const [facets, setFacets] = useState<{ agents: string[]; channels: string[] }>({ agents: [], channels: [] });
  useEffect(() => { if (data) setFacets({ agents: data.agents, channels: data.channels }); }, [data]);

  return (
    <>
      <div className="settings-page-header">
        <h2 className="settings-page-title">History</h2>
        <p className="settings-page-sub">
          Every action by every agent, with what went in and what came out. Passwords, keys and tokens are removed.
        </p>
      </div>
      {chosen ? <ConversationSteps filters={filters} conversation={chosen} onBack={() => setChosen(null)} /> : (
        <>
          <FilterBar filters={filters} agents={facets.agents} channels={facets.channels} onChange={setFilters} />
          {error && <p className="autonomy-error" role="alert">{error}</p>}
          {!data && !error && <p className="settings-muted-hint" role="status">Loading…</p>}
          {data && <ConversationRows conversations={data.conversations} onOpen={setChosen} />}
          {data?.hasMore && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
              onClick={() => void more(listPath(filters, data.conversations.length))}>Show more</button>
          )}
        </>
      )}
    </>
  );
}

export default function HistoryPage() {
  return (
    <SettingsLayout activeSection="history">
      <HistorySection />
    </SettingsLayout>
  );
}
