/**
 * ExamActive context object + types (Overhaul P1.1). Kept separate from the
 * Provider so the React Refresh rule (`react-refresh/only-export-components`)
 * stays clean across `ExamActiveProvider.tsx` and `useExamActive.ts`.
 *
 * Purpose: lift MockMode's local "a timed TOPIK exam is running" flag
 * (`phase === 'exam'`) into shared state so shell chrome — the chat FAB —
 * can hide during an exam. MockMode writes it; ChatFab reads it.
 *
 * Unlike Theme/Auth (null default + throwing hook), this context ships a
 * SAFE NO-OP DEFAULT: the flag is advisory UI state, and a study page must
 * never crash just because the shell chrome that consumes the flag isn't
 * mounted (standalone page tests, future embeds). Reading outside the
 * provider yields `examActive: false` and a setter that does nothing.
 */
import { createContext } from 'react';

export interface ExamActiveContextValue {
  /** True while a timed mock exam is in progress. */
  readonly examActive: boolean;
  /** Set by the exam owner (MockMode) on enter/leave/submit/unmount. */
  readonly setExamActive: (active: boolean) => void;
}

export const ExamActiveContext = createContext<ExamActiveContextValue>({
  examActive: false,
  setExamActive: () => {
    /* no-op outside the provider — see file header */
  },
});
