// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describeStep, elapsed, endStep, headline, startStep, trace, type Step } from './activity.js';
import { WorkingIndicator } from './WorkingIndicator.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const asked = startStep([], { agent: 'coordinator', tool: 'delegate', delegateTo: 'budget' });
const reading = startStep(asked, { agent: 'budget', tool: 'budget-sheet-read' });

describe('what the assistant is doing', () => {
  it('follows the tools as they run, the specialist inside the delegation', () => {
    expect(headline([])).toBe('Thinking');
    expect(headline(asked)).toBe('Asking the budget agent');
    expect(headline(reading)).toBe('Budget agent: reading your spreadsheet');
    const read = endStep(reading, { agent: 'budget', tool: 'budget-sheet-read', ok: true });
    expect(headline(read)).toBe('Asking the budget agent');
    const all = endStep(read, { agent: 'coordinator', tool: 'delegate', ok: true });
    expect(headline(all)).toBe('Writing the reply');
    expect(trace(all)).toEqual(['✓ Asked the budget agent', '✓ Budget agent: read your spreadsheet']);
  });

  it('says when a step did not work, and leaves one with no result as unfinished', () => {
    const failed = endStep(startStep(reading, { agent: 'budget', tool: 'budget-propose' }), { agent: 'budget', tool: 'budget-propose', ok: false });
    expect(trace(failed)).toEqual(['• Asking the budget agent', '• Budget agent: reading your spreadsheet', '✕ Budget agent: preparing proposed changes: did not work']);
  });

  it('ends the latest matching step, and ignores a result for none', () => {
    const twice = startStep(startStep([], { agent: 'budget', tool: 'budget-plan' }), { agent: 'budget', tool: 'budget-plan' });
    expect(endStep(twice, { agent: 'budget', tool: 'budget-plan', ok: true }).map(s => s.state)).toEqual(['running', 'done']);
    expect(endStep(twice, { agent: 'coordinator', tool: 'budget-plan', ok: true })).toBe(twice);
  });

  it('names tools it has no special words for', () => {
    const step = (tool: string): Step => ({ id: 0, agent: 'coordinator', tool, state: 'running' });
    expect(describeStep(step('calendar-list-events'))).toBe('Working with your calendar');
    expect(describeStep(step('date-resolve'))).toBe('Using date resolve');
    expect(describeStep({ ...step('delegate'), delegateTo: 'ceo-inbox' })).toBe('Asking the ceo inbox agent');
    expect(describeStep(step('delegate'))).toBe('Asking a specialist');
  });

  it('counts time as minutes and seconds', () => {
    expect([0, 7_400, 125_000, -5].map(elapsed)).toEqual(['0:00', '0:07', '2:05', '0:00']);
  });
});

describe('WorkingIndicator', () => {
  afterEach(() => vi.useRealTimers());

  it('shows the Moonray loader, the current step and the steps so far', () => {
    const html = renderToStaticMarkup(<WorkingIndicator work={{ startedAt: Date.now(), steps: reading }} />);
    for (const text of ['mr-orbit', 'role="status"', 'Budget agent: reading your spreadsheet…', 'Asking the budget agent', '0:00']) expect(html).toContain(text);
  });

  it('keeps the time moving', async () => {
    vi.useFakeTimers();
    const box = document.createElement('div');
    const root = createRoot(box);
    await act(async () => root.render(<WorkingIndicator work={{ startedAt: Date.now(), steps: [] }} />));
    expect(box.textContent).toContain('Thinking…');
    await act(async () => { vi.advanceTimersByTime(65_000); });
    expect(box.textContent).toContain('1:05');
    await act(async () => root.unmount());
  });
});
