import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { BudgetShell, BudgetGate } from './BudgetShell.js';
import { budgetSource, type BudgetLoad } from './budget-data.js';
import {
  formatCents, centsToDollarInput, validateDraft,
  type BudgetCategory, type CategoryDraft,
} from './budget-utils.js';

const EMPTY: CategoryDraft = { name: '', amount: '', rollover: false };

export default function BudgetsPage() {
  const [load, setLoad] = useState<BudgetLoad | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CategoryDraft>(EMPTY);
  const [errors, setErrors] = useState<{ name?: string; amount?: string }>({});
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoad(await budgetSource.load());
    } catch (e) {
      console.error('budget load failed', e);
      setLoad({ state: 'error', message: 'Could not load the budget.' });
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const categories: BudgetCategory[] = load?.state === 'ok' ? load.categories : [];

  function startEdit(c: BudgetCategory) {
    setEditingId(c.id);
    setDraft({ name: c.name, amount: centsToDollarInput(c.monthlyCents), rollover: c.rollover });
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
      await budgetSource.saveCategory({ id: editingId, ...result.value });
      setMessage(editingId ? `Saved ${result.value.name}.` : `Added ${result.value.name}.`);
      reset();
      await refresh();
    } catch (err) {
      console.error('budget save failed', err);
      setMessage('Could not save the category.');
    }
  }

  async function remove(c: BudgetCategory) {
    try {
      await budgetSource.deleteCategory(c.id);
      setMessage(`Deleted ${c.name}. Its transactions are now uncategorised.`);
      setConfirmId(null);
      if (editingId === c.id) reset();
      await refresh();
    } catch (err) {
      console.error('budget delete failed', err);
      setMessage('Could not delete the category.');
    }
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
                  type="text"
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
                  type="text"
                  inputMode="decimal"
                  value={draft.amount}
                  onChange={e => setDraft({ ...draft, amount: e.target.value })}
                  aria-invalid={errors.amount ? true : undefined}
                  aria-describedby={errors.amount ? 'bud-amt-err' : undefined}
                />
                {errors.amount && <span id="bud-amt-err" className="bud-err" role="alert">{errors.amount}</span>}
              </label>
              <label className="bud-check">
                <input
                  type="checkbox"
                  checked={draft.rollover}
                  onChange={e => setDraft({ ...draft, rollover: e.target.checked })}
                />
                <span>Carry unspent money into next month</span>
              </label>
            </div>
            <div className="bud-actions">
              <button type="submit" className="btn btn-primary btn-sm">{editingId ? 'Save changes' : 'Add budget'}</button>
              {editingId && <button type="button" className="btn btn-secondary btn-sm" onClick={reset}>Cancel</button>}
            </div>
          </form>

          {message && <p className="dash-card-quiet" role="status">{message}</p>}

          <section className="dash-card" aria-labelledby="bud-list-h">
            <h2 id="bud-list-h" className="dash-card-title">Budgets</h2>
            {categories.length === 0 ? (
              <p className="dash-card-quiet">No budgets yet. Add your first one above.</p>
            ) : (
              <table className="records-table">
                <thead>
                  <tr><th scope="col">Category</th><th scope="col" style={{ textAlign: 'right' }}>Per month</th><th scope="col">Rollover</th><th scope="col"><span className="bud-sr">Actions</span></th></tr>
                </thead>
                <tbody>
                  {categories.map(c => (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td style={{ textAlign: 'right' }}>{formatCents(c.monthlyCents)}</td>
                      <td>{c.rollover ? 'Yes' : 'No'}</td>
                      <td className="bud-row-actions">
                        {confirmId === c.id ? (
                          <>
                            <span>Delete {c.name}?</span>
                            <button type="button" className="btn btn-danger btn-sm" onClick={() => void remove(c)}>Delete</button>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmId(null)}>Keep</button>
                          </>
                        ) : (
                          <>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => startEdit(c)} aria-label={`Edit ${c.name}`}>Edit</button>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmId(c.id)} aria-label={`Delete ${c.name}`}>Delete</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </BudgetShell>
  );
}
