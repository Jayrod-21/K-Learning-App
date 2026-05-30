/**
 * Mock loader delay helper.
 *
 * Every mock loader simulates a 60–120 ms network round-trip so that screens
 * exercise their loading states realistically. Without it, the mock resolves
 * synchronously in the next microtask and skeletons never render — then real
 * endpoints in Pass 3+ surface latency bugs the suite never caught.
 *
 * The range is fixed (per-call random within [60, 120]) — not configurable.
 * If a future test needs determinism it should mock this module directly.
 */

/** Returns a promise that resolves after a random 60–120 ms wait. */
export function mockDelay(): Promise<void> {
  // 60 + [0, 60] ms — bounded so the suite stays fast.
  const ms = 60 + Math.floor(Math.random() * 60);
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
