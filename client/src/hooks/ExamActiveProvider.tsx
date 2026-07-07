/**
 * ExamActiveProvider — owns the shared "mock exam in progress" boolean
 * (Overhaul P1.1). Mounted in `Shell` so both the writer (MockMode, deep in
 * the routed outlet) and the reader (ChatFab, shell chrome) sit under it.
 *
 * Deliberately minimal: one boolean + its setter. No persistence — an exam
 * in progress across a reload is F-007's resume flow, not this flag's job.
 */
import { useMemo, useState, type JSX, type ReactNode } from 'react';
import {
  ExamActiveContext,
  type ExamActiveContextValue,
} from './exam-active-context';

export function ExamActiveProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [examActive, setExamActive] = useState(false);

  // `useState` setters are referentially stable, so the memo only re-runs
  // when the flag itself flips — consumers don't re-render on provider
  // re-renders that didn't change the flag.
  const value = useMemo<ExamActiveContextValue>(
    () => ({ examActive, setExamActive }),
    [examActive],
  );

  return (
    <ExamActiveContext.Provider value={value}>
      {children}
    </ExamActiveContext.Provider>
  );
}
