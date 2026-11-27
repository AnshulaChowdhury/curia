import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { BudgetShell, BudgetGate } from './BudgetShell.js';
import { budgetClient, type BudgetLoad } from './budget-data.js';
import {
  formatCents, centsToDollarInput, validateDraft,
  type BudgetCategory, type CategoryDraft,
} from './budget-utils.js';

const EMPTY: CategoryDraft = { name: '', amount: '', rollover: false };

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
  const [load, setLoad] = useState<BudgetLoad<BudgetCategory[]> | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CategoryDraft>(EMPTY);
  const [errors, setErrors] = useState<{ name?: string; amount?: string }>({});
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoad(await budgetClient.loadCategories());
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const all: BudgetCategory[] = load?.state === 'ok' ? load.data : [];
  const categories = all.filter(c => !c.archived);
  const archived = all.filter(c => c.archived);

  function startEdit(c: BudgetCategory) {
    setEditingId(c.id);
    setDraft({ name: c.name, amount: c.monthlyCents === null ? '' : centsToDollarInput(c.monthlyCents), rollover: c.rollover });
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

  return (
    <BudgetShell active="/budget/budgets">
      <BudgetGate load={load} />
      {load?.state === 'ok' && (
        <>
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
                <span>Monthly amount (CAD)</span>
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

          {message && <p className="bud-hint" role="status">{message}</p>}

          <section className="dash-card" aria-labelledby="bud-list-h">
            <h2 id="bud-list-h" className="dash-card-title">Budgets</h2>
            {categories.length === 0 ? (
              <p className="bud-hint">No budgets yet. Add your first one above.</p>
            ) : (
              <div className="bud-table-wrap"><table className="bud-table">
                <thead>
                  <tr><th scope="col">Category</th><th scope="col" className="bud-right">Per month</th><th scope="col">Rollover</th><th scope="col"><span className="bud-sr">Actions</span></th></tr>
                </thead>
                <tbody>
                  {categories.map(c => (
                    <tr key={c.id}>
                      <td className="bud-name">{c.name}</td>
                      <td className="bud-right">{c.monthlyCents === null ? 'No budget' : formatCents(c.monthlyCents)}</td>
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
