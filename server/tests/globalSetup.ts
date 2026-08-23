/**
 * vitest globalSetup — runs ONCE in the main process before any test file
 * forks (vitest.config.ts: `globalSetup`). Boots a single postgres:16-alpine
 * container and applies every `db/migrations/*.up.sql` file once into a
 * template database. Forked test files (tests/helpers/pg.ts) then clone that
 * template per file via `CREATE DATABASE ... TEMPLATE`, which is orders of
 * magnitude faster than booting a container and replaying ~91 migrations per
 * file. Connection info reaches the forks through vitest's provide/inject
 * (not env vars — that's the officially supported channel for globalSetup ->
 * worker data and avoids depending on fork env-inheritance timing).
 */
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { Pool } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import type { TestProject } from 'vitest/node';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');
const TEMPLATE_DB = 'kmtemplate';
const ADMIN_DB = 'postgres';
const PG_USER = 'testuser';
const PG_PASSWORD = 'testpass';

export interface PgBaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  adminDb: string;
  templateDb: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    kmTestPgBase: PgBaseConfig;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const container: StartedTestContainer = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_PASSWORD: PG_PASSWORD,
      POSTGRES_USER: PG_USER,
      POSTGRES_DB: 'kmtest',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/i, 2))
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);

  // Create the template database, then apply every migration into it once.
  const adminPool = new Pool({ host, port, user: PG_USER, password: PG_PASSWORD, database: ADMIN_DB, max: 1 });
  try {
    await adminPool.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  } finally {
    await adminPool.end();
  }

  const templatePool = new Pool({ host, port, user: PG_USER, password: PG_PASSWORD, database: TEMPLATE_DB, max: 1 });
  try {
    await applyMigrations(templatePool);
  } finally {
    // `CREATE DATABASE ... TEMPLATE` fails while any connection is open
    // against the template database, so every connection against it must be
    // closed before forked test files start cloning it.
    await templatePool.end();
  }

  project.provide('kmTestPgBase', {
    host,
    port,
    user: PG_USER,
    password: PG_PASSWORD,
    adminDb: ADMIN_DB,
    templateDb: TEMPLATE_DB,
  });

  return async () => {
    await container.stop();
  };
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
