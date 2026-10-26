import { describe, it, expect } from 'vitest';
import { scrubPii, parseExtraPiiPatterns, detectPii } from '../../../src/pii/scrubber.js';

describe('scrubPii — built-in patterns', () => {
  // ── Email ──────────────────────────────────────────────────────────────────

  it('scrubs a plain email address', () => {
    expect(scrubPii('Contact resolution failed for user@example.com')).not.toContain('user@example.com');
    expect(scrubPii('Contact resolution failed for user@example.com')).toContain('[EMAIL]');
  });

  it('scrubs email with subdomains and plus-addressing', () => {
    const result = scrubPii('Failed to send to john.doe+tag@mail.company.co.uk');
    expect(result).not.toContain('john.doe');
    expect(result).toContain('[EMAIL]');
  });

  it('scrubs multiple emails in one string', () => {
    const result = scrubPii('from alice@example.com to bob@other.org');
    expect(result).not.toContain('alice@example.com');
    expect(result).not.toContain('bob@other.org');
    expect(result.match(/\[EMAIL\]/g)?.length).toBe(2);
  });

  // ── Phone numbers ─────────────────────────────────────────────────────────

  it('scrubs a US phone in +1-NXX format', () => {
    expect(scrubPii('Phone lookup error for +1-555-867-5309')).toContain('[PHONE]');
  });

  it('scrubs a US phone in (NXX) NXX-XXXX format', () => {
    expect(scrubPii('Failed for (416) 555-1234')).toContain('[PHONE]');
  });

  it('scrubs a 10-digit US phone without formatting', () => {
    expect(scrubPii('Nylas error for sender at 5558675309')).toContain('[PHONE]');
  });

  // ── Credit card ───────────────────────────────────────────────────────────

  it('scrubs a credit card with spaces', () => {
    expect(scrubPii('Payment failed for card 4111 1111 1111 1111')).toContain('[CREDIT_CARD]');
  });

  it('scrubs a credit card without spaces', () => {
    expect(scrubPii('Payment failed for card 4111111111111111')).toContain('[CREDIT_CARD]');
  });

  it('scrubs a credit card with dashes', () => {
    expect(scrubPii('Card: 4111-1111-1111-1111')).toContain('[CREDIT_CARD]');
  });

  // ── SSN (keyword-prefixed only) ───────────────────────────────────────────

  it('scrubs SSN when preceded by "SSN:" keyword', () => {
    expect(scrubPii('SSN: 123-45-6789 is invalid')).toContain('[SSN]');
  });

  it('does NOT scrub bare 9-digit sequences without SSN keyword', () => {
    // Bare numbers (e.g. port numbers, order IDs) should not be scrubbed
    const result = scrubPii('order ref 123456789 processed');
    expect(result).toBe('order ref 123456789 processed');
  });

  // ── UUID protection ───────────────────────────────────────────────────────
  // UUIDs appear constantly in Curia logs (conversationId, contactId, taskId).
  // They must never be scrubbed as false-positive PII matches.

  it('does NOT scrub standard v4 UUIDs', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(scrubPii(`taskId: ${uuid}`)).toContain(uuid);
  });

  it('does NOT scrub UUIDs with zero-heavy segments that look like credit cards', () => {
    const uuid = '00000000-0000-0000-0000-000000000001';
    expect(scrubPii(`taskId: ${uuid}`)).toContain(uuid);
  });

  it('does NOT scrub UUIDs with hex digit groups that look like phone numbers', () => {
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    expect(scrubPii(`convId: ${uuid}`)).toContain(uuid);
  });

  it('scrubs PII in a string that also contains a UUID', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const result = scrubPii(`taskId: ${uuid} failed for user@example.com`);
    expect(result).toContain(uuid);          // UUID preserved
    expect(result).toContain('[EMAIL]');     // email scrubbed
    expect(result).not.toContain('user@example.com');
  });

  // ── No-false-positive cases ───────────────────────────────────────────────

  it('does not alter plain log strings without PII', () => {
    const inputs = [
      'Dispatching to coordinator',
      'Skill timeout after 5000ms',
      'rate limited: 429 retry after 30s',
      'Error: ECONNREFUSED 127.0.0.1:5432',
      'Trust score: 0.85 for conversationId conv:xyz',
      'version 0.15.1 started',
    ];
    for (const input of inputs) {
      expect(scrubPii(input)).toBe(input);
    }
  });

  it('does not scrub ISO timestamps', () => {
    const ts = '2024-01-15T10:30:00.000Z';
    expect(scrubPii(`Failed to process message ${ts}`)).toContain(ts);
  });

  // ── Audit log contract ────────────────────────────────────────────────────
  // scrubPii is called on the LLM-facing copy only; the raw error is retained
  // in the audit log. This test verifies the scrubber doesn't mutate inputs.

  it('does not mutate the input string', () => {
    const original = 'error for user@example.com';
    const copy = original;
    scrubPii(original);
    expect(original).toBe(copy);
  });
});

describe('scrubPii — extra patterns', () => {
  it('applies operator-supplied extra patterns', () => {
    const extras = parseExtraPiiPatterns(
      [{ regex: 'EMP-\\d{6}', replacement: '[EMPLOYEE_ID]' }],
      'test',
    );
    const result = scrubPii('failed for employee EMP-123456 at step 3', extras);
    expect(result).not.toContain('EMP-123456');
    expect(result).toContain('[EMPLOYEE_ID]');
  });

  it('extra patterns are applied case-insensitively', () => {
    const extras = parseExtraPiiPatterns(
      [{ regex: 'passport-[a-z0-9]+', replacement: '[PASSPORT]' }],
      'test',
    );
    expect(scrubPii('doc PASSPORT-AB1234 failed', extras)).toContain('[PASSPORT]');
  });

  it('built-in patterns still apply when extras are provided', () => {
    const extras = parseExtraPiiPatterns(
      [{ regex: 'EMP-\\d{6}', replacement: '[EMPLOYEE_ID]' }],
      'test',
    );
    const result = scrubPii('EMP-999999 emailed user@example.com', extras);
    expect(result).toContain('[EMPLOYEE_ID]');
    expect(result).toContain('[EMAIL]');
  });
});

describe('parseExtraPiiPatterns — validation', () => {
  it('throws on missing regex field', () => {
    expect(() =>
      parseExtraPiiPatterns([{ regex: '', replacement: '[X]' }], 'test.yaml'),
    ).toThrow(/missing a valid 'regex'/);
  });

  it('throws on missing replacement field', () => {
    expect(() =>
      parseExtraPiiPatterns([{ regex: 'foo', replacement: '' }], 'test.yaml'),
    ).toThrow(/missing a valid 'replacement'/);
  });

  it('throws on invalid regex syntax', () => {
    expect(() =>
      parseExtraPiiPatterns([{ regex: '(unclosed', replacement: '[X]' }], 'test.yaml'),
    ).toThrow(/invalid regex/);
  });

  it('returns empty array for empty input', () => {
    expect(parseExtraPiiPatterns([], 'test.yaml')).toEqual([]);
  });
});

describe('classify.ts integration — PII scrubbing in error messages', () => {
  // These tests verify the full path: classify an error that contains PII
  // and confirm the LLM-facing message is scrubbed.

  it('scrubs email from classifyError message', async () => {
    // Dynamic import so setErrorPiiPatterns state is isolated from unit tests above
    const { classifyError } = await import('../../../src/errors/classify.js');
    const err = new Error('failed to contact user@example.com: timeout');
    const result = classifyError(err, 'nylas');
    expect(result.message).not.toContain('user@example.com');
    expect(result.message).toContain('[EMAIL]');
  });

  it('scrubs phone from classifySkillError message', async () => {
    const { classifySkillError } = await import('../../../src/errors/classify.js');
    const result = classifySkillError('signal-send', 'recipient +1-555-867-5309 not found');
    expect(result.message).not.toContain('+1-555-867-5309');
    expect(result.message).toContain('[PHONE]');
  });

  it('scrubs credit card from classifySkillError message', async () => {
    const { classifySkillError } = await import('../../../src/errors/classify.js');
    const result = classifySkillError('payment', 'card 4111 1111 1111 1111 declined');
    expect(result.message).not.toContain('4111 1111 1111 1111');
    expect(result.message).toContain('[CREDIT_CARD]');
  });
});

describe('detectPii', () => {
  it('detects an email address with label and position', () => {
    const text = 'Contact user@example.com for help';
    const matches = detectPii(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.label).toMatch(/email/i);
    expect(matches[0]!.matched).toBe('user@example.com');
    expect(matches[0]!.start).toBe(8);
    expect(matches[0]!.end).toBe(24);
  });

  it('detects a credit card number', () => {
    const matches = detectPii('Card: 4111 1111 1111 1111');
    expect(matches.some(m => m.label.match(/credit_card/i))).toBe(true);
  });

  it('does not false-positive on UUIDs', () => {
    const text = 'Task 550e8400-e29b-41d4-a716-446655440000 failed';
    const matches = detectPii(text);
    expect(matches).toHaveLength(0);
  });

  it('returns empty array for clean text', () => {
    expect(detectPii('Just a normal message')).toHaveLength(0);
  });

  it('returns matches sorted by start position', () => {
    const text = 'from alice@example.com to bob@other.org';
    const matches = detectPii(text);
    expect(matches).toHaveLength(2);
    expect(matches[0]!.start).toBeLessThan(matches[1]!.start);
    expect(matches[0]!.matched).toBe('alice@example.com');
    expect(matches[1]!.matched).toBe('bob@other.org');
  });

  it('match positions reference the original text', () => {
    const text = 'error for user@example.com in task';
    const matches = detectPii(text);
    expect(matches).toHaveLength(1);
    const m = matches[0]!;
    expect(text.slice(m.start, m.end)).toBe(m.matched);
  });

  it('accepts extra patterns and detects them', () => {
    const extras = parseExtraPiiPatterns(
      [{ regex: 'EMP-\\d{6}', replacement: '[EMPLOYEE_ID]' }],
      'test',
    );
    const matches = detectPii('employee EMP-123456 at step 3', extras);
    expect(matches.some(m => m.label === 'extra_0')).toBe(true);
  });
});

describe('sin_ca', () => {
  // Luhn check digit for an 8-digit prefix, so fixtures with a chosen leading
  // digit are valid by construction. Fixed fixtures: 130 692 544 is Luhn-valid
  // (sum 40); 130 692 545 is not; 046 454 286 is valid but leads with 0.
  function withLuhnCheckDigit(prefix8: string): string {
    let sum = 0;
    for (let i = 0; i < prefix8.length; i++) {
      let d = Number(prefix8[i]);
      // Check digit sits in position 9 (odd), so prefix positions 2,4,6,8 double.
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    return prefix8 + String((10 - (sum % 10)) % 10);
  }
  const sinMatches = (text: string) => detectPii(text).filter((m) => m.label === 'sin_ca');

  it('rejects a Luhn-valid number that starts with 0', () => {
    expect(sinMatches('My SIN is 046 454 286')).toHaveLength(0);
  });

  it.each(['130 692 544', '130-692-544'])('matches formatted SIN %s without a keyword', (sin) => {
    const found = sinMatches(`number ${sin} here`);
    expect(found).toHaveLength(1);
    expect(found[0]!.matched).toBe(sin);
  });

  it.each(['SIN: 130692544', 'social insurance number 130692544', 'Social Insurance No. 130692544'])(
    'matches bare digits after keyword in %s, excluding the keyword from the span',
    (text) => {
      const found = sinMatches(text);
      expect(found).toHaveLength(1);
      expect(found[0]!.matched).toBe('130692544');
    },
  );

  it('does not match bare 9 digits without a keyword', () => {
    expect(sinMatches('130692544')).toHaveLength(0);
  });

  it('rejects a Luhn-invalid number', () => {
    expect(sinMatches('130 692 545')).toHaveLength(0);
  });

  it('rejects Luhn-valid numbers starting with 0 or 8', () => {
    const lead8 = withLuhnCheckDigit('83069254');
    const lead0 = withLuhnCheckDigit('03069254');
    expect(sinMatches(`SIN ${lead8}`)).toHaveLength(0);
    expect(sinMatches(`SIN ${lead0}`)).toHaveLength(0);
  });

  it('rejects mixed separators', () => {
    expect(sinMatches('130-692 544')).toHaveLength(0);
  });

  it('does not match inside a UUID, a 10-digit number, or an order id', () => {
    expect(sinMatches('id 130692ab-1306-4925-8444-130692544000')).toHaveLength(0);
    expect(sinMatches('1306925440')).toHaveLength(0);
    expect(sinMatches('SIN 1306925440')).toHaveLength(0);
    expect(sinMatches('ORD-130-692-5441')).toHaveLength(0);
  });

  it('scrubs with the [SIN] replacement', () => {
    expect(scrubPii('SIN 130 692 544')).toBe('SIN [SIN]');
  });
});
