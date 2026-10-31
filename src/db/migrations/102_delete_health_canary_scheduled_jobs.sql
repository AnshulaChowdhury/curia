-- Up Migration

-- 102_delete_health_canary_scheduled_jobs.sql
--
-- #2229: the health canaries were registered as a scheduled_jobs row targeting agentId
-- 'health-service'. No agent has that name, so the row never ran: stale-job cleanup
-- cancelled it at every boot, and a revived row is failed by the scheduler's unowned-agent
-- check. The canaries now run on their own timer (src/health/canary-schedule.ts) and
-- nothing writes these rows. Delete them so they stop reading as a job that exists.
--
-- References to scheduled_jobs are ON DELETE SET NULL, so no dependent row blocks this.

DELETE FROM scheduled_jobs
 WHERE agent_id = 'health-service';

-- Down Migration

-- Nothing to restore: the rows never ran, and the previous code re-creates one at boot.
SELECT 1;
