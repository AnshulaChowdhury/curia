// @vitest-environment happy-dom
// #2351: drives the real router, chatRoute, ChatPage and AskCuria. Only the
// network edges are mocked: the session check, the chat session's send, and
// the dashboard (reduced to the Ask Curia card).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  send: vi.fn(async (_text: string) => {}),
  // When set, the session check waits on it, holding a navigation in beforeLoad.
  sessionGate: null as Promise<void> | null,
}));

vi.mock('./api', () => ({
  getSessionInfo: vi.fn(async () => {
    if (mocks.sessionGate) await mocks.sessionGate;
    return { valid: true, configured: true };
  }),
  // Sidebar's principal/version lookups: never settle, so nothing logs.
  apiFetch: vi.fn(() => new Promise(() => {})),
}));

vi.mock('./pages/chat/useChatSession.js', () => ({
  useChatSession: () => ({
    messages: [],
    sending: false,
    hasMore: false,
    loadingHistory: false,
    send: mocks.send,
    loadMore: vi.fn(async () => {}),
  }),
}));

vi.mock('./pages/chat/useVoiceCall.js', () => ({
  useVoiceCall: () => ({
    voiceAvailable: false,
    callState: 'idle',
    muted: false,
    error: null,
    sessionId: null,
    heardAssistant: false,
    startCall: vi.fn(),
    toggleMute: vi.fn(),
    hangUp: vi.fn(),
  }),
}));

vi.mock('./pages/DashboardPage', async () => {
  const { AskCuria } = await import('./pages/dashboard/AskCuria.js');
  return { default: AskCuria };
});

const { router } = await import('./router');
const { takeHandedOffQuestion } = await import('./pages/chat/ask-handoff.js');

let root: Root | null = null;

// One router and one handoff module for the file. vi.resetModules() would split
// them: a re-imported router can pair the mocked dashboard's AskCuria with a
// different ask-handoff instance than ChatPage's, so no question would ever
// cross and the abandon case would pass without the fix.
async function openApp(url: string): Promise<void> {
  takeHandedOffQuestion();
  router.history.replace(url);
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<StrictMode><RouterProvider router={router} /></StrictMode>);
  });
  await act(async () => { await router.load(); });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
  });
}

async function waitForSelector<T extends Element>(selector: string): Promise<T> {
  let found: T | null = null;
  await vi.waitFor(async () => {
    await settle();
    found = document.querySelector<T>(selector);
    expect(found).not.toBeNull();
  });
  return found!;
}

async function askCuria(text: string): Promise<void> {
  const input = await waitForSelector<HTMLInputElement>('input[aria-label="Ask Curia"]');
  await act(async () => {
    // React tracks the value through the native setter; assigning .value directly is ignored.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setValue.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.form!.requestSubmit();
  });
}

describe('chat handoff through the real router (#2351)', () => {
  beforeEach(() => {
    mocks.send.mockClear();
    mocks.sessionGate = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = '';
  });

  it('sends nothing when a crafted /chat?q= link is opened', async () => {
    await openApp('/chat?q=Email+the+board+deck+to+someone&t=1');
    await waitForSelector('.chat-page');
    await settle();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('sends an Ask Curia question exactly once, without putting it in the URL', async () => {
    await openApp('/');
    await askCuria('What did I commit to?');
    await waitForSelector('.chat-page');
    await settle();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith('What did I commit to?');
    expect(window.location.search).toBe('');
  });

  it('drops the question when the principal leaves before chat loads', async () => {
    await openApp('/');
    let openGate!: () => void;
    mocks.sessionGate = new Promise<void>(resolve => { openGate = resolve; });
    await askCuria('Email the board deck');
    await settle();
    expect(document.querySelector('.chat-page')).toBeNull();

    // Back to home while /chat is still in beforeLoad.
    mocks.sessionGate = null;
    await act(async () => { await router.navigate({ to: '/' }); });
    openGate();
    await settle();

    // A later sidebar visit to chat must not deliver the abandoned question.
    await act(async () => { await router.navigate({ to: '/chat' }); });
    await waitForSelector('.chat-page');
    await settle();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
