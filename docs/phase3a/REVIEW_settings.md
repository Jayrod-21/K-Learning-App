# Independent Review — Phase 3A Settings (F-038 / F-039 / F-040)

**Reviewer scope:** `client/src/pages/Settings.tsx`, `client/src/pages/Settings.css` (new), `client/src/pages/Settings.test.tsx`, `client/src/services/notifications.ts` (new), plus a cross-page consistency sweep over Today.tsx / Progress.tsx.
**Branch:** `feat/phase3a-core-surfaces` vs `rebuild`.
**Verification run:** `npx vitest run src/pages/Settings.test.tsx` → 49/49 pass. `npx tsc --noEmit` → clean. `npx eslint` over all five in-scope files → clean. Grep sweeps for uploads residue, dead refs, console.log/TODO → performed independently (results below).

---

## Summary verdict

**APPROVE with SHOULD-FIXes. 0 blockers, 2 should-fix, 6 nits.**

The riskiest surface — the two-way `/notifications/schedules` sync — is genuinely excellent: it mirrors the AccentProvider/TextSize template and then improves on it where the substrate differs (no localStorage durability behind schedules → rows disabled until hydrate, dirty-set survives failure). PUT-before-hydrate is structurally impossible, not merely guarded. Tests exercise real ordering with held-open promises, not tautologies. The two should-fixes are a WCAG AA contrast miss on the SMS placeholder hint text (where the CSS comment asserts the opposite of what the code does) and orphaned CSS left in the shared global sheet by the F-039/F-040 removals.

---

## Bar checklist

| Bar item | Status | Evidence |
|---|---|---|
| WCAG AA | **PARTIAL** | One miss: SMS placeholder hint text ~3.1:1 light / ~3.9:1 dark (SF-1). Everything else checks out. |
| Correct ARIA — CollapsibleTile aria-expanded/controls | PASS | `CollapsibleTile.tsx:65-92` (button + aria-expanded + aria-controls + aria-hidden/inert body); asserted for all four groups in `Settings.test.tsx:1665-1682` |
| Every notification field + SMS placeholder labeled | PASS | `Settings.tsx:2227,2244,2261,2275` — per-control aria-labels derived from row label, `(SMS)` suffix disambiguates channels; placeholder has "Coming soon" badge + explanatory note (`Settings.tsx:1160-1167`) |
| Strict TS at I/O boundary — response narrowed, no `any` | PASS | Wire `kind`/`channel` deliberately `string` (`notifications.ts:63-65`), narrowed via `isNotificationKind` before adoption (`Settings.tsx:943`); no `any` anywhere in scope |
| No swallowed errors | PASS | Schedules GET failure → ErrorCard with real `refetch` (`Settings.tsx:1124-1132`); PUT failure → error toast + Retry (`Settings.tsx:993-1002`); `canceled` correctly filtered (`Settings.tsx:988`) |
| Two-way sync mirrors template — adopt on hydrate | PASS | Hydrate-once effect, real-settle-only, mock never adopted (`Settings.tsx:932-960`) |
| — PUT on change, debounced | PASS | 400ms debounce (`Settings.tsx:1020-1024`), batches multi-kind edits (test `:1890-1916`) |
| — NEVER PUT before hydrate / no clobber | PASS | Structural: rows `disabled={!schedulesHydrated}` (`Settings.tsx:1150`); logical backstop in `onScheduleChange` (`Settings.tsx:1011`); hydrate runs while rows are disabled so adopt-over-drafts cannot clobber (`Settings.tsx:929-931`); held-open-promise test (`:1918-1950`) |
| — Partial writes + dirty-set retry on failure | PASS | Only dirty kinds sent (`Settings.tsx:963-969`); dirty set survives failure; Retry re-reads freshest drafts (`:962-1004`, test `:1952-1985`) |
| Tests exercise real behavior | PASS | 49/49; ordering tests hold hydration promises open; wire-shape asserted incl. weekday omission (`:1856`); retry re-send verified (`:1978-1984`) |
| Co-located CSS | PASS | `Settings.css` new, tokens-only, only P3a additions; legacy rules stay in `index.css` per its own header note |
| No scope creep | PASS | Settings diff confined to F-038/F-039/F-040 (+ pre-existing P3a controls untouched) |
| No console.log / TODO without ticket | PASS | Grep clean across all in-scope files |
| No dead imports/refs/CSS | **PARTIAL** | Code + exports clean under tsc/eslint; but 6 orphaned rule blocks now dead in shared `index.css` (SF-2) and one unused exported guard (N-3) |
| F-038 every tile CollapsibleTile, collapsed by default | PASS | `SettingsGroup` hard-codes `defaultCollapsed` (`Settings.tsx:1273-1276`); all four groups verified collapsed (test `:1665`) |
| F-038 text-size S/M/L still works inside tile | PASS | Test `:1702-1712` (inside Appearance tile) + full interaction tests `:1023-1173` |
| F-039 Uploads removed cleanly | PASS | Independent grep of Settings.tsx/css: zero `UploadTypeModal` / upload state / `/uploads` nav / dead imports — only doc-comments describing the removal. tsc + eslint clean. Builder's claim verified, not trusted. |
| F-040 per-type timing + labeled disabled SMS placeholder wired to /notifications/schedules | PASS | Three kinds × time (+ weekday for weekly), email channel; SMS inert with disabled controls; wire contract matches server route exactly (see consistency section) |

---

## BLOCKER

None.

---

## SHOULD-FIX

**SF-1 — SMS placeholder hint text fails WCAG AA, and the comment claims otherwise.**
`Settings.css:53-59`: `.km-settings__sched-row--placeholder { opacity: 0.75; }` with a comment asserting "Text keeps its full-contrast tokens so the labels stay readable (WCAG 1.4.3 exempts disabled CONTROLS, not the copy explaining them)." That is not what `opacity` on the row does — it dims the entire subtree, labels and hints included. Computed against the actual card surface (`--ink-1`: `#FFFFFF` light / `#141A28` dark):
- hint text (`--paper-mute`, 11px, `index.css:4988`) at 0.75 alpha → **~3.1:1 light, ~3.9:1 dark** — below the 4.5:1 AA threshold for small text;
- row label (`--paper`) at 0.75 → ~7.5:1 / ~8.5:1 — passes.

One can argue the whole row is an "inactive user interface component" and exempt under 1.4.3 — but the code's own stated intent is that the explanatory copy must stay AA-readable, and it doesn't. Fix: drop the row-level opacity and dim only the controls (the `:disabled` rule at `Settings.css:79-82` already does this), or restyle the placeholder with a border/tint treatment. Also correct the comment either way.

**SF-2 — F-039/F-040 removals orphaned six rule blocks in the shared global sheet.**
`client/src/styles/index.css:4869` (`.km-settings__channels`), `:4874/:4890/:4895` (`.km-settings__chanchip`, `--active`, `--disabled`), `:4977/:4985` (`.km-settings__toggle-row`, `--last`). Their only consumers (channel chips + intent toggle rows) were removed from `Settings.tsx` by this diff (confirmed: 6 references on `rebuild`, 0 now; no other `.tsx` file references them). `index.css` was deliberately left untouched — the same shared-file discipline that deferred the `nav.ts` comment — but unlike the nav.ts item this one is **not on the known-open-items list and has no ticket**. Fold it into the same follow-up ticket as known item (a), or delete the rules in the fix-pass if a shared-file edit is acceptable there. Not a blocker: dead CSS can't break the build.

---

## NIT

**N-1 — Profile field errors not programmatically associated with their inputs.** Inputs set `aria-invalid` (`Settings.tsx:1064,1085,1104`) and the adjacent `ErrorCard` has `role="alert"` (announces on mount), but there is no `aria-describedby` linking the error to the field, so a screen-reader user re-entering the field gets no error context. Pre-existing pattern (present on `rebuild`), not introduced by 3A — hence nit, not should-fix.

**N-2 — PUT echo not adopted as baseline.** `flushSchedules` discards the server's echoed full stored set (`Settings.tsx:975`), whereas `flushPrefs` adopts its echo (`Settings.tsx:699-703`). Harmless today (drafts are identical to what was sent, and hydrate-once semantics make cross-device staleness acceptable by design), but it is a small divergence from the prefs template and would mask any future server-side normalization. A one-line comment stating the echo is deliberately ignored would close the gap.

**N-3 — Dead export.** `isNotificationChannel` / `NOTIFICATION_CHANNELS` (`notifications.ts:45-58`) are exported and advertised by the file's threat model ("narrows with the guards below") but never consumed — `Settings.tsx:943` compares the literal `'email'` instead. Either use the guard or drop the export until a consumer (push channel) exists.

**N-4 — 🅂 mock marker uses `aria-label` on a plain `<span>`** (`Settings.tsx:1285-1291`). `aria-label` on a non-role element is unreliably exposed by AT, and what does get exposed is folded into the tile header button's accessible name. `role="img"` on the span (or moving the marker out of the button) would make it deterministic.

**N-5 — Mid-file imports.** `Settings.tsx:157-174` places an import block after `loadMeMock` (line 145). Legal (hoisted), but it hides dependencies from a top-of-file read. Pre-existing arrangement in a heavily-touched region — worth tidying opportunistically.

**N-6 — Toast Retry can fire after unmount.** The schedules failure toast's Retry closure (`Settings.tsx:997-1001`) outlives the page (toasts live in the provider) and calls `flushSchedules` against captured refs. No setState occurs so nothing breaks, and a late save is arguably the desired outcome — noting for awareness only.

---

## PRAISE (fix-pass must not undo these)

**P-1 — The schedule sync's no-clobber guarantee is structural, not incidental.** Hydration runs while every row is still disabled, so `scheduleDraftsRef.current` provably cannot have diverged from the defaults when adopt-over-drafts runs (`Settings.tsx:929-960`); `onScheduleChange` carries an explicit defence-in-depth guard for a future row that forgets its `disabled` prop (`Settings.tsx:1008-1011`). This is the correct adaptation of the prefs template to a substrate with no localStorage behind it.

**P-2 — Identity-compare dirty clearing.** On PUT success, a kind is un-dirtied only if the exact draft object that was sent is still current (`Settings.tsx:979-983`) — an in-flight edit keeps its kind dirty and its freshly-armed debounce timer re-flushes it. Correct handling of the edit-during-flight race with zero locking machinery.

**P-3 — Wire-contract fidelity.** `toScheduleInput` (`Settings.tsx:306-318`) omits the `weekday` key for non-weekly kinds rather than sending `undefined`, matching the server's `.strict()` + `superRefine` schema (`server/src/routes/notifications.ts:76-109`) exactly; the test pins it (`Settings.test.tsx:1856`). The response types keep `kind`/`channel` as `string` and force narrowing (`notifications.ts:60-76`), so a future server enum extension degrades to row-ignored, never a crash.

**P-4 — Tests verify ordering, not just outcomes.** The PUT-before-hydrate test holds the GET promise open, clicks through the disabled window, flushes well past the debounce, asserts zero PUTs, then releases the settle and asserts the unlock (`Settings.test.tsx:1918-1950`). The failed-PUT test asserts the optimistic state survives AND that Retry re-sends the same row (`:1952-1985`). The stored-sms-row test proves placeholder data can't bleed into the editable email rows (`:1756-1821`). None of these can pass for the wrong reason.

**P-5 — F-039 removal is genuinely clean.** Verified independently: zero upload-related identifiers, imports, state, or nav targets remain in Settings.tsx/Settings.css; tsc (`noUnusedLocals`) and eslint both clean; the removal test asserts absence of even aria-hidden content (`Settings.test.tsx:1717-1731`).

**P-6 — `DEVICE_TZ` resolution** (`Settings.tsx:294-301`) handles pathological embedders whose `Intl` lacks a zone, with an honest domain-appropriate fallback, and the tz is surfaced to the user in the section note (`:1136-1138`).

---

## Cross-page consistency (Settings · Today · Progress)

Consistent across the set (good):
- **Data pattern:** all three use `useEndpointOrMock` with `realFn`, honest mock loaders (empty schedules / null attempt / empty history — no fabricated data), `MockBadge` OR-ed over the page's sources, and `refetch()`-backed ErrorCard retries. No page deviates.
- **Primitive consumption:** Topbar + Bilingual eyebrow everywhere; `navItem()` as the eyebrow source in Settings (`Settings.tsx:143`) and Progress (`Progress.tsx:~119`); Today's date eyebrow is an appropriate exception. SwipeCarousel confined to Today/Progress, CollapsibleTile to Settings — matches ticket allocation, no gratuitous cross-adoption. BackButton used by none, correctly (Today.tsx:32 documents F-024 as n/a for top-level tabs).
- **CSS discipline:** each page's P3a additions live in its co-located sheet; the shared `index.css` is untouched by all three (deliberate branch discipline — see coordination). Settings.css and Today.css are tokens-only. No console.log, no TODO/FIXME anywhere in the set.

Inconsistencies (all cosmetic, none blocking):
- **BEM element casing drifts per page:** Settings is kebab-case throughout (`__sched-row`, `__group-head`); Today is camelCase (`__tileIcon`, `__taskPage`); Progress mixes both (`__historyPage`, `__trendHead` vs `__card-title`, `__select-label`). Worth a convention note before P3b compounds it.
- **Eyebrow primitive vs raw class:** Settings (`Settings.tsx:1140`) and Progress (`Progress.tsx:350,491`) use the `<Eyebrow>` component; Today hand-rolls `<div className="km-eyebrow" style={{marginBottom:10}}>` (`Today.tsx:429,462`).
- **Spacing style:** Today leans on inline `style={{ marginBottom: 16 }}` for section rhythm; Settings/Progress use classes. Pre-existing Today idiom, but it diverges from the co-located-CSS posture the other two pages follow.
- **Hard-coded colors:** Progress.css:26-36 introduces raw hex series colors (with a documented ΔE color-blindness rationale and light/dark variants) where Settings.css declares "tokens only." Justified for chart series, but the token-only rule stated in Settings.css:7 is not universal across the set — fine, just don't let the Settings sheet's claim be read as a repo invariant.

---

## Coordination observations

- **Known open items confirmed correctly deferred, not silently dropped:** (a) `client/src/lib/nav.ts:280-282` still says Uploads is "reached from Settings → Uploads" — stale, untouched as planned; (b) legacy notif intent booleans are wire-echo-only — `notifEqual` + verbatim echo remain (`Settings.tsx:362-370, 858-867`), no UI reads or writes them, and the file comments state the plan to drop them server-side; (c) `/uploads` route + `Uploads.tsx`/`UploadTypeModal.tsx` remain mounted, so typed-URL reachability holds until F-057–F-059.
- **SF-2 should ride the same follow-up ticket as known item (a)** — both are "shared-file edits deferred for branch hygiene," but only (a) is currently recorded.
- **Client/server contract is in lockstep:** the client's 1–9-row partial PUT, per-(kind,channel) upsert expectation, weekday-iff-weekly rule, and `placeholder: true` sms flag all match `server/src/routes/notifications.ts` (schema `:76-135`, serialization `:165-176`) exactly. No drift for the fix-pass to introduce.
- **Test-suite provider stack** (`Settings.test.tsx:138-154`) mirrors the App.tsx order including the new TextSizeProvider — any future provider added to App.tsx must be added here too or hydration tests will silently test a different tree.
