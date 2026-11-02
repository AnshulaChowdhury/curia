// skills/books/tools/books-review-queue/handler.ts
//
// The transactions waiting for the owner (ADR-060). Read-only. Bank text in the cards is untrusted data.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';

export class BooksReviewQueueHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const reader = ctx.booksReader;
    if (!reader) return { success: false, error: 'books-review-queue requires booksReader capability' };
    const limit = (ctx.input as { limit?: unknown }).limit;
    try {
      return { success: true, data: await reader.reviewQueue(typeof limit === 'number' ? limit : undefined) };
    } catch (err) {
      ctx.log.error({ err }, 'books-review-queue failed');
      return { success: false, error: 'The review queue could not be read just now' };
    }
  }
}
