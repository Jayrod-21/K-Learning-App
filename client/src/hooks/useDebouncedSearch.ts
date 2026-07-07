/**
 * Debounced search-input hook shared by the Review-library browse pages
 * (vocabulary / dictionary / grammar — extracted from pages/Reference.tsx in
 * Overhaul P1.2).
 *
 * `input` mirrors the live <input>; `q` is the debounced value that drives
 * the keyed network fetch. The debounce is the client's RATE defence for
 * user-controlled search boxes (the server Zod-validates + parameterises the
 * SQL — see the browse pages' threat models): keystrokes never fan out into
 * a request storm.
 */
import { useCallback, useEffect, useState } from 'react';

export const SEARCH_DEBOUNCE_MS = 200;

export interface DebouncedSearch {
  /** Live <input> value. */
  input: string;
  /** Debounced query — follows `input` after {@link SEARCH_DEBOUNCE_MS}. */
  q: string;
  setInput: (v: string) => void;
  clear: () => void;
}

export function useDebouncedSearch(): DebouncedSearch {
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const handle = setTimeout(() => {
      setQ(input);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [input]);
  const clear = useCallback(() => {
    setInput('');
  }, []);
  return { input, q, setInput, clear };
}
