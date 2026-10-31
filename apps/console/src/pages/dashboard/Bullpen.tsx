// Compact bullpen link. The count is in-flight agent.task roots from the last
// few minutes. When that query can't be trusted, the card keeps static copy
// and never invents a number.
//
// LimeZu attribution (a license condition of the floor-plan art) is satisfied
// by this card linking to /antfarm/, whose footer credits the packs
// (apps/antfarm/CREDITS.md).

import { agentLabel, fetchBullpen } from './dashboard-utils.js';
import { useAsyncData } from './useAsyncData.js';

export function Bullpen() {
  const { data, error, loading, retry } = useAsyncData(fetchBullpen);
  const live = data?.available === true;

  let title = 'Watch the bullpen work →';
  let detail = 'Every agent, task and hand-off, on a live floor plan.';
  if (live && data) {
    const noun = data.count === 1 ? 'agent' : 'agents';
    title = `${data.count} ${noun} working right now →`;
    detail = data.agents.length > 0
      ? data.agents.map((agent) => agentLabel(agent)).join(' · ')
      : 'No agents are mid-task.';
  }

  return (
    <div className="dash-bullpen-wrap">
      <a href="/antfarm/" className="dash-card dash-bullpen">
        <div className="dash-card-title">{live ? 'Bullpen · live' : 'Bullpen'}</div>
        {loading && !data && !error && <div className="dash-bullpen-title">Checking the floor…</div>}
        {(data || error) && (
          <>
            <div className="dash-bullpen-title">{title}</div>
            <div className="dash-bullpen-sub">{detail}</div>
          </>
        )}
      </a>
      {error && (
        <button type="button" className="btn btn-secondary btn-sm dash-bullpen-retry" onClick={retry}>Retry</button>
      )}
    </div>
  );
}
