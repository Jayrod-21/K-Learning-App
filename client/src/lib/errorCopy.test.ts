/**
 * errorCopy — the fixed-copy contract (F-UP-018).
 *
 * The load-bearing assertion: server prose carried on `ApiError.message`
 * NEVER comes back out of `errorMessageFor` — only fixed strings (plus the
 * structured numeric retry_after) do.
 */
import { describe, it, expect } from 'vitest';
import {
  audioUploadErrorMessage,
  bookUploadErrorMessage,
  errorMessageFor,
  imageUploadErrorMessage,
} from './errorCopy';
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

describe('bookUploadErrorMessage', () => {
  it('never echoes server prose from an ApiError message', () => {
    const cases = [
      new ApiError(SERVER_PROSE, { status: 429, code: 'daily_cap_exceeded' }),
      new ApiError(SERVER_PROSE, { status: 429, code: 'rate_limited', retryAfter: 9 }),
      new ApiError(SERVER_PROSE, { status: 413, code: 'payload_too_large' }),
      new ApiError(SERVER_PROSE, { status: 400, code: 'validation_error' }),
      new ApiError(SERVER_PROSE, { status: 0, code: 'network' }),
      new ApiError(SERVER_PROSE, { status: 500, code: 'server_error' }),
    ];
    for (const err of cases) {
      expect(bookUploadErrorMessage(err)).not.toContain('unique constraint');
      expect(bookUploadErrorMessage(err)).not.toBe(SERVER_PROSE);
    }
  });

  // C-S2 regression: post-REVISION the cap is ~300 MB (not the pre-revision
  // ~15 MB) and the accepted types are PDF OR zip (not PDF-only) — the old
  // copy for both the 413 and 400 branches was stale and actively wrong.
  it('states the current ~300 MB cap on 413 (not the pre-revision 15 MB copy)', () => {
    expect(
      bookUploadErrorMessage(new ApiError('x', { status: 413, code: 'payload_too_large' })),
    ).toBe('That file is too large. Pick one under 300 MB.');
  });

  // C-S2 regression: the 400 branch is reached by EVERY ValidationError the
  // route can throw — a bad file (magic-byte/zip-PDF normalize failure) OR a
  // body-schema violation unrelated to the file (a >200-char title, a blank
  // title, an invalid `type`). The old copy ("That file isn't a valid PDF.
  // Choose a different file.") gave wrong, unactionable advice whenever the
  // real cause was the title — re-picking the same valid file would just
  // hit the same 400 again. The new copy must stay correct for either cause
  // and must NOT single out "the file" or say "isn't a valid PDF".
  it('does not blame "the file" specifically on 400 (title-length 400s share this code too)', () => {
    const msg = bookUploadErrorMessage(
      new ApiError('title must be at most 200 characters', {
        status: 400,
        code: 'validation_error',
      }),
    );
    expect(msg).not.toMatch(/isn.t a valid PDF/i);
    expect(msg).not.toMatch(/choose a different file/i);
    expect(msg).toMatch(/title/i);
  });

  it('splits the two 429s — short-window retry_after vs the daily upload cap', () => {
    const limited = new ApiError('rate_limited: bucket exhausted', {
      status: 429,
      code: 'rate_limited',
      retryAfter: 12,
    });
    expect(bookUploadErrorMessage(limited)).toBe('Rate-limited. Try again in about 12 seconds.');
    const cap = new ApiError('book_upload_daily_cap_exceeded: user 3', {
      status: 429,
      code: 'daily_cap_exceeded',
    });
    expect(bookUploadErrorMessage(cap)).toBe("You've hit today's upload limit. Try again tomorrow.");
  });

  it('maps network to its fixed copy and falls back to generic copy otherwise', () => {
    expect(
      bookUploadErrorMessage(new ApiError('x', { status: 0, code: 'network' })),
    ).toBe('Network unreachable. Check your connection and try again.');
    expect(
      bookUploadErrorMessage(new ApiError(SERVER_PROSE, { status: 500, code: 'server_error' })),
    ).toBe('Upload failed. Try again.');
    expect(bookUploadErrorMessage(new Error('raw internals'))).toBe('Upload failed. Try again.');
    expect(bookUploadErrorMessage(undefined)).toBe('Upload failed. Try again.');
  });
});

describe('audioUploadErrorMessage (Track A A-4b)', () => {
  it('never echoes server prose from an ApiError message', () => {
    const cases = [
      new ApiError(SERVER_PROSE, { status: 429, code: 'daily_cap_exceeded' }),
      new ApiError(SERVER_PROSE, { status: 429, code: 'rate_limited', retryAfter: 9 }),
      new ApiError(SERVER_PROSE, { status: 413, code: 'payload_too_large' }),
      new ApiError(SERVER_PROSE, { status: 400, code: 'validation_error' }),
      new ApiError(SERVER_PROSE, { status: 0, code: 'network' }),
      new ApiError(SERVER_PROSE, { status: 500, code: 'server_error' }),
    ];
    for (const err of cases) {
      expect(audioUploadErrorMessage(err)).not.toContain('unique constraint');
      expect(audioUploadErrorMessage(err)).not.toBe(SERVER_PROSE);
    }
  });

  it('splits the two 429s — short-window retry_after vs the daily audio caps', () => {
    // The short-window limiter's 429 carries the structured retry_after —
    // a seconds-scale wait; the copy must not say "tomorrow".
    const limited = new ApiError('rate_limited: bucket exhausted', {
      status: 429,
      code: 'rate_limited',
      retryAfter: 12,
    });
    expect(audioUploadErrorMessage(limited)).toBe(
      'Rate-limited. Try again in about 12 seconds.',
    );
    // The per-user DAILY caps (transcription bytes + upload count, both
    // Whisper-CPU cost controls) carry NO retry_after — that one IS
    // "tomorrow". retryAfter presence is the only discriminator.
    const cap = new ApiError('audio_daily_cap_exceeded: user 3', {
      status: 429,
      code: 'daily_cap_exceeded',
    });
    expect(audioUploadErrorMessage(cap)).toBe(
      "You've hit today's audio limit. Try again tomorrow.",
    );
    // Same-code daily-cap shape (some paths reuse `rate_limited` without a
    // retry_after) must still read as the daily cap.
    const capSameCode = new ApiError('daily limit reached', {
      status: 429,
      code: 'rate_limited',
    });
    expect(audioUploadErrorMessage(capSameCode)).toBe(
      "You've hit today's audio limit. Try again tomorrow.",
    );
  });

  it('maps 413 / 400 / network to their fixed copy', () => {
    expect(
      audioUploadErrorMessage(
        new ApiError('x', { status: 413, code: 'payload_too_large' }),
      ),
    ).toBe('That file is too large. Pick one under 100 MB.');
    // 400 covers EVERY ValidationError the route throws (failed sniff, a
    // disallowed mime, a bad title) — the copy must not single out the file.
    expect(
      audioUploadErrorMessage(
        new ApiError('x', { status: 400, code: 'validation_error' }),
      ),
    ).toBe(
      'That upload could not be processed. Check the file (MP3 or M4A) and the title, then try again.',
    );
    expect(
      audioUploadErrorMessage(new ApiError('x', { status: 0, code: 'network' })),
    ).toBe('Network unreachable. Check your connection and try again.');
  });

  it('falls back to the generic fixed copy for everything else', () => {
    expect(
      audioUploadErrorMessage(
        new ApiError(SERVER_PROSE, { status: 500, code: 'server_error' }),
      ),
    ).toBe('Upload failed. Try again.');
    expect(audioUploadErrorMessage(new Error('raw internals'))).toBe(
      'Upload failed. Try again.',
    );
    expect(audioUploadErrorMessage('string')).toBe('Upload failed. Try again.');
    expect(audioUploadErrorMessage(undefined)).toBe('Upload failed. Try again.');
  });
});
