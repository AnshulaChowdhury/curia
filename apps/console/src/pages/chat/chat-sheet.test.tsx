// @vitest-environment happy-dom
// The chat's attached spreadsheet: when it may frame, what the controls offer, and attaching and detaching.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttachButton, SheetBar, SheetSide } from './ChatSheet.js';
import { loadedAsChatPage, useChatSheet, DETACH_SETTLE_MS, type ChatSheet } from './useChatSheet.js';
import { createSheetClient } from '../../sheets/sheet-client.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const info = { id: 'a', name: '<b>Budget</b>', version: 1, updatedAt: '', expiresAt: '' };
const noop = () => {};

describe('when the chat may frame the sheet', () => {
  it('only on a document loaded as the chat page', () => {
    expect(loadedAsChatPage('https://x.test/chat')).toBe(true);
    expect(loadedAsChatPage('https://x.test/chat/?attach=1')).toBe(true);
    expect(loadedAsChatPage('https://x.test/budget')).toBe(false);
    expect(loadedAsChatPage('https://x.test/')).toBe(false);
  });
});

describe('controls', () => {
  it('opens a file chooser when ready, and otherwise reloads the chat', () => {
    expect(renderToStaticMarkup(<AttachButton ready busy={false} onFile={noop} />)).toContain('type="file"');
    const link = renderToStaticMarkup(<AttachButton ready={false} busy={false} onFile={noop} />);
    expect(link).toContain('href="/chat?attach=1"');
    expect(link).not.toContain('type="file"');
  });
  it('names the sheet as text and offers to hide or detach it', () => {
    const html = renderToStaticMarkup(<SheetBar sheet={info} ready open busy={false} error={null} hint={false} onToggle={noop} onDetach={noop} />);
    expect(html).not.toContain('<b>');
    expect(html).toContain('Hide sheet');
    expect(html).toContain('Detach');
    expect(renderToStaticMarkup(<SheetBar sheet={null} ready open busy={false} error={null} hint={false} onToggle={noop} onDetach={noop} />)).toBe('');
  });
  it('frames the sheet page, and hides without unloading it', () => {
    const html = renderToStaticMarkup(<SheetSide sheet={info} hidden />);
    expect(html).toContain('src="/budget/sheet-frame?id=a"');
    expect(html).toContain('hidden=""');
  });
});

describe('useChatSheet', () => {
  let root: Root | null = null;
  afterEach(() => { act(() => root?.unmount()); vi.useRealTimers(); });

  async function mount(conversationId: string | null, client: Parameters<typeof useChatSheet>[2], ensure = () => 'chat-new') {
    const seen: { now: ChatSheet | null } = { now: null };
    const convert = vi.fn(async () => ({ sheets: {} }));
    function Probe() { seen.now = useChatSheet(conversationId, ensure, client, convert); return null; }
    root = createRoot(document.createElement('div'));
    await act(async () => root!.render(<Probe />));
    return { seen, convert };
  }

  it('finds the sheet already attached to the chat', async () => {
    const client = { attached: vi.fn(async () => info), create: vi.fn(), detach: vi.fn() };
    const { seen } = await mount('chat-1', client);
    expect(client.attached).toHaveBeenCalledWith('chat-1');
    expect(seen.now!.sheet).toEqual(info);
  });

  it('attaches to a new chat, then detaches, keeping the grid a moment', async () => {
    const client = { attached: vi.fn(async () => null), create: vi.fn(async () => ({ ...info, workbook: {} })), detach: vi.fn(async () => {}) };
    const { seen } = await mount(null, client);
    expect(client.attached).not.toHaveBeenCalled();
    await act(() => seen.now!.add(new File(['a,b'], 'Home.csv')));
    expect(client.create).toHaveBeenCalledWith('Home', { sheets: {} }, 'chat-new');
    expect(seen.now!.sheet?.id).toBe('a');
    act(() => root!.unmount());

    const attached = { attached: vi.fn(async () => info), create: vi.fn(), detach: vi.fn(async () => {}) };
    const second = await mount('chat-1', attached);
    vi.useFakeTimers();
    await act(() => second.seen.now!.detach());
    expect(attached.detach).toHaveBeenCalledWith('chat-1');
    expect(second.seen.now!.sheet).toBeNull();
    expect(second.seen.now!.leaving).toEqual(info);
    await act(async () => { vi.advanceTimersByTime(DETACH_SETTLE_MS); });
    expect(second.seen.now!.leaving).toBeNull();
  });

  it('refuses the wrong kind of file before converting it', async () => {
    const client = { attached: vi.fn(async () => null), create: vi.fn(), detach: vi.fn() };
    const { seen, convert } = await mount(null, client);
    await act(() => seen.now!.add(new File(['x'], 'old.xls')));
    expect(seen.now!.error).toContain('.xlsx');
    expect(convert).not.toHaveBeenCalled();
    expect(client.create).not.toHaveBeenCalled();
  });
});

describe('sheet client', () => {
  it('sends the chat id when attaching, and encodes it when looking up', async () => {
    const seen: Array<[string, string | undefined, unknown]> = [];
    const client = createSheetClient(async (path, init) => {
      seen.push([path, init?.method, init?.body ? JSON.parse(init.body as string) : undefined]);
      return new Response(JSON.stringify({ sheet: null }));
    });
    await client.create('n', {}, 'c 1');
    await client.attached('c 1');
    await client.detach('c 1');
    expect(seen).toEqual([
      ['/api/budget/sheets', 'POST', { name: 'n', workbook: {}, conversationId: 'c 1' }],
      ['/api/budget/sheets/attached?conversationId=c%201', 'GET', undefined],
      ['/api/budget/sheets/attached?conversationId=c%201', 'DELETE', undefined],
    ]);
  });
});
