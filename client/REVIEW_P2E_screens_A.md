# Independent review — Pass 2 screens A (Today / Reading / Review / Chat)

> Reviewer: independent senior engineer (30 yrs).
> Scope: `pages/{Today,Reading,Review,Chat}.tsx` + `.test.tsx` + CSS additions
> in `styles/index.css` for `.km-today*`, `.km-reading*`, `.km-review*`,
> `.km-chat*`.
> Method: read Reading + Review fully; sampled Today + Chat; cross-checked
> domain types, mocks, supporting components (Tapword, KoreanPassage,
> Flashcard, WordPopover, AudioBlock, Sheet, Toggle, useEndpointOrMock).
> Date: 2026-05-29.

## Verdict

**PASS WITH CONDITIONS.** The four screens hit their Pass 2 contracts (mock
plumbing, MockBadge, tabs/sub-tabs, flashcard flip, tap-anything gesture,
register-aware chat, FSRS rating buttons) and the visual fidelity to the
design HTML is high. The tests gate each screen's contract (loading +
primary interaction) without over-specifying. **However**, three issues
genuinely need to land before this code carries weight in Pass 3 wiring:
a state-reset race in Chat that wipes user-sent turns, a missing keyboard
handler on grammar spans (a11y regression vs the canonical "tap-anything"
gesture), and an empty-state misuse in Review/AllPanel that surfaces normal
"empty bank" as a hanji-vermilion error card with a hard reload button.

Roll-up:

| Category | Count |
|---|---:|
| BLOCKER | 0 |
| SHOULD-FIX | 9 |
| NIT | 12 |
| PRAISE | 9 |

## BLOCKERs

None. Nothing on the screens prevents merge — but several SHOULD-FIX items
are close to the line; treat them as "must fix this pass" not "next pass".

## SHOULD-FIX

### SF-1. `Chat.tsx:123-125` — `useEffect(() => setMsgs(seed), [seed])` wipes user-sent turns on any seed identity change

The local thread (`msgs`) is replaced with `seed` every time `seed`'s
identity changes. `seed` is a `useMemo` over `[data, settings.name]`. If the
user is mid-conversation and `settings.name` updates (Settings screen edit,
Pass 3+ profile sync, palette swap re-render that touches the provider's
value identity, etc.), the local thread — including the user's sent
messages and the canned tutor reply — is silently destroyed and reseeded.
Even within Pass 2, a name update in a separate tab via SettingsProvider's
storage-sync path would trigger this.

The intent (per the comment) is "replace is intentional, because the
personalised first message is the source of truth." But the implementation
overshoots: it discards every later message too. The conventional fix is to
seed `msgs` from `seed` ONLY on `data` arriving (replace), then on name
change patch only `msgs[0]`:

```ts
// Replace only when data arrives (seed loaded for the first time).
useEffect(() => { if (data) setMsgs(personalise(data, settings.name)); }, [data]);
// On settings.name change, patch msgs[0] in place — preserve later turns.
useEffect(() => { setMsgs((cur) => cur.length ? [personalise([cur[0]], settings.name)[0], ...cur.slice(1)] : cur); }, [settings.name]);
```

(Pseudocode — keep the existing `personalise` predicate guard for non-tutor
first turns.)

### SF-2. `KoreanPassage.tsx:133-145` — grammar-span has `onClick` but no role, tabIndex, or key handler

The spec's defining gesture is "tap anything". Tapwords are keyboard-
accessible (`role="button"`, `tabIndex={0}`, Enter/Space handler — good).
The grammar `<span class="gram-span">` wrapping a token run is mouse-only:

```tsx
<span key={…} className="gram-span" onClick={() => onOpenGrammar(gid)} title="Grammar pattern — tap to study">
```

No `role`, no `tabIndex`, no key handler. Keyboard + screen-reader users
cannot reach the grammar popover at all. This is a strict regression vs the
Pass 2 "tap-anything gesture" criterion stated in the integration plan and
README §3. Mirror the Tapword pattern: `role="button"`, `tabIndex={0}`,
`onKeyDown` for Enter/Space, `aria-label="Grammar pattern"`.

### SF-3. `Review.tsx:699-706` — empty bank ("0 banked cards") renders as a vermilion `ErrorCard` with "Retry" → `window.location.reload()`

```tsx
if (cards.length === 0) {
  return <ErrorCard message="No cards in your bank yet." onRetry={retry} />;
}
```

Three problems:
1. Empty state ≠ error. The card border is `var(--vermilion)` and labelled
   "Couldn't load" — copy lies about state.
2. The Retry button calls `window.location.reload()`, which won't add cards
   to an empty bank; clicking it is a no-op that throws away unsaved UI
   state.
3. Empty state is a legitimate first-run experience for a brand-new user
   — surfacing it as an error condition will read as a bug.

Either render a quiet empty-state Card ("Your bank is empty. Mine words on
Reading or Chat to start."), or split `ErrorCard` from `EmptyCard` and
route accordingly.

### SF-4. `Today.tsx:222-235` — Listening tile hardcodes `tag="Largest gap"`, Writing hardcodes `tag="Register drill"`, regardless of plan data

The design integration plan (Pass 4 spec) says `/plan/today` returns a
`largestGap` string and only the matching tile gets the gold pill. Type
`TodayPlan` currently has no `largestGap` field, and Today.tsx always
paints `Largest gap` on Listening and `Register drill` on Writing. When
Pass 4 wires the real endpoint and a reading-weak user gets `largestGap:
"Reading"`, this screen will lie. Add `largestGap` (and probably a
`writingTag` or per-task `tag`) to `TodayPlan`, branch the tile, and let
the mock keep the current literal values for Pass 2.

This is in scope for Pass 2 because the type contract is established here
— `TodayPlan` is the wire shape Pass 4 will mirror.

### SF-5. `Reading.tsx:151` + `Review.tsx:147` + `Today.tsx:127` + `Chat.tsx:133` — `retry = () => window.location.reload()` is the wrong abstraction

Every screen retries via full-page reload. This:
- Drops popover/sheet state, scroll position, and all sibling-screen state.
- Defeats the abort-aware refetch path already built into
  `useEndpointOrMock` (a `key` change would refetch cleanly).
- Comments on Today.tsx (lines 123-126) explicitly acknowledge it's wrong:
  "Reload trick: bumping window.location reload is too coarse … A proper
  retry flow lands with the toast system in Pass 3."

The fix is one line: bump a `refetchKey` state (a counter) and pass it
into `useEndpointOrMock(key + ':' + refetchKey, …)`. Add this now and the
Pass 3 toast layer just calls the same retry. Leaving four `location.reload`
calls in production code is below the senior-engineer bar.

### SF-6. `Review.tsx:125-139` — Spacebar handler is window-scoped, listens during sheets too

```ts
useEffect(() => {
  if (tab !== 'session' || !card) return;
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== ' ' && e.key !== 'Spacebar') return;
    const active = document.activeElement;
    const tag = active?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    …
```

When `ListDetailSheet` or `CreateListSheet` is open over the Session tab,
pressing Space anywhere outside an input flips the underlying card. The
INPUT/TEXTAREA guard catches the CreateList textareas but not, e.g., a
focused button inside the sheet. Either gate on a "card visible" state (no
sheet open) or move the listener onto the Flashcard's `onKeyDown` since
the card is already `tabIndex={0}` (the listener only fires when the user
focuses the card — semantically cleaner than the window-level escape
hatch).

`Spacebar` (legacy IE key string) is also redundant alongside `' '` —
trim it.

### SF-7. `Review.tsx:141-145` — `rate()` discards the rating, always advances

```ts
const rate = (): void => {
  setFlipped(false);
  setDrawer(false);
  setIdx((i) => i + 1);
};
```

The four FSRS buttons (Again / Hard / Good / Easy at lines 416-426) all
bind to the same `onRate={onRate}` with no rating-id passed. The
prototype's prototype-ness aside, this means the rating data is *not
captured anywhere* — not even logged. When Pass 3 wires `PUT /progress/
:cardId` it will need the rating id, and adding it later means rewiring
every button binding. Wire it now: `onRate(rating: RatingDef['id'])` and
push `setIdx + setFlipped` into a local handler that calls `onRate(r.id)`.
Even if Pass 2 doesn't persist, the prop shape is correct from day one.

### SF-8. `Review.tsx:195` + `SessionPanel:262,308-315` — `error` prop is derived from `!vocab.data || !lists.data`, mis-fires on first paint and on legitimate empty list

`error={!vocab.data || !lists.data}` is `true` whenever either fetch hasn't
resolved or returned. Inside `SessionPanel`, the `loading` guard runs
first, so loading state wins — fine. But on a session where the user has
no banked cards at all, `vocab.data` is an empty array (not null), so
`error` would actually be `false`; OK. The bug only bites if mock loader
ever returns `null` (it doesn't today, but the typing allows it). Tighten
by switching to `error={vocab.error !== null || lists.error !== null}` —
the hook already exposes typed `error`. Fixes the over-eager error path
for free.

### SF-9. `Today.tsx` + `Reading.tsx` + `Review.tsx` + `Chat.tsx` — `MockBadge` is rendered as a sibling to the title, but a11y order puts it before the screen heading

The badge is positioned absolutely (presumably) via `position: relative`
on the section, but in DOM order it comes before the Topbar:

```tsx
{isMock ? <MockBadge /> : null}
<Topbar krTitle={…} eyebrow={…} />
```

For screen-reader linearisation, the user hears "🅂 Mock" before the
screen title. Move `MockBadge` after Topbar (or `aria-hidden="true"`
since the corner stamp's purpose is visual). The integration plan says
"dev-only corner badge so mocks can't ship by accident" — visual
intent, not a11y intent.

## NITs

### N-1. `Today.tsx:46-52` — `formatDateEyebrow` is locale-hardcoded `'en-US'`

The user's `Settings` has no locale yet, and the design's eyebrow is in
English ("Monday, May 28"), so this is the right call now. But the
function is unsplit — when locale comes (Pass Final i18n), this becomes a
sed-and-pray refactor. Tiny: take `locale = 'en-US'` as a second arg and
default it. One-line guard against future surprise.

### N-2. `Today.tsx:69-71` — `isCeiling: r.id === 'native'` re-implements logic that lives in the type

`DiagnosticReference.id` discriminates `'native'` from `'L3'|'L4'|'L5'|'L6'`
in the type. The mapping `id === 'native' → ceiling tick` is application
truth. Either pull this into a `toCeiling(r: DiagnosticReference): boolean`
helper colocated with `DiagnosticReference`, or push it into the mock
fixture as an explicit `isCeiling: true`. Inline string equality with no
type narrowing is fine; it's just a future-coupling sniff.

### N-3. `Today.tsx:79-88` — `SkeletonCard` renders `<></>` as `Card`'s children to satisfy required `children`

```tsx
<Card variant="default" aria-busy="true" style={{ minHeight: 120, opacity: 0.55 }}>
  <></>
</Card>
```

Card's children is required; fragment-as-children is acceptable but
deserves a `children?: ReactNode` on `CardProps` so this stops being a
workaround. Duplicated identically in `Reading.tsx:37-46`, `Review.tsx:54-64`,
`Chat.tsx:49-59` — four screens each carrying the same boilerplate.

Cleanest fix: lift a shared `SkeletonCard({ height = 120 })` into
`components/SkeletonCard.tsx`. The repetition is exactly the kind of
"third occurrence → extract" the senior-engineer bar covers.

### N-4. `Today.tsx:99-110` + Reading/Review/Chat — identical `ErrorCard` definition copied four times

Same observation as N-3 but for the error card. Lift to
`components/ErrorCard.tsx`. Both refactors land one PR.

### N-5. `Review.tsx:118` — `cards[idx % Math.max(1, cards.length)]` is wrong when `cards.length === 0`

`Math.max(1, 0) === 1`, so `idx % 1 === 0`, so `cards[0] === undefined`.
That's fine because the next line `?? null` saves the screen — but the
mod-by-1 hides intent. Just `cards[idx] ?? null` is equivalent and reads
honestly. The mod was presumably meant for `idx >= cards.length`
wrap-around, but `rate()` keeps incrementing `idx` past `cards.length`
indefinitely. The session also never marks itself "done" — Pass 3 problem.

### N-6. `Review.tsx:167-189` — `role="tablist"` / `role="tab"` but no `role="tabpanel"` on the panel bodies, no `aria-controls`

Each tab announces "selected" correctly, but screen-reader users can't
tell which region the tab governs. Add `aria-controls={panelId}` on
buttons and `role="tabpanel" id={panelId}` on the active panel container.
WAI-ARIA tabs pattern; well-documented. Five lines.

### N-7. `Review.tsx:1-1024` — file is 1024 lines

Five `function` components (`Review`, `SessionPanel`, `ListsPanel`,
`AllPanel`, plus row helpers and sheets) live in one file. The screen is
the surface and ownership is clear, but the sub-panels are easily
extractable to `Review/SessionPanel.tsx` etc. (matches the pattern
`KoreanPassage` already uses with internal `Sentence`). Not load-bearing
for Pass 2; rolling into Pass 3 wiring split is fine.

### N-8. `Review.tsx:797-812` — `ListDetailSheet` re-implements `findActiveList`'s search across `bundle.custom` + `bundle.sources[].lists`

Two implementations of the same lookup (lines 90-100 and 797-812). Pull
into one helper:

```ts
function findListById(bundle: VocabListBundle | null, id: string | null):
  { list: CustomVocabList | SourceVocabListItem; source: SourceVocabGroup | null } | null
```

…and use it from both places. DRY rule-of-three not quite triggered, but
two identical traversals on the same data structure are noisy.

### N-9. `Review.tsx:586-613` — `SourceGroupRow` uses `.km-review__source` as the *container* class, but the same class is used at line 377 for the `.km-review__source` italic text style on the flashcard back. Class name collision.

Two unrelated CSS rules share the class name:
- Line 2014: `.km-review__source { font-size: 13px; color: var(--paper-dim); font-style: italic; }` (flashcard "Seen in" line)
- Line 2153: `.km-review__source { margin-top: 8px; }` (source group container)

The second declaration overrides the first when the elements were
intended to be different things. As written the flashcard's source line
is OK because the cascade order is fine, but this is exactly the kind of
shadow that breaks on the next CSS edit. Rename one — perhaps
`.km-review__cardSource` and `.km-review__sourceGroup`.

### N-10. `Chat.tsx:140` — `userTurn` has `en: ''` (empty string), so the EN bubble is hidden by `showEn && msg.en` — works, but ambiguous

Better: make `ConversationMessage.en` optional (`en?: string`) so omitting
the field is structurally meaningful, and the Bubble guard becomes
`showEn && msg.en` semantically.

### N-11. `Reading.tsx:107-116` — `openWord`'s `kind: undefined`

```ts
setPopData({
  kind: undefined, // vocab branch in WordPopover
  …
});
```

`WordPopoverData.kind?: 'grammar'` — omitting the field is the
type-correct way. `kind: undefined` is the same value but more code. Drop
the line and the explanatory comment with it. Minor.

### N-12. `Chat.test.tsx:81-93` — Send-message test relies on `setTimeout`-scheduled tutor reply but doesn't `vi.useFakeTimers()`

The test sends a user message, asserts the user bubble appears, and
finishes. It happens to pass because the `600ms` tutor reply is scheduled
but the assertion runs before it fires. If a maintainer extends the test
to assert the tutor reply, they'll discover the race; lock the timing
down now with `vi.useFakeTimers()` + `vi.advanceTimersByTime(600)`
patterns, OR document why timers are intentionally real ("we don't care
about the canned reply for this test").

## PRAISE

### P-1. `Reading.tsx:21-22, 91-100, 117, 144-149` — minedIds/bankedGrammar tracked as `ReadonlySet<string>`, set via immutable `new Set(prev).add(…)` pattern

Correct immutable-Set update for React state. No `prev.add(…); return prev`
foot-gun anywhere. The `ReadonlySet` type discourages mutation at call
sites too — well-done plumbing for what's normally a leak point.

### P-2. `useEndpointOrMock` — abort-aware, key-driven refetch, no exhaustive-deps lint suppression except where load-bearing, ApiError typed surface

The hook is rock-solid. The `raceAgainstAbort` helper is exactly the
right primitive, the `safeSet` closure eliminates the stale-write footgun
that breaks most hand-rolled fetch hooks, and the documented "key is the
only refetch trigger" contract is honest. The four screens take
advantage of it well (loading guards, isMock badge plumbing). The
explicit `eslint-disable-next-line` is targeted, not blanket.

### P-3. `Today.tsx:175-191` — Review-queue CTA as a single `<button>` with `aria-label` that includes the count

`aria-label={`Open review — ${reviewCount} cards due`}` — screen reader
gets the count in the same announcement as the action. Better than the
visual tree's mixed Pill + count + meta lines would convey by default.

### P-4. `Review.tsx:383-394` — `e.stopPropagation()` on the drawer-toggle button inside the Flashcard back face

Most engineers ship the bug where the flashcard outer onClick flips the
card every time the user wants to toggle "More examples". This catches
it explicitly with a code comment that explains why.

### P-5. `Review.tsx:909-936` — `CreateListSheet` resets form state on close, no submit-on-Enter in the textarea

Form reset on `handleClose` (lines 920-926) avoids the stale-input bug.
The Enter-from-name handler only fires from the *name* input, not the
textarea — correct ergonomics. Both are commented with the rationale.

### P-6. `Chat.tsx:84-100, 14-19 (threat-model)` — name interpolation is documented as XSS-safe because React escapes children, NOT because the input was sanitised

This is the right threat model. Sanitising user-controlled name would be
the wrong defence (it's a Korean name field, should accept ANY string);
relying on React's children-as-text contract is the correct invariant.
The comment also calls out the trap: never add a `dangerouslySetInnerHTML`
path without a sanitiser. Exactly the senior-engineer-bar mode.

### P-7. `Reading.tsx:75-81` + `Chat.tsx:127-131` — transcript / scroll effects bounded by refs, no infinite loops

`buildTranscript` is `useMemo`'d on `data`. The Chat thread-scroll
effect reads from `scrollRef.current` and updates `scrollTop`
imperatively — not via state — so it can't loop with itself. Small but
load-bearing detail.

### P-8. Tests use `vi.hoisted` to share mutable mock state with `vi.mock` factories

`Today.test.tsx:19-27`, `Reading.test.tsx:12-17`, `Review.test.tsx:13-21`,
`Chat.test.tsx:13-18` — all use the `vi.hoisted` pattern to avoid
TDZ at mock-factory time. Notably commented in the Today test for the
next maintainer. This is the correct pattern; many teams ship the TDZ
bug.

### P-9. CSS `.km-review__rating--good { color: var(--indigo); }` — Good rating tint uses indigo per the design palette discipline

Most engineers reach for green-for-good. Sticking to the palette's
indigo-grammar / moss-correct / vermilion-incorrect / paper-mute-neutral
discipline (per the README's "one primary accent" note) is the kind of
detail that compounds into the hanji feel. Same care visible in the
sub-pill choice on `SourceGroupRow` (grammar → red/indigo, mixed → ochre,
vocab → gold).

## Cross-cutting observations

1. **Boilerplate per screen ≈ 30 LOC.** `SkeletonCard` + `ErrorCard` +
   `retry = () => window.location.reload()` are duplicated four times.
   Lift into `components/{SkeletonCard,ErrorCard}.tsx` and a shared
   `useRefetchKey()` hook before Pass 3 doubles down on the pattern.

2. **`window.location.reload` is the wrong retry primitive.** Touched in
   SF-5, but mentioning again because every screen has it. The hook
   supports `key`-driven refetch; use it. The Pass 3 toast layer
   shouldn't need to rewire this — it should pluck the existing retry fn.

3. **Tab/sub-tab a11y is 80% there.** `role="tablist"/tab"/aria-selected`
   is wired in Review; missing `aria-controls`/`tabpanel`. Mirror this in
   any other screen that ports a sub-tab pattern (Hanja Today vs Index,
   Diagnostic intro/take/done/results) in later passes.

4. **The grammar-span keyboard gap (SF-2) is the most surprising
   regression** because the tap-anything gesture is THE app's tagline.
   Worth treating as a high-priority SHOULD-FIX, just below the BLOCKER
   line.

5. **All four tests gate the contract correctly** (loading + primary
   interaction + render-when-data-loaded). None over-specify. None mock
   internal components. Test failure modes correspond cleanly to UX
   regressions — the right shape for screen contracts.

## Recommendation

Dispatch a fix-pass agent against:
- All 9 SHOULD-FIX (none are gold-plating; SF-1/2/3 are user-visible
  bugs, SF-4/5/6/7 are correctness-and-future-proofing, SF-8/9 are
  small).
- NITs to fold while editing same files: N-3, N-4 (lift skeleton/error
  cards — one PR, four screens), N-5, N-6, N-8, N-9 (rename), N-11.
- Skip in this pass: N-1, N-2, N-7, N-10, N-12 (true polish; queue for
  Pass Final).

Once SF-1, SF-2, SF-3 close, the screens are honestly Pass-2-done. The
remaining SHOULD-FIXes are the kind of "don't ship technical debt into
Pass 3" that the senior-engineer bar demands.
