// The converter reads every CSV value as text, which would left-align amounts and break sums. Plain numbers become
// numbers; anything else (including "007", "$1,200" and dates) stays as written.

const PLAIN_NUMBER = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;

interface Cell { v?: unknown; t?: number }
export function numbersFromText(workbook: unknown): unknown {
  const sheets = (workbook as { sheets?: Record<string, { cellData?: Record<string, Record<string, Cell>> }> } | null)?.sheets ?? {};
  for (const sheet of Object.values(sheets)) {
    for (const row of Object.values(sheet.cellData ?? {})) {
      for (const cell of Object.values(row)) {
        if (cell && typeof cell.v === 'string' && PLAIN_NUMBER.test(cell.v.trim())) {
          cell.v = Number(cell.v.trim());
          cell.t = 2;
        }
      }
    }
  }
  return workbook;
}
