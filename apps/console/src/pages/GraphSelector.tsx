import { useNavigate } from '@tanstack/react-router';

/** Switches the Knowledge Graph page between the memory graph and the accounting rules graph. */
export function GraphSelector({ current }: { current: 'memory' | 'accounting' }) {
  const navigate = useNavigate();
  const go = (graph: 'memory' | 'accounting') => {
    if (graph === current) return;
    navigate({ to: '/kg', search: { q: undefined, node: undefined, graph: graph === 'accounting' ? 'accounting' : undefined } }).catch((err: unknown) => {
      console.error('[GraphSelector] navigation failed:', err);
    });
  };
  return (
    <div className="kg-graph-switch" role="group" aria-label="Graph">
      <button type="button" className={current === 'memory' ? 'active' : ''} aria-pressed={current === 'memory'} onClick={() => go('memory')}>
        Memory
      </button>
      <button type="button" className={current === 'accounting' ? 'active' : ''} aria-pressed={current === 'accounting'} onClick={() => go('accounting')}>
        Accounting
      </button>
    </div>
  );
}
