import { describe, expect, it, vi } from 'vitest';
import { PhoneBriefService, cleanText } from '../../../src/phone-brief/brief-service.js';
import type { Brief, BriefContext, BriefItem, BriefSource, BriefStore } from '../../../src/phone-brief/types.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
// 2 Nov 2026, 06:30 in Toronto (EST) = 11:30Z.
const NOW = Date.parse('2026-11-02T11:30:00Z');

function memoryStore(): BriefStore & { saved: Brief[] } {
  const saved: Brief[] = [];
  return {
    saved,
    save: async (b) => { saved.push(b); },
    get: async (d) => saved.find((b) => b.date === d) ?? null,
  };
}

const source = (id: BriefSource['id'], items: BriefItem[] | (() => Promise<BriefItem[]>)): BriefSource => ({
  id,
  items: typeof items === 'function' ? items : async () => items,
});

function service(opts: { signal?: string } = { signal: '+14165550123' }) {
  const store = memoryStore();
  return { store, svc: new PhoneBriefService(store, logger, 'America/Toronto', () => opts.signal) };
}

describe('cleanText', () => {
  it('flattens whitespace and control characters and cuts without splitting an emoji', () => {
    expect(cleanText('a\n\nb\t c\u0000d', 50)).toBe('a b c d');
    expect(cleanText('x'.repeat(10) + '😀', 11)).toBe('x'.repeat(10));
  });
});

describe('PhoneBriefService', () => {
  it('sends sections in the contract order whatever order sources were registered in', async () => {
    const { svc } = service();
    svc.registerSource(source('newsletters', [{ from: 'A', subject: 'S' }]));
    svc.registerSource(source('accounting', [{ text: '12 transactions categorised; 3 need your review' }]));
    svc.registerSource(source('contacts', [{ text: '4 duplicates merged' }]));
    const brief = await svc.generate(NOW);
    expect(brief.sections.map((s) => s.id)).toEqual(['accounting', 'contacts', 'newsletters']);
    expect(brief.date).toBe('2026-11-02');
    expect(brief.generatedAt).toBe('2026-11-02T11:30:00.000Z');
  });

  it('hands sources the local "yesterday" window', async () => {
    const { svc } = service();
    const seen: BriefContext[] = [];
    svc.registerSource(source('newsletters', async () => []));
    svc.registerSource({ id: 'accounting', items: async (ctx) => { seen.push(ctx); return []; } });
    await svc.generate(NOW);
    // Yesterday (1 Nov) in Toronto: 04:00Z on 1 Nov to 05:00Z on 2 Nov, a 25-hour day.
    expect(seen[0]!.yesterday).toEqual({ start: Date.parse('2026-11-01T04:00:00Z') / 1000, end: Date.parse('2026-11-02T05:00:00Z') / 1000 });
    expect(seen[0]!.date).toBe('2026-11-02');
  });

  it('enforces the contract: at most 10 items, 280 characters, plain text, nothing empty', async () => {
    const { svc } = service();
    const many = Array.from({ length: 14 }, (_, i) => ({ text: `item ${i}` }));
    svc.registerSource(source('accounting', [...many, { text: '   ' }]));
    svc.registerSource(source('newsletters', [{ from: 'Dana\nSmith', subject: 'Hi', text: 'y'.repeat(400) }]));
    const brief = await svc.generate(NOW);
    expect(brief.sections[0]!.items).toHaveLength(10);
    const news = brief.sections[1]!.items[0]!;
    expect(news.text).toHaveLength(280);
    expect(news.from).toBe('Dana Smith');
  });

  it('drops items with nothing to show and sections with no items', async () => {
    const { svc } = service();
    svc.registerSource(source('accounting', [{ from: 'only a sender' }, { text: '' }]));
    svc.registerSource(source('contacts', []));
    const brief = await svc.generate(NOW);
    expect(brief.sections).toEqual([]);
  });

  it('keeps a sender-and-subject-only newsletter item', async () => {
    const { svc } = service();
    svc.registerSource(source('newsletters', [{ from: 'Substack', subject: 'Weekly' }]));
    expect((await svc.generate(NOW)).sections[0]!.items[0]).toEqual({ from: 'Substack', subject: 'Weekly' });
  });

  it('a failing source only loses its own section', async () => {
    const { svc } = service();
    svc.registerSource(source('accounting', async () => { throw new Error('books down'); }));
    svc.registerSource(source('newsletters', [{ from: 'A', subject: 'S' }]));
    const brief = await svc.generate(NOW);
    expect(brief.sections.map((s) => s.id)).toEqual(['newsletters']);
  });

  it('a second source for the same section replaces the first', async () => {
    const { svc } = service();
    svc.registerSource(source('accounting', [{ text: 'old' }]));
    svc.registerSource(source('accounting', [{ text: 'new' }]));
    expect((await svc.generate(NOW)).sections[0]!.items[0]!.text).toBe('new');
  });

  it('stores an empty day too, but today() answers null for it', async () => {
    const { svc, store } = service();
    await svc.generate(NOW);
    expect(store.saved).toHaveLength(1);
    expect(await svc.hasRun('2026-11-02')).toBe(true);
    expect(await svc.today(NOW)).toBeNull();
  });

  it("today() never returns another day's brief", async () => {
    const { svc } = service();
    svc.registerSource(source('accounting', [{ text: 'x' }]));
    await svc.generate(NOW);
    expect(await svc.today(NOW)).not.toBeNull();
    expect(await svc.today(NOW + 24 * 3_600_000)).toBeNull();
  });

  it.each([
    ['+14165550123', '+14165550123'],
    [' +14165550123 ', '+14165550123'],
    ['416-555-0123', null],
    ['+1 416 555 0123', null],
    ['', null],
    [undefined, null],
  ])('shows the Signal number %j as %j (E.164 only)', async (configured, expected) => {
    const { svc } = service({ signal: configured });
    svc.registerSource(source('accounting', [{ text: 'x' }]));
    await svc.generate(NOW);
    expect((await svc.today(NOW))!.signalNumber).toBe(expected);
  });
});
