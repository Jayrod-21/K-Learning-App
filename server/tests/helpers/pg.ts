/**
 * testcontainers helper — boots a real Postgres for integration tests.
 *
 * Bar §"Testing": "Integration tests against a real Postgres in Docker. No
 * SQLite stand-in." Each test file gets one container shared across its
 * tests; the suite tears it down on completion.
 */
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { Pool } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../db/migrations');

export interface PgHandle {
  container: StartedTestContainer;
  pool: Pool;
  connectionString: string;
}

export async function startPostgres(): Promise<PgHandle> {
  const container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_PASSWORD: 'testpass',
      POSTGRES_USER: 'testuser',
      POSTGRES_DB: 'kmtest',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/i, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const connectionString = `postgres://testuser:testpass@${host}:${port}/kmtest`;
  const pool = new Pool({ connectionString, max: 5 });

  await applyMigrations(pool);
  return { container, pool, connectionString };
}

async function applyMigrations(pool: Pool): Promise<void> {
  // Apply *.up.sql in numeric order. Each file runs inside its own
  // transaction so a failure leaves earlier migrations applied.
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.up.sql'))
    .sort();
  for (const file of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      // eslint-disable-next-line no-console
      console.error(`Migration ${file} failed:`, err);
      throw err;
    } finally {
      client.release();
    }
  }
}

export async function stopPostgres(handle: PgHandle): Promise<void> {
  try {
    await handle.pool.end();
  } finally {
    await handle.container.stop();
  }
}
