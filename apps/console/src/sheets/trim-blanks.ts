// The converter writes a cell for every formatted blank, often tens of thousands, which would make the upload too large.
// Blanks beyond the last filled row or column are dropped here, and the rest are capped. The server applies its own
// limits to whatever arrives; this only keeps the request small.

const MAX_BLANKS = 10_000;

interface Cell { v?: unknown; f?: unknown; p?: unknown }
type Rows = Record<string, Record<string, Cell | null>>;

const isFilled = (c: Cell | null): boolean => !!c && ((c.v !== undefined && c.v !== null && c.v !== '') || !!c.f || !!c.p);

export function trimBlanks(workbook: unknown): unknown {
  const sheets = (workbook as { sheets?: Record<string, { cellData?: Rows }> } | null)?.sheets ?? {};
  let blanks = 0;
  for (const sheet of Object.values(sheets)) {
    const rows = sheet.cellData ?? {};
    let lastRow = -1;
    let lastColumn = -1;
    for (const [r, row] of Object.entries(rows)) {
      for (const [c, cell] of Object.entries(row)) {
        if (isFilled(cell)) { lastRow = Math.max(lastRow, Number(r)); lastColumn = Math.max(lastColumn, Number(c)); }
      }
    }
    for (const [r, row] of Object.entries(rows)) {
      for (const [c, cell] of Object.entries(row)) {
        if (isFilled(cell)) continue;
        if (Number(r) <= lastRow && Number(c) <= lastColumn && blanks < MAX_BLANKS) blanks += 1;
        else delete row[c];
      }
      if (Object.keys(row).length === 0) delete rows[r];
    }
  }
  return workbook;
}
