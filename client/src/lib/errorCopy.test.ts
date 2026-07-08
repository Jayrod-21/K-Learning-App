/**
 * errorCopy — the fixed-copy contract (F-UP-018).
 *
 * The load-bearing assertion: server prose carried on `ApiError.message`
 * NEVER comes back out of `errorMessageFor` — only fixed strings (plus the
 * structured numeric retry_after) do.
 */
import { describe, it, expect } from 'vitest';
import { errorMessageFor, imageUploadErrorMessage } from './errorCopy';
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

describe('imageUploadErrorMessage', () => {
  it('never echoes server prose from an ApiError message', () => {
    const cases = [
      new ApiError(SERVER_PROSE, { status: 429, code: 'daily_cap_exceeded' }),
      new ApiError(SERVER_PROSE, {
        status: 429,
        code: 'rate_limited',
        retryAfter: 9,
      }),
      new ApiError(SERVER_PROSE, { status: 413, code: 'payload_too_large' }),
      new ApiError(SERVER_PROSE, { status: 400, code: 'unsupported_image' }),
      new ApiError(SERVER_PROSE, { status: 502, code: 'ocr_unavailable' }),
      new ApiError(SERVER_PROSE, { status: 0, code: 'network' }),
      new ApiError(SERVER_PROSE, { status: 500, code: 'server_error' }),
    ];
    for (const err of cases) {
      expect(imageUploadErrorMessage(err)).not.toContain('unique constraint');
      expect(imageUploadErrorMessage(err)).not.toBe(SERVER_PROSE);
    }
  });

  it('splits the two 429s — short-window retry_after vs the daily Vision cap (img SF-2)', () => {
    // The expensive-bucket limiter's 429 carries the structured
    // retry_after — a seconds-scale wait, NOT the daily cap. The copy must
    // not tell the user to come back tomorrow.
    const limited = new ApiError('rate_limited: bucket exhausted', {
      status: 429,
      code: 'rate_limited',
      retryAfter: 12,
    });
    expect(imageUploadErrorMessage(limited)).toBe(
      'Rate-limited. Try again in about 12 seconds.',
    );
    // Fractional retry_after rounds UP (never invites an early retry).
    const fractional = new ApiError('rate_limited', {
      status: 429,
      code: 'rate_limited',
      retryAfter: 0.4,
    });
    expect(imageUploadErrorMessage(fractional)).toBe(
      'Rate-limited. Try again in about 1 seconds.',
    );
    // The daily cap has NO retry_after — that one IS "tomorrow".
    const cap = new ApiError('vision_daily_cap_exceeded: user 3 spent $1.02', {
      status: 429,
      code: 'daily_cap_exceeded',
    });
    expect(imageUploadErrorMessage(cap)).toBe(
      "You've hit today's image limit. Try again tomorrow.",
    );
    // Same-code daily-cap shape (both 429s use `rate_limited` on some
    // paths — presence of retry_after is the only discriminator).
    const capSameCode = new ApiError('daily limit reached', {
      status: 429,
      code: 'rate_limited',
    });
    expect(imageUploadErrorMessage(capSameCode)).toBe(
      "You've hit today's image limit. Try again tomorrow.",
    );
  });

  it('maps 413 / 400 / 502 / network to their fixed copy', () => {
    expect(
      imageUploadErrorMessage(
        new ApiError('x', { status: 413, code: 'payload_too_large' }),
      ),
    ).toBe('That image is too large. Pick one under 8 MB.');
    expect(
      imageUploadErrorMessage(
        new ApiError('x', { status: 400, code: 'unsupported_image' }),
      ),
    ).toBe('That file isn’t a supported image. Use a JPEG, PNG, or WebP.');
    expect(
      imageUploadErrorMessage(
        new ApiError('x', { status: 502, code: 'ocr_unavailable' }),
      ),
    ).toBe('OCR is temporarily unavailable. Try again shortly.');
    expect(
      imageUploadErrorMessage(
        new ApiError('x', { status: 0, code: 'network' }),
      ),
    ).toBe('Network unreachable. Check your connection and try again.');
  });

  it('falls back to the generic fixed copy for everything else', () => {
    // Unmatched ApiError (generic 500) and non-ApiError values alike.
    expect(
      imageUploadErrorMessage(
        new ApiError(SERVER_PROSE, { status: 500, code: 'server_error' }),
      ),
    ).toBe('Upload failed. Try again.');
    expect(imageUploadErrorMessage(new Error('raw internals'))).toBe(
      'Upload failed. Try again.',
    );
    expect(imageUploadErrorMessage('string')).toBe('Upload failed. Try again.');
    expect(imageUploadErrorMessage(undefined)).toBe('Upload failed. Try again.');
  });
});
