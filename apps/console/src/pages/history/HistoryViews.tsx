// The History screen's views. They only draw what they are given.

import type { ReactNode } from 'react';
import { conversationTitle, detailBlocks, type Conversation, type Detail, type Filters, type Step } from './history-client.js';

const when = (iso: string): string => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const clock = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;
const money = (usd: number): string => (usd < 0.01 ? 'under $0.01' : `$${usd.toFixed(2)}`);

export function FilterBar({ filters, agents, channels, onChange }: {
  filters: Filters; agents: string[]; channels: string[]; onChange: (next: Filters) => void;
}) {
  const set = (part: Partial<Filters>) => onChange({ ...filters, ...part });
  // A chosen value stays listed even when the new dates have nothing for it.
  const options = (all: string[], chosen: string) => [...new Set([...all, ...(chosen ? [chosen] : [])])].sort();
  return (
    <div className="hist-filters" role="group" aria-label="Filter history">
      <label>From<input className="bud-input" type="date" value={filters.from} max={filters.to || undefined} onChange={e => set({ from: e.target.value })} /></label>
      <label>To<input className="bud-input" type="date" value={filters.to} min={filters.from || undefined} onChange={e => set({ to: e.target.value })} /></label>
      <label>Agent
        <select className="bud-input" value={filters.agent} onChange={e => set({ agent: e.target.value })}>
          <option value="">All agents</option>
          {options(agents, filters.agent).map(a => <option key={a} value={a}>{a}</option>)}
        </select>
      </label>
      <label>Channel
        <select className="bud-input" value={filters.channel} onChange={e => set({ channel: e.target.value })}>
          <option value="">All channels</option>
          {options(channels, filters.channel).map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <label className="hist-check"><input type="checkbox" checked={filters.errorsOnly} onChange={e => set({ errorsOnly: e.target.checked })} />Errors only</label>
    </div>
  );
}

export function ConversationRows({ conversations, onOpen }: { conversations: Conversation[]; onOpen: (c: Conversation) => void }) {
  if (conversations.length === 0) return <p className="settings-muted-hint">Nothing matches in these dates.</p>;
  return (
    <ul className="hist-list">
      {conversations.map(c => (
        <li key={c.id ?? ''}>
          <button type="button" className="hist-row" onClick={() => onOpen(c)}>
            <span className="hist-title">{conversationTitle(c)}</span>
            <span className="hist-meta">
              {when(c.lastAt)}
              {c.channels.length > 0 && <> · {c.channels.join(', ')}</>}
              {c.agents.length > 0 && <> · {c.agents.join(', ')}</>}
              {' · '}{count(c.events, 'step')}
              {c.costUsd > 0 && <> · {money(c.costUsd)}</>}
              {c.errors > 0 && <span className="hist-failed">{count(c.errors, 'error')}</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function DetailView({ detail }: { detail: Detail }) {
  return (
    <div className="hist-detail">
      {detail.notes.map(note => <p key={note} className="hist-note">{note}</p>)}
      {detailBlocks(detail).map(block => (
        // The full record repeats the parts above it, so it starts closed.
        <details key={block.heading} open={block.heading !== 'Full record' && block.heading !== 'Tools offered'}>
          <summary>{block.heading}</summary>
          <pre>{block.body}</pre>
        </details>
      ))}
    </div>
  );
}

export function StepRows({ steps, open, onToggle, detail }: {
  steps: Step[]; open: Set<string>; onToggle: (step: Step) => void; detail: (step: Step) => ReactNode;
}) {
  if (steps.length === 0) return <p className="settings-muted-hint">No steps in these dates.</p>;
  return (
    <ol className="hist-steps">
      {steps.map(step => (
        <li key={step.id} style={{ marginLeft: `${Math.min(step.depth, 4) * 20}px` }} className={step.failed ? 'is-failed' : undefined}>
          <button type="button" className="hist-row" aria-expanded={open.has(step.id)} onClick={() => onToggle(step)}>
            <span className="hist-step-head">
              <time dateTime={step.at}>{clock(step.at)}</time>
              {step.agent && <span className="hist-agent">{step.agent}</span>}
              <span className="hist-title">{step.label}</span>
              {step.failed && <span className="hist-failed">failed</span>}
            </span>
            {step.preview && <span className="hist-meta">{step.preview}</span>}
          </button>
          {open.has(step.id) && detail(step)}
        </li>
      ))}
    </ol>
  );
}
