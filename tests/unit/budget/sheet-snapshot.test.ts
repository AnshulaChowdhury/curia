import { describe, it, expect } from 'vitest';
import { sanitizeWorkbook, MAX_BLANK_CELLS, MAX_CELLS, MAX_SHEETS } from '../../../src/budget/sheet-snapshot.js';

const book = (sheet: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ sheetOrder: ['s1'], sheets: { s1: { name: 'Budget', ...sheet } }, ...over });
const first = (raw: unknown) => sanitizeWorkbook(raw).sheets['s1']!;

describe('sanitizeWorkbook', () => {
  it('keeps cells, formulas, styles, merges and sizes', () => {
    const w = sanitizeWorkbook(book({
      cellData: { '0': { '0': { v: 'Groceries', t: 1, s: 'bold' }, '1': { v: 900, t: 2, f: '=B1*1' } } },
      mergeData: [{ startRow: 0, startColumn: 0, endRow: 0, endColumn: 1 }], columnData: { '0': { w: 120 } }, rowData: { '1': { hd: 1 } },
    }, { styles: { bold: { bl: 1, cl: { rgb: '#000000' } } } }));
    const s = w.sheets['s1']!;
    expect(s.cellData['0']).toEqual({ '0': { v: 'Groceries', t: 1, s: 'bold' }, '1': { v: 900, t: 2, f: '=B1*1' } });
    expect(w.styles).toEqual({ bold: { bl: 1, cl: { rgb: '#000000' } } });
    expect(s.mergeData).toHaveLength(1);
    expect(s.columnData).toEqual({ '0': { w: 120 } });
    expect(s.rowData).toEqual({ '1': { hd: 1 } });
  });

  it('drops the null sizes the converter writes, and sets sizes the grid can draw', () => {
    const s = first(book({ defaultRowHeight: null, defaultColumnWidth: null, rowData: { '0': { h: null, ah: null, hd: 0 } }, columnData: { '0': { w: null, hd: 0 } } }));
    expect(s).toMatchObject({ defaultRowHeight: 24, defaultColumnWidth: 88, rowData: {}, columnData: {}, rowCount: 100, columnCount: 20 });
  });

  it('keeps nothing it does not know: plugin data, images, links, scripts, prototype keys', () => {
    const raw = JSON.parse(`{"sheetOrder":["s1","__proto__"],"resources":[{"name":"SHEET_DRAWING","data":"x"}],"custom":1,
      "styles":{"__proto__":{"bl":1},"ok":{"constructor":"x","bl":1}},
      "sheets":{"__proto__":{"name":"p"},"s1":{"name":"A\\u0000B","drawings":[1],"cellData":{"0":{"0":{"v":"x","custom":{"url":"http://example.test"},"__proto__":{"polluted":1}}},"__proto__":{"0":{"v":"y"}}}}}}`) as unknown;
    const w = sanitizeWorkbook(raw);
    expect(Object.keys(w).sort()).toEqual(['id', 'name', 'sheetOrder', 'sheets', 'styles']);
    expect(w.sheetOrder).toEqual(['s1']);
    expect(w.sheets['s1']!.cellData).toEqual({ '0': { '0': { v: 'x' } } });
    expect(w.sheets['s1']!.name).toBe('AB');
    expect(w.styles).toEqual({ ok: { bl: 1 } });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('keeps only the words of a rich-text cell, and remembers a hidden sheet', () => {
    const s = first(book({ hidden: 1, cellData: { '0': { '0': { p: { body: { dataStream: 'Rich words\r\n', customRanges: [{ url: 'http://example.test' }] } } } } } }));
    expect(s.cellData['0']!['0']).toEqual({ v: 'Rich words' });
    expect(s.hidden).toBe(1);
  });

  it('refuses rather than silently cutting a sheet that is too big', () => {
    expect(() => sanitizeWorkbook(book({ cellData: { '5000': { '0': { v: 1 } } } }))).toThrow(/rows/);
    expect(() => sanitizeWorkbook(book({ cellData: { '0': { '100': { v: 1 } } } }))).toThrow(/columns/);
    const many: Record<string, Record<string, unknown>> = {};
    for (let r = 0; r <= MAX_CELLS / 100; r++) many[String(r)] = Object.fromEntries(Array.from({ length: 100 }, (_, c) => [String(c), { v: 1 }]));
    expect(() => sanitizeWorkbook(book({ cellData: many }))).toThrow(/cells/);
    const sheets = Object.fromEntries(Array.from({ length: MAX_SHEETS + 1 }, (_, i) => [`s${i}`, { name: 'x' }]));
    expect(() => sanitizeWorkbook({ sheets })).toThrow(/sheets/);
    expect(first(book({ cellData: { '9000': { '0': { s: 'x' } } } })).cellData).toEqual({}); // formatting far away is dropped
  });

  // What the converter writes for a formatted blank cell.
  const blank = { s: { bl: 1, ff: 'Calibri' }, t: 1 };
  const grid = (rows: number, columns: number, make: (r: number, c: number) => unknown) =>
    Object.fromEntries(Array.from({ length: rows }, (_, r) => [String(r), Object.fromEntries(Array.from({ length: columns }, (_, c) => [String(c), make(r, c)]))]));

  it('accepts a small budget with formatting spread over thousands of blank cells', () => {
    const s = first(book({ cellData: grid(1000, 26, (r, c) => (r < 5 && c < 3 ? { v: r + c } : blank)) }));
    expect(Object.keys(s.cellData)).toHaveLength(5);
    expect(Object.keys(s.cellData['4']!)).toHaveLength(3);
  });

  it('keeps formatting on blanks among the figures, up to a limit, and none on an empty tab', () => {
    const s = first(book({ cellData: { '0': { '0': { v: 1 }, '1': blank, '9': blank }, '1': { '0': { v: '' , ...blank } }, '2': { '1': { v: 2 } } } }));
    expect(Object.keys(s.cellData['0']!)).toEqual(['0', '1']);
    expect(s.cellData['1']!['0']).toBeDefined();
    expect(first(book({ cellData: { '0': { '0': blank } } })).cellData).toEqual({});
    const wide = first(book({ cellData: grid(300, 50, (r, c) => (r === 299 && c === 49 ? { v: 1 } : blank)) }));
    expect(Object.values(wide.cellData).reduce((n, row) => n + Object.keys(row).length, 0)).toBe(MAX_BLANK_CELLS + 1);
  });

  it('says how many filled cells there are, and where, when there are too many', () => {
    const raw = { sheetOrder: ['a', 'b'], sheets: { a: { name: 'Summary', cellData: grid(10, 10, () => ({ v: 1 })) }, b: { name: 'Transactions', cellData: grid(250, 100, () => ({ v: 1 })) } } };
    expect(() => sanitizeWorkbook(raw)).toThrow('That spreadsheet has 25,100 filled cells; the limit is 20,000. The largest tab is "Transactions" with 25,000.');
  });

  it('refuses what is not a workbook', () => {
    for (const bad of [null, 'x', [], {}, { sheets: {} }]) expect(() => sanitizeWorkbook(bad)).toThrow();
  });
});
