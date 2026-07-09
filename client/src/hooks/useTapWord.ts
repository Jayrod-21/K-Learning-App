/**
 * useTapWord — the tap-anything popover state machine.
 *
 * Extracted (U3b) from `pages/Ttmik.tsx`'s `DetailView` (~lines 596-706),
 * which had this exact machine copy-pasted alongside `pages/Reading.tsx`
 * (pre-U3b) and `pages/Images.tsx`. Owns: the open popover's data + loading
 * flag, the abortable lemmatize → define → enrich chain
 * (`lib/tapChain.resolveWordPopover`), and abort-on-unmount /
 * abort-on-new-tap / abort-on-close discipline. Any screen that renders
 * tappable Korean text via `Tapword` + `WordPopover` should consume this
 * instead of re-copying the machine.
 *
 * Scope note: only the OPEN → DEFINE → CLOSE machine is extracted here.
 * "Add to bank" (mine state + `POST /vocab/mine`) stays page-local — it
 * needs a toast + a `minedIds` set the caller already owns for rendering
 * `Tapword`'s underline, so folding it into this hook would just relocate
 * the coupling, not remove it (see `pages/Reading.tsx`'s own `handleAdd`
 * for the pattern this hook composes with). Ttmik.tsx's inline copy of this
 * machine is left in place — de-dup deferred to U3c per
 * `db/docs/U3_READER_DESIGN.md` §U3c, to keep this pass's blast radius
 * small — and Images.tsx's copy is likewise untouched.
 *
 * Threat model: identical to Ttmik's inline copy — every popover field
 * renders as React text children downstream (never HTML), the chain
 * degrades gracefully on any step's failure (see tapChain's own header),
 * and the whole chain is abortable so a stale response can never paint over
 * a newer tap, a closed popover, or an unmounted screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { GLOSS_UNAVAILABLE, resolveWordPopover } from '../lib/tapChain';
import type { WordPopoverData } from '../components/WordPopover';

export interface UseTapWordOptions {
  /**
   * Given a raw/lemma word, returns whether it's already in the learner's
   * bank — feeds `WordPopoverData.mined` so the popover shows its
   * "already banked" pill. Read via a ref (not a hook dependency), so the
   * caller may pass a fresh closure every render with no memoization and no
   * stale-closure risk. Omit to always report not-mined.
   */
  isMined?: (word: string) => boolean;
}

export interface UseTapWordResult {
  /** The open popover's data, or null when no popover is open. */
  popData: WordPopoverData | null;
  /** True while the lemmatize→define→enrich chain is still resolving. */
  popLoading: boolean;
  /** Tap handler — pass a token's surface form plus its source sentence. */
  onTapWord: (raw: string, sentenceText: string) => void;
  /** Close the open popover and abort any still-in-flight chain call. */
  onClose: () => void;
}

/** Tap-anything popover machine — see module header for scope + threat model. */
export function useTapWord(options: UseTapWordOptions = {}): UseTapWordResult {
  const [popData, setPopData] = useState<WordPopoverData | null>(null);
  const [popLoading, setPopLoading] = useState(false);

  // Popover-scoped chain controller — aborted on close, new tap, unmount.
  const inFlightCtrlRef = useRef<AbortController | null>(null);

  // Latest `isMined` in a ref so `onTapWord`'s identity stays stable across
  // renders even when the caller passes an inline closure — no dependency
  // array footgun for consumers. Written from an effect (not the render
  // body) — `eslint-plugin-react-hooks` flags a ref WRITE during render as
  // unsafe (React Compiler / concurrent-rendering hazard), even though this
  // particular ref never feeds this component's own output.
  const isMinedRef = useRef(options.isMined);
  useEffect(() => {
    isMinedRef.current = options.isMined;
  });

  // Abort any in-flight chain call on unmount — a late resolve must not
  // leak a setState into an unmounted screen.
  useEffect(
    () => () => {
      inFlightCtrlRef.current?.abort();
    },
    [],
  );

  const onTapWord = useCallback((raw: string, sentenceText: string): void => {
    inFlightCtrlRef.current?.abort();
    const ctrl = new AbortController();
    inFlightCtrlRef.current = ctrl;

    const mined = isMinedRef.current?.(raw) ?? false;
    setPopLoading(true);
    setPopData({ kr: raw, en: '', pos: 'word', ex_kr: '', ex_en: '', mined });

    void resolveWordPopover(raw, sentenceText, ctrl.signal).then(
      (popover) => {
        // null = aborted (closed / newer tap) — paint nothing stale.
        if (popover === null || ctrl.signal.aborted) return;
        popover.mined = isMinedRef.current?.(popover.kr) ?? false;
        setPopData(popover);
        setPopLoading(false);
      },
      () => {
        // The chain catches its own step failures, so a rejection here is a
        // defect belt-and-braces path — still resolve the popover to the
        // fixed fallback rather than stranding the spinner.
        if (ctrl.signal.aborted) return;
        setPopData({
          kr: raw,
          en: GLOSS_UNAVAILABLE,
          pos: 'word',
          ex_kr: '',
          ex_en: '',
          mined: isMinedRef.current?.(raw) ?? false,
        });
        setPopLoading(false);
      },
    );
  }, []);

  const onClose = useCallback((): void => {
    inFlightCtrlRef.current?.abort();
    inFlightCtrlRef.current = null;
    setPopData(null);
    setPopLoading(false);
  }, []);

  return { popData, popLoading, onTapWord, onClose };
}
