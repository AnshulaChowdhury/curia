// The instance lock: a session-level Postgres advisory lock that a running Curia holds for
// its whole life (ADR-051). Maintenance commands that rewrite data a live process also
// writes, such as `pnpm reembed:kg`, take the same lock first and refuse to run while
// Curia holds it. Postgres releases a session lock when its connection ends, so a crashed
// process never leaves it held.
import type { DbPool, DbPoolClient } from './connection.js';
import type { Logger } from '../logger.js';

// The two-key form of pg_try_advisory_lock, so pg_locks shows the pair as classid/objid
// and the holder can be named. The pair spells "CURI" and 1; nothing else in Curia takes
// a session-level advisory lock.
export const INSTANCE_LOCK_KEYS = [0x43555249, 1] as const;

/** application_name a running Curia sets on its connections, so the lock holder is nameable. */
export const CURIA_APPLICATION_NAME = 'curia';

/** application_name `pnpm reembed:kg` sets, so the schema gate can tell it is running. */
export const REEMBED_APPLICATION_NAME = 'curia-reembed-kg';

export interface InstanceLockHolder {
  pid: number;
  applicationName: string | null;
  clientAddr: string | null;
  backendStart: Date | null;
}

export type InstanceLockResult =
  | { acquired: true; release: () => Promise<void> }
  | { acquired: false; holder: InstanceLockHolder | undefined };

/**
 * Takes the instance lock on a client checked out of `pool` and keeps that client until
 * `release()`. When another session holds the lock, returns who holds it instead.
 * `onLost` runs once if the connection ends before `release()`, taking the lock with it.
 */
export async function tryAcquireInstanceLock(
  pool: DbPool,
  logger: Logger,
  onLost?: () => void,
): Promise<InstanceLockResult> {
  const client = await pool.connect();
  let keep = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [...INSTANCE_LOCK_KEYS],
    );
    if (!rows[0]?.locked) {
      return { acquired: false, holder: await findInstanceLockHolder(pool) };
    }
    keep = true;
    let released = false;
    // A checked-out client has no pool error listener; without this one a dropped
    // connection would crash the process. The lock goes with the connection.
    client.on('error', (err) => {
      logger.warn({ err }, 'Instance lock connection error');
    });
    client.once('end', () => {
      if (released) return;
      released = true;
      client.release(new Error('Instance lock connection ended'));
      onLost?.();
    });
    return {
      acquired: true,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await client.query('SELECT pg_advisory_unlock($1, $2)', [...INSTANCE_LOCK_KEYS]);
        } catch (err) {
          // Destroy the connection rather than pool it still holding the lock.
          client.release(err instanceof Error ? err : new Error(String(err)));
          throw err;
        }
        client.release();
      },
    };
  } finally {
    if (!keep) client.release();
  }
}

/** The session holding the instance lock, or undefined when none does. */
export async function findInstanceLockHolder(pool: DbPool | DbPoolClient): Promise<InstanceLockHolder | undefined> {
  const { rows } = await pool.query<{
    pid: number;
    application_name: string | null;
    client_addr: string | null;
    backend_start: Date | null;
  }>(
    `SELECT l.pid, a.application_name, host(a.client_addr) AS client_addr, a.backend_start
       FROM pg_locks l
       LEFT JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory'
        AND l.granted
        AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND l.classid::bigint = $1
        AND l.objid::bigint = $2
        AND l.objsubid = 2`,
    [...INSTANCE_LOCK_KEYS],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    pid: row.pid,
    applicationName: row.application_name,
    clientAddr: row.client_addr,
    backendStart: row.backend_start,
  };
}

export function describeInstanceLockHolder(holder: InstanceLockHolder | undefined): string {
  if (!holder) return 'another session (it released the lock before it could be named)';
  const name = holder.applicationName ? `"${holder.applicationName}"` : 'an unnamed client';
  const from = holder.clientAddr ? ` from ${holder.clientAddr}` : '';
  const since = holder.backendStart ? `, connected ${holder.backendStart.toISOString()}` : '';
  return `${name} (pid ${holder.pid}${from}${since})`;
}

/**
 * Boot's use of the lock. A held lock is logged and boot continues, because refusing would
 * block a restart whenever an old connection lingers. The lock is taken once; if its
 * connection drops, it stays dropped until Curia restarts.
 */
export async function holdInstanceLock(pool: DbPool, logger: Logger): Promise<() => Promise<void>> {
  let result: InstanceLockResult;
  try {
    result = await tryAcquireInstanceLock(pool, logger, () => {
      logger.error(
        'Instance lock lost with its database connection. Maintenance commands such as pnpm reembed:kg can now run beside this process. Restart Curia to take the lock again.',
      );
    });
  } catch (err) {
    logger.warn({ err }, 'Could not take the instance lock; continuing without it');
    return async () => {};
  }
  if (!result.acquired) {
    logger.warn(
      { holder: result.holder },
      `Instance lock is held by ${describeInstanceLockHolder(result.holder)}. Another Curia, or a maintenance command such as pnpm reembed:kg, may be running against this database. Continuing without the lock.`,
    );
    return async () => {};
  }
  logger.debug('Instance lock held');
  return result.release;
}
