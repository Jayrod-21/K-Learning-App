/**
 * Reading screen — passage with tap-anything + grammar drag + audio bar.
 *
 * Pass 3 wiring (replaces the Pass 2 mock-only loader):
 *   1. Two-step real loader — `fetchUnits(corpus)` → take the first unit →
 *      `fetchSentences(corpus, unitId)`. Wrapped in a single `realFn` and
 *      threaded through `useEndpointOrMock` so the mock fallback still
 *      lights up the 🅂 badge when the chain rejects.
 *   2. Wire-shape adapter — server `ReadingSentences` (rows of bare KR
 *      strings) is transformed into the fixture-flavoured `ReadingPassage`
 *      `KoreanPassage` already consumes. Every whitespace-segmented token
 *      becomes a `Tapword` carrying a *placeholder* gloss (empty `en`) —
 *      the slow-path lemmatize/define/enrich chain on tap fills it in.
 *   3. Tap-anything chain — fast-path when `gloss.en` is non-empty
 *      (fixture had a real gloss attached); slow-path otherwise
 *      (`lemmatize → define → enrich`, with graceful degradation if any
 *      step beyond `define` fails).
 *   4. Grammar span tap → `identifyPattern`, opens popover in grammar
 *      mode with the returned pattern shape rendered into the popover's
 *      `desc` slot.
 *   5. Add-to-bank (vocab) — `services.vocab.mineWord(...)` against
 *      `POST /vocab/mine` (FU-NF-33). The tap chain resolves the KRDICT
 *      entry id (`/define` `entries[0].id`), threaded through the popover;
 *      the server upserts a shared `user_mined` entry and banks a
 *      recognition card. The flip is OPTIMISTIC: `minedIds` gains the
 *      lemma the instant the user taps Add, then rolls back (and surfaces a
 *      non-blocking toast) if the bank fails — a failed bank never breaks
 *      the tap UX, and the dotted-underline stays honest. A close-aborted
 *      request is swallowed (no rollback, no toast). The grammar branch
 *      stays local-only (no server `pattern_key` from `identifyPattern`).
 *
 * Layout (per design README §3):
 *   1. Topbar: passage level/min eyebrow + 읽기 · Read serif title.
 *   2. Passage title in serif Korean.
 *   3. AudioBlock — fake-play, transcript reveals KR sentences combined.
 *   4. KoreanPassage — tokens render as plain / tapword / gram-span.
 *      Tapword → WordPopover (Add to bank lifts word into minedIds).
 *      Gram-span → grammar popover; banks a grammar id.
 *
 * State (this screen, lifted to context in a later Pass):
 *   - `popData`        — open popover content; null = closed.
 *   - `minedIds`       — Set<string> of banked KR lemma keys (vocab).
 *   - `bankedGrammar`  — Set<string> of banked grammar ids.
 *   - `inFlightCtrlRef`— in-flight controller for the popover-scoped
 *                        slow-path chain; aborted on popover close to
 *                        ignore late lemmatize/define/enrich resolves.
 *
 * Threat model (Pass 3):
 *   - **Behavioural telemetry leak via tap-anything.** Every tapword in
 *     real-data mode fires a 3-call chain (lemmatize → define → enrich).
 *     The server sees a per-tap stream that mirrors the learner's
 *     reading-attention pattern. Mitigation lives server-side: rate
 *     limiting on each route, expensive-bucket throttling on `/enrich`.
 *     The client deliberately does NOT batch or fingerprint — batching
 *     would hide individual signals from the rate limiter; fingerprinting
 *     would make replay trivial. We rely on the server's bucket for
 *     defence in depth.
 *   - **Independent-failure surface.** Each of the three slow-path calls
 *     can fail on its own (KRDICT 503, Claude timeout on /enrich, etc.).
 *     A single failure must not take the popover down — the chain
 *     degrades gracefully: a successful `define` with a failed `enrich`
 *     still surfaces the dictionary entry; even a failed `define` falls
 *     back to a minimal popover showing the raw lemma. Only the user-
 *     facing tap-target's text is ever shown — server failure messages
 *     are NEVER echoed (closes the error-leak vector documented in
 *     `ErrorCard`'s threat model).
 *   - **Stale-popover resolution race.** A learner can close one popover
 *     and tap a new word before the previous chain settles. Without
 *     guarding, the late resolve would clobber the new popover's data.
 *     The controller in `inFlightCtrlRef` is aborted on `setPopData(null)`
 *     AND on every new tap; settle handlers check `signal.aborted` before
 *     calling `setPopData` so the latest tap always wins. The three
 *     service modules don't accept an `AbortSignal` parameter today (see
 *     `services/api.ts` — `api.get/post` wrap `apiRequest` and don't
 *     forward call-site config beyond what each service hard-codes), so
 *     we cannot cancel the in-flight HTTP request itself. The
 *     ignore-late-response pattern keeps UI state correct; the wasted
 *     network round-trip is small and the server's rate limiter caps the
 *     cost. Threading `signal` end-to-end is tracked for the services pass.
 *   - **Passage rendering.** Tokens render as React children → escaped.
 *     The server contract (see types/domain.ts `ReadingSentenceRow`)
 *     keeps `korean` as a text field; never HTML.
 *   - **Add-to-bank failure-safety (FU-NF-33).** The vocab Add gesture fires
 *     `mineWord` against `POST /vocab/mine`. The `minedIds` flip is
 *     optimistic so the dotted-underline lands instantly; a failed bank
 *     rolls the lemma back out of the set and surfaces a non-blocking error
 *     toast rather than throwing — a server hiccup must never break the tap
 *     UX or strand the underline in a lying "banked" state. Server failure
 *     text is NEVER echoed: the toast copy is fixed client-side (closes the
 *     same error-leak vector as `ErrorCard`). A request the user aborts by
 *     closing the popover is swallowed (no rollback, no toast). The request
 *     is scoped to `inFlightCtrlRef` so a popover close cancels it.
 */
import { useCallback, useMemo, useRef, useState, type JSX } from 'react';
import { Topbar } from '../components/Topbar';
import { Card } from '../components/Card';
import { KoreanPassage } from '../components/KoreanPassage';
import { AudioBlock } from '../components/AudioBlock';
import { WordPopover } from '../components/WordPopover';
import type { WordPopoverData } from '../components/WordPopover';
import { MockBadge } from '../components/MockBadge';
import { ErrorCard } from '../components/ErrorCard';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { loadReadingMock } from '../data/mocks/reading';
import { fetchSentences, fetchUnits } from '../services/reading';
import { lemmatize } from '../services/lemmatize';
import { defineEntry } from '../services/define';
import { enrich } from '../services/enrich';
import { identifyPattern } from '../services/grammar';
import { mineWord } from '../services/vocab';
import { ApiError } from '../services/api';
import { useToast } from '../components/useToast';
import type {
  DefineResult,
  EnrichResult,
  PassageGloss,
  PassageSentence,
  PassageToken,
  PatternMatch,
  ReadingCorpus,
  ReadingPassage,
  ReadingSentences,
} from '../types/domain';

/**
 * Default corpus + level used when the real `/reading/units` chain is on.
 *
 * Hard-coded for Pass 3 — Pass 4 will lift corpus + unit selection into
 * Today's plan envelope (`/plan/today.reading`). Pinned at module scope so
 * the realFn closure doesn't capture per-render state.
 */
const DEFAULT_CORPUS: ReadingCorpus = 'ttmik';

/** Skeleton placeholder while the passage loads. */
function SkeletonCard(): JSX.Element {
  return (
    <Card
      variant="default"
      aria-busy="true"
      style={{ minHeight: 240, opacity: 0.55 }}
    >
      <></>
    </Card>
  );
}

/**
 * Concatenate every sentence's tokens into one Korean transcript so the
 * AudioBlock can show the underlying text without a separate `audio.transcript`
 * field. Pass-3+ TTS endpoints will return their own transcript and this
 * fallback will go away.
 */
function buildTranscript(passage: ReadingPassage): string {
  return passage.sentences
    .map((s) => s.tokens.map((t) => t.w).join(''))
    .join(' ');
}

/**
 * Wire-shape adapter — `ReadingSentences` (server) → `ReadingPassage`
 * (KoreanPassage's input).
 *
 * Each `ReadingSentenceRow.korean` is split on whitespace (eojeol
 * boundary) so KoreanPassage can render every word as a `Tapword`. We
 * attach a *placeholder* gloss (`en: ''`) to every non-space token so
 * the tap surface is live; the slow-path chain fills the gloss in on
 * tap. Spaces become bare tokens.
 *
 * Why not lemmatize the whole passage up front? Cost. A 30-sentence
 * passage would burn through the server's Kiwi bucket on first paint
 * for words the user may never tap. The on-demand chain keeps the
 * cold-load cost at zero and the per-tap cost bounded.
 */
function adaptWirePassage(
  unitTitle: string,
  wire: ReadingSentences,
): ReadingPassage {
  const sentences: PassageSentence[] = wire.sentences.map((row) => ({
    en: row.english ?? '',
    tokens: tokeniseSentence(row.korean),
  }));
  return {
    title: unitTitle,
    level: 'TOPIK II · Intermediate',
    meta: `Reading · ${wire.corpus}`,
    sentences,
  };
}

/**
 * Split a Korean sentence into eojeol-boundary tokens plus the spaces
 * between them. Every non-space token gets a placeholder gloss so it
 * renders as a Tapword; the slow-path on tap replaces the placeholder.
 *
 * Placeholder sentinel: `en === ''`. Real glosses (fixture-attached or
 * post-enrichment) always carry a non-empty English string, so the
 * fast-path / slow-path branch in `handleOpenWord` can key off this.
 */
function tokeniseSentence(korean: string): PassageToken[] {
  const tokens: PassageToken[] = [];
  // Match runs of whitespace OR runs of non-whitespace. Punctuation rides
  // with its adjacent word — fine for a tap target; the slow-path lemma
  // chain strips it server-side.
  const parts = korean.match(/\s+|\S+/g) ?? [];
  for (const part of parts) {
    if (/^\s+$/.test(part)) {
      tokens.push({ w: part });
    } else {
      tokens.push({
        w: part,
        vid: null,
        gloss: {
          kr: part,
          pos: 'n.',
          en: '',
          ex_kr: '',
          ex_en: '',
        },
      });
    }
  }
  return tokens;
}

/**
 * Real loader — the chain the `realFn` slot needs. Resolves a passage
 * the screen can hand to KoreanPassage; rejects with `ApiError` so the
 * hook surfaces the error to the mock fallback.
 *
 * Edge case: `fetchUnits` returns []. We surface that as an `ApiError`
 * so the screen falls back to the mock instead of rendering an empty
 * Card — an empty passage isn't a learning experience.
 */
async function loadReadingReal(): Promise<ReadingPassage> {
  const units = await fetchUnits({ corpus: DEFAULT_CORPUS, limit: 1 });
  if (units.length === 0) {
    throw new ApiError('no reading units available', {
      status: 404,
      code: 'no_units',
    });
  }
  const unit = units[0];
  const wire = await fetchSentences(DEFAULT_CORPUS, unit.id);
  return adaptWirePassage(unit.title, wire);
}

/** True when the gloss is the placeholder synthesised by the adapter. */
function isPlaceholderGloss(g: PassageGloss): boolean {
  return g.en === '';
}

/**
 * Lift a `DefineResult` into the popover shape. The server keeps senses
 * as opaque JSONB; the helper picks the first entry's headword for the
 * KR field and falls back to the requested lemma. POS comes from the
 * entry when present.
 */
function popoverFromDefine(
  lemma: string,
  result: DefineResult,
  enrichment: EnrichResult | null,
): WordPopoverData {
  const first = result.entries[0];
  const enrichSummary = summariseEnrichment(enrichment);
  return {
    kr: first?.headword ?? lemma,
    en: enrichSummary ?? 'Dictionary entry',
    pos: first?.part_of_speech ?? 'word',
    // The KRDICT entry id is what FU-NF-33 mines on — it gives the server a
    // stable, homograph-safe dedup key. Absent only when `/define` returned
    // no entries (the fallback popover keys on the lemma instead).
    ...(first ? { krdictEntryId: first.id } : {}),
    ex_kr: '',
    ex_en: '',
  };
}

/**
 * Pluck a human-readable line out of the enrichment envelope. The inner
 * `result` is owned by B4 (Claude-shaped); we look for a `summary` /
 * `gloss` string and ignore anything else rather than render unknown
 * JSON. Returns null when the envelope doesn't carry a usable string —
 * the popover then falls back to the dictionary headline.
 */
function summariseEnrichment(enrichment: EnrichResult | null): string | null {
  if (!enrichment) return null;
  const inner = enrichment.result;
  if (typeof inner === 'string') return inner;
  if (typeof inner === 'object' && inner !== null) {
    const rec = inner as Record<string, unknown>;
    if (typeof rec.summary === 'string') return rec.summary;
    if (typeof rec.gloss === 'string') return rec.gloss;
    if (typeof rec.en === 'string') return rec.en;
  }
  return null;
}

/** Same idea for an identify-pattern envelope. */
function patternDescription(pattern: PatternMatch): {
  title: string;
  desc: string;
} {
  const inner = pattern.result;
  if (typeof inner === 'string') {
    return { title: 'Grammar pattern', desc: inner };
  }
  if (typeof inner === 'object' && inner !== null) {
    const rec = inner as Record<string, unknown>;
    const title =
      typeof rec.pattern === 'string'
        ? rec.pattern
        : typeof rec.title === 'string'
          ? rec.title
          : 'Grammar pattern';
    const desc =
      typeof rec.summary === 'string'
        ? rec.summary
        : typeof rec.explanation === 'string'
          ? rec.explanation
          : '';
    return { title, desc };
  }
  return { title: 'Grammar pattern', desc: '' };
}

export function Reading(): JSX.Element {
  const { data, loading, isMock, refetch } = useEndpointOrMock<ReadingPassage>(
    'reading',
    loadReadingMock,
    { realFn: loadReadingReal },
  );
  const { toast } = useToast();

  // popData null = closed. The same component renders for vocab and grammar
  // (kind discriminator on `WordPopoverData`).
  const [popData, setPopData] = useState<WordPopoverData | null>(null);
  // True while the slow-path chain (lemmatize → define → enrich) is in
  // flight. WordPopover renders an inline spinner in place of the gloss +
  // example body so the user sees the popover open IMMEDIATELY on tap
  // rather than waiting ~500-1500ms for the chain to settle. Cleared as
  // soon as `popData` lands its resolved value.
  const [popLoading, setPopLoading] = useState<boolean>(false);
  // Set<string> keyed by KR lemma — KoreanPassage uses this to paint dotted
  // underlines on banked tapwords. Lifted to context in a later Pass; for now
  // the Set lives here and resets on reload.
  const [minedIds, setMinedIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [bankedGrammar, setBankedGrammar] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  // Tracks the active slow-path / grammar-identify chain so a popover
  // close (or a new tap) aborts the previous one. See the file-header
  // threat model on the stale-resolution race.
  const inFlightCtrlRef = useRef<AbortController | null>(null);

  const transcript = useMemo(
    () => (data ? buildTranscript(data) : ''),
    [data],
  );

  /**
   * Begin a new popover interaction. Aborts the previous chain and hands
   * back a controller the caller threads into its settle guards. The
   * controller is also retained for the popover-close abort path.
   */
  const beginInteraction = useCallback((): AbortController => {
    inFlightCtrlRef.current?.abort();
    const ctrl = new AbortController();
    inFlightCtrlRef.current = ctrl;
    return ctrl;
  }, []);

  /**
   * Slow-path: tap on a placeholder-gloss token. Chain is
   * lemmatize → (define ‖ enrich). Define is the spine of the popover;
   * enrich is enrichment — if enrich fails the popover still opens with
   * just the dictionary entry. If lemmatize itself fails we fall back to
   * showing the raw token so the user isn't left staring at a closed
   * popover (graceful degradation).
   */
  const runSlowPath = useCallback(
    async (
      raw: string,
      sentenceText: string,
      ctrl: AbortController,
    ): Promise<void> => {
      // C-SF-1 fix: open the popover IMMEDIATELY with a stub + loading
      // flag so the user sees a visible response to their tap rather than
      // waiting ~500-1500ms for the chain to resolve. The stub carries
      // the raw word as the headword so the dialog has an accessible
      // name (the kr field is the `aria-labelledby` target). The body is
      // suppressed in favour of a spinner via WordPopover's `isLoading`
      // prop; the resolved data lands in a second update once define +
      // enrich settle.
      setPopLoading(true);
      setPopData({
        kr: raw,
        en: '',
        pos: 'word',
        ex_kr: '',
        ex_en: '',
        mined: minedIds.has(raw),
      });

      let lemma = raw;
      try {
        const tokens = await lemmatize(raw);
        const first = tokens[0];
        if (first && first.lemma) lemma = first.lemma;
      } catch {
        // Lemmatize failure → fall through with the raw form. Define
        // will still try; KRDICT often matches the conjugated form.
      }
      if (ctrl.signal.aborted) return;

      let defineResult: DefineResult | null = null;
      try {
        defineResult = await defineEntry(lemma);
      } catch {
        // Define failure → graceful degradation: render a "definition
        // unavailable" popover keyed on the lemma so the user still has
        // a tappable Add-to-bank surface.
      }
      if (ctrl.signal.aborted) return;

      let enrichResult: EnrichResult | null = null;
      try {
        enrichResult = await enrich({
          lemma,
          sourceSentence: sentenceText,
        });
      } catch {
        // Enrich failure is non-fatal — popover still opens on the
        // dictionary entry alone (graceful-degradation contract above).
      }
      if (ctrl.signal.aborted) return;

      const popover: WordPopoverData = defineResult
        ? popoverFromDefine(lemma, defineResult, enrichResult)
        : {
            kr: lemma,
            en:
              summariseEnrichment(enrichResult) ?? 'Definition unavailable',
            pos: 'word',
            ex_kr: '',
            ex_en: '',
            mined: minedIds.has(lemma),
          };
      // Fold in the mined flag — the gloss's own kr (post-define) is what
      // counts for the bank dotted-underline.
      popover.mined = minedIds.has(popover.kr);
      setPopData(popover);
      setPopLoading(false);
    },
    [minedIds],
  );

  /**
   * Open the popover for a tapword. Branch on fast-path (gloss has
   * non-empty `en`) vs slow-path (placeholder, run the chain).
   *
   * The fast/slow decision is the docstring-mandated optimisation: Pass 2
   * mock fixtures pre-attach real glosses, so on the mock fallback every
   * tap is free. Real-data tokens carry a synthesised placeholder; only
   * those eat the network round-trip.
   */
  const handleOpenWord = useCallback(
    (g: PassageGloss, sentenceText: string): void => {
      const ctrl = beginInteraction();
      if (!isPlaceholderGloss(g)) {
        // Fast path — fixture-attached gloss is already complete. No
        // loading state needed; the popover renders fully populated.
        setPopLoading(false);
        setPopData({
          kr: g.kr,
          pos: g.pos,
          en: g.en,
          ex_kr: g.ex_kr,
          ex_en: g.ex_en,
          mined: minedIds.has(g.kr),
        });
        return;
      }
      void runSlowPath(g.kr, sentenceText, ctrl);
    },
    [beginInteraction, minedIds, runSlowPath],
  );

  /** Grammar span tap → identify → open grammar popover. */
  const handleOpenGrammar = useCallback(
    (gid: string, sentenceText: string, spanText: string): void => {
      const ctrl = beginInteraction();
      void (async (): Promise<void> => {
        try {
          const pattern = await identifyPattern({
            highlightSpan: spanText,
            fullSentence: sentenceText,
          });
          if (ctrl.signal.aborted) return;
          const { title, desc } = patternDescription(pattern);
          setPopData({
            kind: 'grammar',
            kr: gid,
            en: 'Grammar pattern',
            title,
            desc,
            ex_kr: '',
            ex_en: '',
            mined: bankedGrammar.has(gid),
          });
        } catch {
          if (ctrl.signal.aborted) return;
          // Graceful degradation — open the popover with the gid so the
          // gesture still feels real and the user can bank it.
          setPopData({
            kind: 'grammar',
            kr: gid,
            en: 'Grammar pattern',
            title: `Pattern · ${gid}`,
            desc: 'Pattern detail unavailable — tap to bank for later.',
            ex_kr: '',
            ex_en: '',
            mined: bankedGrammar.has(gid),
          });
        }
      })();
    },
    [beginInteraction, bankedGrammar],
  );

  /**
   * Add-to-bank handler (FU-NF-33 for vocab).
   *
   * Vocab branch: optimistically flip `minedIds` so the dotted-underline
   * lands the instant the user taps Add, then fire `mineWord` against
   * `POST /vocab/mine` (popover-scoped signal). On failure we roll the lemma
   * back out of the set and surface a non-blocking error toast — a failed
   * bank must never break the tap UX or leave the underline lying. A request
   * the user aborts by closing the popover (code `canceled`) is swallowed:
   * no rollback, no toast (the popover is already gone). Server error text is
   * never echoed; the toast copy is fixed here.
   *
   * Grammar branch: still local-only — `bankPattern` requires a server
   * `pattern_key` we don't have from `identifyPattern`'s opaque envelope.
   */
  const handleAdd = useCallback(
    (d: WordPopoverData): void | Promise<void> => {
      if (d.kind === 'grammar') {
        setBankedGrammar((prev) => {
          const next = new Set(prev);
          next.add(d.kr);
          return next;
        });
        return;
      }

      const lemma = d.kr;
      // Optimistic flip — the underline lands immediately.
      setMinedIds((prev) => {
        const next = new Set(prev);
        next.add(lemma);
        return next;
      });

      // Reuse the popover-scoped controller so a popover close cancels the
      // bank too; fall back to a fresh one if the chain already cleared it.
      const ctrl = inFlightCtrlRef.current ?? new AbortController();
      inFlightCtrlRef.current = ctrl;

      // Returned so WordPopover can roll its own "Added" button back on a real
      // failure (resolve on success/cancel = button stays; reject = button
      // resets, matching the underline rollback below).
      return mineWord(
        {
          lemma,
          ...(d.en && d.en !== 'Dictionary entry' && d.en !== 'Definition unavailable'
            ? { english: d.en }
            : {}),
          ...(d.pos && d.pos !== 'word' ? { pos: d.pos } : {}),
          ...(d.krdictEntryId !== undefined
            ? { krdictEntryId: d.krdictEntryId }
            : {}),
        },
        ctrl.signal,
      ).then(
        () => undefined,
        (err: unknown) => {
          // A close-aborted request is expected — swallow it (resolves, so the
          // popover button isn't reset; the popover is closing anyway).
          if (err instanceof ApiError && err.code === 'canceled') return;
          // Roll the optimistic flip back so the underline stays honest, then
          // surface a fixed, non-blocking failure notice (no server text).
          setMinedIds((prev) => {
            if (!prev.has(lemma)) return prev;
            const next = new Set(prev);
            next.delete(lemma);
            return next;
          });
          toast({ message: "Couldn't bank — try again", tone: 'error' });
          // Re-throw so WordPopover rolls its "Added" button back too.
          throw err instanceof Error ? err : new Error('bank failed');
        },
      );
    },
    [toast],
  );

  /** Close the popover and abort any still-pending chain. */
  const handleClose = useCallback((): void => {
    inFlightCtrlRef.current?.abort();
    inFlightCtrlRef.current = null;
    setPopData(null);
    setPopLoading(false);
  }, []);

  /**
   * KoreanPassage's `onOpenWord` / `onOpenGrammar` signatures don't carry
   * sentence context. We thread it via a per-sentence closure built
   * inline below — the passage data is owned here, so reconstructing
   * "the sentence this token belongs to" needs us to find it. To keep
   * KoreanPassage untouched, we instead resolve the sentence text from
   * the gloss kr / gid the first time it matters: scan `data.sentences`
   * for one whose tokens contain a matching gloss or grammar id.
   */
  const sentenceTextForGloss = useCallback(
    (g: PassageGloss): string => {
      if (!data) return '';
      for (const sent of data.sentences) {
        for (const tk of sent.tokens) {
          if (tk.gloss && tk.gloss.kr === g.kr) {
            return sent.tokens.map((t) => t.w).join('');
          }
        }
      }
      return '';
    },
    [data],
  );

  const sentenceTextForGrammar = useCallback(
    (gid: string): { sentence: string; span: string } => {
      if (!data) return { sentence: '', span: '' };
      for (const sent of data.sentences) {
        const inRun = sent.tokens.some(
          (t) => t.span?.startsWith(`${gid}-`) ?? false,
        );
        if (!inRun) continue;
        const sentenceText = sent.tokens.map((t) => t.w).join('');
        let collecting = false;
        const spanParts: string[] = [];
        for (const tk of sent.tokens) {
          if (tk.span === `${gid}-start`) {
            collecting = true;
            spanParts.push(tk.w);
            continue;
          }
          if (tk.span === `${gid}-end`) {
            spanParts.push(tk.w);
            collecting = false;
            break;
          }
          if (collecting) spanParts.push(tk.w);
        }
        return { sentence: sentenceText, span: spanParts.join('') };
      }
      return { sentence: '', span: '' };
    },
    [data],
  );

  return (
    <section
      className="screen km-reading"
      aria-labelledby="reading-title"
      style={{ position: 'relative', padding: '0 18px 32px' }}
    >
      {isMock ? <MockBadge /> : null}

      <Topbar
        krTitle={<span id="reading-title">읽기 · Read</span>}
        eyebrow={
          data
            ? `${data.level} · ${data.meta}`
            : 'Passage'
        }
      />

      {loading ? (
        <SkeletonCard />
      ) : data ? (
        <>
          <h2 className="kr kr-display km-reading__title">{data.title}</h2>

          <div style={{ marginBottom: 18 }}>
            <AudioBlock transcriptKr={transcript} />
          </div>

          <Card variant="default" style={{ padding: '24px 26px' }}>
            <KoreanPassage
              passage={data}
              onOpenWord={(g) => {
                handleOpenWord(g, sentenceTextForGloss(g));
              }}
              onOpenGrammar={(gid) => {
                const { sentence, span } = sentenceTextForGrammar(gid);
                handleOpenGrammar(gid, sentence, span);
              }}
              minedIds={minedIds}
            />
          </Card>
        </>
      ) : (
        <ErrorCard
          message="Couldn't load the passage"
          onRetry={refetch}
        />
      )}

      {popData ? (
        <WordPopover
          data={popData}
          onClose={handleClose}
          onAdd={handleAdd}
          isLoading={popLoading}
        />
      ) : null}
    </section>
  );
}

export default Reading;
