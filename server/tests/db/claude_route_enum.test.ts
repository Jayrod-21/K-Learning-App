/**
 * Drift guard: the `claude_route` Postgres enum MUST equal the code's
 * `RouteName` union exactly (C-SF-2 / A-SF-1).
 *
 * Migrations 031 and 032 exist because this enum silently lost sync with
 * `RouteName` (`config.ts`) — every grammar-drill / image-OCR / diagnostic call
 * then failed its `claude_cache` + `claude_usage` write with `invalid input
 * value for enum claude_route`, so those responses were uncached (full paid
 * call each time) and untracked. Both migrations' own headers ask for exactly
 * this test so the drift cannot silently recur.
 *
 * It runs against a FRESH Testcontainers Postgres with `db/migrations/*.up.sql`
 * applied (see `startPostgres`), so it reflects the migration FILES, not a
 * hand-mutated local database. It fails if the enum and `RouteName` diverge in
 * EITHER direction (a value missing from the enum, or an extra value like the
 * `'anon'` bucket-key that 032 must not add).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type PgHandle } from '../helpers/pg.js';
import { ROUTE_NAMES } from '../../src/services/claude/config.js';

let pg: PgHandle;

beforeAll(async () => {
  pg = await startPostgres();
});

afterAll(async () => {
  await stopPostgres(pg);
});

describe('claude_route enum ⇄ RouteName drift guard', () => {
  it('the migrated claude_route enum equals the RouteName union exactly', async () => {
    const { rows } = await pg.pool.query<{ value: string }>(
      `SELECT e::text AS value
         FROM unnest(enum_range(NULL::claude_route)) AS e`,
    );
    const enumValues = rows.map((r) => r.value).sort();
    // ROUTE_NAMES is compile-time-pinned to the RouteName union (config.ts), so
    // it is a trustworthy runtime stand-in for the type.
    const routeNames: string[] = [...ROUTE_NAMES].sort();

    // Explicit both-direction diffs so a failure names the offending value(s)
    // and the required migration, not just "arrays differ".
    const missingFromEnum = routeNames.filter((r) => !enumValues.includes(r));
    const extraInEnum = enumValues.filter((v) => !routeNames.includes(v));

    expect(
      missingFromEnum,
      `RouteName values missing from the claude_route enum — add an ` +
        `ALTER TYPE ... ADD VALUE migration: [${missingFromEnum.join(', ')}]`,
    ).toEqual([]);
    expect(
      extraInEnum,
      `claude_route enum has values that are NOT RouteNames — a migration ` +
        `added a bogus route (e.g. the 'anon' bucket key): [${extraInEnum.join(', ')}]`,
    ).toEqual([]);
    // Belt-and-braces exact-set assertion.
    expect(enumValues).toEqual(routeNames);
  });
});
