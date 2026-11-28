// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProposalCard } from './ProposalCard.js';
import { isApproval } from './useBudgetProposal.js';

const none = () => {};
const handlers = { onApply: none, onDiscard: none, onDismiss: none, onEdit: none, onBad: none, onType: none, invalid: false, projection: null };

describe('approving by message', () => {
  it('takes only a plain yes', () => {
    for (const text of ['yes', 'Yes', ' YES! ', 'yes.', 'apply']) expect(isApproval(text), text).toBe(true);
    for (const text of ['yes please', 'yes, but change rent', 'no', 'yesterday', 'apply the rent change only', '']) expect(isApproval(text), text).toBe(false);
  });
});

describe('ProposalCard', () => {
  it('shows each change as stored, as text, and says nothing has changed', () => {
    const html = renderToStaticMarkup(<ProposalCard {...handlers} outcome={null} error={null} busy={false} proposal={{ id: 'p', expiresAt: '', rows: [
      { action: 'create', name: '<i>Pay</i>', kind: 'income', amounts: [{ month: '2031-03', cents: 500000, was: null }] },
      { action: 'update', name: 'Housing', renameFrom: 'Rent', kind: 'expense', previousKind: 'savings', amounts: [{ month: '2031-04', cents: 120000, was: 100000 }] },
    ] }} />);
    expect(html).not.toContain('<i>');
    for (const text of ['Nothing has changed yet', 'Apply', 'Discard', 'New', 'renamed from Rent', 'was savings', 'value="5000.00"', 'value="1200.00"', 'was $1,000.00', 'aria-label="Housing, April 2031"', 'Edit any amount']) expect(html).toContain(text);
  });
  const rows = [{ action: 'create' as const, name: 'Pay', kind: 'income' as const, amounts: [{ month: '2031-04', cents: 500000, was: null }] }];
  const month = { month: '2031-04', incomeCents: 500000, expenseCents: 120000, changeCents: 380000, netWorthCents: 10380000, empty: false };

  it('shows where net worth heads if approved, from the figures given', () => {
    const html = renderToStaticMarkup(<ProposalCard {...handlers} outcome={null} error={null} busy={false} proposal={{ id: 'p', expiresAt: '', rows }}
      projection={{ today: { netWorthCents: 10000000, assetsCents: 10000000, debtsCents: 0 }, leftOut: 2, months: [month] }} />);
    for (const text of ['Net worth today', '$100,000.00', '$103,800.00', 'by the end of April 2031', 'If approved', '2 accounts with no CAD balance left out',
      'Income less expenses', '$3,800.00', 'Net worth at month end', 'aria-label="Type of Pay"', 'Savings &amp; debt paydown']) expect(html).toContain(text);
  });

  it('shows only the change when there are no balances, never a made-up net worth', () => {
    const html = renderToStaticMarkup(<ProposalCard {...handlers} outcome={null} error={null} busy={false} proposal={{ id: 'p', expiresAt: '', rows }}
      projection={{ today: null, leftOut: 0, months: [{ ...month, netWorthCents: null }] }} />);
    for (const text of ['Add balances on the budget Overview', 'Change from today', '$3,800.00']) expect(html).toContain(text);
    expect(html).not.toContain('Net worth at month end');
    expect(html).not.toContain('$0.00');
  });

  it('is absent with nothing to say, and reports what happened', () => {
    expect(renderToStaticMarkup(<ProposalCard {...handlers} proposal={null} outcome={null} error={null} busy={false} />)).toBe('');
    expect(renderToStaticMarkup(<ProposalCard {...handlers} proposal={null} outcome="Applied: 2 created." error={null} busy={false} />)).toContain('Applied: 2 created.');
  });
});
