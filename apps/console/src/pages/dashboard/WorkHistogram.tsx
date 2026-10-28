// 14-day work histogram. Bars are not buttons: hover shows a tooltip, click does nothing.

import { useRef, useState, type MouseEvent } from 'react';
import {
  OUTCOME_COLORS,
  agentColor,
  fetchHistogram,
  histogramDateLabel,
  type HistogramDay,
} from './dashboard-utils.js';
import { useAsyncData } from './useAsyncData.js';

type Mode = 'agent' | 'outcome';

interface Segment {
  key: string;
  count: number;
  color: string;
}

interface Tip {
  x: number;
  y: number;
  day: HistogramDay;
  segments: Segment[];
}

function segments(day: HistogramDay, mode: Mode, agents: readonly string[]): Segment[] {
  if (mode === 'outcome') {
    return (['success', 'partial', 'failed'] as const)
      .map((key) => ({ key, count: day.byOutcome[key], color: OUTCOME_COLORS[key] }))
      .filter((segment) => segment.count > 0);
  }
  return agents
    .map((name) => ({ key: name, count: day.byAgent[name] ?? 0, color: agentColor(name, agents) }))
    .filter((segment) => segment.count > 0);
}

export function WorkHistogram() {
  const { data, error, loading, retry } = useAsyncData(fetchHistogram);
  const [mode, setMode] = useState<Mode>('agent');
  const [tip, setTip] = useState<Tip | null>(null);
  const cardRef = useRef<HTMLElement>(null);

  const title = mode === 'agent' ? 'Work by agent · 14 days' : 'Work by outcome · 14 days';

  function showTip(event: MouseEvent<HTMLDivElement>, day: HistogramDay, parts: Segment[]) {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    let x = event.clientX - rect.left + 14;
    if (x > rect.width - 188) x = event.clientX - rect.left - 188;
    setTip({ x: Math.max(8, x), y: Math.max(8, event.clientY - rect.top - 8), day, segments: parts });
  }

  return (
    <article className="dash-card dash-hist-card" ref={cardRef}>
      <div className="dash-card-head">
        <span className="dash-card-title">{title}</span>
        <div className="dash-seg" role="group" aria-label="Group the histogram">
          <button type="button" className={mode === 'agent' ? 'on' : ''} onClick={() => setMode('agent')}>By agent</button>
          <button type="button" className={mode === 'outcome' ? 'on' : ''} onClick={() => setMode('outcome')}>By outcome</button>
        </div>
      </div>

      {loading && !data && !error && <div className="dash-card-quiet">Loading…</div>}

      {error && (
        <div className="dash-alert danger">
          <div className="dash-alert-title">Work history unavailable</div>
          <div className="dash-alert-body">{error}</div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={retry}>Retry</button>
        </div>
      )}

      {data && (
        <>
          <div className="dash-hist">
            <div className="dash-hist-track">
              {data.max > 0 && (
                <div className="dash-hist-avg" style={{ bottom: `${(data.average / data.max) * 100}%` }} />
              )}
              {data.days.map((day) => {
                const parts = segments(day, mode, data.agents);
                const height = data.max > 0 ? (day.total / data.max) * 100 : 0;
                return (
                  <div
                    key={day.key}
                    className={`dash-hist-bar${day.today ? ' today' : ''}`}
                    style={{ height: `${height}%` }}
                    onMouseMove={(event) => showTip(event, day, parts)}
                    onMouseLeave={() => setTip(null)}
                  >
                    {day.hiccups > 0 && <span className="dash-hist-err">{day.hiccups}</span>}
                    {parts.map((part) => (
                      <span key={part.key} className="dash-hist-seg" style={{ flex: part.count, background: part.color }} />
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="dash-hist-axis">
            {data.days.map((day) => (
              <span key={day.key} className={`${day.weekend ? 'weekend' : ''}${day.today ? ' today' : ''}`}>{day.label}</span>
            ))}
          </div>
          <div className="dash-hist-legend">
            {mode === 'agent'
              ? data.agents.map((name) => (
                <span key={name}><i style={{ background: agentColor(name, data.agents) }} />{name}</span>
              ))
              : (['success', 'partial', 'failed'] as const).map((name) => (
                <span key={name}><i style={{ background: OUTCOME_COLORS[name] }} />{name}</span>
              ))}
            <span className="dash-hist-legend-note"><b>n</b> = hiccups that day</span>
          </div>
          {tip && (
            <div className="dash-tip" style={{ left: tip.x, top: tip.y }}>
              <div><strong>{histogramDateLabel(tip.day.key, tip.day.today)}</strong> · {tip.day.total} actions</div>
              {tip.segments.map((part) => (
                <div key={part.key}><i style={{ background: part.color }} />{part.key} {part.count}</div>
              ))}
              {tip.day.hiccups > 0 && (
                <div className="dash-tip-hiccup">{tip.day.hiccups} hiccup{tip.day.hiccups === 1 ? '' : 's'}</div>
              )}
            </div>
          )}
        </>
      )}
    </article>
  );
}
