// @vitest-environment happy-dom
// Renders MoneyCard directly. Covers: bank text is rendered as text, state is not colour-only.
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MoneyCard } from '../components/MoneyCard.js';

describe('MoneyCard', () => {
  const summary = {
    month: '2026-11',
    top: [{ id: 'a', name: '<img src=x onerror=alert(1)>', spentCents: 12000, budgetCents: 10000, status: 'over' as const }],
    needsYouCount: 2,
  };
  const html = renderToStaticMarkup(<MoneyCard summary={summary} />);

  it('escapes untrusted text instead of rendering it as HTML', () => {
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
  it('states the status in words and exposes the bar to assistive tech', () => {
    expect(html).toContain('Over budget');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('2 need you');
  });
});
