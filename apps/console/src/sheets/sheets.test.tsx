// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAutosave } from './autosave.js';
import { convertFile, fileProblem } from './convert-client.js';
import { numbersFromText } from './csv-numbers.js';
import { createSheetClient, SheetError } from './sheet-client.js';
import { loadedAsSheetPage, SheetList } from '../pages/SheetPage.js';

describe('file checks', () => {
  it('accepts small xlsx and csv files only', () => {
    expect(fileProblem({ name: 'Budget.XLSX', size: 10 })).toBeNull();
    expect(fileProblem({ name: 'b.csv', size: 10 })).toBeNull();
    for (const bad of [{ name: 'b.xls', size: 1 }, { name: 'b.xlsm', size: 1 }, { name: 'b.csv', size: 0 }, { name: 'b.csv', size: 3 * 1024 * 1024 }]) {
      expect(fileProblem(bad), bad.name).not.toBeNull();
    }
  });
});

describe('csv amounts', () => {
  it('turns plain numbers into numbers and leaves the rest as written', () => {
    const cells = ['900', '-12.50', '0.5', '007', '$1,200', '2031-01-01', ' 42 ', 'x'].map(v => ({ v, t: 1 }));
    numbersFromText({ sheets: { s: { cellData: { '0': Object.fromEntries(cells.map((c, i) => [i, c])) } } } });
    expect(cells.map(c => c.v)).toEqual([900, -12.5, 0.5, '007', '$1,200', '2031-01-01', 42, 'x']);
    expect(numbersFromText(null)).toBeNull();
  });
});

describe('converter frame', () => {
  const start = (timeout = 1000) => {
    const result = convertFile(new File(['a,b'], 'b.csv'), document, timeout);
    return { result, frame: () => document.querySelector('iframe')! };
  };
  const announce = (source: unknown, ports: MessagePort[], origin = 'null') =>
    window.dispatchEvent(new MessageEvent('message', { data: { kind: 'ready' }, source: source as Window, origin, ports }));
  /** Stands in for the frame: hands over a channel and answers the file with the given reply. */
  const converter = (source: unknown, answer: unknown) => {
    const channel = new MessageChannel();
    const received = vi.fn();
    channel.port1.onmessage = event => { received(event.data); channel.port1.postMessage(answer); };
    announce(source, [channel.port2]);
    return received;
  };

  it('runs sandboxed, hands the file only to its own frame over a private channel, and removes it', async () => {
    const { result, frame } = start();
    await vi.waitFor(() => expect(frame()).not.toBeNull());
    expect(frame().getAttribute('sandbox')).toBe('allow-scripts');
    const inner = frame().contentWindow;
    const stranger = new MessageChannel();
    const leaked = vi.spyOn(stranger.port2, 'postMessage');
    announce(window, [stranger.port2]);                          // not our frame
    announce(inner, [stranger.port2], window.location.origin);   // our frame without its sandbox
    const received = converter(inner, { kind: 'done', workbook: { sheets: {} } });
    await expect(result).resolves.toEqual({ sheets: {} });
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ kind: 'convert', name: 'b.csv' }));
    expect(leaked).not.toHaveBeenCalled();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('reports a failure, and gives up after a time limit', async () => {
    const failing = start();
    await vi.waitFor(() => expect(failing.frame()).not.toBeNull());
    converter(failing.frame().contentWindow, { kind: 'failed', message: 'broken zip' });
    await expect(failing.result).rejects.toThrow('could not be read');
    await expect(start(20).result).rejects.toThrow('too long');
    expect(document.querySelector('iframe')).toBeNull();
  });
});

describe('autosave', () => {
  const setup = (save = vi.fn(async (v: number) => ({ version: v + 1 }))) => {
    let book = { a: 1 };
    const states: string[] = [];
    const auto = createAutosave({ read: () => book, save, version: 1, onState: s => states.push(s) });
    return { auto, save, states, edit: (a: number) => { book = { a }; } };
  };

  it('saves only changes, each over the version it last saw', async () => {
    const { auto, save, edit } = setup();
    await auto.tick();
    expect(save).not.toHaveBeenCalled();
    edit(2); await auto.tick(); await auto.tick();
    edit(3); await auto.tick();
    expect(save.mock.calls).toEqual([[1, { a: 2 }], [2, { a: 3 }]]);
  });

  it('retries after a failure, and stops for good on a conflict', async () => {
    let fail: Error | null = new SheetError('down', 500);
    const save = vi.fn(async (v: number) => { if (fail) throw fail; return { version: v + 1 }; });
    const { auto, states, edit } = setup(save);
    edit(2); await auto.tick();
    fail = null; await auto.tick();
    fail = new SheetError('changed elsewhere', 409); edit(3); await auto.tick();
    fail = null; edit(4); await auto.tick();
    expect(save).toHaveBeenCalledTimes(3);
    expect(states).toEqual(['saving', 'failed', 'saving', 'saved', 'saving', 'conflict']);
  });
});

describe('sheet page', () => {
  it('knows whether it carries its own policy', () => {
    expect(loadedAsSheetPage('https://x.test/budget/sheet-frame?id=1')).toBe(true);
    expect(loadedAsSheetPage('https://x.test/budget')).toBe(false);
    expect(loadedAsSheetPage(undefined)).toBe(true);
  });
  it('shows file names as text and asks before deleting', () => {
    const html = renderToStaticMarkup(<SheetList sheets={[{ id: 'a', name: '<img src=x>', version: 1, updatedAt: '2031-01-01T00:00:00Z', expiresAt: '2031-01-15T00:00:00Z' }]} onDelete={() => {}} />);
    expect(html).not.toContain('<img');
    expect(html).toContain('href="/budget/sheet-frame?id=a"');
    expect(html).not.toContain('btn-danger');
  });
});

describe('sheet client', () => {
  it('sends the version with a save and surfaces a conflict', async () => {
    const seen: Array<{ path: string; body: unknown }> = [];
    const client = createSheetClient(async (path, init) => { seen.push({ path, body: JSON.parse(init!.body as string) }); return new Response(JSON.stringify({ error: 'changed' }), { status: 409 }); });
    await expect(client.save('id1', 4, { w: 1 })).rejects.toMatchObject({ conflict: true, message: 'changed' });
    expect(seen).toEqual([{ path: '/api/budget/sheets/id1', body: { version: 4, workbook: { w: 1 } } }]);
  });
});
