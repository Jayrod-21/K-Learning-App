/**
 * MockBadge — dev-only 🅂 corner seal that flags screens rendering against
 * mock data. Renders `null` in production builds so a forgotten badge can't
 * ship to end-users.
 *
 * Visual: small vermilion square (낙관-style seal) with a serif "S" glyph,
 * absolute-positioned to the nearest positioned ancestor's top-right corner.
 * `aria-hidden` because it's developer chrome, not user information.
 *
 * Usage:
 *   const { isMock } = useEndpointOrMock('today', loadTodayMock);
 *   return (
 *     <section className="relative">
 *       {isMock ? <MockBadge /> : null}
 *       …
 *     </section>
 *   );
 *
 * Why a separate component (not a flag on every screen):
 *   - One render path, one place to change. If the design swaps the glyph
 *     from 'S' to '模' (mock-in-Korean), every screen flips together.
 *   - Single PROD gate. Inlining `if (PROD) return null` at every call site
 *     would invite drift.
 *
 * ## Gating semantics — when to fire the badge
 *
 * Cross-screen rule (formalised in the Pass 3 tightening cycle):
 *
 *   > The badge fires when every realFn-backed query has fallen back to
 *   > mock. Mock-only sources (no `realFn` configured on `useEndpointOrMock`)
 *   > are NOT part of the AND — their `isMock: true` is constant and would
 *   > pin the badge permanently on any screen that included them.
 *
 * Concretely:
 *   - Grammar's `drill` tab is mock-only (no realFn) — the badge fires
 *     when the drill tab is active OR when both the realFn-backed `list`
 *     AND `bank` queries fall back to mock simultaneously.
 *   - Reference's `hanja` source is mock-only — under the `all` filter
 *     the badge fires only when both `vocab` AND `grammar` (the realFn-
 *     backed sources) fall back to mock; hanja's permanent `isMock: true`
 *     is excluded from the conjunction.
 *
 * Wrong rule (caused a recurring bug): `.some(s => s.isMock)` across all
 * active states. Any mock-only source pins the badge to true regardless
 * of whether vocab + grammar successfully reached the server. The
 * intent of the badge — "all real-data is unavailable, you're looking
 * at fixtures" — degrades to "at least one source is fixture-shaped",
 * which is uninformative when fixture-shaped is by design.
 */
import type { CSSProperties, JSX } from 'react';

/** Styles colocated — too small to justify a CSS rule. */
const STYLE: CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  // Vermilion 단청 — same hex the Pass 1 token file exports as --vermilion.
  // We don't read the CSS var because this component must render correctly
  // even if the token block hasn't been injected (test environment, error
  // boundary fallback, etc.).
  background: '#B83A2E',
  color: '#FBF6E6',
  width: 18,
  height: 18,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: '"Noto Serif KR", "Inter", serif',
  fontSize: 11,
  fontWeight: 600,
  lineHeight: 1,
  borderRadius: 2,
  transform: 'rotate(-3deg)',
  // Subtle inner stroke so the seal reads as a stamp, not a solid block.
  boxShadow: 'inset 0 0 0 1px rgba(27,24,19,0.25)',
  pointerEvents: 'none',
  userSelect: 'none',
  zIndex: 5,
};

/** Renders the corner seal in dev; `null` in production. */
export function MockBadge(): JSX.Element | null {
  if (import.meta.env.PROD) return null;
  return (
    <span
      aria-hidden="true"
      data-testid="mock-badge"
      className="km-mock-badge"
      style={STYLE}
    >
      🅂
    </span>
  );
}
