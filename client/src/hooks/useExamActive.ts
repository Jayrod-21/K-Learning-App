/**
 * `useExamActive` — read/write the shared "mock exam in progress" flag.
 *
 * Safe outside `<ExamActiveProvider/>`: returns `examActive: false` and a
 * no-op setter (see `exam-active-context.ts` for why this context does not
 * follow the null-default/throw convention).
 */
import { useContext } from 'react';
import {
  ExamActiveContext,
  type ExamActiveContextValue,
} from './exam-active-context';

export type { ExamActiveContextValue } from './exam-active-context';

export function useExamActive(): ExamActiveContextValue {
  return useContext(ExamActiveContext);
}
