/**
 * api layer — AxiosError → ApiError normalisation.
 *
 * Focus (SF1): a 423 lockout body `{ error: { code:'account_locked',
 * retry_after } }` must surface `retry_after` (seconds) as a structured numeric
 * `ApiError.retryAfter`, so the UI can render "wait N minutes" with a real N.
 * The contract's "no server prose echoed" rule is not violated — `retry_after`
 * is a number, not a message. We mock axios at the module boundary so the test
 * drives `instance.request` rejections without a real network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError } from 'axios';

// Mock axios so `axios.create()` returns a stub instance whose `request` we
// control. We keep the real `AxiosError` class so `instanceof` narrowing in the
// api layer behaves exactly as in production.
const requestMock = vi.fn();
vi.mock('axios', async () => {
  const actual = await vi.importActual<typeof import('axios')>('axios');
  return {
    ...actual,
    default: {
      ...actual.default,
      create: () => ({
        request: requestMock,
        defaults: { headers: {} },
        interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
      }),
    },
  };
});

// Imported AFTER the mock so the api module's `axios.create()` hits the stub.
const { apiRequest, ApiError } = await import('./api');

/** Build an AxiosError carrying a server error body at the given status. */
function axiosErrorWithBody(status: number, body: unknown): AxiosError {
  const err = new AxiosError('request failed');
  err.response = {
    status,
    data: body,
    statusText: '',
    headers: {},
    // The api layer only reads `status` + `data`; cast the rest minimally.
    config: {} as never,
  };
  return err;
}

beforeEach(() => {
  requestMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('normaliseError — 423 retry_after (SF1)', () => {
  it('preserves a numeric retry_after on ApiError', async () => {
    requestMock.mockRejectedValueOnce(
      axiosErrorWithBody(423, {
        error: { code: 'account_locked', message: 'too many attempts', retry_after: 90 },
      }),
    );

    const err = await apiRequest({ method: 'POST', url: '/auth/login/totp' }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as InstanceType<typeof ApiError>;
    expect(apiErr.status).toBe(423);
    expect(apiErr.code).toBe('account_locked');
    expect(apiErr.retryAfter).toBe(90);
  });

  it('leaves retryAfter undefined when the body omits retry_after', async () => {
    requestMock.mockRejectedValueOnce(
      axiosErrorWithBody(423, { error: { code: 'account_locked', message: 'locked' } }),
    );

    const apiErr = (await apiRequest({ method: 'POST', url: '/x' }).catch(
      (e: unknown) => e,
    )) as InstanceType<typeof ApiError>;

    expect(apiErr.retryAfter).toBeUndefined();
  });

  it('drops a non-positive or non-finite retry_after (never trusts garbage)', async () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '90' as unknown]) {
      requestMock.mockRejectedValueOnce(
        axiosErrorWithBody(423, { error: { code: 'account_locked', retry_after: bad } }),
      );
      const apiErr = (await apiRequest({ method: 'POST', url: '/x' }).catch(
        (e: unknown) => e,
      )) as InstanceType<typeof ApiError>;
      expect(apiErr.retryAfter).toBeUndefined();
    }
  });

  it('still surfaces code + message for non-lockout errors unchanged', async () => {
    requestMock.mockRejectedValueOnce(
      axiosErrorWithBody(401, { error: { code: 'invalid_code', message: 'nope' } }),
    );
    const apiErr = (await apiRequest({ method: 'POST', url: '/x' }).catch(
      (e: unknown) => e,
    )) as InstanceType<typeof ApiError>;
    expect(apiErr.code).toBe('invalid_code');
    expect(apiErr.retryAfter).toBeUndefined();
  });
});
