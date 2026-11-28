import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { BudgetShell, BudgetGate } from './BudgetShell.js';
import { ReconcileSection } from './ReconcilePanel.js';
import { PlanGrid } from './PlanGrid.js';
import { budgetClient, type BudgetLoad, type ReconcileData } from './budget-data.js';
import {
  currentMonth, isMonth, formatCents, centsToDollarInput, shiftMonth, validateDraft, KIND_LABEL,
  type BudgetCategory, type CategoryDraft, type CategoryKind,
} from './budget-utils.js';

const EMPTY: CategoryDraft = { name: '', kind: 'expense', amount: '', rollover: false };

/** The month the overview linked here with, or this month. */
export function monthFromSearch(search: string): string {
  const month = new URLSearchParams(search).get('month') ?? '';
  return isMonth(month) ? month : currentMonth();
}

/** Edit, then Delete (empty) or Archive (used), each confirmed in place. */
export function RetireActions({ c, confirming, onAsk, onKeep, onConfirm, onEdit }: {
  c: BudgetCategory; confirming: boolean; onAsk: () => void; onKeep: () => void; onConfirm: () => void; onEdit?: () => void;
}) {
  const verb = c.transactionCount > 0 ? 'Archive' : 'Delete';
  return (
    <div className="bud-row-actions">
      {confirming ? (
        <>
          <span>
            {verb} {c.name}?{c.transactionCount > 0 ? ` Its ${c.transactionCount} transaction${c.transactionCount === 1 ? ' keeps' : 's keep'} it; nothing new can be added.` : ''}
          </span>
          <button type="button" className="btn btn-danger btn-sm" onClick={onConfirm}>{verb}</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onKeep}>Keep</button>
        </>
      ) : (
        <>
          {onEdit && <button type="button" className="btn btn-secondary btn-sm" onClick={onEdit} aria-label={`Edit ${c.name}`}>Edit</button>}
          <button type="button" className="btn btn-secondary btn-sm" onClick={onAsk} aria-label={`${verb} ${c.name}`}>{verb}</button>
        </>
      )}
    </div>
  );
}

export default function BudgetsPage() {
  const [load, setLoad] = useState<BudgetLoad<ReconcileData> | null>(null);
  const [month, setMonth] = useState(() => monthFromSearch(window.location.search));
  const [busy, setBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  /** The last month asked for in the grid, when later than the budget already reaches. */
  const [through, setThrough] = useState<string | null>(null);
  /** Grid edits not yet saved. */
  const [saving, setSaving] = useState(0);
  const wanted = useRef({ month, through });
  wanted.current = { month, through };
  const asked = useRef(0);
  // Grid edits are saved one after another, in the order made.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const reconcile = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CategoryDraft>(EMPTY);
  const [errors, setErrors] = useState<{ name?: string; amount?: string }>({});
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Only the latest answer is applied. The budgets stay put while another month loads.
  const refresh = useCallback(async () => {
    const mine = ++asked.current;
    const result = await budgetClient.loadBudgets(wanted.current.month, currentMonth(), wanted.current.through);
    if (asked.current === mine) setLoad(result);
  }, []);
  useEffect(() => { setReviewError(null); }, [month]);
  useEffect(() => { void refresh(); }, [month, through, refresh]);

  // A link naming a month is about categorising it, which sits below the budget grid.
  const loaded = load?.state === 'ok';
  useEffect(() => {
    if (loaded && new URLSearchParams(window.location.search).has('month')) reconcile.current?.scrollIntoView({ block: 'start' });
  }, [loaded]);

  const data = load?.state === 'ok' ? load.data : null;
  const all: BudgetCategory[] = data?.categories ?? [];
  const categories = all.filter(c => !c.archived);
  const archived = all.filter(c => c.archived);

  function startEdit(c: BudgetCategory) {
    setEditingId(c.id);
    setDraft({ name: c.name, kind: c.kind, amount: c.monthlyCents === null ? '' : centsToDollarInput(c.monthlyCents), rollover: c.rollover });
    setErrors({});
    setMessage(null);
  }

  function reset() {
    setEditingId(null);
    setDraft(EMPTY);
    setErrors({});
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const result = validateDraft(draft, categories, editingId);
    setErrors(result.errors);
    if (!result.ok || !result.value) return;
    try {
      await budgetClient.saveCategory({ id: editingId, ...result.value });
      setMessage(editingId ? `Saved ${result.value.name}.` : `Added ${result.value.name}.`);
      reset();
      await refresh();
    } catch (err) {
      console.error('budget save failed', err);
      setMessage(`Could not save the category. ${err instanceof Error ? err.message : ''}`);
    }
  }

  // A category with transactions is archived (they keep it); an empty one is deleted.
  async function retire(c: BudgetCategory) {
    const used = c.transactionCount > 0;
    try {
      if (used) await budgetClient.archiveCategory(c.id);
      else await budgetClient.deleteCategory(c.id);
      setMessage(used ? `Archived ${c.name}. Its transactions keep it.` : `Deleted ${c.name}.`);
      if (editingId === c.id) reset();
    } catch (err) {
      console.error('budget retire failed', err);
      setMessage(`Could not ${used ? 'archive' : 'delete'} the category. ${err instanceof Error ? err.message : ''}`);
    }
    setConfirmId(null);
    await refresh();
  }

  async function categorise(id: string, categoryId: string) {
    setBusy(true);
    setReviewError(null);
    try {
      await budgetClient.categorise(id, categoryId);
      await refresh();
    } catch (err) {
      console.error('budget categorise failed', err);
      setReviewError('Could not save that category.');
    }
    setBusy(false);
  }

  /** Saves one grid edit after those before it, then shows what the server now holds. */
  function save(what: string, change: () => Promise<void>) {
    setSaving(n => n + 1);
    queue.current = queue.current.then(async () => {
      try {
        await change();
        setMessage(null);
      } catch (err) {
        console.error(`budget ${what} failed`, err);
        setMessage(`Could not save ${what}. ${err instanceof Error ? err.message : ''}`);
      }
      await refresh();
      setSaving(n => n - 1);
    });
  }

  return (
    <BudgetShell active="/budget/budgets" wide>
      <BudgetGate load={load} />
      {data && (
        <>
          <PlanGrid plan={data.plan} current={currentMonth()} saving={saving > 0}
            onSet={(id, m, cents) => save('that amount', () => budgetClient.setMonthAmount(id, m, cents))}
            onType={(id, kind) => save('that type', () => budgetClient.setKind(id, kind))}
            onFill={(id, months, cents) => save('those amounts', () => budgetClient.setMonthAmounts(id, months, cents))}
            onAddMonths={count => setThrough(shiftMonth(data.plan.months[data.plan.months.length - 1]!, count))} />

          {message && <p className="bud-hint" role="status">{message}</p>}

          <div ref={reconcile}>
            <ReconcileSection month={month} data={data.month === month ? data : null} busy={busy} error={reviewError}
              onMonth={setMonth} onCategorise={(id, c) => void categorise(id, c)} />
          </div>

          <form className="dash-card" onSubmit={e => void submit(e)} noValidate aria-labelledby="bud-form-h">
            <h2 id="bud-form-h" className="dash-card-title">{editingId ? 'Edit budget' : 'Add a budget'}</h2>
            <div className="bud-form">
              <label className="bud-field">
                <span>Category name</span>
                <input
                  className="bud-input"
                  type="text"
                  placeholder="e.g. Groceries"
                  value={draft.name}
                  onChange={e => setDraft({ ...draft, name: e.target.value })}
                  aria-invalid={errors.name ? true : undefined}
                  aria-describedby={errors.name ? 'bud-name-err' : undefined}
                  maxLength={80}
                />
                {errors.name && <span id="bud-name-err" className="bud-err" role="alert">{errors.name}</span>}
              </label>
              <label className="bud-field">
                <span>Type</span>
                <select className="bud-input" value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as CategoryKind })}>
                  <option value="expense">Expense</option>
                  <option value="income">Income</option>
                  <option value="savings">Savings &amp; debt paydown</option>
                </select>
              </label>
              <label className="bud-field">
                <span>Usual monthly amount (CAD)</span>
                <input
                  className="bud-input"
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={draft.amount}
                  onChange={e => setDraft({ ...draft, amount: e.target.value })}
                  aria-invalid={errors.amount ? true : undefined}
                  aria-describedby={errors.amount ? 'bud-amt-err' : undefined}
                />
                {errors.amount && <span id="bud-amt-err" className="bud-err" role="alert">{errors.amount}</span>}
              </label>
              <div className="bud-actions">
                <button type="submit" className="btn btn-primary btn-sm">{editingId ? 'Save changes' : 'Add budget'}</button>
                {editingId && <button type="button" className="btn btn-secondary btn-sm" onClick={reset}>Cancel</button>}
              </div>
            </div>
            <label className="bud-check">
              <input
                type="checkbox"
                checked={draft.rollover}
                onChange={e => setDraft({ ...draft, rollover: e.target.checked })}
              />
              <span>Carry unspent money into next month (saved, not counted in totals yet)</span>
            </label>
          </form>

          <section className="dash-card" aria-labelledby="bud-list-h">
            <h2 id="bud-list-h" className="dash-card-title">Categories</h2>
            {categories.length === 0 ? (
              <p className="bud-hint">No budgets yet. Add your first one above.</p>
            ) : (
              <div className="bud-table-wrap"><table className="bud-table">
                <thead>
                  <tr><th scope="col">Category</th><th scope="col">Type</th><th scope="col" className="bud-right">Usual per month</th><th scope="col">Rollover</th><th scope="col"><span className="bud-sr">Actions</span></th></tr>
                </thead>
                <tbody>
                  {categories.map(c => (
                    <tr key={c.id}>
                      <td className="bud-name">{c.name}</td>
                      <td>{KIND_LABEL[c.kind]}</td>
                      <td className="bud-right">{c.monthlyCents === null ? 'Set by month' : formatCents(c.monthlyCents)}</td>
                      <td>{c.rollover ? 'Yes' : 'No'}</td>
                      <td className="bud-right"><RetireActions c={c} confirming={confirmId === c.id}
                        onAsk={() => setConfirmId(c.id)} onKeep={() => setConfirmId(null)} onConfirm={() => void retire(c)}
                        onEdit={() => startEdit(c)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </section>

          {archived.length > 0 && (
            <section className="dash-card" aria-labelledby="bud-arch-h">
              <h2 id="bud-arch-h" className="dash-card-title">Archived</h2>
              <p className="bud-hint">Their transactions keep them and past months still show them. Nothing new can be added.</p>
              <div className="bud-table-wrap"><table className="bud-table">
                <thead>
                  <tr><th scope="col">Category</th><th scope="col" className="bud-right">Transactions</th><th scope="col"><span className="bud-sr">Actions</span></th></tr>
                </thead>
                <tbody>
                  {archived.map(c => (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td className="bud-right">{c.transactionCount}</td>
                      <td className="bud-right">{c.transactionCount === 0 && (
                        <RetireActions c={c} confirming={confirmId === c.id} onAsk={() => setConfirmId(c.id)} onKeep={() => setConfirmId(null)} onConfirm={() => void retire(c)} />
                      )}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </section>
          )}
        </>
      )}
    </BudgetShell>
  );
}
