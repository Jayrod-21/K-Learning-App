# Build note — In-app guided tutorial / product tour

Branch: `feat/tutorial-tour` (off `rebuild`). Library: **driver.js 1.7.0**.

## What shipped

Coach-mark tours (spotlight + arrow popover) that walk a user through the app:
a first-run welcome flow on first login, plus per-surface mini-tours that fire
the first time each major surface is opened. Completion state is server-synced
through the existing `/settings/prefs` JSONB blob, so a tour never re-fires —
on this device or another.

## Architecture

### Registry — `client/src/lib/tours.ts`

Pure data, no React, no driver.js import. Each tour is

```ts
{ id: TourId, steps: [{ target?: '[data-tour="key"]', title, body, side? }] }
```

- `TourId` is a **closed union** (compile-time exhaustive `TOUR_IDS` list) —
  ids are client-defined, never user input.
- Steps anchor via `data-tour="<key>"` attributes added to the real elements
  (never CSS class names — F-098 will rename those). A step with no `target`
  renders as a centered modal popover (used for welcome/outro copy).
- Surface tours carry the route they belong to; `surfaceTourForPath(pathname)`
  maps the current URL to its tour (exact match, except the upload viewer's
  `/uploads/:id` prefix rule).

### Driver wrapper — `client/src/lib/tourDriver.ts`

The only module that imports driver.js. `startTour(def, opts)`:

- Filters out anchored steps whose element is not currently in the DOM
  (missing-target guard). If a tour has anchored steps and **none** resolve,
  it reports `'unavailable'` and nothing runs — and the tour is *not* marked
  seen, so it retries on the next visit instead of burning its one shot on a
  half-loaded page.
- Respects `prefers-reduced-motion` (`animate: false`), Esc / overlay-click to
  dismiss (`allowClose`), keyboard next/prev, progress "n of m" text.
- `disableActiveInteraction: true` — the highlighted element is not clickable
  mid-tour, so a tour can never trigger a navigation that strands itself.
- `onDestroyed` (fires for finish *and* skip/Esc) → the caller's `onFinished`,
  which is what persists the seen-mark. Returns a handle with `destroy()` for
  unmount/route-change cleanup.

### Trigger + state — `client/src/hooks/TourProvider.tsx` (+ `tour-context.ts`, `useTour.ts`)

Mounted in `Shell` (inside `ExamActiveProvider`, above the `<Outlet/>`), so it
only exists for authenticated users and every page can reach it.

- **Seen-state is two-tier**, mirroring the accent/textSize posture:
  `localStorage["km.toursSeen"]` is the same-device fast path (written
  synchronously on mark-seen); the `toursSeen` array in `/settings/prefs` is
  the cross-device truth.
- **Boot hydration**: one `GET /settings/prefs` on mount; the server's
  `toursSeen` is union-merged into the local set. Auto-fire decisions **wait
  for hydration to settle** (success or failure) so a seen-elsewhere tour
  never flashes before the server answers. On fetch failure we fall back to
  the local set — worst case a tour re-fires once and is Esc-dismissable.
- **Trigger rule** (effect on `[hydrated, pathname, seen, examActive]`):
  first-run tour if its id is unseen; otherwise the current surface's tour if
  unseen. Fires after a short paint-settle delay. Suppressed entirely while a
  mock exam is active (`useExamActive`) and while another tour is running.
- **Persistence**: finish or skip marks the id seen — local set + localStorage
  immediately, then a read-merge-write server sync (`GET` fresh prefs, union
  `toursSeen`, `PUT` the full blob) so a palette change made since boot is
  never clobbered. Sync failure is non-fatal (localStorage holds the mark).
- `replay(id)` runs a tour imperatively regardless of seen state (Settings
  control); `markAllSeen()` is the "skip all tours" affordance.
- Route change or unmount destroys an in-flight tour.

### Server — `server/src/routes/settings.ts`

`toursSeen` added to `StoredPrefsSchema`:
`z.array(z.string().min(1).max(64)).max(200).default([]).catch([])`.

- `.default([])` — a legacy blob without the field parses cleanly and comes
  back filled in, **without** wiping the stored palette/textSize (the same
  JSONB deep-merge posture `languageDisplay` uses; no migration needed).
- `.catch([])` — a corrupt/oversized stored value coerces to "none seen"
  rather than failing the whole-blob parse.
- The schema stays `.strict()` at every level: unknown keys are still a 400
  (no mass-assignment). Ids are opaque bounded strings server-side — the
  closed set lives in the client registry; a hard server enum would 400 stale
  clients every time a tour is added.
- Nothing sensitive enters the blob: the field is a list of UI-tour ids.

### Settings screen integration

- `services/settings.ts` `Prefs` gains `toursSeen: string[]`; the Settings
  screen's PUT bodies source it **live** from `loadSeenTours()` (the
  localStorage store the provider writes synchronously) rather than from its
  hydration baseline — so a Settings-driven palette PUT can never carry a
  stale tour list and wipe a just-finished tour. `toursSeen` is deliberately
  *not* in the screen's change-diff: the TourProvider is the sole writer that
  *initiates* PUTs for it.
- New **Help & tours** section in Settings (`TourControls`, rendered above
  About): "Replay the welcome tour", a per-surface replay picker, and
  "Skip all tours". The component reads the tour context leniently (renders
  null when no provider is mounted) so the enormous existing Settings test
  suite doesn't need a provider wrapper.

### Theming — `client/src/styles/tour.css`

driver.js's stock stylesheet is imported once (in the wrapper module) and
overridden with app tokens: `--ink-3` popover surface, `--paper` ink,
`--vermilion` (accent-preset-driven — follows the user's Seoul-neon accent
choice automatically) for the progress/next affordances, `--radius-lg` corner
language, and the display serif for titles. Both `data-theme="light"` and
`"dark"` read correctly because every color routes through the existing
theme-scoped tokens.

## Tours shipped (11)

| id | fires on | steps |
|----|----------|-------|
| `first-run` | first authenticated boot, any page | 9 |
| `library` | first visit `/review` | 3 |
| `topik` | first visit `/learn/topik` | 3 |
| `listen` | first visit `/learn/listen` | 3 |
| `flashcards` | first visit `/learn/vocab` | 4 |
| `grammar` | first visit `/learn/grammar` | 3 |
| `writing` | first visit `/learn/writing` | 4 |
| `hanja` | first visit `/learn/hanja` | 4 |
| `reading` | first visit `/learn/reading` | 3 |
| `uploads` | first visit `/uploads` | 3 |
| `upload-viewer` | first visit `/uploads/:id` | 3 |

Anchors added (all `data-tour` attributes on real controls): BottomNav tab
buttons + LEARN hexagon, Sidebar links + Learn section (desktop gets the same
tour — same keys, whichever chrome is mounted resolves), ChatFab, Today's
review-and-drills section, ReviewLibrary section nav, Topik's Study/Mock
chooser, Ttmik collection tiles, Review's study-due CTA + lists block,
Grammar's practice CTA, Writing's task-type picker + editor entry, Hanja's
study/draw CTAs, Reading's book shelf, Uploads' new-upload button, and the
UploadViewer's Extract-text (OCR) + zoom controls.

Surfaces NOT anchored, and why: PastExams (`/review/exams`) is covered by copy
in the `topik` and `library` tours rather than its own tour — it's one list
with a self-explanatory header, and an eleventh popover sequence there read as
nagging. Diagnostic/Images/Chat likewise get no mini-tour: Chat is pointed at
by the first-run tour's FAB step; Diagnostic is a guided wizard already.

## Test coverage

Client (`TourProvider.test.tsx`, `tours.test.ts`, driver wrapper mocked):
first-run fires on empty `toursSeen` / not when present; surface tour fires on
first visit, not second; finish persists (PUT shape asserted); replay re-runs
a seen tour; skip-all suppresses everything; missing-target tour doesn't run,
doesn't crash, isn't marked seen; registry integrity (unique ids, every
surface path resolves, selector format). Settings tests extended for the new
field; services fixture updated.

Server (`tests/routes/settings.test.ts`): round-trip accepts + returns
`toursSeen`; fresh user defaults to `[]`; legacy blob without the field
coerces without wiping palette/textSize; corrupt element coerces to `[]`;
`.strict()` still rejects unknown keys; oversized array rejected on PUT.

## Gate results

Filled in at commit time — see final report:

- Client: lint 0 · tsc 0 · vitest (touched files) PASS · vite build PASS
- Server: typecheck 0 · settings route suite PASS
