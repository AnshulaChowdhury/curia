// skills/books/tools/books-uploads/handler.test.ts

import { describe, it, expect, vi } from 'vitest';
import { BooksUploadsHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import { createSilentLogger } from '../../../../src/logger.js';

const ctx = (over: Partial<ToolContext>): ToolContext =>
  ({ input: {}, secret: () => { throw new Error('no secrets'); }, log: createSilentLogger(), timezone: 'America/Toronto', ...over }) as ToolContext;

describe('books-uploads', () => {
  it('fails closed without the booksReader capability', async () => {
    const r = await new BooksUploadsHandler().execute(ctx({}));
    expect(r).toEqual({ success: false, error: expect.stringContaining('booksReader') });
  });

  it('returns what the reader gives', async () => {
    const reader = { summary: vi.fn().mockResolvedValue({ ok: 1 }), reviewQueue: vi.fn().mockResolvedValue({ total: 1, cards: [] }), recentUploads: vi.fn().mockResolvedValue([]) };
    const r = await new BooksUploadsHandler().execute(ctx({ booksReader: reader as never, input: { limit: 5 } }));
    expect(r.success).toBe(true);
  });

  it('turns a failure into a plain error without leaking the cause', async () => {
    const boom = vi.fn().mockRejectedValue(new Error('db password=hunter2'));
    const r = await new BooksUploadsHandler().execute(ctx({ booksReader: { summary: boom, reviewQueue: boom, recentUploads: boom } as never }));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).not.toContain('hunter2');
  });
});
