import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000, // testcontainers warm-up
    hookTimeout: 120_000,
    setupFiles: ['./tests/setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
