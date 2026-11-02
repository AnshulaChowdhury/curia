// brief-service.ts — builds and serves the morning brief.
//
// generate() asks every registered source for its items, drops what the contract does not allow (unknown or empty
// sections, more than 10 items, text over 280 characters), and stores the result for the local date. A source that
// throws only loses its own section. Sections are always sent in the contract's order.

import type { Logger } from '../logger.js';
import { localDate, previousLocalDate, startOfLocalDay } from './local-time.js';
import {
  BRIEF_SECTION_IDS,
  MAX_ITEMS_PER_SECTION,
  MAX_ITEM_TEXT,
  type Brief,
  type BriefContext,
  type BriefItem,
  type BriefSection,
  type BriefSource,
  type BriefStore,
} from './types.js';

/** Plain text only: control characters out, whitespace collapsed, cut to the limit without splitting an emoji. */
export function cleanText(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  let end = max;
  const last = flat.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // do not leave half a surrogate pair
  return flat.slice(0, end).trimEnd();
}

function cleanItem(item: BriefItem): BriefItem | null {
  const out: BriefItem = {};
  const text = item.text ? cleanText(item.text, MAX_ITEM_TEXT) : '';
  const from = item.from ? cleanText(item.from, 120) : '';
  const subject = item.subject ? cleanText(item.subject, 200) : '';
  if (text) out.text = text;
  if (from) out.from = from;
  if (subject) out.subject = subject;
  // An item needs something to show.
  return out.text || out.subject ? out : null;
}

export class PhoneBriefService {
  private readonly sources: BriefSource[] = [];

  constructor(
    private readonly store: BriefStore,
    private readonly logger: Logger,
    private readonly timeZone: string,
    /** The Signal number to show on "Chat about this", read per call because the vault can set it after boot. */
    private readonly getSignalNumber: () => string | undefined,
  ) {}

  /** Other owners (accounting, contacts) add their section here. A second source for the same id replaces the first. */
  registerSource(source: BriefSource): void {
    const at = this.sources.findIndex((s) => s.id === source.id);
    if (at >= 0) this.sources.splice(at, 1);
    this.sources.push(source);
  }

  /** The local date for an instant, in the brief's timezone. */
  dateFor(nowMs: number): string {
    return localDate(nowMs, this.timeZone);
  }

  /** Builds the brief for the local day containing `nowMs` and stores it (even when empty, so the day is marked done). */
  async generate(nowMs: number): Promise<Brief> {
    const date = this.dateFor(nowMs);
    const ctx: BriefContext = {
      date,
      yesterday: {
        start: startOfLocalDay(previousLocalDate(date), this.timeZone) / 1000,
        end: startOfLocalDay(date, this.timeZone) / 1000,
      },
    };

    const sections: BriefSection[] = [];
    for (const id of BRIEF_SECTION_IDS) {
      const source = this.sources.find((s) => s.id === id);
      if (!source) continue;
      try {
        const items = (await source.items(ctx))
          .map(cleanItem)
          .filter((i): i is BriefItem => i !== null)
          .slice(0, MAX_ITEMS_PER_SECTION);
        if (items.length > 0) sections.push({ id, items });
      } catch (err) {
        // One section failing must not cost the others.
        this.logger.warn({ err, section: id }, 'phone-brief: a section failed and was left out');
      }
    }

    const brief: Brief = { date, generatedAt: new Date(nowMs).toISOString(), sections };
    await this.store.save(brief);
    this.logger.info({ date, sections: sections.map((s) => `${s.id}:${s.items.length}`) }, 'phone-brief: generated');
    return brief;
  }

  /** True once the job has run for this local date (even if it found nothing). */
  async hasRun(date: string): Promise<boolean> {
    return (await this.store.get(date)) !== null;
  }

  /** Today's brief with the Signal number, or null when there is nothing to report (the route answers 204). */
  async today(nowMs: number): Promise<(Brief & { signalNumber: string | null }) | null> {
    const brief = await this.store.get(this.dateFor(nowMs));
    if (!brief || brief.sections.length === 0) return null;
    const number = this.getSignalNumber()?.trim();
    return { ...brief, signalNumber: number && /^\+\d{7,15}$/.test(number) ? number : null };
  }
}
