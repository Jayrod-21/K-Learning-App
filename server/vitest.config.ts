import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000, // testcontainers warm-up
    hookTimeout: 120_000,
    setupFiles: ['./tests/setup.ts'],
    pool: 'forks',
    // vitest 4 removed `poolOptions.forks.singleFork`. `fileParallelism:
    // false` (forces maxWorkers to 1) keeps what that setting was load-bearing
    // for: test files run strictly sequentially, so per-file testcontainers
    // Postgres instances never race each other and the in-process rate-limiter
    // stores stay deterministic (tests/setup.ts resets them per test). We keep
    // the default `isolate: true` (fresh fork per file) — unlike singleFork's
    // shared process, per-file isolation is required for `vi.mock` of
    // node:fs/promises / node:child_process in pdfPageRender.bounds.test.ts
    // and uploads.test.ts to apply reliably under vitest 4's mocker.
    fileParallelism: false,
  },
});
