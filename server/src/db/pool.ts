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
