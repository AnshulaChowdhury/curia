// skills/books/tools/books-uploads/handler.ts
//
// Recent bank-file uploads and their state (ADR-060). Read-only; never returns file contents.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';

export class BooksUploadsHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const reader = ctx.booksReader;
    if (!reader) return { success: false, error: 'books-uploads requires booksReader capability' };
    const limit = (ctx.input as { limit?: unknown }).limit;
    try {
      return { success: true, data: { uploads: await reader.recentUploads(typeof limit === 'number' ? limit : undefined) } };
    } catch (err) {
      ctx.log.error({ err }, 'books-uploads failed');
      return { success: false, error: 'The uploads could not be read just now' };
    }
  }
}
