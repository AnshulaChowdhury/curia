// Mirrors GET /api/books/batches (src/channels/http/routes/books-batches.ts).

export interface BatchSummary {
  batch_id: string;
  created_at: string;
  /** 'complete' once every row is posted or skipped. */
  status: 'open' | 'complete';
  rows: number;
  pending: number;
  approved: number;
  skipped: number;
  posted: number;
  failed: number;
  manual: number;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
