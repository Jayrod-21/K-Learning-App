/**
 * useTapWord — the tap-anything popover state machine.
 *
 * Extracted (U3b) from `pages/Ttmik.tsx`'s `DetailView`, which had this
 * exact machine copy-pasted alongside `pages/Reading.tsx` (pre-U3b). Owns:
 * the open popover's data + loading flags, the abortable two-stage
 * lemmatize → define (paint) → enrich (merge) chain (F-209 Phase 1:
 * `lib/tapChain.resolveBasePopover` + `resolveEnrichment`),
 * and abort-on-unmount / abort-on-new-tap / abort-on-close discipline. Any
 * screen that renders tappable Korean text via `Tapword` + `WordPopover`
 * should consume this instead of re-copying the machine. Consumers today:
 * `pages/Reading.tsx` (U3b) and `pages/Ttmik.tsx` (U3c de-dup — its inline
 * original is gone).
 *
 * Scope note: only the OPEN → DEFINE → CLOSE machine is extracted here.
 * "Add to bank" (mine state + `POST /vocab/mine`) stays page-local — it
 * needs a toast + a `minedIds` set the caller already owns for rendering
 * `Tapword`'s underline, so folding it into this hook would just relocate
 * the coupling, not remove it (see `pages/Reading.tsx`'s own `handleAdd`
 * for the pattern this hook composes with). `pages/Images.tsx` deliberately
 * does NOT consume this hook: its word popover opens synchronously from OCR
 * wire data (`wordToPopover` — the words arrive glossed with the capture),
 * with no lemmatize→define→enrich resolve and therefore no loading state or
 * abortable chain to share; routing it through this hook would ADD network
 * calls, not remove duplication.
 *
 * F-209 Phase 1 (progressive paint): the chain runs as two stages. Stage 1
 * (lemmatize → `/define`, both fast local calls) resolves the KRDICT-based
 * popover and paints it immediately — `popLoading` clears here, so the
 * blocking spinner lives only for the brief pre-define moment. Stage 2
 * (`/enrich` — live Claude, ~1–2s cold / near-instant on a cache hit) runs
 * in the background under the SAME AbortController; while it's in flight
 * `popEnriching` is true (the popover shows a subtle inline affordance, not
 * a blocker), and when it lands the enrichment is folded in by re-running
 * `buildWordPopover` with the stage-1 define result — so the merged popover
 * is identical to what the old one-shot chain produced. A failed or aborted
 * enrich merges nothing and surfaces no error (the KRDICT popover stands).
 *
 * Threat model: identical to Ttmik's inline copy — every popover field
 * renders as React text children downstream (never HTML), the chain
 * degrades gracefully on any step's failure (see tapChain's own header),
 * and the whole chain is abortable so a stale response (base OR late
 * enrichment) can never paint over a newer tap, a closed popover, or an
 * unmounted screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GLOSS_UNAVAILABLE,
  buildWordPopover,
  resolveBasePopover,
  resolveEnrichment,
} from '../lib/tapChain';
import { defineEntry } from '../services/define';
import { deleteGlossOverride, putGlossOverride } from '../services/vocab';
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
  /**
   * True only while stage 1 (lemmatize→define) is still resolving — i.e.
   * before the popover has anything real to paint. Clears as soon as the
   * KRDICT-based popover is set; the slow enrich no longer holds it.
   */
  popLoading: boolean;
  /**
   * True while stage 2 (`/enrich`) is still in flight AFTER the base
   * popover painted — drives the popover's subtle "adding nuance…" inline
   * affordance (never a blocking spinner). False once enrichment merged,
   * failed (silent degrade), or was aborted.
   */
  popEnriching: boolean;
  /** Tap handler — pass a token's surface form plus its source sentence. */
  onTapWord: (raw: string, sentenceText: string) => void;
  /** Close the open popover and abort any still-in-flight chain call. */
  onClose: () => void;
  /**
   * Phase 2.8 — save a gloss override for the open popover's word and
   * optimistically patch `popData.en`/`overridden` on success. Rejects (does
   * NOT swallow) on failure so `WordPopover`'s own editor keeps the draft
   * open for a retry — mirrors `onAdd`'s rollback-on-rejection contract
   * page-side. Pass directly as `WordPopover`'s `onEditGloss` prop.
   */
  onEditGloss: (data: WordPopoverData, gloss: string) => Promise<void>;
  /**
   * Phase 2.8 — clear the open popover's override and restore the shared
   * default gloss. Best-effort refetch of the fresh default via `/define`
   * (the popover's own resolved state doesn't retain the pre-override
   * value once merged) — a refetch failure still leaves the override
   * cleared server-side, just with a stale `en` until the next tap.
   */
  onResetGloss: (data: WordPopoverData) => Promise<void>;
}

/** Tap-anything popover machine — see module header for scope + threat model. */
export function useTapWord(options: UseTapWordOptions = {}): UseTapWordResult {
  const [popData, setPopData] = useState<WordPopoverData | null>(null);
  const [popLoading, setPopLoading] = useState(false);
  const [popEnriching, setPopEnriching] = useState(false);

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
    setPopEnriching(false);
    setPopData({ kr: raw, en: '', pos: 'word', ex_kr: '', ex_en: '', mined });

    const run = async (): Promise<void> => {
      // Stage 1 — lemmatize → define (fast): paint the KRDICT popover the
      // moment it resolves; do NOT wait for the slow Claude enrich.
      const base = await resolveBasePopover(raw, ctrl.signal);
      // null = aborted (closed / newer tap) — paint nothing stale.
      if (base === null || ctrl.signal.aborted) return;
      const basePopover = base.popover;
      basePopover.mined = isMinedRef.current?.(basePopover.kr) ?? false;
      setPopData(basePopover);
      setPopLoading(false);
      setPopEnriching(true);

      // Stage 2 — enrich (slow, background): fold the nuance/usage/extra
      // examples in when they land. `resolveEnrichment` never rejects
      // (failure → null → silent degrade: the KRDICT popover stands), but
      // a defect here must not fall through to the stage-1 fallback below
      // and wipe an already-painted popover — hence its own try/catch.
      try {
        const enrichment = await resolveEnrichment(
          base.lemma,
          sentenceText,
          ctrl.signal,
        );
        if (ctrl.signal.aborted) return;
        if (enrichment !== null) {
          // Rebuild through the same fold the one-shot chain used, so the
          // merged popover is identical to the pre-F-209 final content.
          const merged = buildWordPopover(base.lemma, base.defineResult, enrichment);
          merged.mined = isMinedRef.current?.(merged.kr) ?? false;
          setPopData(merged);
        }
      } catch {
        // Defect belt-and-braces — keep the painted KRDICT popover.
      }
      if (!ctrl.signal.aborted) setPopEnriching(false);
    };

    run().catch(() => {
      // Stage 1 catches its own step failures, so a rejection here is a
      // defect belt-and-braces path — still resolve the popover to the
      // fixed fallback rather than stranding the spinner. (Stage 2 defects
      // are contained above and never reach this handler.)
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
      setPopEnriching(false);
    });
  }, []);

  const onClose = useCallback((): void => {
    inFlightCtrlRef.current?.abort();
    inFlightCtrlRef.current = null;
    setPopData(null);
    setPopLoading(false);
    setPopEnriching(false);
  }, []);

  // Phase 2.8 — both gloss mutators guard the setPopData patch on `kr`
  // still matching the CURRENTLY open popover: a slow request racing a
  // popover close/new-tap must not resurrect stale text into whatever is
  // open now (same "stale response can't paint over a newer state" posture
  // the tap chain's own abort discipline enforces, just via a value check
  // instead of an AbortSignal — these are plain mutations, not part of the
  // abortable lemmatize→define→enrich chain).
  const onEditGloss = useCallback(
    async (data: WordPopoverData, gloss: string): Promise<void> => {
      const saved = await putGlossOverride(data.kr, gloss);
      setPopData((prev) =>
        prev && prev.kr === data.kr ? { ...prev, en: saved.gloss, overridden: true } : prev,
      );
    },
    [],
  );

  const onResetGloss = useCallback(async (data: WordPopoverData): Promise<void> => {
    await deleteGlossOverride(data.kr);
    // Best-effort: fetch the fresh shared default so the popover reflects it
    // immediately. A failure here does NOT roll back the delete (the
    // override is already gone server-side) — it just leaves `en` stale
    // until the word is tapped again, which is an acceptable v1 tradeoff
    // over re-throwing and confusing "was it cleared?" state.
    try {
      const defineResult = await defineEntry(data.kr);
      const defaultEn = defineResult.entries[0]?.definition_english ?? data.en;
      setPopData((prev) =>
        prev && prev.kr === data.kr ? { ...prev, en: defaultEn, overridden: false } : prev,
      );
    } catch {
      setPopData((prev) =>
        prev && prev.kr === data.kr ? { ...prev, overridden: false } : prev,
      );
    }
  }, []);

  return {
    popData,
    popLoading,
    popEnriching,
    onTapWord,
    onClose,
    onEditGloss,
    onResetGloss,
  };
}
