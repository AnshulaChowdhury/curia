// Web Worker for the Knowledge Graph layout (ADR-058): runs the force simulation off the
// main thread and posts every node's final position back in one message.

import { computeLayout } from './kg-layout.js';
import type { LayoutRequest, LayoutResponse } from './kg-layout.js';

// The console's tsconfig uses the DOM lib, whose `self` is a Window; type the worker scope by hand.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<LayoutRequest>) => void) | null;
  postMessage: (msg: LayoutResponse) => void;
};

scope.onmessage = (e) => {
  try {
    scope.postMessage(computeLayout(e.data));
  } catch (err) {
    console.error('[kg-layout.worker] layout failed:', err);
    scope.postMessage({ seq: e.data.seq, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
