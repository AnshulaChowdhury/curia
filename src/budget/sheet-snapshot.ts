// sheet-snapshot.ts — turns a workbook sent by the browser into the one shape Curia stores.
//
// The input is untrusted: it comes from a third-party file converter or from the grid, and its text came from a file.
// Only known fields are copied (cells, formulas, plain styles, merges, sizes); everything else, including embedded
// images, links, rich-text documents and plugin data, is dropped. The converter also writes null sizes, which the grid
// would draw as zero, so nulls are dropped and defaults set here.

import { BudgetError } from './budget-store.js';

export interface SheetCell { v?: string | number | boolean; t?: number; f?: string; s?: string | Record<string, unknown> }
export interface Worksheet {
  id: string; name: string; hidden: number; rowCount: number; columnCount: number; defaultRowHeight: number; defaultColumnWidth: number;
  cellData: Record<string, Record<string, SheetCell>>;
  mergeData: Array<{ startRow: number; startColumn: number; endRow: number; endColumn: number }>;
  rowData: Record<string, { h?: number; hd?: number }>;
  columnData: Record<string, { w?: number; hd?: number }>;
}
export interface Workbook { id: string; name: string; sheetOrder: string[]; styles: Record<string, unknown>; sheets: Record<string, Worksheet> }

export const MAX_SHEETS = 20;
export const MAX_ROWS = 5000;
export const MAX_COLUMNS = 100;
/** Cells holding a value or a formula. Formatted blanks are not counted here: spreadsheet apps save thousands of them. */
export const MAX_CELLS = 20_000;
/** Formatted blank cells kept, across the workbook, and only among the filled ones; the rest are dropped. */
export const MAX_BLANK_CELLS = 10_000;
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_TEXT = 1000;
const MAX_STYLES = 2000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Names used as object keys: never one that reaches an object's prototype. */
const safeKey = (k: string): boolean => /^[A-Za-z0-9_-]{1,64}$/.test(k) && k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
const index = (k: string, max: number): number | null => (/^\d{1,5}$/.test(k) && Number(k) < max ? Number(k) : null);
const num = (v: unknown, min: number, max: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined);
const clean = (s: string, max: number): string => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);

/** A style object as plain data: short strings, finite numbers and booleans, a few levels deep. */
function plain(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return clean(v, 200);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (!isObj(v) || depth <= 0) return undefined;
  const out: Obj = {};
  for (const [k, inner] of Object.entries(v).slice(0, 60)) {
    if (!safeKey(k)) continue;
    const value = plain(inner, depth - 1);
    if (value !== undefined) out[k] = value;
  }
  return out;
}

function cell(raw: unknown): SheetCell | null {
  if (!isObj(raw)) return null;
  const out: SheetCell = {};
  let v = raw['v'];
  // A rich-text cell keeps only its words.
  if (v === undefined || v === null) {
    const body = isObj(raw['p']) && isObj(raw['p']['body']) ? raw['p']['body'] : undefined;
    if (body && typeof body['dataStream'] === 'string') v = body['dataStream'].replace(/[\r\n]+$/, '');
  }
  if (typeof v === 'string') out.v = clean(v, MAX_TEXT);
  else if (typeof v === 'boolean') out.v = v;
  else if (typeof v === 'number' && Number.isFinite(v)) out.v = v;
  const t = num(raw['t'], 1, 4);
  if (t !== undefined) out.t = t;
  if (typeof raw['f'] === 'string' && raw['f']) out.f = clean(raw['f'], MAX_TEXT);
  if (typeof raw['s'] === 'string' && safeKey(raw['s'])) out.s = raw['s'];
  else if (isObj(raw['s'])) out.s = plain(raw['s'], 4) as Obj;
  return Object.keys(out).length ? out : null;
}

function sizes(raw: unknown, max: number, size: 'h' | 'w'): Record<string, { h?: number; w?: number; hd?: number }> {
  const out: Record<string, { h?: number; w?: number; hd?: number }> = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (index(k, max) === null || !isObj(v)) continue;
    const entry: { h?: number; w?: number; hd?: number } = {};
    const px = num(v[size], 1, 2000);
    if (px !== undefined) entry[size] = px;
    if (v['hd'] === 1) entry.hd = 1;
    if (Object.keys(entry).length) out[k] = entry;
  }
  return out;
}

/** The cleaned workbook, or a BudgetError saying what is wrong or too large. */
export function sanitizeWorkbook(raw: unknown): Workbook {
  if (!isObj(raw) || !isObj(raw['sheets'])) throw new BudgetError('That is not a spreadsheet');
  const source = raw['sheets'];
  const listed = Array.isArray(raw['sheetOrder']) ? raw['sheetOrder'].filter((k): k is string => typeof k === 'string') : Object.keys(source);
  const order = [...new Set(listed)].filter(k => safeKey(k) && Object.hasOwn(source, k) && isObj(source[k]));
  if (order.length === 0) throw new BudgetError('That spreadsheet has no sheets');
  if (order.length > MAX_SHEETS) throw new BudgetError(`That spreadsheet has more than ${MAX_SHEETS} sheets`);

  const sheets: Record<string, Worksheet> = {};
  let blanksKept = 0;
  const filled: Array<{ name: string; cells: number }> = [];
  for (const id of order) {
    const s = source[id] as Obj;
    const name = clean(typeof s['name'] === 'string' ? s['name'] : id, 60) || id;
    const cellData: Worksheet['cellData'] = {};
    const blanks: Array<{ r: string; c: string; ri: number; ci: number; kept: SheetCell }> = [];
    let count = 0;
    // The area the filled cells cover; -1 while there are none.
    let lastRow = -1;
    let lastColumn = -1;
    for (const [r, row] of Object.entries(isObj(s['cellData']) ? s['cellData'] : {})) {
      if (!isObj(row)) continue;
      for (const [c, value] of Object.entries(row)) {
        // Anything not addressed by row and column numbers is not a cell.
        if (!/^\d+$/.test(r) || !/^\d+$/.test(c)) continue;
        const kept = cell(value);
        if (!kept) continue;
        const ri = index(r, MAX_ROWS);
        const ci = index(c, MAX_COLUMNS);
        const blank = (kept.v === undefined || kept.v === '') && kept.f === undefined;
        // Refused rather than cut: a budget silently missing rows would be worse than no budget.
        if (ri === null || ci === null) {
          if (blank) continue; // formatting only, far out: not needed
          throw new BudgetError(`That spreadsheet goes past ${MAX_ROWS} rows or ${MAX_COLUMNS} columns`);
        }
        if (blank) { blanks.push({ r, c, ri, ci, kept }); continue; }
        // Past the limit cells are still counted, to say how far over the file is, but no longer kept.
        if (++count <= MAX_CELLS) (cellData[r] ??= {})[c] = kept;
        lastRow = Math.max(lastRow, ri);
        lastColumn = Math.max(lastColumn, ci);
      }
    }
    // Formatting on blank cells matters among the figures (borders, fills), not beyond them.
    for (const { r, c, ri, ci, kept } of blanks) {
      if (ri > lastRow || ci > lastColumn || blanksKept >= MAX_BLANK_CELLS) continue;
      (cellData[r] ??= {})[c] = kept;
      blanksKept += 1;
    }
    filled.push({ name, cells: count });
    const merges = Array.isArray(s['mergeData']) ? s['mergeData'] : [];
    const mergeData = merges.slice(0, 1000).flatMap(m => {
      if (!isObj(m)) return [];
      const [startRow, startColumn, endRow, endColumn] = [num(m['startRow'], 0, MAX_ROWS - 1), num(m['startColumn'], 0, MAX_COLUMNS - 1), num(m['endRow'], 0, MAX_ROWS - 1), num(m['endColumn'], 0, MAX_COLUMNS - 1)];
      return startRow === undefined || startColumn === undefined || endRow === undefined || endColumn === undefined || endRow < startRow || endColumn < startColumn
        ? [] : [{ startRow, startColumn, endRow, endColumn }];
    });
    sheets[id] = {
      id,
      name,
      hidden: s['hidden'] === 1 || s['hidden'] === true ? 1 : 0,
      rowCount: Math.min(Math.max(num(s['rowCount'], 1, MAX_ROWS) ?? 100, lastRow + 1), MAX_ROWS),
      columnCount: Math.min(Math.max(num(s['columnCount'], 1, MAX_COLUMNS) ?? 20, lastColumn + 1), MAX_COLUMNS),
      defaultRowHeight: num(s['defaultRowHeight'], 5, 500) ?? 24,
      defaultColumnWidth: num(s['defaultColumnWidth'], 10, 1000) ?? 88,
      cellData,
      mergeData,
      rowData: sizes(s['rowData'], MAX_ROWS, 'h'),
      columnData: sizes(s['columnData'], MAX_COLUMNS, 'w'),
    };
  }

  const total = filled.reduce((n, tab) => n + tab.cells, 0);
  if (total > MAX_CELLS) {
    const largest = filled.reduce((a, b) => (b.cells > a.cells ? b : a));
    const n = (value: number): string => value.toLocaleString('en-CA');
    throw new BudgetError(`That spreadsheet has ${n(total)} filled cells; the limit is ${n(MAX_CELLS)}. The largest tab is "${largest.name}" with ${n(largest.cells)}.`);
  }

  const styles: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(isObj(raw['styles']) ? raw['styles'] : {}).slice(0, MAX_STYLES)) {
    if (safeKey(k) && isObj(v)) styles[k] = plain(v, 4);
  }
  const workbook: Workbook = { id: 'budget-sheet', name: clean(typeof raw['name'] === 'string' ? raw['name'] : 'Budget', 120) || 'Budget', sheetOrder: order, styles, sheets };
  if (Buffer.byteLength(JSON.stringify(workbook)) > MAX_SNAPSHOT_BYTES) throw new BudgetError('That spreadsheet is too large');
  return workbook;
}
