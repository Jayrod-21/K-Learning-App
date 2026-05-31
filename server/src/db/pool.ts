/**
 * Postgres connection pool.
 *
 * Choice: `pg` (node-postgres) over `postgres.js` — see ADR-018.
 * Pool sized via DATABASE_POOL_MAX; statement_timeout enforced per session.
 *
 * Every query goes through the typed helper here (`query`, `withTransaction`)
 * so the rest of the codebase never touches the raw pool. Reasons:
 *   - One place to log slow queries and inject correlation IDs.
 *   - Force parameterized-only API: callers cannot accidentally call
 *     `pool.query(stringConcat)` because they receive a typed wrapper.
 */
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { loadConfig } from '../config/index.js';
import { getLogger } from '../logging.js';

/**
 * A parameterized-query executor returning the rows + a non-null rowCount.
 *
 * Both the module-level `query` helper and a transaction-bound executor (see
 * `withTransaction`'s `tx` argument) satisfy this shape, so a helper that needs
 * to run either standalone OR inside a caller's transaction takes a `Querier`
 * and the caller decides. This is what lets an atomic multi-step operation
 * (e.g. recovery-code spend + challenge consume) share one connection so a
 * later failure rolls the earlier write back.
 */
export type Querier = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: readonly unknown[],
) => Promise<{ rows: T[]; rowCount: number }>;

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (_pool) return _pool;
  const cfg = loadConfig();
  _pool = new Pool({
    connectionString: cfg.DATABASE_URL,
    max: cfg.DATABASE_POOL_MAX,
    application_name: 'korean-master-api',
    statement_timeout: cfg.DATABASE_STATEMENT_TIMEOUT_MS,
    // Optimistic-concurrency / readonly-write split could be added later; for
    // now a single pool is plenty (ADR-001 §D13).
  });
  _pool.on('error', (err) => {
    getLogger().error({ err: serializeError(err) }, 'pg pool unexpected error');
  });
  return _pool;
}

/**
 * Reset the pool (test teardown). Closes existing clients.
 */
export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

/**
 * Replace the pool with one bound to a different connection string.
 * Test-only — production startup creates one pool and keeps it.
 */
export function setPoolForTesting(pool: Pool): void {
  _pool = pool;
}

/**
 * Run a parameterized query. The wrapper exists so the rest of the codebase
 * never touches the raw pool — adds slow-query logging and centralizes the
 * "no string interpolation" rule (callers MUST pass `$1, $2, ...`).
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<{ rows: T[]; rowCount: number }> {
  const pool = getPool();
  const started = process.hrtime.bigint();
  try {
    const result = await pool.query<T>(text, params as unknown[]);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (elapsedMs > 200) {
      getLogger().warn(
        { elapsedMs: Math.round(elapsedMs), sql: text.slice(0, 120) },
        'slow query',
      );
    }
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (err) {
    getLogger().error(
      { err: serializeError(err), sql: text.slice(0, 240) },
      'query failed',
    );
    throw err;
  }
}

/**
 * Run a function inside a transaction. Commits on success, rolls back on throw.
 *
 * Bar: "transactions as short as possible. No external I/O inside an open
 * transaction." — this helper exists to keep that contract loud and visible.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // Surface but don't mask the original error.
      getLogger().error({ err: serializeError(rollbackErr) }, 'rollback failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Adapt a transaction-bound `PoolClient` into the `Querier` shape so a helper
 * written against `Querier` (e.g. `consumeChallenge`) can run inside a caller's
 * transaction on the same connection. Normalizes pg's nullable `rowCount` to 0,
 * matching the module-level `query` helper's contract.
 */
export function clientQuerier(client: PoolClient): Querier {
  return async <T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
  ) => {
    const result = await client.query<T>(text, params as unknown[]);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  };
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      ...(err as unknown as Record<string, unknown>),
    };
  }
  return { value: String(err) };
}
