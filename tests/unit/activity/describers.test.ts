import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describeToolCall,
  describerRefs,
  formatTally,
  hasDescriber,
  type DescribeContext,
  type ToolCall,
} from '../../../src/activity/describers.js';
import { discoverToolManifests } from '../../../src/skills/loader.js';
import { AutonomyService } from '../../../src/autonomy/autonomy-service.js';

const SKILLS_DIR = path.resolve(import.meta.dirname, '../../../skills');

function ctx(names: Record<string, string> = {}, timezone = 'America/Toronto'): DescribeContext {
  return { name: (ref) => names[ref] ?? null, timezone };
}

function call(toolName: string, input: Record<string, unknown>, data: Record<string, unknown> | null, ok = true): ToolCall {
  return { toolName, input, data, ok };
}

describe('describer coverage', () => {
  it('every tool at action_risk medium or above has a describer', () => {
    const threshold = AutonomyService.minScoreForActionRisk('medium');
    const missing: string[] = [];
    for (const disc of discoverToolManifests(SKILLS_DIR)) {
      if (disc.error || !disc.manifest) continue;
      if (AutonomyService.minScoreForActionRisk(disc.manifest.action_risk) < threshold) continue;
      if (!hasDescriber(disc.manifest.name)) missing.push(disc.manifest.name);
    }
    // Add an entry to src/activity/describers.ts for each tool listed here.
    expect(missing).toEqual([]);
  });
});

describe('describeToolCall', () => {
  it('names a draft reply recipient by contact, falling back to the address', () => {
    const draft = call('ceo-inbox-draft-reply', { reply_to_message_id: 'm1', body: 'secret body' }, {
      to: [{ name: 'Johnny (header)', email: 'John@Example.com' }],
    });
    expect(describerRefs(draft)).toEqual(['email:john@example.com']);
    expect(describeToolCall(draft, ctx({ 'email:john@example.com': 'John Doe' }))?.text).toBe('drafted a reply to John Doe');
    expect(describeToolCall(draft, ctx())?.text).toBe('drafted a reply to john@example.com');
  });

  it('writes a calendar event date in the principal timezone', () => {
    // 02:30 UTC on Nov 1 is still Oct 31 in Toronto.
    const create = call('calendar-create-event', { title: 'Board Meeting', start: '2026-11-01T02:30:00Z' }, {
      event: { title: 'Board Meeting', startTime: '2026-10-31T22:30:00-04:00' },
    });
    expect(describeToolCall(create, ctx())?.text).toBe('scheduled “Board Meeting” on Oct 31');
    expect(describeToolCall(create, ctx({}, 'Asia/Tokyo'))?.text).toBe('scheduled “Board Meeting” on Nov 1');
  });

  it('keeps an all-day date on its calendar day in any timezone', () => {
    const allDay = call('calendar-create-event', { title: 'Offsite', start: '2026-10-31' }, null);
    expect(describeToolCall(allDay, ctx())?.text).toBe('scheduled “Offsite” on Oct 31');
    expect(describeToolCall(allDay, ctx({}, 'Pacific/Honolulu'))?.text).toBe('scheduled “Offsite” on Oct 31');
    expect(describeToolCall(allDay, ctx({}, 'Pacific/Kiritimati'))?.text).toBe('scheduled “Offsite” on Oct 31');
  });

  it('describes a failure as a "couldn\'t" line', () => {
    const send = call('email-send', { to: 'c-1', body: 'x' }, null, false);
    expect(describeToolCall(send, ctx({ 'c-1': 'Jane Roe' }))?.text).toBe("couldn't email Jane Roe");
  });

  it('resolves the principal alias and strips #label hints', () => {
    const send = call('signal-send', { recipient: 'principal#personal', message: 'hi' }, { delivered_to: '+1555' });
    expect(describerRefs(send)).toEqual(['principal']);
    expect(describeToolCall(send, ctx({ principal: 'Joseph' }))?.text).toBe('messaged Joseph on Signal');
  });

  it('never reveals a contact id when the name does not resolve', () => {
    const send = call('email-send', { to: '7f1c0c1e-0000-4000-8000-000000000001' }, { to: '' });
    expect(describeToolCall(send, ctx())?.text).toBe('emailed a contact');
  });

  it('hides plumbing and marks web tools as research', () => {
    expect(describeToolCall(call('config-store', {}, {}), ctx())?.prominence).toBe('hidden');
    expect(describeToolCall(call('web-search', { query: 'x' }, {}), ctx())).toMatchObject({ prominence: 'hidden', research: 'search' });
    expect(describeToolCall(call('ceo-inbox-search', {}, {}), ctx())).toBeNull();
  });

  it('hides a dry-run merge and a hold that was not placed', () => {
    expect(describeToolCall(call('contact-merge', { primary_contact_id: 'a', secondary_contact_id: 'b', dry_run: true }, {}), ctx())?.prominence).toBe('hidden');
    expect(describeToolCall(call('calendar-create-hold', { start: '2026-10-31T10:00:00Z' }, { held: false }), ctx())?.prominence).toBe('hidden');
  });
});

describe('formatTally', () => {
  it('uses the singular phrase for one and a count otherwise', () => {
    const t = { verb: 'drafted', one: 'a reply', many: 'replies' };
    expect(formatTally(t, 1)).toBe('drafted a reply');
    expect(formatTally(t, 3)).toBe('drafted 3 replies');
  });
});
