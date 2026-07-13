# Korean Master — "Seoul, Day & Night" design system

The authoritative visual contract for the Wave-2 redesign. Every page-builder reads
this and builds to it. Approved direction (2026-07-13): **full day↔night duality,
all nine character devices in.** No cheaping out — a page that adopts the tokens but
skips the character devices has not adopted this system.

---

## 1. The idea

One city, two moods — **not two color themes**. The app is a place that breathes.

- **Day Seoul** (downtown, daylight) → the **light** theme. Hanji paper, palace
  *dancheong* color, hanok tiled roofs, seal stamps, warm and crafted.
- **Night Seoul** (nightlife) → the **dark** theme. Neon signboards, glow, a
  rain-slick sheen over a dark Namsan skyline, electric.

`data-theme="light"` = Day, `data-theme="dark"` = Night. Both get equal craft — Night
is not "Day inverted," it is its own world. (Stretch, later ticket: auto-pick by local
time of day, with the manual toggle as override — F-129.)

The existing **accent picker** (`data-accent="coral|blue|mint"`) still works and is
orthogonal: it recolors the primary accent inside whichever world is active.

Bilingual **Korean / English** stays everywhere. All per-tile **daily progress** stays.

---

## 2. Tokens

Define as CSS custom properties on `:root`, redefine the whole set under
`@media (prefers-color-scheme: dark)`, then again under `:root[data-theme="light"]`
(Day) and `:root[data-theme="dark"]` (Night) so the toggle wins both directions. Style
components through tokens only — never hard-code a hex in a component.

### Day Seoul (light)
```
--ground        #EFE7D6   /* app bg — warm hanji */
--ground-sky    #DCE9EC   /* daytime sky tint (headers/skyline top) */
--paper         #FAF6EC   /* card face */
--paper-2       #F3ECDB   /* elevated */
--ink           #27331F   /* primary text — pine ink */
--ink-mute      #6B5F49
--line          #E0D6BF
/* dancheong accent set (temple polychrome) */
--dan-jade      #2E7D6B   --dan-jade-soft #E6E9D6
--dan-verm      #C0492E   --dan-verm-soft #F3E0D6   /* seal red / CTA in day */
--dan-cobalt    #2B5F9E   --dan-cobalt-soft #DDE6F1
--dan-ochre     #C98A1E   --dan-ochre-soft #F4E6C4
```

### Night Seoul (dark)
```
--ground        #07080F   /* deepest night */
--ground-sky    #161d3a   /* skyline horizon glow */
--paper         #12172a   /* signboard body (with gradient, see cards) */
--paper-2       #1a2038
--ink           #EAEEFB
--ink-mute      #8B96C8
--line          rgba(255,255,255,.08)
/* neon accent set (glow) */
--neon-coral    #FF3E6C   --neon-coral-soft rgba(255,62,108,.16)
--neon-blue     #4F7BFF   --neon-blue-soft  rgba(79,123,255,.16)
--neon-mint     #12C08A   --neon-mint-soft  rgba(18,192,138,.16)
```

### Shared / semantic (both worlds, per-theme values)
- `--accent` / `--accent-soft` / `--on-accent` — resolved from the active `data-accent`
  (coral→neon-coral in night / dan-verm in day; blue→neon-blue / dan-cobalt; mint→
  neon-mint / dan-jade). One knob; both worlds honor it.
- **Skill colors** stay (Vocab, Grammar, Hanja, Reading) — map each to its nearest
  dancheong tone in Day and neon tone in Night.
- Semantic **good / warn / critical** are separate from accent (jade / ochre / vermilion
  in Day; mint / amber / coral in Night).
- Radii keep the current scale (cards ~16–18px Night, ~8px Day paper — Day is squarer/
  crafted, Night is rounded/modern). `--radius-card-day: 8px; --radius-card-night: 18px`.

---

## 3. Typography

Keep the app's real faces (already loaded): **Noto Serif KR** (Korean display),
**Noto Sans KR** (Korean body), **Inter** (Latin body), **Nunito** (rounded display).

- **Day** = serif-forward. Korean display in **Noto Serif KR**; Latin headings in a
  serif or high-contrast treatment. Labels/eyebrows in Inter, uppercase, letter-spaced.
  Calm, editorial, ink-on-paper.
- **Night** = rounded/neon. Korean + Latin display in **Nunito / Noto Sans KR** bold
  with a **neon glow** (`text-shadow`), body in Inter/Noto Sans KR. Electric.
- Body copy ~65ch max, one type scale, `text-wrap: balance` on headings.

---

## 4. The nine character devices

A page has adopted this system only when the relevant devices are present. Build each as
a reusable component/utility (Section 5) — pages compose, never re-implement.

1. **Neon signboards** (Night card) / **hanji-paper cards** (Day card). The core surface.
   Night: dark gradient body, a thin bright **neon-tube border** (accent), inner+outer
   glow, glowing title. Day: warm paper, hairline border, soft low shadow, ink title.
2. **Dancheong rail** — a thin vertical stripe of temple-paint bands (jade/vermilion/
   cobalt/ochre) on a Day featured card's leading edge. Night equivalent: an accent
   neon edge.
3. **기와 roof texture** — subtle tiled-roof pattern (repeating arcs) behind Day section
   grounds / empty states, at very low contrast. Night: faint city-grid texture.
4. **Namsan skyline header** — an SVG skyline strip at the top of the Today hub and major
   landings. Day variant: hanok roofs + soft buildings + a red beacon. Night variant:
   dark towers + Namsan tower + lit windows + neon horizon. Parallaxes gently (reduced-
   motion: static).
5. **Subway-line progress** — the signature progress metaphor (user loves it). A metro
   line with **station dots**: filled = done, ringed = current, hollow = ahead. Use for
   **daily progress**, multi-step exercises, TOPIK question runs, onboarding. Line color
   = active accent/skill color.
6. **Hangul watermark** — a giant, very faint 자모/character set behind section headers or
   empty states (e.g. an outsized `한` or the section's Korean word). Texture, never
   competes with content.
7. **Seal stamps (印)** — a red 도장 stamp mark for **milestones/completion/"done"**
   (finished a list, a mastered item, a perfect run). Slightly rotated, hand-stamped feel.
8. **Rain-neon sheen** — a very subtle diagonal wet-street reflection overlay in Night
   ambient areas (behind the skyline, over the hub bg). Low opacity; Night only.
9. **Mother-of-pearl (자개)** — an iridescent shimmer for **special highlights**:
   achievement accents, streak flames, a mastered-badge sheen, the accent on a hero CTA.
   Used sparingly — it's the jewel, not the wallpaper.

*(Market-awning stripes — the 10th kit chip — is OPTIONAL/held; use only if a warm
market motif is wanted on a specific surface. Not required.)*

---

## 5. Reusable components to build in the foundation phase

Build + fixpass these once; every page consumes them. Co-located CSS, token-driven,
day/night-aware, accent-aware, reduced-motion-aware, WCAG AA in both worlds.

- `SkylineHeader` — the Namsan skyline strip (day/night SVG variants, optional title slot).
- `SubwayProgress` — station-dot progress (props: steps, current, done, color).
- `SealStamp` — the 印 milestone stamp (props: label, tone).
- `DancheongRail` — the leading-edge palette stripe (day) / neon edge (night).
- `CityCard` — the themed surface (neon signboard ⇄ hanji paper), the app's default card.
- Utilities/mixins: `rain-sheen` overlay, `najeon` (mother-of-pearl) gradient,
  `hangul-watermark`, `giwa-texture`, `neon-glow(color)` text/box helpers.
- Retheme existing shared primitives (`Card`, `Pill`, `Tabs`, `Button`, `ShowMore`,
  `CollapsibleTile`, bottom nav, `Topbar`, popovers/sheets) to the token system so the
  whole app shifts at once.

---

## 6. Component treatments (day → night)

- **Buttons** — Day: solid vermilion/accent, ink label, subtle press. Night: accent fill
  with glow, or a neon-outline ghost. Focus-visible ring in both (AA).
- **Pills / badges** — Day: soft dancheong-tint chips. Night: soft neon-tint with a
  hairline glow border.
- **Progress bars** — prefer `SubwayProgress` for step/daily progress; plain bars fill
  with the accent (Day flat, Night glowing tube).
- **Tabs** — underline/segment in the accent; Night selected glows.
- **Popups / sheets** (Wave-2 uses many: create-list, Study/Mock chooser, add-to-list)
  — a semi-transparent scrim (Night: dark blur + faint rain sheen; Day: warm blur),
  the sheet is a `CityCard`. Focus-trapped, Esc/outside-close, returns focus.
- **Bottom nav** — Day: paper + ink, active vermilion. Night: dark blur + active neon glow.
- **Empty states** — hangul watermark + a soft giwa/rain texture + one clear action.

---

## 7. Motion (reduced-motion aware — always provide the static fallback)

- Night: a one-time subtle **neon flicker-on** as a screen mounts; gentle skyline
  parallax; glow pulses only on primary CTAs.
- Day: calmer — soft fades, a seal-stamp "press" on completion.
- Respect `prefers-reduced-motion: reduce` → no parallax, no flicker, no pulse.

---

## 8. Non-negotiables (the fixpass design-fidelity reviewer checks these)

- Both **Day and Night** implemented with equal care; toggling `data-theme` fully
  reskins (no orphaned hard-coded colors).
- The page uses the **actual character-device components**, not a flat token reskin.
- **Accent picker** works in both worlds. **Bilingual** intact. **WCAG AA** contrast in
  both. **Reduced-motion** honored. **Mobile-first** (Wave-2 requires it) — nothing
  clips off-screen-right, touch targets ≥ 44px.
- No regression to existing behavior/tests; new visuals don't break the a11y contracts.

---

## 9. How this rolls out

Foundation (tokens + components above) first, fixpass'd. Then per-page groups reskin +
fold in their Wave-2 changes, each gated + fixpass'd with the design-fidelity reviewer,
deployed zero-downtime in batches. Wave-2 per-page change lists live in
`BUGS_AND_FEATURES.md` (Wave 2 section).
