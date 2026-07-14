# REVIEW — LEARN Batch B (Listen / Writing / TOPIK / Chat / Tickets / Settings / LearnMenu launcher)

**Design-fidelity + whole-app-consistency capstone review**
Branch `feat/redesign-learn-b` @ `fae8223` (off `rebuild`). Reviewer: independent senior design-engineer (did not author this code). No code was changed by this review.

Contract: `DESIGN_SEOUL_DAY_NIGHT.md` + mockups `km-learn2.html` (Listen/Writing/TOPIK), `km-final.html` (Chat/Tickets), `km-prototype.html` (Settings/launcher).

---

## Verdict

**PASS for the seven in-scope surfaces — zero BLOCKERs.** All seven fully reskin in both worlds via `data-theme`, adopt the real character-device components (not a flat token reskin), keep the accent picker orthogonal, keep bilingual + per-tile progress intact, and match their mockups. Grep confirms **no hardcoded hex** anywhere across the seven pages + `LearnMenu` (`.tsx` and `.css`). Every shared token and device utility they consume (`--on-vermilion`, `--vermilion-bright`, `--radius-lg`, `km-tone--accent`, `km-giwa`, `km-hangul-watermark`, `km-rain-sheen`, `km-neon-text`) is defined and pre-existing.

Because this is the final page-rework batch, I ran the whole-app capstone sweep, and it surfaces two genuine drifts that are **out of batch-B's edit scope but must be filed before beta** — they are the reason the app is not yet "one app": `Images.tsx` still renders the legacy flat `Topbar`, and `MockMode.tsx` (the timed-exam body reachable straight from this batch's new TOPIK chooser) is entirely unreskinned. Neither blocks this PR; both are coordination follow-ups (below).

---

## Fidelity checklist

| Surface | Devices present | Matches mockup? | Consistent w/ shipped app? |
|---|---|---|---|
| **Listen (Ttmik)** | #1 CityCard tiles (blue/mint fixed tone) + reader cards, #2 rail, #3 giwa, #5 —, #6 watermark, #8 rain-sheen; PageHubHeader (#4/#2) | Yes — 2-across blue-vs-mint square grid + player-over-transcript stack per `km-learn2` Listen | Yes — mirrors Reading's Resume/Generate fixed-tone CityCards + chapter-reader treatment |
| **Writing** | #1 CityCard hero (`rail tone=accent`), #3 giwa, #6 watermark, #8 rain-sheen; PageHubHeader | Yes — "AI Prompt" promoted to a 3rd top-level chip beside Q53/Q54, topic-sign + answer-sheet stack | Yes — hero-surface convention matches Grammar live-drill / Reading reader |
| **TOPIK (landing/attempts/study)** | #1 CityCard tally+study hero, #2 rail, #5 SubwayProgress, #6 watermark, #7 SealStamp milestone, #8 rain-sheen; shared **Sheet** chooser; PageHubHeader | Yes — Study/Mock chooser as bottom Sheet, daily subway progress, "Set complete" stamp | Yes — CollapsibleTile `surface="city"` attempts tiles + SubwayProgress match shipped Progress |
| **Chat** | #1 CityCard (ask-popup, `feat`), #2 rail (current conv row), #3 giwa thread ground, #6 watermark (empty only), #8 rain-sheen; PageHubHeader (height-capped) | Yes — labeled EN toggle chip, "+" round attach, tone bubbles, auto-named chats | Yes — bubble treatment reads off the same `--km-tone` mechanism as CityCard/DancheongRail |
| **Tickets** | #1 CityCard rows + detail + comment cards (`tone=plain`), #2 rail, #6 watermark, #8 rain-sheen; shared **Sheet** file-form; PageHubHeader | Yes — rows + "+ New" → bottom Sheet + "reported from" provenance per `km-final` | Yes — `.km-tickets__card.km-citycard` padding idiom mirrors Uploads rows |
| **Settings** | #1 CollapsibleTile `surface="city"` per group, #2 rail per fixed group tone, #8 rain-sheen; PageHubHeader; F-129 mobile pass | Yes — collapsible Appearance/Notifications/Beta groups per `km-prototype` Settings | Yes — CollapsibleTile `surface="city"` is the shipped Library idiom |
| **LearnMenu launcher** | #1 per-tile signboard/wash glow, #3 giwa (backdrop + per-tile), #6 —, #8 rain-sheen, #7 neon-flicker mount, accent-tracking neon-box/neon-text | **Partial** — true 2-3-2 honeycomb vs the mockup's 2-2-2-1 grid; see S4 | Mostly — hero launcher carries the most devices; per-tile hue tokens intact |

---

## Whole-app consistency findings (headline — the capstone)

**The app is one batch-and-two-files away from reading as a single system.** Within everything that has been through a redesign batch (Today/Progress, Library, LEARN-A, and now LEARN-B) the shared vocabulary is now genuinely uniform: `PageHubHeader` is the top chrome on every reskinned page; `CityCard` / `CollapsibleTile surface="city"` / plain `Card` are used for consistent jobs (hero vs collapsible-group vs quiet-panel); the giwa + hangul-watermark "honest empty state" discipline is applied identically; `SubwayProgress` / `SealStamp` / rain-sheen conventions match; skill-hue vs accent stays orthogonal everywhere I checked.

**The two remaining drift sources are both outside this batch's declared scope but are what stops the "one app" claim from being fully true today:**

1. **`Images.tsx` is the last page in the entire app still on the legacy flat `Topbar`** (`pages/Images.tsx:56,235`). It is a routed, nav-listed page (`App.tsx:140` `path="images"`, `nav.ts:265`). It was never assigned to any redesign batch. This is the single literal answer to "any lingering flat Topbar in the whole app?" — yes, one.

2. **`MockMode.tsx` (the TOPIK timed-exam body) is unreskinned** — old `Card variant="flat"` surfaces, no `PageHubHeader`, no CityCard, no devices. It renders *inside* the now-Seoul TOPIK shell (`Topik.tsx:370`), and this batch's new Study/Mock **chooser Sheet routes users straight into it**. So the most jarring transition in the app is now one this batch created: pick "Mock" from a polished Seoul sheet → land in flat legacy cards.

Everything else is uniform. These two are the capstone's real output.

---

## Rulings on the four known gaps

**(a) MockMode.tsx left unreskinned — is it a visible inconsistency needing a follow-up?**
**Yes — SHOULD-FIX, file a follow-up now; not a batch-B blocker.** It is explicitly out of this pass's edit scope and the code documents that honestly (`Topik.tsx:68`). But it is a *reachable, high-traffic* surface and this batch's chooser Sheet is the on-ramp to it, so the flat→Seoul seam is now more visible than before. It should be the very next reskin ticket, ideally before beta, and it is the natural place to also land the known timer bug (the file already carries a fix comment at `MockMode.tsx:1295` for the "frozen at 1:09 / once-per-minute" symptom — verify that shipped).

**(b) WritingTopicGenerator keeps a plain surface (card-within-card inside the new CityCard) — acceptable or fix?**
**Acceptable for this PR, but file a shared-primitive follow-up (SHOULD-FIX-soon).** `.km-topicgen` paints its own `background: var(--ink-1); border: 1px solid var(--line); border-radius: var(--radius)` (`WritingTopicGenerator.css:10-17`). Dropped inside the new `CityCard tone="accent"` AI-Prompt slot it reads as a flat squared box nested in a hero signboard — a double surface. It is tokenized so it is *theme-correct*, just not *device-correct*. It is a shared component (Today tile consumes it too), so the right fix is an embedded/surfaceless variant (strip its own background+border when it sits inside a CityCard), not a one-off. Minor visible ding today; correct call to not hack it locally.

**(c) Chat bubbles use `--km-tone` at bubble scale instead of a CityCard per message — sound?**
**Sound — PRAISE.** This is the right restraint. `CityCard`'s language is an *outer hero glow*; a thread holds dozens of bubbles and stacking dozens of glowing hero cards would be visual noise. The mockup's own `.bub.ai`/`.bub.me` specify an *inset* tone ring + solid accent fill, not an outer glow — and the implementation reproduces exactly that by consuming the same `km-tone--accent` utility (`--km-tone`) that CityCard/DancheongRail resolve, applying the day/night formula at bubble scale (`Chat.css:114-143`). Same primitive, right altitude. The surfaced contrast fix (failed-row retry uses `--on-vermilion` + underline instead of `--vermilion` text on its own accent fill) is exactly the AA catch a reskin should produce.

**(d) `Sheet` / `.km-popover` chrome renders FLAT regardless of theme tone — is a shared tone-aware Sheet the right final follow-up?**
**Yes — this is the right final shared-primitive promotion, on the same pattern as the CollapsibleTile / PageHubHeader / ochre promotions of prior batches.** Confirmed: `.km-sheet__panel` (`index.css:2526`) paints `background: var(--ink-1)`, `border-top: 1px solid var(--line-strong)`, and a fixed rgba upward shadow. It is theme-*aware* (ink-1 differs light/dark) but tone-*flat*: no Night neon top-border + gradient + glow, which is exactly what both mockups draw (`km-final` `.night .sheet` and `km-prototype` `.night .sheet` show a `rgba(255,62,108,.4/.5)` top border + signboard gradient + upward glow; Day shows the dancheong `border-image` top stripe). This gap is now shared across many surfaces — this batch's **TOPIK chooser** and **Tickets file-form**, plus the already-shipped create-list, Hanja detail, and Mistakes detail sheets all render the same flat panel. Because it is shared, no page should patch it locally (and correctly, none did — they reuse `Sheet` verbatim). Promote `Sheet` to a tone-aware / CityCard-lined panel once, and every sheet in the app gains the neon-signboard/hanji treatment at once. **Highest-value single follow-up before beta.**

---

## Findings

### BLOCKER
None in the seven in-scope surfaces.

### SHOULD-FIX
- **S1 — `Images.tsx` lingering flat `Topbar`** (`pages/Images.tsx:56,235`). Last un-migrated page in the app; routed + nav-listed. Out of batch-B scope → file a reskin ticket. (Capstone item.)
- **S2 — `MockMode.tsx` unreskinned** (`Topik.tsx:370` renders it; `pages/topik/MockMode.tsx` uses legacy `Card variant="flat"`). Reachable straight from this batch's new chooser Sheet; largest remaining flat→Seoul seam. File a reskin ticket (gap-a ruling). Land the timer fix in the same pass.
- **S3 — Shared `Sheet` panel is not tone-aware** (`index.css:2526`). Renders flat vs the mockups' Night neon top-border/gradient/glow + Day dancheong top-stripe. Affects this batch's TOPIK chooser + Tickets file-form and 3 shipped sheets. Promote `Sheet` once (gap-d ruling). Highest-value shared follow-up.
- **S4 — `LearnMenu` comb order + stale comments** (`LearnMenu.tsx:116-120,30-37`). The actual `COMB_ROWS` = `[[flashcards,grammar],[reading,topik,ttmik],[writing,hanja]]`, but **both** in-file comments describe a *different* arrangement (header comment: "Row1 Reading·Hanja / Row2 Vocab·Grammar·Listen / Row3 Writing·TOPIK"; the `COMB_ROWS` docstring: "Row 2 = vocab/grammar/listening, the accent pair writing+TOPIK nearest the hexagon"). Neither is what renders. Two consequences: (1) the design rationale for the shared vermilion hue — "group writing + TOPIK so the sharing reads as intentional" — **fails**, because as actually laid out `topik` is row-2-center and `writing` is row-3-left, i.e. two non-adjacent vermilion tiles; (2) the layout is a true 2-3-2 honeycomb vs the mockup's 2-2-2-1 (TOPIK alone, nearest the hex). The 2-3-2 honeycomb is a *defensible improvement* (truer tessellation) — but reconcile the stale comments to the real array, and either re-pair the two vermilion tiles adjacently or drop the "intentional pair" justification. The rendered hues themselves (`HEX_HUE`) are correct and AA-mapped.
- **S5 — `WritingTopicGenerator` double-surface** (`WritingTopicGenerator.css:10-17` inside `Writing.tsx:1047` CityCard). Flat ink-1 box nested in a CityCard hero. Add an embedded/surfaceless variant (gap-b ruling).

### NIT
- **N1 — Chat skyline height-cap reaches into shared internals.** `Chat.css:53-63` overrides `.km-hubheader__skyline` / `.km-skyline__svg` via page-scoped `.km-chat__hub` descendant selectors to shrink the banner for a thread screen. It works and is correctly scoped, but a first-class `PageHubHeader` `compact`/`size` prop would be cleaner and reusable (Chat is unlikely to be the only thread-shaped page). Low priority.
- **N2 — `LearnMenu` header prose is stale** — folded into S4; worth a standalone cleanup so the next reader isn't misled by comments that contradict the array they annotate (senior-quality-bar item: comments that lie are worse than none).

### PRAISE
- **P1 — Chat bubble tone mechanism** (gap-c): correct altitude, reuses the shared `--km-tone` primitive instead of nesting CityCards; the `--on-vermilion` retry-contrast fix is the exact AA catch a reskin should generate.
- **P2 — Honest-empty-state discipline is uniform and *rule-governed*.** giwa + hangul-watermark is applied to a view's ONE true empty state and explicitly withheld from per-tab micro-fallbacks (documented and correctly enforced in Ttmik's Highlights-vs-Transcript-vs-Sentences panels, Writing, Topik attempts/study, Chat thread, Tickets). This is the kind of consistency that makes an app feel authored.
- **P3 — `tone="plain"` for Tickets** — a ticket carries no skill color; identity comes from its Pills. Correct semantic restraint rather than forcing a decorative hue.
- **P4 — Shared `Sheet` reused verbatim** for both the TOPIK chooser and the Tickets file-form (matching the mockups), rather than two bespoke popups — which is precisely what makes the S3 promotion a single-point win.
- **P5 — Wave-2 feature work is real, not faked.** F-160 (runtime audio-error `alert` distinct from the "no audio mapped" `note`), F-161/F-162 (scroll restore keyed to the real Shell scroller via guarded sessionStorage), F-163 (AI-Prompt promoted to a top-level radio with `uiChoice` kept in sync) are all root-caused and correctly scoped, with backend/ingest gaps filed as follow-ups instead of hacked at the client.
- **P6 — Zero hardcoded hex** across all seven surfaces + `LearnMenu`; every device is token/utility-driven, so both themes and every accent preset come free.

---

## Coordination observations — final shared-primitive follow-ups to file before beta

1. **Tone-aware `Sheet`** (S3/gap-d) — promote the shared panel like CollapsibleTile/PageHubHeader/ochre were promoted in prior batches. Biggest single consistency win; unblocks 5+ surfaces at once.
2. **Reskin `MockMode.tsx`** (S2) — the largest reachable flat surface, and the on-ramp is this batch's own chooser. Bundle the timer-freeze fix.
3. **Reskin `Images.tsx`** (S1) — retire the app's last legacy `Topbar`; then a repo-wide grep for `Topbar` should return only `Topbar.tsx` + tests, and the "one app" claim is literally true.
4. **Embedded/surfaceless `WritingTopicGenerator`** (S5/gap-b) — strip its own surface when nested in a CityCard; benefits both Writing and the Today tile.
5. **Optional `PageHubHeader` `compact` prop** (N1) — fold Chat's height-cap into the component.
6. **Reconcile `LearnMenu` comb comments + accent pairing** (S4) — cheap, and it removes an actively-misleading comment from the app's hero launcher.
