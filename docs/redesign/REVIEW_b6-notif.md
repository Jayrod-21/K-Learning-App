# Review: F-093 CONTRACT step — notif single-sourced from notification_schedules

Reviewer: independent senior backend review (wire-contract + data-source correctness). Scope: `server/src/routes/settings.ts`, `server/tests/routes/settings.test.ts`, `client/src/pages/Settings.tsx` on branch `worktree-agent-a1fd8330d7b581634` @ `e76c55d`, diffed against `rebuild`. Cross-read: `db/migrations/064_backfill_notification_schedules_from_prefs.up.sql`, `db/migrations/052_notification_schedules.up.sql`, `server/src/routes/notifications.ts`, `server/src/services/notificationDelivery.ts`, `client/src/services/settings.ts`, `client/src/lib/settings.ts`. Code not modified.

## Summary verdict: **PASS**

**Blockers: 0. Should-fix: 1 (doc-only). Nits: 4.**

The derivation is a faithful inverse of what migration 064 *produces* (email-channel rows keyed on the three kinds), the dual-write is verifiably gone (pinned by a direct-DB assertion in the tests), the stale-blob purge and the malformed-legacy-notif hardening are both real and both tested, and the rewritten test suite is *stronger* than what it replaced — the key assertions would fail hard if the route reverted to blob-sourced notif. I traced every reader of the `notif` field across client and server: nothing consumes it in a way the fresh-user all-false default (or the legacy-user drift enumerated below) can break. The one should-fix is documentation honesty: the route header's "exact inverse of 064's mapping" claim is true of 064's *output* but silently glosses three classes of legacy blob state that 064 itself deliberately dropped — worth enumerating in the comment so a future reader doesn't rediscover it as a bug.

## Gates (run from the worktree)

| Gate | Command | Result |
|---|---|---|
| Server typecheck | `cd server && npm run typecheck` | **0 errors** (clean `tsc --noEmit`) |
| Server settings route tests | `cd server && npx vitest run tests/routes/settings.test.ts` | **37/37 passed** (1 file, testcontainer, 39.6s) |
| Client settings tests | `cd client && npx vitest run src/pages/Settings.test.tsx src/services/settings.test.ts` | **65/65 passed** (2 files, 7.6s) |

## 1. Derivation correctness — is `deriveNotifFromSchedules` the inverse of 064?

Side-by-side:

| Wire field | 064 blob→rows (`064_...up.sql`) | derive rows→blob (`settings.ts:224-243`) | Round-trips? |
|---|---|---|---|
| `daily` | `notif.daily=true` AND `notif.channel.email=true` → enabled (`'email'`, `daily_reminder`) row (`:80`, gate `:87-91`, `:92-98`) | enabled (`'email'`, `daily_reminder`) row exists (`:237`) | YES |
| `reviewsDue` | same, kind `reviews_due` (`:81`) | enabled (`'email'`, `reviews_due`) row (`:236`) | YES |
| `weekly` | same, kind `weekly_report` (`:82`) | enabled (`'email'`, `weekly_report`) row (`:238`) | YES |
| `channel.email` | never written as such — implied by any row existing | ANY enabled email row exists (`:232`) | iff ≥1 kind was true |
| `channel.sms` | **never backfilled** (064 header `:31-39`: email-only, deliberate) | ANY enabled sms row exists (`:233`) | only via F-040-created sms rows |

So `derive(backfill(blob)) == blob` holds exactly for every blob with `channel.email=true` and at least one kind true — including the important population: anyone who ever saved the old default `{email:true, reviewsDue:true, weekly:true}` reads back exactly that (064 inserted `reviews_due` + `weekly_report` email rows; derive returns `email:true, reviewsDue:true, weekly:true, daily:false, sms:false`). The kind names, the email-channel keying, and the enabled flag all match 064's VALUES table (`:80-82`) precisely. The `enabled` predicate on every `rows.some(...)` correctly reflects post-064 user edits via the F-040 UI (a user who disabled a row reads false — canonical wins, as intended).

**Three legacy classes DO read differently than the pre-contract blob-sourced GET** (this is the full enumeration; see SHOULD-FIX-1):

1. `channel.email=true` with **all three kinds false** → 064 inserted nothing → derived `email:false` (was `true`).
2. `channel.sms=true` → 064 never backfilled sms → derived `sms:false` (was `true`), unless the user has since created enabled sms rows via `PUT /notifications/schedules`.
3. Any kind `true` with `channel.email=false` → 064's gate (`:87-91`) skipped it → derived kind `false` (was `true`).

All three are *lossy in 064 itself* (each is an explicit, documented design decision in 064's header — the derive faithfully inverts what 064 chose to record), and all three represent intent that could never have produced a send (email off, or no kind on, or sms which has no send infrastructure). Crucially — see §2 — **no consumer renders or acts on these booleans**, so the drift is wire-only. Not a blocker.

Fresh-user all-false default (`settings.ts:229-243` — no rows → every field false): confirmed intentional (matches F-040's "nothing is implicitly on" model, 064 header `:38-39`) and confirmed harmless per §2.

Minor asymmetry, deliberate and defensible: derived kind booleans key on the **email** channel only (`enabledEmailKind`, `settings.ts:235-236`), so an enabled `push` row — creatable via the API, `ScheduleChannel = z.enum(['push','email','sms'])` at `routes/notifications.ts:55` — is invisible in `daily/reviewsDue/weekly`. This exactly mirrors 064's email-only mapping and the F-040 client only ever creates email rows, so it is consistent; flagged as NIT-2.

## 2. Consumers of `prefs.notif` — does the all-false default break anything?

Exhaustive grep of both trees (`\.notif\b`, `settings\.notif`, `preferences` readers):

**Server:** the only reader of `users.preferences` outside `routes/settings.ts` is a *comment* in `routes/notifications.ts:6`. `notificationDelivery.ts` operates purely on `notification_schedules`/`notification_deliveries` (its only diff here is the `scheduleId: number → string` BIGINT typing fix at `notificationDelivery.ts:74-77`, unrelated to notif sourcing and correct — node-postgres returns BIGINT as string). No server code gates sends or anything else on the blob's notif booleans.

**Client:** the F-040 notification UI is driven entirely by `/notifications/schedules` (`Settings.tsx:914-935` — `schedulesQuery`, `scheduleDrafts`; render section at `:1150+`). **No toggle or render reads `settings.notif`** — verified: every remaining `notif` reference in `Settings.tsx` is either (a) the hydration pass-through that writes the server's derived value into the provider (`:843-851`), (b) the PUT echo that relays `lastSyncedPrefsRef.current.notif` — the last *server*-reported value, never client-originated (`:882-890`, the F-093 client-side hardening, present pre-diff), or (c) the mock fallback (`:213`, guarded by `isMock` so never adopted as truth). `chatContext.ts`'s grep hit is a `notify()` function — false positive. `lib/settings.ts:144-158` parses a localStorage notif slice that nothing renders. `services/settings.ts` has no runtime response validation (TS types only, Pass 3 contract — `:20-22`), so the response gaining nothing/losing nothing at runtime.

**Conclusion: the builder's claim is verified.** A fresh user (or any of the three legacy classes above) receiving all-false `notif` changes no pixel and no send behavior anywhere in the system.

## 3. No dual-write + purge + hardening

- **PUT writes only the stored slices**: `settings.ts:319-323` builds `stored` from exactly `{palette, languageDisplay, textSize}`; `:335-340` persists `JSON.stringify(stored)`. The body's `notif` is provably dropped — pinned by the test at `settings.test.ts:207-217` which SELECTs the column directly and asserts `toEqual(CUSTOM_STORED)` **and** `Object.keys(...).not.toContain('notif')`. No other write path to `users.preferences` exists (grep).
- **Stale-key purge**: since PUT replaces the whole blob with the notif-free `stored`, a pre-contract row loses its legacy notif keys on the next save — tested end-to-end at `settings.test.ts:236-252` (seed blob WITH notif → PUT → direct SELECT asserts exact `CUSTOM_STORED`). The purge cannot wipe palette/other keys because the replacement object is built from the freshly validated body, not from a mutation of the old blob.
- **"Malformed legacy notif can't wipe palette" — real.** `parseStoredPrefs` (`settings.ts:265-274`) strips the top-level `notif` key *without validating it* before running `StoredPrefsSchema.safeParse` on the remainder — so `{notif: "garbage", ...validSlices}` parses clean and the palette survives, where the old code's whole-blob `PrefsSchema.safeParse` would have nuked everything to defaults. Tested at `settings.test.ts:152-164`. The `'notif' in candidate` guard is safe on null/arrays (null excluded explicitly; `'notif' in []` is false).
- Echo semantics: PUT responds with `{notif: derived, ...stored}` (`settings.ts:344-345`) — the client's `lastSyncedPrefsRef` therefore converges on the canonical value (`Settings.tsx:726-731`), closing the loop. The removed `rowCount !== 1` branch (`git diff`, old `:230-236`) is behavior-neutral: both old branches returned the identical body; the new code echoes the same shape either way, as its comment states (`settings.ts:329-334`).

## 4. Tests — strengthened, not weakened

37 tests pass (the file grew ~180 lines net). The rewritten assertions are genuine reversion tripwires — each of these **fails** if the route goes back to blob-sourced notif:

- `settings.test.ts:189-205` — blob hand-seeded to all-ON, zero schedule rows → GET must return `NOTIF_NONE`. A blob-sourced GET returns all-on. Hard tripwire.
- `:207-217` — direct-DB no-dual-write assert (above). A restored dual-write fails the exact-equality *and* the key-absence check.
- `:219-234` — PUT body claims `daily:true, weekly:false`; seeded schedules say `weekly:true` only → echo must be the schedule truth, not the body. An echo-the-body reversion fails both directions.
- `:167-187` — derivation matrix: enabled email kinds true, disabled email kind false, enabled sms row → `channel.sms:true` but kind booleans unaffected; plus `:174-180` disabled-only email row → `channel.email:false`.
- `:517-523` — **cross-user isolation**: user A's enabled schedule rows never leak into user B's derived notif. Present, as required.
- Backward-compat: full pre-contract body accepted (`CUSTOM_PREFS` with notif used throughout, e.g. `:300-307`), body **without** notif accepted (`:254-259`), malformed notif still 400 (`:261-266`, strict posture retained per `PrefsSchema`'s `NotifPrefsSchema.optional()` inside `.strict()`, `settings.ts:201-203`).
- The pre-existing accent/languageDisplay/textSize don't-clobber suite was mechanically re-based onto `CUSTOM_STORED`/`*_VIEW` constants without loosening any of its palette-survival assertions (spot-checked all of them in the diff — every `toEqual` stayed exact-match, none degraded to `toMatchObject`/field picks except where they already were).
- Seeding is direct-SQL (`seedSchedules`, `:88-99`) into the canonical table, parameterized, weekday CHECK-compliant (`weekly_report → 0`, else NULL) — tests the route against real DB state, not mocks (per the real-corpus-data house rule).

Client tests (`Settings.test.tsx`, `settings.test.ts`) were not modified in this diff and still pass 65/65 against the updated `Settings.tsx` comments-only change — consistent, since the client's F-093 pass-through behavior itself was landed in the prior step.

## 5. Backward-compat (old deployed client)

The deployed client's `putPrefs` sends the full object including `notif` (`client/src/services/settings.ts:98-107`, `Prefs.notif` required). Server: `PrefsSchema = StoredPrefsSchema.extend({notif: NotifPrefsSchema.optional()}).strict()` (`settings.ts:201-203`) — a well-formed notif passes validation and is dropped; tested at `:300-307` and throughout. Response always carries `notif` (derived) on both GET and PUT (`PrefsView`, `:207-208`), so the old client's typed reads never see a missing field. Malformed notif remains 400 — unchanged strictness, correct posture. Confirmed graceful.

## Findings

### BLOCKER
None.

### SHOULD-FIX
1. **Route-header inverse claim overstates round-trip fidelity** — `settings.ts:216-228` says the mapping is "the exact inverse of 064's backfill", which is true of 064's *output* but not of arbitrary pre-064 blob states: the three lossy legacy classes (§1: email-on/no-kinds → email now false; sms-on → sms now false; kinds-on/email-off → kinds now false) read differently than the pre-contract GET did. No consumer is affected (§2), but the enumeration belongs in the comment (or `BUGS_AND_FEATURES.md`) so the next engineer who diffs a legacy user's before/after doesn't file it as a derivation bug. Doc-only; no code change needed.

### NIT
2. Derived kind booleans are email-channel-keyed (`settings.ts:235-236`) while the API can create enabled `push` rows (`routes/notifications.ts:55`) that would be invisible in the wire notif. Consistent with 064 and the email-only F-040 client; worth one sentence in the derive fn's doc-comment if push ever becomes real.
3. GET runs the prefs SELECT and the derive SELECT sequentially (`settings.ts:283-293`); a `Promise.all` would save one round-trip. Trivial on this route's traffic.
4. `client/src/pages/Settings.tsx:213` (`loadPrefsMock`) still fabricates `notif` from localStorage — mock-only, never adopted (`isMock` guard `:834`), but it is now the last place a client-originated notif value exists at all; drop it together with the outgoing-PUT `notif` in the final client contract step.
5. `seedSchedules` (`settings.test.ts:92-99`) inserts row-by-row in a loop; a single multi-VALUES insert would be marginally faster. Test-only.

### PRAISE
- The no-dual-write test asserting against a **direct DB SELECT** (not the API echo) is exactly the right way to pin this contract — the echo alone could lie.
- `parseStoredPrefs`'s strip-before-validate ordering is a genuine robustness improvement over the old whole-blob parse: it converts "any garbage in a dead key wipes your palette" into "dead key is dead". The dedicated test proves it.
- Deriving `notif` on **every** GET branch including the missing-row and corrupt-blob fallbacks (`settings.ts:290-293`, `:299-311`) forecloses any path that could quietly reintroduce a second source of truth.
