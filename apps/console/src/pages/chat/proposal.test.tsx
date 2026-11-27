// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProposalCard } from './ProposalCard.js';
import { isApproval } from './useBudgetProposal.js';

const none = () => {};
const handlers = { onApply: none, onDiscard: none, onDismiss: none };

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
    for (const text of ['Nothing has changed yet', 'Apply', 'Discard', 'New', 'renamed from Rent', 'was savings', '$5,000.00', '$1,200.00', 'was $1,000.00']) expect(html).toContain(text);
  });
  it('is absent with nothing to say, and reports what happened', () => {
    expect(renderToStaticMarkup(<ProposalCard {...handlers} proposal={null} outcome={null} error={null} busy={false} />)).toBe('');
    expect(renderToStaticMarkup(<ProposalCard {...handlers} proposal={null} outcome="Applied: 2 created." error={null} busy={false} />)).toContain('Applied: 2 created.');
  });
});
