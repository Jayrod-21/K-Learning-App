/**
 * Global test setup — runs once before the suite.
 *
 * Imports `@testing-library/jest-dom` so every `expect(...)` call gains the
 * DOM-aware matchers (`toBeInTheDocument`, `toHaveAttribute`, etc.).
 *
 * RTL's auto-cleanup only runs when Vitest globals are exposed. We keep
 * `globals: false` for explicit imports, which means RTL never sees a
 * global `afterEach` to hook. Wire cleanup ourselves once here.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
