/**
 * Shared focus guard for the GLOBAL "Space reveals the card" key handlers
 * (the vocab Review session and the Hanja study drill both bind a
 * window-level keydown).
 *
 * Keyboard users activate buttons with Space; a global handler that
 * `preventDefault()`s Space while a rating button (or the drawer toggle, or
 * the flashcard itself) has focus cancels that activation and flips the card
 * instead — silently dropping the rating. The window handlers therefore bail
 * whenever focus sits on (or inside) anything that owns its own keyboard
 * interaction.
 *
 * `[role="button"]` covers the Flashcard container itself: it handles its own
 * Enter/Space, so the global handler must not double-fire a second flip
 * (which reads as a visible no-op).
 *
 * No I/O — no threat model.
 */
const INTERACTIVE_SELECTOR =
  'button, a[href], input, textarea, select, [role="button"], [contenteditable="true"]';

/** True when `el` (typically `document.activeElement`) is, or sits inside,
 *  an element that owns its own keyboard interaction. `null` (no focus /
 *  focus on `body`) is not interactive. */
export function isInteractiveElement(el: Element | null): boolean {
  return el !== null && el.closest(INTERACTIVE_SELECTOR) !== null;
}
