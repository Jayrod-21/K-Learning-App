/**
 * Test helpers — minimal env setup and SDK stub factory.
 *
 * We DON'T spin up a real Postgres in the unit tests; the
 * `InMemoryCacheStore` / `InMemoryUsageStore` implement the same
 * interface and give us fast, deterministic tests. Integration tests
 * (gated on POSTGRES_TEST_URL) live in tests/services/claude/integration/.
 */

import { __resetConfigForTests } from '../../../src/services/claude/config';
import { __resetLoggerForTests } from '../../../src/services/claude/logger';

export function setTestEnv(overrides: Record<string, string> = {}): void {
  // Minimal valid env.
  process.env.ANTHROPIC_API_KEY = overrides.ANTHROPIC_API_KEY ?? 'sk-test-' + 'x'.repeat(30);
  process.env.DATABASE_URL = overrides.DATABASE_URL ?? 'postgres://test:test@localhost:5432/test';
  process.env.LOG_LEVEL = overrides.LOG_LEVEL ?? 'silent';
  process.env.NODE_ENV = overrides.NODE_ENV ?? 'test';
  process.env.CLAUDE_RETRY_BASE_MS = overrides.CLAUDE_RETRY_BASE_MS ?? '1';
  process.env.CLAUDE_RETRY_MAX_DELAY_MS = overrides.CLAUDE_RETRY_MAX_DELAY_MS ?? '2';
  for (const [k, v] of Object.entries(overrides)) {
    process.env[k] = v;
  }
  __resetConfigForTests();
  __resetLoggerForTests();
}

export interface StubResponseSpec {
  text?: string;
  toolUse?: { name: string; input: unknown };
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  stopReason?: string;
  /**
   * Streaming only: emit `text` as delta events, then make the event
   * iterator REJECT with this error mid-stream (instead of completing),
   * and reject `finalMessage()` with the same error. Models the real SDK's
   * behavior on a mid-stream network reset / upstream error / abort, where
   * both the iterator and the final-message promise reject.
   */
  streamError?: unknown;
}

export interface StubSdk {
  messages: {
    create: (req: unknown) => Promise<unknown>;
    stream: (req: unknown) => AsyncIterable<unknown> & { finalMessage: () => Promise<unknown> };
  };
  calls: Array<{ method: 'create' | 'stream'; req: unknown }>;
}

/**
 * Build a stub SDK that returns a fixed response (or throws an error).
 *
 * `responses`: pass either a single response or an array; the stub
 * returns them in order. Each can be a thrown error (instance of
 * Error / { status, message }) — pass it as { error: ... } to make
 * the stub throw.
 */
export function makeStubSdk(
  responses: Array<StubResponseSpec | { error: unknown }>,
): StubSdk {
  let i = 0;
  const calls: StubSdk['calls'] = [];

  const next = (): StubResponseSpec | { error: unknown } => {
    if (i >= responses.length) {
      throw new Error(`stub SDK ran out of responses after ${i} calls`);
    }
    const r = responses[i]!;
    i += 1;
    return r;
  };

  const buildResponse = (spec: StubResponseSpec): unknown => {
    const content: Array<Record<string, unknown>> = [];
    if (spec.text !== undefined) {
      content.push({ type: 'text', text: spec.text });
    }
    if (spec.toolUse) {
      content.push({
        type: 'tool_use',
        id: 'toolu_test_' + Math.random().toString(36).slice(2, 8),
        name: spec.toolUse.name,
        input: spec.toolUse.input,
      });
    }
    return {
      id: 'msg_test_' + Math.random().toString(36).slice(2, 8),
      model: 'claude-test',
      stop_reason: spec.stopReason ?? 'end_turn',
      content,
      usage: spec.usage ?? {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
  };

  const stub: StubSdk = {
    calls,
    messages: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async create(req: unknown): Promise<unknown> {
        calls.push({ method: 'create', req });
        const r = next();
        if ('error' in r) throw r.error;
        return buildResponse(r);
      },
      stream(req: unknown): AsyncIterable<unknown> & { finalMessage: () => Promise<unknown> } {
        calls.push({ method: 'stream', req });
        const r = next();
        const events: unknown[] = [];
        let midStreamError: unknown;
        let final: unknown;
        if ('error' in r) {
          final = Promise.reject(r.error);
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          (final as Promise<unknown>).catch(() => undefined);
        } else if (r.streamError !== undefined) {
          // Mid-stream failure: deltas first, then the iterator itself
          // rejects and finalMessage() rejects with the same error — exactly
          // what the Anthropic SDK does when the connection drops mid-stream.
          if (r.text) {
            for (const c of chunkString(r.text, 8)) {
              events.push({ type: 'content_block_delta', delta: { type: 'text_delta', text: c } });
            }
          }
          midStreamError = r.streamError;
          final = Promise.reject(r.streamError);
          // Pre-observe the stub's inner promise so the STUB never produces
          // an unhandled rejection of its own. This does not mask the bug
          // under test: client.ts derives a NEW promise from it via
          // `.then(normalizeResponse)`, and it is THAT derived promise whose
          // observation the regression test asserts.
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          (final as Promise<unknown>).catch(() => undefined);
        } else {
          // Emit each character of text as a delta for realism.
          if (r.text) {
            // Split into a few chunks rather than per-char to keep tests fast.
            const chunks = chunkString(r.text, 8);
            for (const c of chunks) {
              events.push({ type: 'content_block_delta', delta: { type: 'text_delta', text: c } });
            }
          }
          events.push({ type: 'message_stop' });
          final = Promise.resolve(buildResponse(r));
        }
        const iter: AsyncIterable<unknown> & { finalMessage: () => Promise<unknown> } = {
          [Symbol.asyncIterator](): AsyncIterator<unknown> {
            let k = 0;
            return {
              next(): Promise<IteratorResult<unknown>> {
                if (k >= events.length) {
                  if (midStreamError !== undefined) {
                    return Promise.reject(midStreamError);
                  }
                  return Promise.resolve({ value: undefined, done: true });
                }
                const value = events[k]!;
                k += 1;
                return Promise.resolve({ value, done: false });
              },
            };
          },
          finalMessage(): Promise<unknown> {
            return final as Promise<unknown>;
          },
        };
        return iter;
      },
    },
  };
  return stub;
}

function chunkString(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/** Build an SDK-shaped error object the retry classifier recognizes. */
export function sdkError(status: number, message = 'simulated'): Error {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}
