// Hands an Ask Curia question to the chat page through module memory, never
// the URL (#2351). A URL can be crafted by anyone, so a `/chat?q=…` link must
// not send anything as the principal. Module memory is set only by an Ask
// Curia submit in this tab, is consumed once, and is gone after a reload, so
// reload and back/forward cannot resend.
//
// The question belongs to the navigation that Ask Curia starts. If the
// principal ends up anywhere but /chat first (sidebar, back, a second click
// while the session check or the lazy ChatPage chunk is still loading), the
// router reports that location and the question is dropped, so a later /chat
// visit cannot send it. router.tsx wires noteResolvedPath to `onResolved`;
// this module can't import the router, because the router lazy-loads ChatPage,
// which imports this file.

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

export function noteResolvedPath(pathname: string): void {
  if (pathname !== '/chat') pending = null;
}

// Sends a handed-off question once. Taking it inside the effect (not during
// render) means a strict-mode remount finds nothing left and sends nothing.
// ChatPage mounts with a fresh useChatSession, so its in-flight guard cannot
// discard the text taken here.
export function useHandedOffQuestion(send: (text: string) => Promise<void>): void {
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const text = (takeHandedOffQuestion() ?? '').trim();
    if (!text) return;
    void sendRef.current(text);
  }, []);
}
