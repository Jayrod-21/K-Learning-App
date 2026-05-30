import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

/**
 * Vitest config — runs the suite under `happy-dom` (faster than jsdom and
 * has the DOM APIs RTL needs). `globals: false` keeps the imports explicit
 * (no global `describe`/`it`/`expect`) which plays nicely with strict TS.
 *
 * Coverage runs via v8 and excludes the things we deliberately do not test:
 * the entry file (`main.tsx`), purely declarative config, fixtures, and the
 * Vite-generated `dist/` output.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'happy-dom',
      globals: false,
      include: ['src/**/*.{test,spec}.{ts,tsx}'],
      setupFiles: ['./src/test/setup.ts'],
      css: false,
      coverage: {
        provider: 'v8',
        reporter: ['text', 'html'],
        include: ['src/**/*.{ts,tsx}'],
        exclude: [
          'src/main.tsx',
          'src/**/*.test.{ts,tsx}',
          'src/**/*.spec.{ts,tsx}',
          'src/test/**',
          'src/data/mocks/**',
        ],
      },
    },
  }),
);
