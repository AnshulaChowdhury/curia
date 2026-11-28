import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BatchList } from './BatchList.js';
import type { BatchSummary } from './batch-types.js';

const batch = (batch_id: string, status: BatchSummary['status']): BatchSummary =>
  ({ batch_id, status, created_at: '2031-03-01T10:00:00Z', rows: 2, pending: 0, approved: 0, skipped: 0, posted: 0, failed: 0, manual: 0 });
const draw = (batches: BatchSummary[], showCompleted = false) =>
  renderToStaticMarkup(createElement(BatchList, { batches, showCompleted, onShowCompleted: () => {}, onOpen: () => {} }));

describe('batch list', () => {
  const both = [batch('aaaaaaaa', 'open'), batch('bbbbbbbb', 'complete')];

  it('leaves completed batches out by default, and counts them', () => {
    const html = draw(both);
    expect(html).toContain('aaaaaaaa');
    expect(html).not.toContain('bbbbbbbb');
    expect(html).toContain('1 open, 1 complete');
  });

  it('shows them when asked', () => {
    const html = draw(both, true);
    expect(html).toContain('bbbbbbbb');
    expect(html).toContain('Complete</span>');
  });

  it('lists every open batch it is given, however many', () => {
    const many = Array.from({ length: 150 }, (_, i) => batch(i.toString(16).padStart(8, 'c'), 'open'));
    expect(draw(many).match(/<tr style/g)).toHaveLength(150);
  });

  it('says why nothing is listed', () => {
    expect(draw([batch('bbbbbbbb', 'complete')])).toContain('All batches are complete');
    expect(draw([])).toContain('No batches yet');
  });
});
