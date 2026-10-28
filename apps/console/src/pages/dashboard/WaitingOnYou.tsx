// Waiting on you — overdue tasks and held approvals (#2340).
//
// Dismiss and Mark done wait UNDO_WINDOW_MS before they hit the server, so Undo
// reverses them by cancelling the commit. Approve runs immediately and cannot
// be undone. A failed card stays an error: it never becomes "all caught up".

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ACT_DONE_MS,
  caughtUpDetail,
  fetchWaiting,
  heldMeta,
  orderWaitingItems,
  overdueMeta,
  postDashboard,
  scheduleUndoCommit,
  showCaughtUp,
  type UndoCommit,
  type WaitingApproval,
  type WaitingRow,
  type WaitingTask,
} from './dashboard-utils.js';
import { useAsyncData } from './useAsyncData.js';

interface WaitingOnYouProps {
  onVisibleCount: (count: number | null) => void;
  onTimezone: (zone: string) => void;
}

interface ToastState {
  key: string;
  message: string;
  onUndo?: () => void;
}

function rowKey(row: WaitingRow): string {
  return row.kind === 'task' ? `task:${row.id}` : `approval:${row.id}`;
}

export function WaitingOnYou({ onVisibleCount, onTimezone }: WaitingOnYouProps) {
  const { data, error, loading, retry } = useAsyncData(fetchWaiting);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [done, setDone] = useState<Set<string>>(() => new Set());
  const [reviewId, setReviewId] = useState<number | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [extraCleared, setExtraCleared] = useState(0);
  const [toast, setToast] = useState<ToastState | null>(null);

  const pending = useRef(new Map<string, UndoCommit>());
  const hideTimers = useRef(new Map<string, number>());
  const mounted = useRef(true);

  const visible = useMemo(() => {
    if (!data) return [];
    return orderWaitingItems(data.tasks, data.approvals).filter((row) => !hidden.has(rowKey(row)));
  }, [data, hidden]);

  useEffect(() => {
    mounted.current = true;
    const timers = hideTimers.current;
    const commits = pending.current;
    const flush = () => {
      for (const commit of commits.values()) commit.flush();
      commits.clear();
    };
    window.addEventListener('pagehide', flush);
    return () => {
      mounted.current = false;
      window.removeEventListener('pagehide', flush);
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
      flush();
    };
  }, []);

  useEffect(() => {
    if (pending.current.size > 0) return;
    setHidden(new Set());
    setDone(new Set());
    setExtraCleared(0);
    setReviewId(null);
  }, [data]);

  useEffect(() => {
    if (error) {
      onVisibleCount(null);
      return;
    }
    if (!data) {
      onVisibleCount(null);
      return;
    }
    onVisibleCount(visible.length);
    onTimezone(data.timezone);
  }, [data, error, visible.length, onVisibleCount, onTimezone]);

  useEffect(() => {
    if (!toast || toast.onUndo) return;
    const timer = window.setTimeout(() => setToast(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function unhide(key: string) {
    const timer = hideTimers.current.get(key);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      hideTimers.current.delete(key);
    }
    setHidden((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setDone((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }

  function armUndo(key: string, path: string, message: string) {
    setExtraCleared((n) => n + 1);
    const handle = scheduleUndoCommit(() => {
      pending.current.delete(key);
      if (mounted.current) setToast((current) => (current?.key === key ? null : current));
      void postDashboard(path).catch((err: unknown) => {
        if (!mounted.current) return;
        unhide(key);
        setExtraCleared((n) => Math.max(0, n - 1));
        const text = err instanceof Error ? err.message : 'Could not save that change';
        setToast({ key: `${key}:err`, message: text });
      });
    });
    pending.current.set(key, handle);
    setToast({
      key,
      message,
      onUndo: () => {
        handle.cancel();
        pending.current.delete(key);
        unhide(key);
        setExtraCleared((n) => Math.max(0, n - 1));
        setToast(null);
      },
    });
  }

  function dismiss(key: string, path: string) {
    if (pending.current.has(key) || hidden.has(key)) return;
    setHidden((prev) => new Set(prev).add(key));
    setReviewId(null);
    armUndo(key, path, 'Dismissed');
  }

  function markDone(row: WaitingTask) {
    const key = `task:${row.id}`;
    if (pending.current.has(key)) return;
    setDone((prev) => new Set(prev).add(key));
    armUndo(key, `/api/dashboard/tasks/${encodeURIComponent(row.id)}/done`, 'Marked done');
    const timer = window.setTimeout(() => {
      hideTimers.current.delete(key);
      if (!mounted.current || !pending.current.has(key)) return;
      setHidden((prev) => new Set(prev).add(key));
    }, ACT_DONE_MS);
    hideTimers.current.set(key, timer);
  }

  async function approve(row: WaitingApproval) {
    const key = `approval:${row.id}`;
    if (busyKey) return;
    setBusyKey(key);
    try {
      const body = await postDashboard(`/api/dashboard/approvals/${row.id}/approve`);
      setHidden((prev) => new Set(prev).add(key));
      setExtraCleared((n) => n + 1);
      setReviewId(null);
      const sent = body['sent'] === true;
      setToast({
        key,
        message: sent ? 'Approved & sent' : "Approved, but it didn't go out.",
      });
    } catch (err: unknown) {
      setToast({ key, message: err instanceof Error ? err.message : 'Could not approve' });
    } finally {
      setBusyKey(null);
    }
  }

  const caughtUp = showCaughtUp({
    loaded: data !== null,
    error,
    count: visible.length,
  });
  const now = new Date();

  return (
    <article className="dash-card dash-waiting">
      {!caughtUp && (
        <div className="dash-card-head">
          <span className="dash-card-title">Waiting on you</span>
          {data && error === null && <span className="dash-count">{visible.length}</span>}
        </div>
      )}

      {loading && !data && !error && <div className="dash-card-quiet">Loading…</div>}

      {error && (
        <div className="dash-alert danger">
          <div className="dash-alert-title">Couldn’t load what’s waiting</div>
          <div className="dash-alert-body">{error}</div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={retry}>Retry</button>
        </div>
      )}

      {data && caughtUp && (
        <div className="dash-caught">
          <span className="dash-caught-check" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          </span>
          <div>
            <strong>All caught up</strong>
            <span className="dash-caught-detail">
              {' · '}
              {caughtUpDetail(data.clearedToday + extraCleared, data.curiaHandling)}
            </span>
          </div>
        </div>
      )}

      {data && !caughtUp && visible.map((row) => {
        const key = rowKey(row);
        const striking = done.has(key);
        const meta = row.kind === 'task'
          ? overdueMeta(row.dueAt, now, data.timezone)
          : heldMeta(row.createdAt, now, row.toolName === 'send-draft');
        const dot = row.kind === 'task' ? 'var(--app-destructive)' : 'var(--app-amber)';
        return (
          <div key={key} className={`dash-wait-item${striking ? ' done' : ''}`}>
            <span className="dash-wait-dot" style={{ background: dot }} />
            <div className="dash-wait-main">
              <div className="dash-wait-title">{row.title}</div>
              <div className="dash-wait-meta">{meta}</div>
              {row.kind === 'approval' && reviewId === row.id && (
                <div className="dash-review">
                  <p>{row.summary || 'Held for your approval.'}</p>
                  <div className="dash-review-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={busyKey === key}
                      onClick={() => void approve(row)}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={busyKey === key}
                      onClick={() => dismiss(key, `/api/dashboard/approvals/${row.id}/deny`)}
                    >
                      Discard
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="dash-wait-acts">
              {row.kind === 'task' ? (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={striking}
                  onClick={() => markDone(row)}
                >
                  Mark done
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  aria-expanded={reviewId === row.id}
                  onClick={() => setReviewId((current) => (current === row.id ? null : row.id))}
                >
                  Review
                </button>
              )}
              <button
                type="button"
                className="dash-x"
                aria-label="Dismiss"
                onClick={() => dismiss(
                  key,
                  row.kind === 'task'
                    ? `/api/dashboard/tasks/${encodeURIComponent(row.id)}/cancel`
                    : `/api/dashboard/approvals/${row.id}/deny`,
                )}
              >
                ×
              </button>
            </div>
          </div>
        );
      })}

      {toast && (
        <div className="dash-toast" role="status">
          <span>{toast.message}</span>
          {toast.onUndo && (
            <button type="button" onClick={toast.onUndo}>Undo</button>
          )}
        </div>
      )}
    </article>
  );
}
