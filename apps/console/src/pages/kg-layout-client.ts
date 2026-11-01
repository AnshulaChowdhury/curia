// Runs Knowledge Graph layouts in a Web Worker (ADR-058), falling back to the main thread
// when a worker cannot be created (old browsers, tests) or has crashed.

import { computeLayout } from './kg-layout.js';
import type { LayoutRequest, LayoutResponse } from './kg-layout.js';

export interface LayoutClient {
  run(req: LayoutRequest): Promise<LayoutResponse>;
  dispose(): void;
}

export function createLayoutClient(): LayoutClient {
  let worker: Worker | null = null;
  const pending = new Map<number, (res: LayoutResponse) => void>();

  const runLocally = (req: LayoutRequest): LayoutResponse => {
    try {
      return computeLayout(req);
    } catch (err) {
      console.error('[kg-layout-client] layout failed:', err);
      return { seq: req.seq, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  if (typeof Worker !== 'undefined') {
    try {
      worker = new Worker(new URL('./kg-layout.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<LayoutResponse>) => {
        const resolve = pending.get(e.data.seq);
        pending.delete(e.data.seq);
        resolve?.(e.data);
      };
      worker.onerror = (e) => {
        // The worker is unusable: stop using it and answer anything in flight with an error;
        // later layouts run on the main thread.
        console.error('[kg-layout-client] layout worker failed; using the main thread:', e.message);
        worker?.terminate();
        worker = null;
        for (const [seq, resolve] of pending) resolve({ seq, ok: false, error: 'Layout worker failed' });
        pending.clear();
      };
    } catch (err) {
      console.error('[kg-layout-client] could not start the layout worker; using the main thread:', err);
      worker = null;
    }
  }

  return {
    run(req) {
      if (!worker) return Promise.resolve(runLocally(req));
      const w = worker;
      return new Promise(resolve => {
        pending.set(req.seq, resolve);
        w.postMessage(req);
      });
    },
    dispose() {
      worker?.terminate();
      worker = null;
      for (const [seq, resolve] of pending) resolve({ seq, ok: false, error: 'Layout cancelled' });
      pending.clear();
    },
  };
}
