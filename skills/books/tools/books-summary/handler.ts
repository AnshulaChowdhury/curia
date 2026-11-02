// skills/books/tools/books-summary/handler.ts
//
// The books specialist's one-read overview (ADR-060). Read-only: BooksReader has no method that changes anything.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';

export class BooksSummaryHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const reader = ctx.booksReader;
    if (!reader) return { success: false, error: 'books-summary requires booksReader capability' };
    try {
      return { success: true, data: await reader.summary() };
    } catch (err) {
      ctx.log.error({ err }, 'books-summary failed');
      return { success: false, error: 'The books could not be read just now' };
    }
  }
}
