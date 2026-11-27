// Budget proposals against real Postgres: nothing changes until applied, and applying is all or nothing. Skips without
// DATABASE_URL.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { BudgetStore } from '../../src/budget/budget-store.js';
import { ProposalStore } from '../../src/budget/proposal-store.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const CHAT = 'proposal-test-chat';

describeIf('budget proposals', () => {
  let pool: pg.Pool;
  let budget: BudgetStore;
  let proposals: ProposalStore;

  const wipe = async () => {
    await pool.query(`DELETE FROM budget_categories WHERE lower(name) LIKE 'p-%'`);
    await pool.query(`DELETE FROM budget_proposals WHERE conversation_id LIKE 'proposal-test-%'`);
  };
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    budget = new BudgetStore(pool);
    proposals = new ProposalStore(pool);
  });
  beforeEach(wipe);
  afterAll(async () => { await wipe(); await pool.end(); });

  const mine = async () => (await budget.plan('2031-03', 2)).categories.filter(c => c.name.startsWith('P-'));

  it('changes nothing until applied, then creates, updates, renames and archives together', async () => {
    const rent = await budget.createCategory({ name: 'P-Rent', monthlyCents: 100000 });
    await budget.createCategory({ name: 'P-Old' });
    const made = await proposals.propose(CHAT, [
      { name: 'P-Pay', type: 'income', amounts: [6000.5, 5000] },
      { name: 'P-Housing', renameFrom: 'p-rent', amounts: [1200, 1000] },
      { name: 'P-Old', archive: true },
    ], ['2031-04', '2031-03']);
    expect(made.rows.map(r => r.action)).toEqual(['create', 'update', 'archive']);
    // The month that already matches is not a change.
    expect(made.rows[1]!.amounts).toEqual([{ month: '2031-04', cents: 120000, was: 100000 }]);
    expect((await mine()).map(c => c.name).sort()).toEqual(['P-Old', 'P-Rent']);
    expect(await proposals.pending(CHAT)).toMatchObject({ id: made.id });
    expect(await proposals.pending('proposal-test-other')).toBeNull();
    await expect(proposals.apply(made.id, 'proposal-test-other')).rejects.toMatchObject({ kind: 'conflict' });

    expect(await proposals.apply(made.id, CHAT)).toEqual({ created: 1, updated: 1, archived: 1 });
    const after = await mine();
    expect(after.map(c => c.name).sort()).toEqual(['P-Housing', 'P-Pay']);
    expect(after.find(c => c.categoryId === rent.id)!.amounts.map(a => a.cents)).toEqual([100000, 120000]);
    expect(after.find(c => c.name === 'P-Pay')).toMatchObject({ kind: 'income', amounts: [{ cents: 500000 }, { cents: 600050 }] });
    await expect(proposals.apply(made.id, CHAT)).rejects.toMatchObject({ kind: 'conflict' });
    expect(await proposals.pending(CHAT)).toBeNull();
  });

  it('applies nothing when anything has changed since it was proposed', async () => {
    const rent = await budget.createCategory({ name: 'P-Rent', monthlyCents: 100000 });
    const made = await proposals.propose(CHAT, [{ name: 'P-New', amounts: [1] }, { name: 'P-Rent', amounts: [1500] }], ['2031-03']);
    await budget.setMonthAmount(rent.id, '2031-03', 110000);
    await expect(proposals.apply(made.id, CHAT)).rejects.toThrow('"P-Rent" has changed');
    expect((await mine()).map(c => c.name)).toEqual(['P-Rent']);

    const again = await proposals.propose(CHAT, [{ name: 'P-New' }]);
    await budget.createCategory({ name: 'p-new' });
    await expect(proposals.apply(again.id, CHAT)).rejects.toMatchObject({ kind: 'conflict' });
  });

  it('keeps one waiting proposal per chat, and lets it be discarded or lapse', async () => {
    const first = await proposals.propose(CHAT, [{ name: 'P-A' }]);
    const second = await proposals.propose(CHAT, [{ name: 'P-B' }]);
    await expect(proposals.apply(first.id, CHAT)).rejects.toMatchObject({ kind: 'conflict' });
    expect(await proposals.pending(CHAT)).toMatchObject({ id: second.id });
    await proposals.discard(second.id, CHAT);
    await expect(proposals.apply(second.id, CHAT)).rejects.toMatchObject({ kind: 'conflict' });
    const third = await proposals.propose(CHAT, [{ name: 'P-C' }]);
    await pool.query(`UPDATE budget_proposals SET expires_at = now() - interval '1 minute' WHERE id = $1`, [third.id]);
    expect(await proposals.pending(CHAT)).toBeNull();
    await expect(proposals.apply(third.id, CHAT)).rejects.toMatchObject({ kind: 'conflict' });
    expect(await mine()).toEqual([]);
  });

  it('takes the owner\'s edits before applying, still changing nothing until then', async () => {
    const rent = await budget.createCategory({ name: 'P-Rent', monthlyCents: 100000 });
    const made = await proposals.propose(CHAT, [{ name: 'P-New', amounts: [10, 20] }, { name: 'P-Rent', amounts: [1500, 1000] }], ['2031-03', '2031-04']);
    await proposals.setAmount(made.id, CHAT, 'P-New', '2031-03', 1250);
    await proposals.setAmount(made.id, CHAT, 'P-New', '2031-04', null);
    // A month the proposal left alone records what it holds now, so a later change is still noticed.
    const edited = await proposals.setAmount(made.id, CHAT, 'P-Rent', '2031-04', 130000);
    expect(edited.rows[1]!.amounts).toEqual([{ month: '2031-03', cents: 150000, was: 100000 }, { month: '2031-04', cents: 130000, was: 100000 }]);
    expect((await mine()).map(c => c.name)).toEqual(['P-Rent']);
    expect((await proposals.pending(CHAT))!.rows).toEqual(edited.rows);

    // Clearing an amount leaves the month as it is, even if the budget moved there meanwhile.
    await proposals.setAmount(made.id, CHAT, 'P-Rent', '2031-03', null);
    await budget.setMonthAmount(rent.id, '2031-03', 99);
    await proposals.apply(made.id, CHAT);
    const after = await mine();
    expect(after.find(c => c.name === 'P-New')!.amounts.map(a => a.cents)).toEqual([1250, null]);
    expect(after.find(c => c.name === 'P-Rent')!.amounts.map(a => a.cents)).toEqual([99, 130000]);
    await expect(proposals.setAmount(made.id, CHAT, 'P-New', '2031-03', 1)).rejects.toMatchObject({ kind: 'conflict' });
  });

  it('refuses an edit that names nothing in the waiting proposal', async () => {
    await budget.createCategory({ name: 'P-Old' });
    const made = await proposals.propose(CHAT, [{ name: 'P-Old', archive: true }, { name: 'P-A' }]);
    for (const [chat, name, month, cents, kind] of [
      [CHAT, 'P-A', 'March', 1, 'invalid'], [CHAT, 'P-A', '2031-03', -1, 'invalid'], [CHAT, 'P-A', '2031-03', 1.5, 'invalid'],
      [CHAT, 'P-Nope', '2031-03', 1, 'not_found'], [CHAT, 'P-Old', '2031-03', 1, 'not_found'], ['proposal-test-other', 'P-A', '2031-03', 1, 'conflict'],
    ] as const) {
      await expect(proposals.setAmount(made.id, chat, name, month, cents), `${name} ${month} ${cents}`).rejects.toMatchObject({ kind });
    }
  });

  it('leaves out a month with no amount', async () => {
    const made = await proposals.propose(CHAT, [{ name: 'P-Gap', amounts: [null, 2] }], ['2031-03', '2031-04']);
    expect(made.rows[0]!.amounts).toEqual([{ month: '2031-04', cents: 200, was: null }]);
  });

  it('refuses what cannot be applied', async () => {
    await budget.createCategory({ name: 'P-Same', monthlyCents: 100 });
    for (const [bad, months] of [
      [[]], ['x'], [[{ name: '' }]], [[{ name: 'P-X', type: 'other' }]], [[{ name: 'P-X' }, { name: 'p-x' }]],
      [[{ name: 'P-X', amounts: [1] }], ['March']], [[{ name: 'P-X', amounts: [1] }]], [[{ name: 'P-X', amounts: [1, 2] }], ['2031-03']],
      [[{ name: 'P-X' }], ['2031-03', '2031-03']], [[{ name: 'P-X', amounts: [-1] }], ['2031-03']], [[{ name: 'P-X', amounts: ['5'] }], ['2031-03']],
      [[{ name: 'P-X', renameFrom: 'P-Nothing' }]], [[{ name: 'P-Nothing', archive: true }]],
      [[{ name: 'P-Same', amounts: [1] }], ['2031-03']], // already so
    ] as Array<[unknown, unknown?]>) {
      await expect(proposals.propose(CHAT, bad, months), JSON.stringify(bad)).rejects.toMatchObject({ kind: 'invalid' });
    }
  });
});
