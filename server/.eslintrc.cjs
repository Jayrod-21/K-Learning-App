/* eslint-disable */
/**
 * Server ESLint config.
 *
 * Two architectural guardrails enforced here (not just style):
 *
 *   1. Only `src/services/claude/client.ts` may import `@anthropic-ai/sdk`.
 *      Every other consumer goes through the typed proxy public API. This
 *      is the constraint REVIEW_B4 P-10 calls out and ADR-020 documents.
 *      Direct SDK use elsewhere is how API keys leak into the wrong layer
 *      and how cost-accounting drifts away from the proxy's claude_usage
 *      writer.
 *
 *   2. Only `src/db/pool.ts` may import `pg`. Every other file goes through
 *      the typed pool wrapper that enforces parameterized queries. This is
 *      the constraint REVIEW_B3 "PRAISE" calls out — physical discouragement
 *      of raw `pool.query`.
 *
 * If you genuinely need to add a third exception, add an eslint-disable-next
 * with a one-line justification AND open a ticket — the constraint exists
 * for a reason.
 */
module.exports = {
  root: true,
  env: { node: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: ['./tsconfig.json'],
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-non-null-assertion': 'warn',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    'no-console': ['warn', { allow: ['error', 'warn'] }],
  },
  overrides: [
    // ---- Guardrail #1: Anthropic SDK boundary -----------------------------
    {
      files: ['src/**/*.ts'],
      excludedFiles: ['src/services/claude/client.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: '@anthropic-ai/sdk',
                message:
                  'Only services/claude/client.ts may import @anthropic-ai/sdk. ' +
                  'Use the typed ClaudeProxy public API instead. See REVIEW_B4 P-10.',
              },
            ],
            patterns: [
              {
                group: ['@anthropic-ai/sdk/*'],
                message:
                  'Only services/claude/client.ts may import from @anthropic-ai/sdk. ' +
                  'Use the typed ClaudeProxy public API instead. See REVIEW_B4 P-10.',
              },
            ],
          },
        ],
      },
    },
    // ---- Guardrail #2: Postgres pool runtime boundary --------------------
    // Type imports from 'pg' are fine — many modules need ``Pool`` /
    // ``PoolClient`` as TYPE annotations. The constraint is that only the
    // wrapper (``src/db/pool.ts``) and the modules that own their own pool
    // lifecycle (B4: ``services/claude/{cache,usage,index}.ts``, which inject
    // a Pool dependency) may DEPEND on the pg package. Application route
    // handlers never import pg — they use ``query`` / ``withTransaction``
    // from ``../db/pool.js``. The rule below catches accidental raw pg use
    // in route handlers; it intentionally excludes B4's pool-aware modules.
    {
      files: ['src/routes/**/*.ts', 'src/middleware/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: 'pg',
                message:
                  'Route handlers and middleware must use query() / ' +
                  'withTransaction() from ../db/pool.js — never import pg ' +
                  'directly. This enforces parameterized queries and shared ' +
                  'pool lifecycle. See REVIEW_B3 PRAISE.',
              },
            ],
          },
        ],
      },
    },
    // ---- Tests can be looser ---------------------------------------------
    {
      files: ['tests/**/*.ts', '**/*.test.ts'],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
        'no-restricted-imports': 'off',
      },
    },
  ],
};
