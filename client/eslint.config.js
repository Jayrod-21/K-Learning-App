import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      // FU-NF-17: adopt jsx-a11y so accessibility regressions are caught at
      // lint time across the whole app, not just by manual review.
      jsxA11y.flatConfigs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
    },
    rules: {
      // `Toggle` (components/Toggle.tsx) renders a native `<button
      // role="switch">` — teach the label/control-association rule about it
      // so wrapping a Toggle in a `<label>` (Chat.tsx's B-020 English-toggle
      // row, fix-pass N-1) is recognized as a real label→control association
      // instead of flagging a false positive.
      'jsx-a11y/label-has-associated-control': [
        'error',
        { controlComponents: ['Toggle'] },
      ],
    },
  },
])
