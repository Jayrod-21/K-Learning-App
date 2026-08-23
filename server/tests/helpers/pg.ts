/**
 * Per-file test database — clones a pre-migrated template database.
 *
 * Bar §"Testing": "Integration tests against a real Postgres in Docker. No
 * SQLite stand-in." Each test file gets its own database, cloned via
 * `CREATE DATABASE ... TEMPLATE` from `kmtemplate`, so a file's state can
 * never leak into another file's — same isolation guarantee as before, just
 * without re-booting a container and re-running ~91 migrations per file.
 *
 * The shared container is booted once and the template migrated once in
 * `tests/globalSetup.ts`; connection info reaches this (forked) process via
 * vitest's provide/inject, set up there.
 */
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';

export interface PgHandle {
  pool: Pool;
  connectionString: string;
}

// Bookkeeping needed to drop a clone on stopPostgres(), kept off the public
// PgHandle shape so the exported interface stays exactly what tests expect.
const cloneDbNames = new WeakMap<PgHandle, string>();

export async function startPostgres(): Promise<PgHandle> {
  const base = inject('kmTestPgBase');
  const dbName = `kmtest_${randomUUID().replace(/-/g, '')}`;

  const adminPool = new Pool({
    host: base.host,
    port: base.port,
    user: base.user,
    password: base.password,
    database: base.adminDb,
    max: 1,
  });
  try {
    await adminPool.query(`CREATE DATABASE ${dbName} TEMPLATE ${base.templateDb}`);
  } finally {
    await adminPool.end();
  }

  const connectionString = `postgres://${base.user}:${base.password}@${base.host}:${base.port}/${dbName}`;
  const pool = new Pool({ connectionString, max: 5 });

  const handle: PgHandle = { pool, connectionString };
  cloneDbNames.set(handle, dbName);
  return handle;
}

export async function stopPostgres(handle: PgHandle): Promise<void> {
  const dbName = cloneDbNames.get(handle);
  await handle.pool.end();

  // Dropping the clone is tidiness, not correctness — the shared container
  // (and every clone in it) is torn down at global teardown regardless. Best
  // effort only: never fail the test run over cleanup.
  if (!dbName) return;
  try {
    const base = inject('kmTestPgBase');
    const adminPool = new Pool({
      host: base.host,
      port: base.port,
      user: base.user,
      password: base.password,
      database: base.adminDb,
      max: 1,
    });
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } finally {
      await adminPool.end();
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Failed to drop clone database ${dbName} (non-fatal):`, err);
  }
}
