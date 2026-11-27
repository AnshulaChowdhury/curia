import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { axisTicks, shortMoney, smoothPath } from './budget-dashboard-utils.js';
import { formatCents, formatMonth, type TrendMonth } from './budget-utils.js';

const HEIGHT = 230;
const PAD = { top: 10, right: 12, bottom: 26, left: 48 };

const shortMonth = (month: string): string =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });

/** Money out and money in by month, on one axis. Hover or arrow keys read a month; the table holds every value. */
export function SpendingChart({ months }: { months: TrendMonth[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(760);
  const [at, setAt] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(([entry]) => { if (entry) setWidth(Math.max(Math.round(entry.contentRect.width), 240)); });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  if (months.length === 0) return <p className="bud-hint">No transactions in this period yet.</p>;

  const ticks = axisTicks(Math.max(...months.map(m => Math.max(m.outCents, m.inCents))));
  const top = ticks[ticks.length - 1]!;
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (months.length === 1 ? plotW / 2 : (i / (months.length - 1)) * plotW);
  const y = (cents: number) => PAD.top + plotH - (cents / top) * plotH;
  const line = (key: 'outCents' | 'inCents') => smoothPath(months.map((m, i): [number, number] => [x(i), y(m[key])]));
  const base = PAD.top + plotH;
  const every = Math.ceil(months.length / Math.max(Math.floor(plotW / 60), 1));
  const shown = at === null || at >= months.length ? null : months[at]!;

  const point = (e: PointerEvent<SVGSVGElement>) => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    setAt(months.length === 1 ? 0 : Math.min(Math.max(Math.round(((px - PAD.left) / plotW) * (months.length - 1)), 0), months.length - 1));
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setAt(i => Math.min(Math.max((i ?? months.length - 1) + (e.key === 'ArrowLeft' ? -1 : 1), 0), months.length - 1));
  };

  return (
    <div className="bud-chart" ref={box}>
      <ul className="bud-legend">
        <li><span className="bud-key bud-key-out" aria-hidden="true" />Money out</li>
        <li><span className="bud-key bud-key-in" aria-hidden="true" />Money in</li>
      </ul>
      <div className="bud-plot">
        <svg width={width} height={HEIGHT} role="img" tabIndex={0} aria-label="Money out and money in by month. Use the left and right arrow keys to read each month."
          onPointerMove={point} onPointerLeave={() => setAt(null)} onBlur={() => setAt(null)} onKeyDown={key}>
          {ticks.map(t => (
            <g key={t}>
              <line className="bud-grid-line" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="bud-axis" x={PAD.left - 8} y={y(t) + 4} textAnchor="end">{shortMoney(t)}</text>
            </g>
          ))}
          {months.map((m, i) => ((months.length - 1 - i) % every === 0
            ? <text key={m.month} className="bud-axis" x={x(i)} y={HEIGHT - 8} textAnchor={i === months.length - 1 && months.length > 1 ? 'end' : 'middle'}>{shortMonth(m.month)}</text>
            : null))}
          {months.length > 1 && <path className="bud-area" d={`${line('outCents')} L${x(months.length - 1)},${base} L${x(0)},${base} Z`} />}
          <path className="bud-line bud-line-in" d={line('inCents')} />
          <path className="bud-line bud-line-out" d={line('outCents')} />
          {shown && <line className="bud-cross" x1={x(at!)} x2={x(at!)} y1={PAD.top} y2={base} />}
          {months.map((m, i) => (
            <g key={m.month}>
              <circle className="bud-dot bud-dot-in" cx={x(i)} cy={y(m.inCents)} r={at === i ? 5 : 3.5} />
              <circle className="bud-dot bud-dot-out" cx={x(i)} cy={y(m.outCents)} r={at === i ? 5 : 3.5} />
            </g>
          ))}
        </svg>
        {shown && (
          <div className="bud-tip" role="status" style={{ left: Math.min(Math.max(x(at!) - 80, 0), width - 170) }}>
            <span className="bud-hint">{formatMonth(shown.month)}</span>
            <span><span className="bud-key bud-key-out" aria-hidden="true" /><strong>{formatCents(shown.outCents)}</strong> out</span>
            <span><span className="bud-key bud-key-in" aria-hidden="true" /><strong>{formatCents(shown.inCents)}</strong> in</span>
          </div>
        )}
      </div>
      <details className="bud-table-toggle">
        <summary>Show as a table</summary>
        <div className="bud-table-wrap">
          <table className="bud-table">
            <thead><tr><th scope="col">Month</th><th scope="col" className="bud-right">Money out</th><th scope="col" className="bud-right">Money in</th></tr></thead>
            <tbody>
              {months.map(m => <tr key={m.month}><td>{formatMonth(m.month)}</td><td className="bud-right">{formatCents(m.outCents)}</td><td className="bud-right">{formatCents(m.inCents)}</td></tr>)}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
