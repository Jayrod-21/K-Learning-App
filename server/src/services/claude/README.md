# `services/claude` — Anthropic API proxy

The module that owns every interaction between the Korean Master server
and the Anthropic API. B3's Express server imports this module; nothing
else in `server/` imports `@anthropic-ai/sdk`.

For architecture rationale see
[`db/docs/ADR-020-claude-proxy-architecture.md`](../../../../db/docs/ADR-020-claude-proxy-architecture.md).
For the attack-vector enumeration see
[`SECURITY.md`](./SECURITY.md).

---

## Public API

```ts
import { createClaudeProxy } from './services/claude';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const claude = createClaudeProxy({ pool });

// 1. enrich — tap-a-word
const { result, metadata } = await claude.enrich({
  lemma: '먹다',
  sourceSentence: '엄마가 만든 음식을 다 먹어 버렸어요.',
}, { requestId: req.id, userId: req.user.id });

// 2. recognizeGrammarPattern — tap-a-span
const { result: pattern } = await claude.recognizeGrammarPattern({
  highlightSpan: '-아/어 버리다',
  fullSentence: '엄마가 만든 음식을 다 먹어 버렸어요.',
});

// 3. gradeWriting — TOPIK rubric
const { result: grade } = await claude.gradeWriting({
  sample: '...600-700 자 essay...',
  rubric: 'topik_ii_54',
});

// 4. generateConversation — streamed
const { events, final } = claude.generateConversation({
  scenario: 'first business meeting with a Korean colleague',
  registerTarget: '합쇼체',
  vocabFocus: ['소개', '담당'],
});
for await (const ev of events) {
  if (ev.type === 'delta') res.write(`data: ${ev.text}\n\n`);
  if (ev.type === 'complete') res.write(`event: complete\ndata: ${JSON.stringify(ev.turn)}\n\n`);
}
const completed = await final;  // { result, metadata }
```

All four functions accept an optional `CallContext`:
```ts
{
  requestId?: string;       // correlation ID; auto-generated if absent
  userId?: number | null;   // for usage attribution + rate-limit bucket
  bucketKey?: string;       // override the rate-limit bucket key
}
```

---

## Required environment

| Env var | Type | Default | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | string | required | Never logged. |
| `DATABASE_URL` | string | required | Postgres for cache + usage. |
| `CLAUDE_BASE_URL` | URL | (SDK default) | Override for local proxies. |
| `CLAUDE_TIMEOUT_MS` | int | 60000 | SDK total timeout. |
| `CLAUDE_RETRY_MAX_ATTEMPTS` | int | 3 | Retries on 5xx / 429. |
| `CLAUDE_RETRY_BASE_MS` | int | 250 | Backoff base. |
| `CLAUDE_RETRY_MAX_DELAY_MS` | int | 8000 | Backoff cap. |
| `CLAUDE_DEFAULT_MODEL_ENRICH` | enum | `claude-haiku-4-5` | |
| `CLAUDE_DEFAULT_MODEL_RECOGNIZE_GRAMMAR` | enum | `claude-sonnet-4-6` | |
| `CLAUDE_DEFAULT_MODEL_GRADE_WRITING` | enum | `claude-sonnet-4-6` | |
| `CLAUDE_DEFAULT_MODEL_CONVERSATION` | enum | `claude-sonnet-4-6` | |
| `CLAUDE_MAX_INPUT_*` | int | 2k / 4k / 16k / 8k | Input length caps. |
| `CLAUDE_CACHE_TTL_*_S` | int | 30d / 30d / 7d / 1d | 0 = no expiry. |
| `CLAUDE_RATE_LIMIT_*` | int | 60 / 30 / 5 / 10 | Per-minute, per-bucket. |
| `LOG_LEVEL` | enum | `info` | pino level. |
| `NODE_ENV` | enum | `development` | `development`/`test`/`production`. |

Model enum values: `claude-haiku-4-5`, `claude-sonnet-4-6`,
`claude-opus-4-7`.

---

## Module layout

```
services/claude/
├── index.ts           # public API + factory; B3 imports from here
├── client.ts          # Anthropic SDK wrapper (ONLY file importing the SDK)
├── cache.ts           # Postgres claude_cache (+ in-memory impl for tests)
├── usage.ts           # claude_usage writer + rate-card math
├── retry.ts           # exponential backoff + jitter
├── rate_limit.ts      # in-process token bucket
├── config.ts          # Zod-validated env → typed config
├── logger.ts          # pino instance, redacted
├── errors.ts          # typed error hierarchy
├── models.ts          # Zod schemas: every input + output type
├── prompts/
│   ├── sanitize.ts             # prompt-injection defense
│   ├── enrich.ts               # tap-a-word
│   ├── recognize_grammar.ts    # tap-a-span
│   ├── grade_writing.ts        # TOPIK rubric (uses tool-use)
│   └── conversation.ts         # streamed turn generation
├── README.md          # this file
└── SECURITY.md        # attack-vector enumeration
```

---

## How to test

```bash
# Unit tests (in-memory cache + usage + mocked SDK):
npm run test -- services/claude

# Type-check:
npm run typecheck

# Lint:
npm run lint
```

Integration tests against a real Postgres are gated on
`POSTGRES_TEST_URL` being set; the suite uses `testcontainers` to spin
one up automatically when run in CI.

The full vitest matrix:
- `cache.test.ts` — hit / miss / expired / collision-collapse / Zod-
  reject-of-stale-row.
- `retry.test.ts` — backoff math, retryable classification, jitter.
- `usage.test.ts` — rate-card math, cache-hit zero-cost.
- `client.test.ts` — mocked SDK happy path + tool-use.
- `sanitize.test.ts` — injection markers, length caps, NFC.
- `rate_limit.test.ts` — bucket math, isolation by key.
- `index.test.ts` — end-to-end: cache miss → SDK call → cache write →
  cost row; second call → cache hit; prompt-injection rejected; Zod
  output rejection.

---

## How to add a new route

1. Add a Zod input schema + output schema to `models.ts`.
2. Add a prompt builder to `prompts/<route>.ts`.
3. Add a public method to `ClaudeProxy` in `index.ts` calling
   `runJsonRoute(...)` (or the streaming variant).
4. Add a value to the `claude_route` enum via a forward-only
   migration (`ALTER TYPE claude_route ADD VALUE 'new_route'`).
5. Add config keys (model default, input cap, cache TTL, rate limit)
   to `config.ts` and document defaults in this README.
6. Add tests.

(5) is the friction. It is intentional.

---

## Gotchas

- **Don't import `@anthropic-ai/sdk` outside this module.** Use
  `createClaudeProxy()`.
- **Streaming calls must consume both `events` and `final`.** The
  worker only completes when one of them is awaited; ignoring `final`
  leaks the cost-tracking write.
- **Cache row schema drift.** A stale row that fails Zod parse
  demotes to a fresh API call. This is intentional. If you see
  "cache row failed schema parse" in logs after a schema bump,
  that's the eviction running and is expected.
- **Rate-limit bucket key.** If you forward calls on behalf of
  multiple users from a worker, set `ctx.bucketKey` explicitly or
  all calls share the `'anon'` bucket.
