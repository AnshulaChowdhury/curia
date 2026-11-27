// The panels of the budget dashboard: headline tiles, spending over time, spending by category, what needs the owner,
// and the categories over, near and within budget. All presentation: data comes in as props.
import { useState } from 'react';
import { BudgetBar } from '../components/MoneyCard.js';
import { SpendingChart } from './SpendingChart.js';
import { actionItems, cashCents, categorySegments, change, columnOf, inRange, type Column, type Range } from './budget-dashboard-utils.js';
import type { DashboardData } from './budget-data.js';
import { formatCents, formatMonth, type PeriodCompare } from './budget-utils.js';

type Tone = 'blue' | 'aqua' | 'violet' | 'alert' | 'plain';

function Tile({ label, value, hint, tone, href }: { label: string; value: string; hint?: string; tone: Tone; href: string }) {
  return (
    <a className={`bud-tile bud-tile-${tone}`} href={href}>
      <span className="bud-tile-label"><span className="bud-dotmark" aria-hidden="true" />{label}</span>
      <span className="bud-tile-value">{value}</span>
      {hint && <span className="bud-hint">{hint}</span>}
    </a>
  );
}

export function Tiles({ data }: { data: DashboardData }) {
  const { netWorth, summary } = data;
  const known = netWorth.accounts.length > 0;
  const { totals } = netWorth;
  const waiting = summary.needsYou.uncategorised + summary.needsYou.guesses;
  return (
    <div className="bud-tiles">
      <Tile label="Net worth" tone="blue" href="/budget/net-worth" value={known ? formatCents(totals.netCents) : '—'}
        hint={known ? `${formatCents(totals.assetsCents)} owned` : 'Add balances'} />
      <Tile label="Cash" tone="aqua" href="/budget/net-worth" value={known ? formatCents(cashCents(netWorth)) : '—'} hint="In cash accounts" />
      <Tile label="Owed" tone="violet" href="/budget/net-worth" value={known ? formatCents(totals.debtsCents) : '—'} hint="Cards, loans and mortgages" />
      <Tile label="To categorise" tone={waiting > 0 ? 'alert' : 'plain'} href="#bud-review" value={String(waiting)} hint={formatMonth(summary.month)} />
    </div>
  );
}

function Compare({ label, note, value }: { label: string; note: string; value: PeriodCompare }) {
  const delta = change(value);
  return (
    <tr>
      <th scope="row">{label}<span className="bud-hint">{note}</span></th>
      <td className="bud-right">
        <span className="bud-big">{formatCents(value.currentCents)}</span>
        {/* More spending is the bad direction. The arrow and sign carry it too, not only the colour. */}
        {delta && <span className={`bud-delta ${delta.up ? 'is-up' : 'is-down'}`}><span aria-hidden="true">{delta.up ? '↗' : '↘'}</span> {delta.up ? '+' : '−'}{delta.percent.toFixed(1)}%</span>}
      </td>
      <td className="bud-right bud-num">{value.previousCents === null ? '—' : formatCents(value.previousCents)}</td>
    </tr>
  );
}

export function SpendingPanel({ data }: { data: DashboardData }) {
  const [range, setRange] = useState<Range>('12m');
  const { trend } = data;
  const monthName = (offset: number) => {
    const d = new Date(`${trend.asOf.slice(0, 7)}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + offset);
    return formatMonth(d.toISOString().slice(0, 7));
  };
  const since = trend.firstDate && trend.firstDate > `${trend.asOf.slice(0, 4)}-01-01` ? `Since ${trend.firstDate}` : trend.asOf.slice(0, 4);
  return (
    <section className="dash-card bud-spend" aria-labelledby="bud-spend-h">
      <div className="bud-spend-figures">
        <h2 id="bud-spend-h" className="dash-card-title">Spending</h2>
        <table className="bud-compare-table">
          <thead><tr><td /><th scope="col" className="bud-right">Current</th><th scope="col" className="bud-right">Previous</th></tr></thead>
          <tbody>
            <Compare label="Month to date" note={monthName(0)} value={trend.monthToDate} />
            <Compare label="Last month" note={monthName(-1)} value={trend.lastMonth} />
            <Compare label="Year to date" note={since} value={trend.yearToDate} />
          </tbody>
        </table>
      </div>
      <div className="bud-spend-chart">
        <div className="bud-ranges" role="group" aria-label="Chart period">
          {([['ytd', 'This year'], ['12m', '12 months'], ['all', 'All']] as const).map(([value, label]) => (
            <button key={value} type="button" className={`bud-range${range === value ? ' is-active' : ''}`} aria-pressed={range === value} onClick={() => setRange(value)}>{label}</button>
          ))}
        </div>
        <SpendingChart months={inRange(trend.months, range, trend.asOf)} />
        <p className="bud-hint">Includes transfers between your own accounts and card or loan payments.</p>
      </div>
    </section>
  );
}

export function CategoryBar({ data }: { data: DashboardData }) {
  const segments = categorySegments(data.summary);
  const total = segments.reduce((n, s) => n + s.cents, 0);
  return (
    <section className="dash-card" aria-labelledby="bud-split-h">
      <div className="dash-card-head">
        <h2 id="bud-split-h" className="dash-card-title">Spending by category · {formatMonth(data.summary.month)}</h2>
        <span className="bud-num">{formatCents(total)}</span>
      </div>
      {total === 0 ? <p className="bud-hint">Nothing spent in this month.</p> : (
        <>
          <div className="bud-split" aria-hidden="true">
            {segments.map(s => (
              <div key={s.key} className={`bud-seg bud-slot-${s.slot}`} style={{ flexGrow: s.cents }} title={`${s.label}: ${formatCents(s.cents)}`}>
                {s.cents / total >= 0.12 ? <span>{Math.round((s.cents / total) * 100)}%</span> : null}
              </div>
            ))}
          </div>
          <ul className="bud-legend">
            {segments.map(s => <li key={s.key}><span className={`bud-key bud-slot-${s.slot}`} aria-hidden="true" />{s.label} <strong>{formatCents(s.cents)}</strong></li>)}
          </ul>
        </>
      )}
    </section>
  );
}

export function ActionItems({ data }: { data: DashboardData }) {
  const items = actionItems({ summary: data.summary, netWorth: data.netWorth, banks: data.banksNeedingYou });
  return (
    <section className="bud-col bud-col-actions" aria-labelledby="bud-actions-h">
      <header><h2 id="bud-actions-h">Action items</h2><span className="bud-badge">{items.length}</span></header>
      {items.length === 0 ? <p className="bud-col-empty">Nothing needs you.</p> : (
        <ul>
          {items.map(i => (
            <li key={i.key} className="bud-action">
              <span className={`bud-dotmark is-${i.tone}`} aria-hidden="true" />
              <div>
                <p><strong>{i.strong}</strong> {i.rest}</p>
                <a href={i.href}>{i.action} →</a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const COLUMNS: Record<Column, { title: string; empty: string }> = {
  over: { title: 'Over budget', empty: 'Nothing is over budget.' },
  near: { title: 'Near limit', empty: 'Nothing is close to its limit.' },
  under: { title: 'Within budget', empty: 'No budgeted categories here yet.' },
};
const SHOWN = 5;

export function StatusColumn({ data, column }: { data: DashboardData; column: Column }) {
  const { categories, spentCents, budgetedCents } = columnOf(data.summary, column);
  const { title, empty } = COLUMNS[column];
  const id = `bud-col-${column}`;
  return (
    <section className={`bud-col bud-col-${column}`} aria-labelledby={id}>
      <header><h2 id={id}><span className="bud-dotmark" aria-hidden="true" />{title}</h2><span className="bud-count">{categories.length}</span></header>
      {categories.length === 0 ? <p className="bud-col-empty">{empty}</p> : (
        <>
          <div className="bud-col-total">
            <BudgetBar spentCents={spentCents} budgetCents={budgetedCents} label={title} status={column} />
            <p className="bud-hint">{formatCents(spentCents)} of {formatCents(budgetedCents)}</p>
          </div>
          <ul>
            {categories.slice(0, SHOWN).map(c => (
              <li key={c.categoryId} className="bud-col-row">
                <span className="bud-name">{c.name}</span>
                <span className="bud-num">
                  {c.remainingCents === null ? formatCents(c.spentCents) : c.remainingCents >= 0 ? `${formatCents(c.remainingCents)} left` : `${formatCents(-c.remainingCents)} over`}
                </span>
              </li>
            ))}
          </ul>
          <a className="bud-col-more" href="/budget/budgets">{categories.length > SHOWN ? `View all ${categories.length} →` : 'Edit budgets →'}</a>
        </>
      )}
    </section>
  );
}
