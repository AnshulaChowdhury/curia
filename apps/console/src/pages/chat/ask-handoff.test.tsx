// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { handOffQuestion, takeHandedOffQuestion, useHandedOffQuestion } from './ask-handoff.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Chat({ send }: { send: (text: string) => Promise<void> }) {
  useHandedOffQuestion(send);
  return null;
}

let root: Root | null = null;

async function openChat(send: (text: string) => Promise<void>): Promise<void> {
  root?.unmount();
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root!.render(<StrictMode><Chat send={send} /></StrictMode>);
  });
}

describe('Ask Curia handoff (#2351)', () => {
  beforeEach(() => {
    takeHandedOffQuestion();
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    window.history.replaceState(null, '', '/');
  });

  it('sends nothing for a crafted /chat?q= link', async () => {
    window.history.replaceState(null, '', '/chat?q=Email+the+board+deck&t=1');
    const send = vi.fn(async () => {});
    await openChat(send);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends a handed-off question exactly once under strict mode', async () => {
    handOffQuestion('What did I commit to?');
    const send = vi.fn(async () => {});
    await openChat(send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('What did I commit to?');
  });

  it('sends the same question again when asked again', async () => {
    const send = vi.fn(async () => {});
    handOffQuestion('Same question');
    await openChat(send);
    handOffQuestion('Same question');
    await openChat(send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not resend when the chat page is opened again without a new ask', async () => {
    const send = vi.fn(async () => {});
    handOffQuestion('Once only');
    await openChat(send);
    await openChat(send);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
