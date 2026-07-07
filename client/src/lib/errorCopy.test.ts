/**
 * errorCopy — the fixed-copy contract (F-UP-018).
 *
 * The load-bearing assertion: server prose carried on `ApiError.message`
 * NEVER comes back out of `errorMessageFor` — only fixed strings (plus the
 * structured numeric retry_after) do.
 */
import { describe, it, expect } from 'vitest';
import { errorMessageFor } from './errorCopy';
import { ApiError } from '../services/api';

const SERVER_PROSE =
  'duplicate key value violates unique constraint "vocab_entries_pkey"';

describe('errorMessageFor', () => {
  it('never echoes server prose from an ApiError message', () => {
    const cases = [
      new ApiError(SERVER_PROSE, { status: 500, code: 'server_error' }),
      new ApiError(SERVER_PROSE, { status: 404, code: 'not_found' }),
      new ApiError(SERVER_PROSE, { status: 409, code: 'conflict' }),
      new ApiError(SERVER_PROSE, { status: 401, code: 'unauthorized' }),
      new ApiError(SERVER_PROSE, { status: 429, code: 'rate_limited' }),
      new ApiError(SERVER_PROSE, { status: 0, code: 'network' }),
      new ApiError(SERVER_PROSE, { status: 0, code: 'timeout' }),
    ];
    for (const err of cases) {
      expect(errorMessageFor(err, 'Fallback copy.')).not.toContain(
        'unique constraint',
      );
      expect(errorMessageFor(err, 'Fallback copy.')).not.toBe(SERVER_PROSE);
    }
  });

  it('returns the caller fallback for generic server errors', () => {
    const err = new ApiError(SERVER_PROSE, { status: 500, code: 'server_error' });
    expect(errorMessageFor(err, 'Could not load the list.')).toBe(
      'Could not load the list.',
    );
  });

  it('maps network / timeout / 401 to their fixed copy', () => {
    expect(
      errorMessageFor(
        new ApiError('x', { status: 0, code: 'network' }),
        'fb',
      ),
    ).toMatch(/Network unreachable/);
    expect(
      errorMessageFor(
        new ApiError('x', { status: 0, code: 'timeout' }),
        'fb',
      ),
    ).toMatch(/timed out/);
    expect(
      errorMessageFor(
        new ApiError('x', { status: 401, code: 'unauthorized' }),
        'fb',
      ),
    ).toMatch(/session has expired/i);
  });

  it('interpolates only the structured retry_after on 429', () => {
    const with429 = new ApiError('server prose', {
      status: 429,
      code: 'rate_limited',
      retryAfter: 42,
    });
    expect(errorMessageFor(with429, 'fb')).toBe(
      'Rate-limited. Try again in about 42 seconds.',
    );
    const without = new ApiError('server prose', {
      status: 429,
      code: 'rate_limited',
    });
    expect(errorMessageFor(without, 'fb')).toMatch(/Rate-limited right now/);
  });

  it('returns the fallback for non-ApiError values', () => {
    expect(errorMessageFor(new Error('raw internals'), 'Fallback.')).toBe(
      'Fallback.',
    );
    expect(errorMessageFor('string', 'Fallback.')).toBe('Fallback.');
    expect(errorMessageFor(undefined, 'Fallback.')).toBe('Fallback.');
  });
});
