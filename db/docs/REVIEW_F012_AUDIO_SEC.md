# Review: F-012 — TTMIK/Iyagi audio streaming + security

**Reviewer:** Independent senior reviewer (did not write the code).
**Branch:** `feat/ttmik-audio` @ `edde44b`.
**Scope:** `server/src/routes/ttmik.ts` (audio-stream endpoints), `server/src/config/index.ts`
(`CORPUS_AUDIO_DIR`), `Deploy/docker-compose.blue.yml` + `Deploy/docker-compose.green.yml`
(the read-only corpus bind-mount). Audio streaming + security only, per the R1 slice of
`db/docs/FIXPASS_F012_PLAN.md`.

**Method:** static read of all in-scope files; ran the existing suite
(`vitest run tests/routes/ttmik.test.ts`, ephemeral testcontainers Postgres — 43/43 green, not
the live `km-db`); wrote and ran a standalone Node script confirming Node's `fs/promises`
null-byte guard actually fires on a crafted `audio_path` containing `\0` (not assumed from
memory); grepped `app.ts` to confirm no competing `express.static`/bypass route serves
`/corpus` and that both routers install `requireAuth` before any handler. No code was
modified; no writes to the live DB.

---

## Verdict

**PASS.**

The path-escape defense is layered correctly (reject-absolute → lexical normalize+prefix →
`realpath()` re-check on both root and file → regular-file check), the failure mode at every
layer is a uniform, indistinguishable 404, Range handling is RFC 9110-correct including the
suffix/clamp/416/malformed/multi-range edge cases, auth gates the whole surface, and the
stream is genuinely backpressured with no whole-file buffering and no fd leak on abort. I
independently exercised the traversal/symlink/null-byte cases rather than taking the header
comment's word for it, and they hold.

- **Blockers:** 0
- **SHOULD-FIX:** 1
- **NITs:** 3
- **Praise:** 4

---

## Findings

### SHOULD-FIX-1 — Audio streaming shares the generic `cheapLimiter` bucket with unrelated endpoints

`server/src/routes/ttmik.ts:184` and `:270` mount `cheapLimiter()` on the `/audio` routes —
the same per-IP bucket (`RATE_LIMIT_CHEAP_MAX`, default 120/`RATE_LIMIT_WINDOW_MS` = 120/min,
`server/src/config/index.ts:103`) shared with every other "cheap" JSON endpoint in the app
(`/ttmik/lessons`, `/ttmik/lessons/:l/:n`, and unrelated routers that also call
`cheapLimiter()`).

A single active listening session (browse catalog → open lesson → play → seek a few times →
open next lesson → repeat) plausibly burns 5–10 hits per lesson across list+detail+audio(+
Range re-requests on seek). A normal study session touching ~15–20 lessons can realistically
approach or exceed 120 hits/min from one IP, at which point the *same* limiter starts 429-ing
unrelated cheap calls elsewhere in the app for that user — a real availability regression
against a legitimate use pattern, not an attack. This is the same class of problem the global
Bar calls out for trading guardrails (§7.2, "a guardrail that blocks a valid action MUST
announce it and support override") generalized to rate limiting: a shared bucket sized for
small JSON responses is being asked to also cover a media-streaming surface it wasn't sized
for.

Fix: give the two `/audio` routes their own limiter bucket (or reuse `expensiveLimiter`'s
per-user-when-authenticated keying, which is more forgiving to a single legitimate multi-tab
listener than a bare per-IP cap), sized for the actual expected Range-request cadence of an
audio player, independent from the JSON list/detail cap.

---

### NIT-1 — `HEAD` requests do full DB lookup + `resolveAudioFile` + stream setup for no payload

Express auto-routes `HEAD /ttmik/lessons/:level/:number/audio` (and the Iyagi twin) to the
same `router.get(...)` handler (`ttmik.ts:182`, `:267`) since no explicit `.head()` route is
registered. Node suppresses the body on the wire for a `HEAD` response, but the handler still
runs the full DB query, `realpath()`×2, `stat()`, and opens a `createReadStream` that gets
piped and then discarded — real disk I/O and an fd churn for a response that discloses nothing
more than a `HEAD` needs (headers only). Not a security hole (same auth/rate-limit/404 gates
apply), just wasted work; worth an explicit `req.method === 'HEAD'` short-circuit that returns
headers only, if audio players in the field are found to send `HEAD` probes.

### NIT-2 — TOCTOU window between the `realpath()` containment check and `createReadStream`

`ttmik.ts:308-343` resolves and validates `realAbs`, then a separate `stat()` and later a
separate `createReadStream(absPath, …)` open the same path again. Between the containment
check and the actual open, a symlink could in principle be swapped in to redirect the read
after validation passed (classic check-then-use gap). In this deployment it's not exploitable
today: nothing on the request path can write into the corpus tree — it's `:ro`-mounted
(`docker-compose.blue.yml:130`, `.green.yml:130`) and the only writer is the offline loader on
the host. Worth a one-line comment noting the `:ro` mount is *why* this TOCTOU is inert here,
so a future reviewer evaluating a different deployment (e.g., corpus on a writable
network share) doesn't have to re-derive it.

### NIT-3 — Response-latency differences between rejection paths are a theoretical residual oracle

The uniform-404 defense (`ttmik.ts:294-343`) correctly equalizes status/body/message across
every rejection reason, but the *code path length* still differs: "no row" and
"absolute-path rejected" return after ~0 fs calls, "traversal outside root" after a lexical
compare, "symlink escape" after two `realpath()` calls, "is a directory" after a further
`stat()`. A sufficiently patient timing attacker could in principle bucket these apart. Given
`audio_path` is never attacker-reachable through any live HTTP input today (it's DB-only,
written by the offline loader — the threat model treats it as hostile in the defense-in-depth
sense, not as an actually-exposed input), this is a purely theoretical gap and does not change
the verdict. Flagging for completeness since the header comment explicitly claims the 404 is
indistinguishable, and strictly it's indistinguishable in *content*, not in *timing*.

---

### PRAISE

- **`ttmik.ts:308-343` (`resolveAudioFile`)** — the defense-in-depth layering is exactly
  right and matches the review checklist point for point: reject absolute → lexical
  `resolve(root, normalize(rel))` + prefix check → `realpath()` on *both* root and resolved
  file, re-verified for containment on the kernel's answer (this is the part that actually
  kills symlink escape — a lexical-only check would have missed it) → regular-file check.
  Every rejection branch is commented with the specific attack it defends against, per Bar
  §0's "name the attack, name the defense" standard — this is what that rule is supposed to
  produce.
- **`ttmik.ts:358-377` (`parseRangeHeader`)** is a clean, pure, exhaustively-unit-tested
  RFC 9110 implementation: suffix ranges, end-clamping to EOF, inverted-range rejection,
  zero-length suffix, malformed/multi-range/unknown-unit all correctly fall through to
  "ignore → full 200" rather than erroring, and the 416 path correctly emits
  `Content-Range: bytes */total` per §15.5.17. I verified all 13 `it.each` cases pass.
- **Fail-soft `CORPUS_AUDIO_DIR` default** (`config/index.ts:40-47`) — a missing/unmounted
  corpus directory is deliberately *not* a startup failure; it degrades to a clean 404 at
  request time (confirmed: `realpath(root)` throwing is caught by the same try/catch as every
  other rejection). Correct call for an optional media feature layered onto an app whose core
  function doesn't depend on it — a missing bind mount on a fresh box shouldn't take down
  login/SRS/grammar.
- **Compose wiring** (`docker-compose.blue.yml:117,130`, `.green.yml:117,130`) — `:ro` on the
  bind mount, `CORPUS_AUDIO_DIR=/corpus` matching the mount target, identically wired in both
  colors, with the rationale (compromised server can't alter the corpus) stated inline rather
  than left implicit.

---

## Detailed checklist against the review brief

| Item | Status | Evidence |
|---|---|---|
| Absolute `audio_path` rejected before any fs call | PASS | `ttmik.ts:316-319`; test `absolute stored audio_path → 404` (`ttmik.test.ts:323-329`) |
| `..` traversal collapsed + lexical prefix check | PASS | `ttmik.ts:320-324`; test `dot-dot traversal … → 404` (`ttmik.test.ts:314-321`) |
| `realpath()` containment re-check kills symlink escape | PASS | `ttmik.ts:325-337`; test `symlink inside the root pointing outside → 404` (`ttmik.test.ts:331-347`), independently re-verified by inspection of the containment logic |
| Null-byte injection can't bypass containment | PASS (independently verified, not in the automated suite) | `realpath()`/`stat()` throw `ERR_INVALID_ARG_VALUE` synchronously on an embedded `\0`, caught by the same `try {…} catch { throw NotFoundError }` at `ttmik.ts:326-333` — confirmed by running a standalone Node script against `fs/promises.realpath`/`stat` with a crafted path |
| Missing mount (root `realpath()` fails) → clean 404 | PASS | same catch block, `ttmik.ts:330-333`; comment at `config/index.ts:44-46` documents the intent |
| Every rejection path is a uniform 404, same body | PASS | all branches throw `new NotFoundError('no audio for this unit')`; only the server-side `log.warn` differs |
| 206 + `Content-Range` correct | PASS | `ttmik.ts:417-419`; test `bytes=0-3 → 206…` |
| Suffix ranges (`bytes=-N`) | PASS | `parseRangeHeader:366-370`; tests incl. suffix-larger-than-file |
| End clamped to EOF | PASS | `parseRangeHeader:374`; test `end clamped to EOF…` |
| 416 + `Content-Range: bytes */total` on unsatisfiable | PASS | `ttmik.ts:399-404`; test `unsatisfiable Range … → 416…` |
| Malformed `Range` → full 200 (RFC 9110) | PASS | `parseRangeHeader:364-365`; test `malformed Range header is ignored → 200` |
| Multi-range rejected/handled sanely | PASS (ignored → full 200, RFC-permitted) | regex requires single `bytes=start-end`; comma-containing header fails the match → `null`; test `bytes=0-3,5-9 → null` |
| `requireAuth` on every route in this surface | PASS | `ttmik.ts:59-60` mounted before any `router.get`; test suite's `it.each` over all 6 paths → 401 unauthenticated (`ttmik.test.ts:105-117`); confirmed no competing static/bypass route in `app.ts` |
| `Content-Type: audio/mpeg`, `Content-Length`, `Accept-Ranges: bytes` | PASS | `ttmik.ts:392-393,423` |
| No whole-file buffering | PASS | `createReadStream(absPath, {start,end}).pipe(res)`, `ttmik.ts:425,440` |
| fd/stream closed on client abort | PASS | `res.on('close', () => stream.destroy())`, `ttmik.ts:439` |
| Stream errors handled (not silently swallowed) | PASS | `ttmik.ts:426-436` — destroys the stream, then either `res.destroy()` if headers already sent or `next(err)` for a clean 500 |
| Compose mount `:ro`, `CORPUS_AUDIO_DIR` wired both colors | PASS | `docker-compose.blue.yml:117,130`; `docker-compose.green.yml:117,130` — byte-identical besides color name/ports |

---

## Bar checklist (spot-checked, this scope only)

| Item | Status | Note |
|---|---|---|
| Tests pass | PASS — VERIFIED IN REVIEW | `vitest run tests/routes/ttmik.test.ts` → 43/43 green against ephemeral testcontainers Postgres |
| Every attack vector named with its defense in a comment | PASS | `ttmik.ts:22-42, 289-307` |
| No hardcoded secrets/paths | PASS | `CORPUS_AUDIO_DIR` env-driven, defaulted but overridable |
| No `print()`/`console.log` debug residue | PASS | structured `getLogger()` throughout |
| No commented-out code / dead code | PASS | |
| Fail closed, fail to safe | PASS | every ambiguous/error case → 404, not a fallthrough serve |
