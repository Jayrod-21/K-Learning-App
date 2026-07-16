/**
 * encounteredBarAria — shared ARIA props for the "Encountered vs ~L4 target"
 * progressbar rendered by BOTH the Hanja screen's EncounteredBand and the
 * Progress page's Hanja mastery tab (F-041). One helper so the two surfaces
 * can never drift on the boundary conditions again.
 *
 * Two boundaries every consumer must handle identically:
 *
 *   - `encountered` counts progress rows across ALL levels while `targetL4`
 *     counts only L4 characters (see server/src/routes/hanja.ts), so a
 *     long-run user's `encountered` legitimately exceeds the target. ARIA 1.2
 *     requires `aria-valuenow` to sit within [valuemin, valuemax], so the
 *     exposed value clamps — the visual fill width already does.
 *
 *   - `targetL4 === 0` (degenerate/empty corpus) would emit
 *     `aria-valuemax={0}`, violating ARIA's valuemax > valuemin requirement.
 *     There is no meaningful fraction to report, so the bar drops progressbar
 *     semantics entirely and hides from AT — the eyebrow line above it
 *     already states the raw counts as text.
 */

interface EncounteredBarProgressProps {
  role: 'progressbar';
  'aria-valuemin': number;
  'aria-valuemax': number;
  'aria-valuenow': number;
  'aria-label': string;
}

interface EncounteredBarHiddenProps {
  'aria-hidden': true;
}

export function encounteredBarAria(
  encountered: number,
  targetL4: number,
): EncounteredBarProgressProps | EncounteredBarHiddenProps {
  if (targetL4 <= 0) return { 'aria-hidden': true };
  return {
    role: 'progressbar',
    'aria-valuemin': 0,
    'aria-valuemax': targetL4,
    'aria-valuenow': Math.min(encountered, targetL4),
    'aria-label': 'Hanja encountered out of L4 target',
  };
}

/**
 * hanjaProgressSummary (F-077) — the bilingual status line under the
 * aggregate hanja progress card, composed on the CLIENT from the
 * `/hanja/progress` DTO's numeric fields.
 *
 * The server DTO also ships a pre-templated English `note`, but it predates
 * the F-077 state reword (it still says "banked") and is single-language —
 * so both consumers (the Hanja screen's EncounteredBand and the Progress
 * page's Hanja mastery tab) render THIS line instead of the wire prose.
 * Information content is identical: the note's total-corpus denominator is
 * reconstructed as banked + practicing + new, which the route contract
 * defines as exactly the total character count (`new` = total − banked −
 * practicing; see server/src/routes/hanja.ts GET /progress).
 */
export function hanjaProgressSummary(progress: {
  banked: number;
  practicing: number;
  new: number;
  encountered: number;
}): { en: string; kr: string } {
  const total = progress.banked + progress.practicing + progress.new;
  const b = String(progress.banked);
  const p = String(progress.practicing);
  const enc = `${String(progress.encountered)}/${String(total)}`;
  return {
    en: `${b} mastered · ${p} practicing · ${enc} encountered`,
    kr: `숙달 ${b} · 연습 중 ${p} · 접한 한자 ${enc}`,
  };
}
