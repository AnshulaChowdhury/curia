// ActivityFeed — "what's been happening?": what Curia did in the last 24 hours,
// one line per job (GET /api/activity?from=<now-24h>&limit=20, #2251). Each item
// is already in words ("drafted a reply to John Doe"); the card adds the time in
// the principal's timezone (earlier days under a day row), a muted agent name, and a link to the job or a replay
// of the conversation.

import { Fragment } from 'react';
import { Link } from '@tanstack/react-router';
import {
  activityHref,
  agentLabel,
  fetchActivity,
  formatActivityTime,
  groupActivityByDay,
  type ActivityItem,
} from './dashboard-utils.js';
import { useAsyncData } from './useAsyncData.js';

function autonomyNote(item: ActivityItem): string | null {
  if (item.autonomy === 'approved') return 'approved';
  if (item.autonomy === 'autonomous') return 'autonomous';
  return null;
}

function Headline({ item }: { item: ActivityItem }) {
  const href = activityHref(item.link);
  if (href && item.link?.kind === 'job') {
    return <Link to="/jobs/$jobId" params={{ jobId: item.link.jobId }} className="dash-activity-headline">{item.headline}</Link>;
  }
  if (href) return <a href={href} className="dash-activity-headline">{item.headline}</a>;
  return <span className="dash-activity-headline">{item.headline}</span>;
}

export function ActivityFeed() {
  const { data, error, loading, retry } = useAsyncData(fetchActivity);

  return (
    <article className="dash-card">
      <div className="dash-card-head">
        <span className="dash-card-title">Recent activity</span>
      </div>

      {loading && !data && !error && <div className="dash-card-quiet">Loading…</div>}

      {error && (
        <div className="dash-alert danger">
          <div className="dash-alert-title">Activity unavailable</div>
          <div className="dash-alert-body">{error}</div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={retry}>Retry</button>
        </div>
      )}

      {data && data.items.length === 0 && (
        <div className="dash-card-quiet">No recent activity yet.</div>
      )}

      {data && data.items.length > 0 && (
        <div className="dash-activity">
          {groupActivityByDay(data.items, data.timezone).map(group => (
            <Fragment key={group.key}>
              {group.label && <div className="dash-activity-day">{group.label}</div>}
              {group.items.map(item => {
                const note = autonomyNote(item);
                return (
                  <div key={item.id} className={`dash-activity-item ${item.outcome === 'success' ? '' : item.outcome}`}>
                    <span className="dash-activity-time">{formatActivityTime(item.ts, data.timezone)}</span>
                    <div className="dash-activity-text">
                      <Headline item={item} />
                      <span className="dash-activity-meta">
                        {agentLabel(item.actor)}{note ? ` · ${note}` : ''}
                        {item.outcome === 'partial' && <span className="dash-activity-partial"> · partly failed</span>}
                      </span>
                      {item.details.length > 0 && (
                        <ul className="dash-activity-details">
                          {item.details.map((d, i) => (
                            <li key={i} className={`dash-activity-detail ${d.startsWith("couldn't") ? 'failed' : ''}`}>{d}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                );
              })}
            </Fragment>
          ))}
          {data.hasMore && (
            <div className="dash-card-quiet dash-activity-more">
              Showing the latest {data.items.length}. <a href="/antfarm/">Replay the full day in the Ant Farm</a>.
            </div>
          )}
        </div>
      )}
    </article>
  );
}
