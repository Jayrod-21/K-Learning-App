/**
 * LearnMenu — the upward-expanding study-page launcher behind the LEARN
 * hexagon (Overhaul P1.1; honeycomb restyle per the Modern Seoul redesign).
 *
 * A scrim + a color-coded HEX HONEYCOMB of the 7 LEARN sub-pages
 * (icon + label + kr), arranged 2-3-2 and rising from just above the
 * BottomNav. Rows reveal with a bottom-up stagger (the row nearest the
 * hexagon lands first) — except the first tile in DOM order, which
 * starts its reveal immediately because it receives initial keyboard
 * focus (an invisible focus target is an a11y foot-gun); the global
 * `prefers-reduced-motion` block zeroes both durations AND delays, so
 * reduced-motion users get an instant, complete comb.
 *
 * CLOSE-OUT (honeycomb motion polish): closing is a two-step handshake
 * with Shell. A close request flips Shell's phase to 'closing'; Shell
 * keeps us MOUNTED and passes `closing=true`, which swaps every tile's
 * entrance animation for a reverse-staggered exit (top row leaves first
 * — last-in-first-out) and fades the scrim/title. When the LAST tile's
 * exit animation ends (`onAnimationEnd` on the bottom-right wrapper — it
 * carries the largest delay, so it finishes last) we call `onExited` and
 * Shell unmounts us for real, which is when `useModalA11y` restores focus
 * to the hexagon. Shell also arms a safety timeout in case animationend
 * never fires, and bypasses the closing phase entirely under
 * prefers-reduced-motion — this component never needs to know; it just
 * unmounts. While closing, the CSS turns pointer-events off (display-only
 * exit; the hexagon in BottomNav stays tappable to re-open).
 *
 * Honeycomb geometry / color coding:
 *   - Row 1: Reading (cyan) · Hanja (ochre)
 *   - Row 2: Vocab flashcards (indigo) · Grammar (violet) · Listen (moss)
 *   - Row 3: Writing (accent) · TOPIK (accent)
 *   Each tile's background is the category `*-soft` chip and its TEXT uses
 *   the AA-safe `*-ink` twin; only the (non-text) icon uses the raw bright
 *   hue. Writing + TOPIK share the accent family — only 6 category hues
 *   exist and those are the two "extra" skills; grouping them as the
 *   accent-colored bottom row (nearest the accent-gradient hexagon) makes
 *   the sharing read as intentional.
 *
 * Each hex is a real `<button>` that navigates + closes; there is no dead
 * center hub. Because the tiles are clip-path hexagons, a rectangular
 * focus outline would read broken — the :focus-visible ring is a
 * hex-silhouette drop-shadow on the UNCLIPPED wrapper (clip-path on an
 * element clips its own filter output, so the glow lives one level up),
 * with a background tint on the tile itself as a second, clip-safe cue.
 *
 * Close paths: scrim tap, Esc (via `useModalA11y`), tile activation
 * (navigate + close), hexagon re-tap (the scrim stops ABOVE the nav so the
 * bar stays tappable — Shell's toggle handles it), and route change
 * (Shell watches `location.pathname` as a safety net for browser
 * back/forward while open).
 *
 * A11y:
 *   - `role="dialog"`, `aria-modal`, labelled by the menu title.
 *   - Focus trap / initial focus / Esc / body scroll-lock / focus restore
 *     are owned by `useModalA11y` (shared with Sheet + WordPopover; it
 *     restores focus to the hexagon that opened us).
 *   - Scrim is click-dismiss only and out of the tab order (`tabIndex=-1`),
 *     mirroring the retired MoreSheet's backdrop pattern.
 *   - Tab order is DOM order: row-by-row, left-to-right — matches the
 *     visual reading order of the comb.
 *
 * SEOUL DAY & NIGHT (F-128 reskin — see LearnMenu.css for the full
 * rationale): the honeycomb is the app's hero launcher, so it carries the
 * DESIGN_SEOUL_DAY_NIGHT.md character devices most heavily of any single
 * component:
 *   - `.km-learnmenu__backdrop` — a decorative, `aria-hidden`, pointer-
 *     events-none layer behind the title + comb combining `km-giwa`
 *     (hanji-paper grain / Night signboard-grid, device #3), `km-rain-sheen`
 *     (Night wet-street sheen, device #8) and `km-neon-box` (a soft
 *     accent-tracking bloom — F-131: this glow follows the ACCENT picker,
 *     never a skill hue, so it stays orthogonal to the per-tile colors).
 *   - Each hex tile additionally carries `km-giwa` (same grain, per-tile)
 *     and an inner signboard/wash glow keyed to its own skill hue (see
 *     LearnMenu.css) — the existing `--hx-hue`/`--hx-ink`/`--hx-bg` per-hue
 *     tokens and AA-checked label contrast (index.css) are untouched.
 *   - `.km-learnmenu__title` gets `km-neon-text` for an accent-tracking
 *     glow in Night (again F-131-orthogonal to skill hues).
 *   - `.km-learnmenu__panel` gets `km-neon-flicker` — a one-time Night
 *     "powering on" flicker as the menu mounts, layered on top of the
 *     existing per-row rise stagger. Already `prefers-reduced-motion`
 *     gated at its source (seoul-devices.css), so no separate handling is
 *     needed here.
 *   - Mobile fit (F-129): purely additive/decorative — no new element adds
 *     width or touches the existing `--km-hex-w` clamp() that already fits
 *     the 3-across row on narrow viewports.
 */
import { useCallback, useId, useRef, type JSX } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useModalA11y } from '../hooks/useModalA11y';
import { cn } from '../lib/cn';
import { LEARN_SUBPAGE_IDS, navItem } from '../lib/nav';
import { Bilingual } from './Bilingual';
import { Icon } from './Icon';
import './LearnMenu.css';

/** Per-row ENTRANCE stagger (ms) — bottom row first, like the mockup.
 *  Paired with the 320ms `km-hexrise` duration in index.css: 70ms is wide
 *  enough that each row reads as its own beat, short enough that the full
 *  comb lands in ~460ms. */
const ROW_STAGGER_MS = 70;

/** Per-row EXIT stagger (ms) — reverse order (top row leaves first). */
const EXIT_ROW_STAGGER_MS = 60;

/** EXIT animation duration per tile (ms) — must match `km-hexexit` in
 *  index.css (exits run faster than entrances, standard motion practice). */
const EXIT_TILE_MS = 240;

type LearnSubpageId = (typeof LEARN_SUBPAGE_IDS)[number];

/**
 * The honeycomb arrangement — 2-3-2 fits the 7 sub-pages exactly.
 * Row 2's three tiles are the daily-drill core (vocab/grammar/listening);
 * the accent pair (writing + TOPIK) sits nearest the hexagon.
 */
const COMB_ROWS = [
  ['flashcards', 'grammar'],
  ['reading', 'topik', 'ttmik'],
  ['writing', 'hanja'],
] as const satisfies ReadonlyArray<ReadonlyArray<LearnSubpageId>>;

/**
 * Total close-out length (ms): the bottom row starts last on exit and its
 * tiles run EXIT_TILE_MS. Shell keys two things off this: the hexagon's
 * un-spin transition duration (360ms in index.css — kept equal so the hex
 * reaches 0° as the menu unmounts) and the stuck-closing safety timeout.
 */
export const LEARN_MENU_EXIT_MS =
  (COMB_ROWS.length - 1) * EXIT_ROW_STAGGER_MS + EXIT_TILE_MS;

/**
 * Category hue per sub-page — keys into the `--<hue>` / `--<hue>-ink` /
 * `--<hue>-soft` token triplets via the `.km-learnmenu__hexwrap--<hue>`
 * CSS modifiers. The 5 token-mapped skills use their §4 hues; writing +
 * topik share the accent (vermilion) family — see the header comment.
 */
const HEX_HUE = {
  topik: 'vermilion',
  ttmik: 'moss',
  flashcards: 'indigo',
  grammar: 'violet',
  writing: 'vermilion',
  hanja: 'ochre',
  reading: 'cyan',
} as const satisfies Record<LearnSubpageId, string>;

/* Compile-time guarantee (same idiom as nav.ts's bucket checks): every
 * LEARN sub-page appears in the comb — a new 8th page fails tsc here
 * instead of silently missing from the launcher. (The 7-buttons test
 * covers the runtime complement: no duplicates.) */
type _CombId = (typeof COMB_ROWS)[number][number];
type _MissingFromComb = Exclude<LearnSubpageId, _CombId>;
const _combComplete: _MissingFromComb extends never ? true : never = true;
void _combComplete;

export interface LearnMenuProps {
  /** DOM id for the dialog panel — matches BottomNav's `aria-controls`. */
  id: string;
  /**
   * Called when the menu should close (Esc, scrim, tile activation).
   * This is a close REQUEST — Shell answers by flipping `closing` to true
   * (or by unmounting immediately under prefers-reduced-motion).
   */
  onClose: () => void;
  /** True while the exit cascade plays; the menu stays mounted throughout. */
  closing: boolean;
  /**
   * Fired when the LAST tile's exit animation ends — Shell's cue to
   * actually unmount (Shell also carries a safety timeout in case this
   * never fires).
   */
  onExited: () => void;
}

export function LearnMenu({
  id,
  onClose,
  closing,
  onExited,
}: LearnMenuProps): JSX.Element {
  const labelId = useId();
  const navigate = useNavigate();
  const location = useLocation();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const firstItemRef = useRef<HTMLButtonElement | null>(null);

  // Shared modal a11y (Esc + body lock + focus trap + focus restore).
  useModalA11y({
    open: true,
    onClose,
    containerRef: panelRef,
    initialFocusRef: firstItemRef,
  });

  const goto = useCallback(
    (path: string): void => {
      if (location.pathname !== path) {
        navigate(path);
      }
      onClose();
    },
    [navigate, location.pathname, onClose],
  );

  const rowCount = COMB_ROWS.length;

  return (
    <div
      className={cn('km-learnmenu', closing && 'km-learnmenu--closing')}
      role="presentation"
    >
      <button
        type="button"
        className="km-learnmenu__scrim"
        aria-label="Close Learn menu"
        // Click/touch dismiss only — kept out of the tab order so Shift-Tab
        // from the first tile lands back on the page, not on an invisible
        // button. Esc covers keyboard dismiss.
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        id={id}
        // km-neon-flicker: one-time Night "powering on" flash as the menu
        // mounts (device §7) — already prefers-reduced-motion gated at its
        // source (seoul-devices.css), no extra handling needed here.
        className="km-learnmenu__panel km-neon-flicker"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
      >
        {/* Seoul reskin (F-128) backdrop: decorative-only, out of the flex
            flow (position:absolute — not a flex item, so it never affects
            title/comb sizing) and out of the a11y tree. km-giwa = hanji-paper
            grain / Night signboard-grid (device #3); km-rain-sheen = Night
            wet-street sheen (device #8); km-neon-box = a soft glow that
            tracks the ACCENT picker (F-131) — orthogonal to the per-tile
            skill hues below. See LearnMenu.css for the full rationale. */}
        <div
          className="km-learnmenu__backdrop km-giwa km-rain-sheen km-neon-box"
          aria-hidden="true"
        />
        <div id={labelId} className="km-eyebrow km-learnmenu__title km-neon-text">
          {/* P3a: menu-title chrome follows the language-display setting; in
              single-language modes the dialog's accessible name (via this
              labelledby target) still carries both languages. */}
          <Bilingual kr="배움" en="Learn" />
        </div>
        <div className="km-learnmenu__comb">
          {COMB_ROWS.map((row, rowIdx) => (
            <div className="km-learnmenu__combrow" key={row.join('-')}>
              {row.map((navId, colIdx) => {
                const it = navItem(navId);
                const active = location.pathname === it.path;
                const isFirst = rowIdx === 0 && colIdx === 0;
                // The tile whose EXIT animation finishes last (bottom row
                // carries the largest reverse-stagger delay; its final tile
                // in DOM order is our sentinel) — its animationend drives
                // the actual unmount via onExited.
                const isExitSentinel =
                  rowIdx === rowCount - 1 && colIdx === row.length - 1;
                // ENTRANCE: bottom-up row stagger — the row nearest the
                // hexagon reveals first. EXCEPT the first tile: it receives
                // initial keyboard focus (useModalA11y), and with the full
                // stagger delay the focus would sit on a still-invisible
                // element; a zero delay starts its reveal the instant it is
                // focused. EXIT: reverse order (top row first) so the comb
                // folds back down toward the hexagon. Both zeroed wholesale
                // under prefers-reduced-motion by the global CSS block
                // (duration AND delay).
                const delayMs = closing
                  ? rowIdx * EXIT_ROW_STAGGER_MS
                  : isFirst
                    ? 0
                    : (rowCount - 1 - rowIdx) * ROW_STAGGER_MS;
                return (
                  <div
                    key={navId}
                    className={`km-learnmenu__hexwrap km-learnmenu__hexwrap--${HEX_HUE[navId]}`}
                    style={{ animationDelay: `${delayMs}ms` }}
                    onAnimationEnd={
                      isExitSentinel
                        ? (e) => {
                            // Only the wrapper's own EXIT animation counts —
                            // not the entrance (guarded by `closing`) and
                            // not a bubbled child animation (target check).
                            if (closing && e.target === e.currentTarget) {
                              onExited();
                            }
                          }
                        : undefined
                    }
                  >
                    <button
                      ref={isFirst ? firstItemRef : undefined}
                      type="button"
                      // km-giwa: per-tile hanji-paper grain / Night
                      // signboard-grid (device #3, seoul-devices.css) —
                      // layers under the existing --hx-bg chip color
                      // without touching it (see LearnMenu.css).
                      className="km-learnmenu__hex km-giwa"
                      aria-current={active ? 'page' : undefined}
                      onClick={() => {
                        goto(it.path);
                      }}
                    >
                      {/* Decorative (no title → aria-hidden); the bright
                          category hue is fine on a non-text graphic. */}
                      <Icon
                        name={it.icon}
                        size={26}
                        className="km-learnmenu__hexicon"
                      />
                      {/* P3a: the tile label follows the language-display
                          setting — main + sub stack inside the hex; the
                          "·" separator is visually hidden but kept in the
                          accessible name (see CSS). */}
                      <Bilingual
                        className="km-learnmenu__hexlabel"
                        en={it.label}
                        kr={it.kr}
                      />
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
