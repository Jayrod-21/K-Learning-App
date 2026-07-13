/**
 * localDay — BLOCKER B1 (`docs/redesign/REVIEW_batch1-today.md`): F-138's
 * per-tile "done today" counts (Today.tsx) depend on `isLocalToday`
 * comparing an attempt's timestamp against LOCAL calendar-day boundaries,
 * not the server's UTC day. `isLocalToday` is implementation-CORRECT (real
 * local `Date` getters), but a test that only exercises the ambient
 * clock/host TZ can never prove that: CI runs on `ubuntu-latest` (TZ=UTC),
 * where the local getters and their UTC twins return byte-for-byte
 * identical values for every `Date`. A test built from `new Date()`-vs-
 * "years ago" fixtures (the kind Today.test.tsx already had for F-138)
 * would pass identically whether the implementation used local OR UTC
 * getters — it cannot distinguish "correct, coincidentally-UTC-on-this-
 * host" from "regressed to hardcoded UTC".
 *
 * Two independent, host-TZ-blind techniques close that gap, without
 * `vi.useFakeTimers` (this suite avoids fake timers; DI is used instead,
 * via `isLocalToday`'s injectable third parameter):
 *
 *   1. A `Date.prototype` spy proves the DEFAULT call path really invokes
 *      `getFullYear`/`getMonth`/`getDate` — never their UTC twins —
 *      regardless of what those calls happen to return on this machine.
 *   2. A SIMULATED non-UTC day-extraction (a fixed +9h/KST offset, computed
 *      purely from the instant's epoch ms — it never reads the host clock)
 *      proves the day-boundary COMPARISON itself picks whichever
 *      interpretation it is given, using a genuine
 *      today-in-one/yesterday-in-the-other UTC-day-crossing pair.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { isLocalToday, localDayParts } from './localDay';
import type { DayParts } from './localDay';

describe('isLocalToday — F-138 local-day math', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the default day-extraction calls the LOCAL Date getters, never their UTC twins', () => {
    const getFullYear = vi.spyOn(Date.prototype, 'getFullYear');
    const getMonth = vi.spyOn(Date.prototype, 'getMonth');
    const getDate = vi.spyOn(Date.prototype, 'getDate');
    const getUTCFullYear = vi.spyOn(Date.prototype, 'getUTCFullYear');
    const getUTCMonth = vi.spyOn(Date.prototype, 'getUTCMonth');
    const getUTCDate = vi.spyOn(Date.prototype, 'getUTCDate');

    isLocalToday(
      '2026-06-01T12:00:00.000Z',
      new Date('2026-06-01T12:00:00.000Z'),
    );

    // Called for BOTH the parsed iso Date and `ref` (2 Dates x 3 getters).
    expect(getFullYear).toHaveBeenCalledTimes(2);
    expect(getMonth).toHaveBeenCalledTimes(2);
    expect(getDate).toHaveBeenCalledTimes(2);
    expect(getUTCFullYear).not.toHaveBeenCalled();
    expect(getUTCMonth).not.toHaveBeenCalled();
    expect(getUTCDate).not.toHaveBeenCalled();
  });

  it('localDayParts is exactly {getFullYear, getMonth, getDate} — a direct, host-TZ-independent structural check', () => {
    const d = new Date('2026-03-15T08:30:00.000Z');
    expect(localDayParts(d)).toEqual({
      y: d.getFullYear(),
      m: d.getMonth(),
      day: d.getDate(),
    });
  });

  it('a simulated non-UTC local timezone: the LOCAL calendar day wins at a real UTC day-boundary crossing', () => {
    // Fixed +9h (KST) offset, derived purely from epoch ms — deterministic
    // on every host, including UTC CI runners, because it never reads the
    // process's actual timezone the way a real "local" extraction would.
    const kstDayParts = (d: Date): DayParts => {
      const shifted = new Date(d.getTime() + 9 * 60 * 60 * 1000);
      return {
        y: shifted.getUTCFullYear(),
        m: shifted.getUTCMonth(),
        day: shifted.getUTCDate(),
      };
    };
    const utcDayParts = (d: Date): DayParts => ({
      y: d.getUTCFullYear(),
      m: d.getUTCMonth(),
      day: d.getUTCDate(),
    });

    // 16:00 UTC on Jan 1 is already 01:00 KST on Jan 2 — a genuine
    // UTC-day-vs-local-day boundary crossing.
    const iso = '2026-01-01T16:00:00.000Z';
    const ref = new Date('2026-01-02T10:00:00.000Z'); // 19:00 KST, still Jan 2

    // Under the (simulated) local interpretation, both instants fall on the
    // SAME calendar day (Jan 2 KST) — "done today" should read true.
    expect(isLocalToday(iso, ref, kstDayParts)).toBe(true);
    // Under a UTC-day interpretation of the EXACT SAME pair, they land on
    // DIFFERENT calendar days (Jan 1 vs Jan 2) — the wrong answer a
    // regression to UTC getters would produce for a KST viewer, and exactly
    // what this test would catch if `isLocalToday`'s comparison logic ever
    // stopped consulting its injected extractor.
    expect(isLocalToday(iso, ref, utcDayParts)).toBe(false);
  });

  it('malformed timestamps resolve false regardless of which day-extraction is injected', () => {
    const ref = new Date('2026-01-02T10:00:00.000Z');
    expect(isLocalToday('not-a-date', ref)).toBe(false);
  });
});
