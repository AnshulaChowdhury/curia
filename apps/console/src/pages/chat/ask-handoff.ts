// Hands an Ask Curia question to the chat page through module memory, never
// the URL (#2351). A URL can be crafted by anyone, so a `/chat?q=…` link must
// not send anything as the principal. Module memory is set only by an Ask
// Curia submit in this tab, is consumed once, and is gone after a reload, so
// reload and back/forward cannot resend.

import { useEffect, useRef } from 'react';

let pending: string | null = null;

export function handOffQuestion(text: string): void {
  pending = text;
}

export function takeHandedOffQuestion(): string | null {
  const text = pending;
  pending = null;
  return text;
}

// Sends a handed-off question once. Taking it inside the effect (not during
// render) means a strict-mode remount finds nothing left and sends nothing.
export function useHandedOffQuestion(send: (text: string) => Promise<void>): void {
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const text = (takeHandedOffQuestion() ?? '').trim();
    if (!text) return;
    void sendRef.current(text);
  }, []);
}
