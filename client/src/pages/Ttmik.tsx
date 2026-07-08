/**
 * Listen screen (F-012) — TTMIK lesson / Iyagi episode audio + read-along.
 *
 * Browse view (unchanged): two sections behind sub-tabs (same tablist idiom
 * as Reference) — TTMIK Lessons grouped by level, Iyagi Episodes as a
 * numbered list. Each row shows the title plus an audio indicator
 * (`hasAudio`). Selecting a row swaps the screen into the detail view.
 *
 * Detail view (F-012 rework):
 *   1. A REAL `<audio controls>` player that is PERSISTENT across the
 *      lesson sub-tabs. The element is rendered exactly once, ABOVE and
 *      OUTSIDE the tab-switched subtree, and is never keyed on the active
 *      tab — switching Highlights ↔ Transcript changes only the panel
 *      below it, so React reconciliation keeps the same DOM node (same
 *      element type at the same stable position in the child list) and
 *      playback position/state survives every switch. The detail view IS
 *      keyed on the selection, so opening a *different* lesson deliberately
 *      remounts the player (fresh src, position 0 — the desired reset).
 *   2. TTMIK lessons get two sub-tabs UNDER the player: Highlights (key
 *      phrases — the original layout) and Transcript (the full ordered
 *      lesson text; `header` lines as section headings, `pair`/`dialog` as
 *      Korean + English, `prose` as explanation notes, `romanization`
 *      subtle). Both arrive in the one detail response, so switching is
 *      instant — no fetch, no spinner, no audio interruption.
 *   3. CLICKABLE WORDS — every Korean line (highlights, transcript, and the
 *      Iyagi transcript) renders through the Read tab's tap-anything path:
 *      the shared `lib/tapChain.tokeniseKorean` splitter + the same
 *      `Tapword` control, so tapping a word fires the abortable
 *      lemmatize → define → enrich chain (`resolveWordPopover`) and opens
 *      the same `WordPopover` with definition / usage / examples and
 *      Add-to-bank (FU-NF-33 `POST /vocab/mine`, optimistic + rollback).
 *   4. Iyagi episode detail: same persistent player + full clickable
 *      transcript; the hosts line renders from `meta.hosts`, a real
 *      `string[]` on the wire (the old string shape crashed this view).
 *
 * Audio `src` contract: `buildAudioSrc` (services/ttmik.ts) joins the
 * detail's app-relative `audioUrl` onto the SAME API base the axios services
 * use, so the media request is same-origin in prod (empty base → the LB
 * routes it) and same-site in dev (Vite :5173 → API :4000) — either way the
 * `SameSite=Strict` session cookie rides the request with no extra plumbing.
 * `audioUrl === null` / `hasAudio === false` → transcript-only with a small
 * "no audio" note, no player.
 *
 * Threat model:
 *   - All data is server corpus text rendered through React text children —
 *     escaped; no dangerouslySetInnerHTML anywhere on this screen. The tap
 *     chain's popover fields go through the same contract (lib/tapChain).
 *   - The audio src is never free-form: `buildAudioSrc` rejects anything but
 *     the exact allow-listed route shapes, so a tampered response body
 *     cannot point the player at a third-party origin.
 *   - Tap-anything fan-out (lemmatize/define/enrich per tap) mirrors the
 *     Read tab's behavioural-telemetry posture: rate limiting lives
 *     server-side; the client neither batches nor fingerprints. The chain
 *     is popover-scoped and aborted on close / new tap / unmount, so an
 *     abandoned tap cancels its in-flight HTTP work — and it never touches
 *     the `<audio>` element, so a tap (or its abort) cannot stall playback.
 *   - Stale-response races: the detail fetch and the tap chain each key to
 *     their own AbortController; settle handlers check the signal so a slow
 *     response never paints over a newer selection or tap.
 *   - GET-only data surface plus `POST /vocab/mine` on Add — that POST rides
 *     the SameSite=Strict cookie posture owned by services/api.ts (ADR-002),
 *     and its failure path never echoes server text (fixed toast copy).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { Bilingual } from '../components/Bilingual';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ErrorCard } from '../components/ErrorCard';
import { Eyebrow } from '../components/Eyebrow';
import { Icon } from '../components/Icon';
import { Tapword } from '../components/Tapword';
import { Topbar } from '../components/Topbar';
import { WordPopover } from '../components/WordPopover';
import type { WordPopoverData } from '../components/WordPopover';
import { useToast } from '../components/useToast';
import {
  GLOSS_DICTIONARY_ENTRY,
  GLOSS_UNAVAILABLE,
  resolveWordPopover,
  tokeniseKorean,
} from '../lib/tapChain';
import { ApiError } from '../services/api';
import { errorMessageFor } from '../lib/errorCopy';
import { navItem } from '../lib/nav';
import {
  buildAudioSrc,
  getIyagiEpisode,
  getIyagiEpisodes,
  getTtmikLesson,
  getTtmikLessons,
} from '../services/ttmik';
import { mineWord } from '../services/vocab';
import type {
  IyagiEpisode,
  ListenSentence,
  TtmikLesson,
  TtmikTranscriptLine,
} from '../types/domain';

type Tab = 'ttmik' | 'iyagi';

/** Page eyebrow source — nav.ts owns the en/kr pair (P3b Batch A). */
const TTMIK_NAV = navItem('ttmik');

const TABS: ReadonlyArray<{ id: Tab; label: string; kr: string }> = [
  { id: 'ttmik', label: 'TTMIK Lessons', kr: 'TTMIK 레슨' },
  { id: 'iyagi', label: 'Iyagi Episodes', kr: '이야기 에피소드' },
];

/** TTMIK lesson-detail sub-tabs (below the persistent player). */
type LessonTab = 'highlights' | 'transcript';

const LESSON_TABS: ReadonlyArray<{ id: LessonTab; label: string; kr: string }> = [
  { id: 'highlights', label: 'Highlights', kr: '하이라이트' },
  { id: 'transcript', label: 'Transcript', kr: '대본' },
];

/**
 * The open lesson/episode. Discriminated on `corpus` so the detail loader
 * can pick the right endpoint; `title` rides along so the header paints
 * instantly while the transcript loads.
 */
type Selection =
  | { corpus: 'ttmik'; level: number; number: number; title: string }
  | { corpus: 'iyagi'; number: number; title: string };

/** Stable identity for a selection — keys the detail view (see DetailView). */
function selectionKey(selection: Selection): string {
  return selection.corpus === 'ttmik'
    ? `ttmik:${String(selection.level)}:${String(selection.number)}`
    : `iyagi:${String(selection.number)}`;
}

/**
 * Everything the detail view renders. Discriminated on `corpus`: TTMIK
 * lessons carry the highlights/transcript pair behind sub-tabs; Iyagi
 * episodes carry one flat transcript plus the hosts line.
 */
type DetailData =
  | {
      corpus: 'ttmik';
      /** Context line above the title, e.g. `Level 2 · Lesson 21`. */
      eyebrow: string;
      /** Korean counterpart of `eyebrow` — rendered via `<Bilingual/>`. */
      krEyebrow: string;
      title: string;
      /** Fully-resolved `<audio src>`; null → transcript-only. */
      audioSrc: string | null;
      highlights: ListenSentence[];
      transcript: TtmikTranscriptLine[];
    }
  | {
      corpus: 'iyagi';
      eyebrow: string;
      krEyebrow: string;
      title: string;
      /** Hosts line; null when the episode has no hosts listed. */
      subtitle: string | null;
      audioSrc: string | null;
      sentences: ListenSentence[];
    };

export default function Ttmik(): JSX.Element {
  const [tab, setTab] = useState<Tab>('ttmik');
  const [selection, setSelection] = useState<Selection | null>(null);

  const openLesson = useCallback((lesson: TtmikLesson): void => {
    setSelection({
      corpus: 'ttmik',
      level: lesson.level,
      number: lesson.number,
      title: lesson.title,
    });
  }, []);

  const openEpisode = useCallback((episode: IyagiEpisode): void => {
    setSelection({
      corpus: 'iyagi',
      number: episode.number,
      title: episode.title,
    });
  }, []);

  const closeDetail = useCallback((): void => {
    setSelection(null);
  }, []);

  return (
    <section
      className="screen km-ttmik"
      aria-labelledby="km-ttmik-title"
      style={{ padding: '0 18px 32px' }}
    >
      <Topbar
        krTitle="듣기"
        title="Listen"
        titleId="km-ttmik-title"
        eyebrow={
          <Bilingual en={TTMIK_NAV.eyebrow} kr={TTMIK_NAV.krEyebrow} />
        }
        right={
          selection !== null ? (
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<Icon name="list" size={14} />}
              onClick={closeDetail}
              aria-label="Back to all lessons and episodes"
            >
              <Bilingual en="Browse" kr="둘러보기" compact />
            </Button>
          ) : undefined
        }
      />
      {selection !== null ? (
        // Keyed on the selection: opening a DIFFERENT unit remounts the
        // detail (fresh sub-tab, fresh player, fresh popover state), while
        // everything within one unit — including the <audio> element —
        // keeps its identity across every re-render.
        <DetailView key={selectionKey(selection)} selection={selection} />
      ) : (
        <>
          <div
            className="km-review__tabs"
            role="tablist"
            aria-label="Audio corpus"
          >
            {TABS.map((t) => {
              const selected = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className={`km-review__tab focusring${selected ? ' km-review__tab--active' : ''}`}
                  onClick={() => {
                    setTab(t.id);
                  }}
                >
                  <Bilingual en={t.label} kr={t.kr} compact />
                </button>
              );
            })}
          </div>

          {tab === 'ttmik' ? <TtmikLessonsTab onOpen={openLesson} /> : null}
          {tab === 'iyagi' ? <IyagiEpisodesTab onOpen={openEpisode} /> : null}
        </>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Shared browse-row bits
// ─────────────────────────────────────────────────────────────

/** Audio indicator pill — never conveys the state by iconography alone. */
function AudioPill({ hasAudio }: { hasAudio: boolean }): JSX.Element {
  return (
    <span className="km-pill km-pill--default">
      {hasAudio ? (
        <>
          <Icon name="headphones" size={12} />{' '}
          <Bilingual en="Audio" kr="오디오" compact />
        </>
      ) : (
        <Bilingual en="No audio" kr="오디오 없음" compact />
      )}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────
// TTMIK Lessons tab — grouped by level, then number
// ─────────────────────────────────────────────────────────────

function TtmikLessonsTab({
  onOpen,
}: {
  onOpen: (lesson: TtmikLesson) => void;
}): JSX.Element {
  const [lessons, setLessons] = useState<TtmikLesson[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Monotonic reload trigger so Retry re-runs the fetch effect.
  const [reloadTick, setReloadTick] = useState(0);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    // Sync-to-external-system (network fetch) — same documented exception
    // the Reference tabs use for their kickoff setState.
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    getTtmikLessons(ctrl.signal)
      .then((rows) => {
        if (ctrl.signal.aborted) return;
        setLessons(rows);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(
          errorMessageFor(err, 'Could not load the lessons.'),
        );
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  // Group by level (ascending), lessons ordered by number within a level.
  // The server already orders (level, number); the sorts are defensive so a
  // reordering regression upstream never scrambles the browse view.
  const groups = useMemo(() => {
    const byLevel = new Map<number, TtmikLesson[]>();
    for (const lesson of lessons) {
      const bucket = byLevel.get(lesson.level);
      if (bucket) bucket.push(lesson);
      else byLevel.set(lesson.level, [lesson]);
    }
    return [...byLevel.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([level, rows]) => ({
        level,
        lessons: [...rows].sort((a, b) => a.number - b.number),
      }));
  }, [lessons]);

  if (loading) {
    return (
      <div className="km-grammar__state" role="status">
        <Bilingual en="Loading lessons…" kr="레슨을 불러오는 중…" />
      </div>
    );
  }
  if (error !== null) {
    return <ErrorCard message={error} onRetry={refetch} />;
  }
  if (groups.length === 0) {
    return (
      <p className="km-reference__empty">
        <Bilingual en="No lessons available yet." kr="아직 레슨이 없어요." />
      </p>
    );
  }

  return (
    <div>
      {groups.map((group) => (
        <div key={`level:${String(group.level)}`} style={{ marginBottom: 18 }}>
          <Eyebrow>
            <Bilingual
              en={`Level ${String(group.level)}`}
              kr={`레벨 ${String(group.level)}`}
            />
          </Eyebrow>
          <Card className="km-reference__list" variant="flat">
            <ul>
              {group.lessons.map((lesson) => (
                <li
                  key={`ttmik:${String(lesson.level)}:${String(lesson.number)}`}
                  className="km-reference__row"
                >
                  <button
                    type="button"
                    className="km-resources__list-open focusring"
                    onClick={() => {
                      onOpen(lesson);
                    }}
                    aria-label={`Open lesson ${String(lesson.number)}: ${lesson.title}`}
                  >
                    <span className="km-reference__row-en">
                      {lesson.number}.
                    </span>
                    <span className="kr km-reference__row-kr">
                      {lesson.title}
                    </span>
                    <AudioPill hasAudio={lesson.hasAudio} />
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Iyagi Episodes tab — numbered list
// ─────────────────────────────────────────────────────────────

function IyagiEpisodesTab({
  onOpen,
}: {
  onOpen: (episode: IyagiEpisode) => void;
}): JSX.Element {
  const [episodes, setEpisodes] = useState<IyagiEpisode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    // Sync-to-external-system (network fetch) — same documented exception
    // the Reference tabs use for their kickoff setState.
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    getIyagiEpisodes(ctrl.signal)
      .then((rows) => {
        if (ctrl.signal.aborted) return;
        setEpisodes(rows);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(
          errorMessageFor(err, 'Could not load the episodes.'),
        );
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  // Defensive order — the server already sorts by episode number.
  const ordered = useMemo(
    () => [...episodes].sort((a, b) => a.number - b.number),
    [episodes],
  );

  if (loading) {
    return (
      <div className="km-grammar__state" role="status">
        <Bilingual en="Loading episodes…" kr="에피소드를 불러오는 중…" />
      </div>
    );
  }
  if (error !== null) {
    return <ErrorCard message={error} onRetry={refetch} />;
  }
  if (ordered.length === 0) {
    return (
      <p className="km-reference__empty">
        <Bilingual
          en="No episodes available yet."
          kr="아직 에피소드가 없어요."
        />
      </p>
    );
  }

  return (
    <Card className="km-reference__list" variant="flat">
      <ul>
        {ordered.map((episode) => (
          <li
            key={`iyagi:${String(episode.number)}`}
            className="km-reference__row"
          >
            <button
              type="button"
              className="km-resources__list-open focusring"
              onClick={() => {
                onOpen(episode);
              }}
              aria-label={`Open episode ${String(episode.number)}: ${episode.title}`}
            >
              <span className="km-reference__row-en">#{episode.number}</span>
              <span className="kr km-reference__row-kr">{episode.title}</span>
              <AudioPill hasAudio={episode.hasAudio} />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// Detail view — persistent player + sub-tabs + clickable read-along
// ─────────────────────────────────────────────────────────────

/** Skeleton placeholder while a transcript loads (mirrors Reading's). */
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

/** Fetch the selected unit's detail, normalised into `DetailData`. */
async function loadDetail(
  selection: Selection,
  signal: AbortSignal,
): Promise<DetailData> {
  if (selection.corpus === 'ttmik') {
    const detail = await getTtmikLesson(
      selection.level,
      selection.number,
      signal,
    );
    return {
      corpus: 'ttmik',
      eyebrow: `Level ${String(detail.meta.level)} · Lesson ${String(detail.meta.number)}`,
      krEyebrow: `레벨 ${String(detail.meta.level)} · ${String(detail.meta.number)}과`,
      title: detail.meta.title,
      audioSrc: buildAudioSrc(detail.audioUrl),
      highlights: detail.highlights,
      transcript: detail.transcript,
    };
  }
  const detail = await getIyagiEpisode(selection.number, signal);
  return {
    corpus: 'iyagi',
    eyebrow: `Iyagi · Episode ${String(detail.meta.number)}`,
    krEyebrow: `이야기 · ${String(detail.meta.number)}화`,
    title: detail.meta.title,
    subtitle:
      detail.meta.hosts.length > 0 ? detail.meta.hosts.join(' · ') : null,
    audioSrc: buildAudioSrc(detail.audioUrl),
    sentences: detail.sentences,
  };
}

/** Signature every tap surface funnels into: raw word + its sentence. */
type TapWordHandler = (raw: string, sentenceText: string) => void;

function DetailView({ selection }: { selection: Selection }): JSX.Element {
  const [data, setData] = useState<DetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const ctrlRef = useRef<AbortController | null>(null);

  // Lesson sub-tab (TTMIK only). Lives here — NOT in a per-tab component —
  // so flipping it re-renders this view in place without remounting it,
  // which is what keeps the <audio> element's identity stable.
  const [lessonTab, setLessonTab] = useState<LessonTab>('highlights');

  // Tap-anything popover state (same machine as Reading's).
  const [popData, setPopData] = useState<WordPopoverData | null>(null);
  const [popLoading, setPopLoading] = useState(false);
  const [minedIds, setMinedIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  // Popover-scoped chain controller — aborted on close, new tap, unmount.
  const inFlightCtrlRef = useRef<AbortController | null>(null);

  const { toast } = useToast();

  useEffect(() => {
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    // Sync-to-external-system (network fetch) — same documented exception
    // the Reference tabs use for their kickoff setState.
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    loadDetail(selection, ctrl.signal)
      .then((detail) => {
        if (ctrl.signal.aborted) return;
        setData(detail);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(
          errorMessageFor(err, 'Could not load the transcript.'),
        );
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [selection, reloadTick]);

  // Abort any in-flight tap chain when the detail view unmounts (Browse /
  // different unit) — a late resolve must not leak a setState.
  useEffect(
    () => () => {
      inFlightCtrlRef.current?.abort();
    },
    [],
  );

  const refetch = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  /**
   * Tap on a Korean word — the Read tab's slow path verbatim: open the
   * popover immediately with a loading stub, run the abortable
   * lemmatize → define → enrich chain, land the resolved payload. The
   * chain never touches the <audio> element, so playback is unaffected
   * by taps, resolutions, or aborts.
   */
  const handleTapWord = useCallback<TapWordHandler>(
    (raw, sentenceText) => {
      inFlightCtrlRef.current?.abort();
      const ctrl = new AbortController();
      inFlightCtrlRef.current = ctrl;

      setPopLoading(true);
      setPopData({
        kr: raw,
        en: '',
        pos: 'word',
        ex_kr: '',
        ex_en: '',
        mined: minedIds.has(raw),
      });

      void resolveWordPopover(raw, sentenceText, ctrl.signal).then(
        (popover) => {
          // null = aborted (closed / newer tap) — paint nothing stale.
          if (popover === null || ctrl.signal.aborted) return;
          popover.mined = minedIds.has(popover.kr);
          setPopData(popover);
          setPopLoading(false);
        },
        () => {
          // The chain catches its own step failures, so a rejection here is
          // a defect belt-and-braces path — still resolve the popover to the
          // fixed fallback rather than stranding the spinner.
          if (ctrl.signal.aborted) return;
          setPopData({
            kr: raw,
            en: GLOSS_UNAVAILABLE,
            pos: 'word',
            ex_kr: '',
            ex_en: '',
            mined: minedIds.has(raw),
          });
          setPopLoading(false);
        },
      );
    },
    [minedIds],
  );

  /** Close the popover and abort any still-pending chain. */
  const handleClosePopover = useCallback((): void => {
    inFlightCtrlRef.current?.abort();
    inFlightCtrlRef.current = null;
    setPopData(null);
    setPopLoading(false);
  }, []);

  /**
   * Add-to-bank (FU-NF-33) — same optimistic-flip + rollback + fixed-copy
   * toast contract as Reading's vocab branch: the underline lands
   * instantly, a real failure rolls it back and surfaces a non-blocking
   * toast (never server text), a close-aborted request is swallowed.
   */
  const handleAdd = useCallback(
    (d: WordPopoverData): void | Promise<void> => {
      const lemma = d.kr;
      setMinedIds((prev) => {
        const next = new Set(prev);
        next.add(lemma);
        return next;
      });

      // Reuse the popover-scoped controller so a popover close cancels the
      // bank too; fall back to a fresh one if the chain already cleared it.
      const ctrl = inFlightCtrlRef.current ?? new AbortController();
      inFlightCtrlRef.current = ctrl;

      return mineWord(
        {
          lemma,
          ...(d.en && d.en !== GLOSS_DICTIONARY_ENTRY && d.en !== GLOSS_UNAVAILABLE
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
          if (err instanceof ApiError && err.code === 'canceled') return;
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

  // Render in ordinal order regardless of wire order (defensive sorts — the
  // server already orders by ordinal).
  const orderedHighlights = useMemo(
    () =>
      data?.corpus === 'ttmik'
        ? [...data.highlights].sort((a, b) => a.ordinal - b.ordinal)
        : [],
    [data],
  );
  const orderedTranscript = useMemo(
    () =>
      data?.corpus === 'ttmik'
        ? [...data.transcript].sort((a, b) => a.ordinal - b.ordinal)
        : [],
    [data],
  );
  const orderedSentences = useMemo(
    () =>
      data?.corpus === 'iyagi'
        ? [...data.sentences].sort((a, b) => a.ordinal - b.ordinal)
        : [],
    [data],
  );

  if (loading) return <SkeletonCard />;
  if (error !== null || data === null) {
    return (
      <ErrorCard
        message={error ?? 'Could not load the transcript.'}
        onRetry={refetch}
      />
    );
  }

  // Derive the shown sub-tab during render (never set state in an effect): if the
  // selected tab has no content, fall back to the other. Covers the ~14% of TTMIK
  // lessons with a transcript but no highlights — they open on Transcript instead
  // of an empty default tab, with no post-render flash.
  const hasHighlights = orderedHighlights.length > 0;
  const hasTranscript = orderedTranscript.length > 0;
  const effectiveTab: LessonTab =
    lessonTab === 'highlights' && !hasHighlights
      ? 'transcript'
      : lessonTab === 'transcript' && !hasTranscript
        ? 'highlights'
        : lessonTab;
  const visibleLessonTabs = LESSON_TABS.filter((t) =>
    t.id === 'highlights' ? hasHighlights : hasTranscript,
  );

  return (
    <div>
      <Eyebrow>
        <Bilingual en={data.eyebrow} kr={data.krEyebrow} />
      </Eyebrow>
      <h2 className="kr kr-display" style={{ margin: '4px 0 6px' }}>
        {data.title}
      </h2>
      {data.corpus === 'iyagi' && data.subtitle !== null ? (
        <p className="km-reference__row-en" style={{ margin: '0 0 12px' }}>
          {data.subtitle}
        </p>
      ) : null}

      {/* PERSISTENT PLAYER — rendered exactly once, at a stable position
          ABOVE the sub-tab subtree and never keyed on the active tab.
          React reconciliation therefore reuses this exact DOM node across
          Highlights ↔ Transcript switches (only the panel below swaps),
          so playback position and play/pause state survive. Do NOT move
          this inside a per-tab component or add a tab-derived key. */}
      <div style={{ margin: '12px 0 18px' }}>
        {data.audioSrc !== null ? (
          // Real streaming player; the server endpoint supports HTTP Range,
          // so seeking works. No timed caption track exists for this corpus;
          // the full read-along transcript renders directly below (per-line
          // karaoke sync is the documented follow-up once timestamps
          // exist), hence the a11y rule exemption.
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <audio
            controls
            preload="metadata"
            src={data.audioSrc}
            aria-label={`Audio for ${data.title}`}
            style={{ width: '100%' }}
          />
        ) : (
          // P3b trim: the scattered "No X for this one." empty-states are
          // consolidated to one terse "No X yet." shape (here + the panels).
          <p className="km-reference__empty" role="note">
            <Bilingual
              en="No audio yet — read along below."
              kr="아직 오디오가 없어요 — 아래에서 읽어 보세요."
            />
          </p>
        )}
      </div>

      {data.corpus === 'ttmik' ? (
        visibleLessonTabs.length === 0 ? (
          <p className="km-reference__row-en" style={{ margin: '8px 0' }}>
            <Bilingual
              en="No lesson text yet."
              kr="아직 수업 내용이 없어요."
            />
          </p>
        ) : (
          <>
            <div
              className="km-review__tabs"
              role="tablist"
              aria-label="Lesson content"
            >
              {visibleLessonTabs.map((t) => {
                const selected = effectiveTab === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className={`km-review__tab focusring${selected ? ' km-review__tab--active' : ''}`}
                    onClick={() => {
                      setLessonTab(t.id);
                    }}
                  >
                    <Bilingual en={t.label} kr={t.kr} compact />
                  </button>
                );
              })}
            </div>

            {effectiveTab === 'highlights' ? (
              <HighlightsPanel
                rows={orderedHighlights}
                minedIds={minedIds}
                onTapWord={handleTapWord}
              />
            ) : (
              <TranscriptPanel
                lines={orderedTranscript}
                minedIds={minedIds}
                onTapWord={handleTapWord}
              />
            )}
          </>
        )
      ) : (
        <SentencesPanel
          rows={orderedSentences}
          minedIds={minedIds}
          onTapWord={handleTapWord}
        />
      )}

      {popData ? (
        <WordPopover
          data={popData}
          onClose={handleClosePopover}
          onAdd={handleAdd}
          isLoading={popLoading}
        />
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Clickable Korean text — the Read tab's tap path, inline
// ─────────────────────────────────────────────────────────────

/**
 * Render a Korean string through the shared tokeniser (`tokeniseKorean` —
 * the exact splitter the Read tab feeds KoreanPassage with) as inline
 * `Tapword`s, so every word is the same tap-anything control as on Read.
 * Spaces render as bare spans; all text goes through React children
 * (escaped).
 */
function TapKorean({
  text,
  minedIds,
  onTapWord,
}: {
  text: string | null;
  minedIds: ReadonlySet<string>;
  onTapWord: TapWordHandler;
}): JSX.Element {
  const tokens = useMemo(() => tokeniseKorean(text), [text]);
  return (
    <>
      {tokens.map((tk, i) =>
        tk.gloss ? (
          <Tapword
            // Position within one immutable line — stable for this text.
            key={`${String(i)}:${tk.w}`}
            mined={minedIds.has(tk.w)}
            onTap={() => {
              // `text` is non-null whenever a token exists (null tokenises to []),
              // so this is only for the type — the '' branch is never reached.
              onTapWord(tk.w, text ?? '');
            }}
          >
            {tk.w}
          </Tapword>
        ) : (
          <span key={`${String(i)}:sp`}>{tk.w}</span>
        ),
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Detail panels
// ─────────────────────────────────────────────────────────────

interface PanelProps {
  minedIds: ReadonlySet<string>;
  onTapWord: TapWordHandler;
}

/**
 * One spoken row — Korean prominent (clickable), English + romanization
 * secondary, speaker label on dialog turns. Shared by the TTMIK Highlights
 * panel and the Iyagi transcript.
 */
function SentenceRow({
  sentence,
  minedIds,
  onTapWord,
}: PanelProps & { sentence: ListenSentence }): JSX.Element {
  const speaker = sentence.speaker ?? null;
  return (
    <li className="km-reference__row" style={{ padding: '10px 0' }}>
      {sentence.is_dialog && speaker !== null && speaker !== '' ? (
        <div className="km-eyebrow" style={{ marginBottom: 2 }}>
          {speaker}
        </div>
      ) : null}
      <p className="kr km-reference__row-kr" style={{ margin: 0 }}>
        <TapKorean
          text={sentence.korean}
          minedIds={minedIds}
          onTapWord={onTapWord}
        />
      </p>
      {sentence.english !== null && sentence.english !== '' ? (
        <p className="km-reference__row-en" style={{ margin: '2px 0 0' }}>
          {sentence.english}
        </p>
      ) : null}
    </li>
  );
}

/** TTMIK Highlights — the key-phrase layout (the original detail body). */
function HighlightsPanel({
  rows,
  minedIds,
  onTapWord,
}: PanelProps & { rows: ListenSentence[] }): JSX.Element {
  return (
    <Card variant="default" style={{ padding: '20px 22px' }}>
      <ol
        aria-label="Highlights"
        style={{ listStyle: 'none', margin: 0, padding: 0 }}
      >
        {rows.map((sentence) => (
          <SentenceRow
            key={sentence.ordinal}
            sentence={sentence}
            minedIds={minedIds}
            onTapWord={onTapWord}
          />
        ))}
      </ol>
      {rows.length === 0 ? (
        <p className="km-reference__empty">
          <Bilingual en="No highlights yet." kr="아직 하이라이트가 없어요." />
        </p>
      ) : null}
    </Card>
  );
}

/** Iyagi episode transcript — flat ordered list of spoken rows. */
function SentencesPanel({
  rows,
  minedIds,
  onTapWord,
}: PanelProps & { rows: ListenSentence[] }): JSX.Element {
  return (
    <Card variant="default" style={{ padding: '20px 22px' }}>
      <ol
        aria-label="Transcript"
        style={{ listStyle: 'none', margin: 0, padding: 0 }}
      >
        {rows.map((sentence) => (
          <SentenceRow
            key={sentence.ordinal}
            sentence={sentence}
            minedIds={minedIds}
            onTapWord={onTapWord}
          />
        ))}
      </ol>
      {rows.length === 0 ? (
        <p className="km-reference__empty">
          <Bilingual en="No transcript yet." kr="아직 대본이 없어요." />
        </p>
      ) : null}
    </Card>
  );
}

/**
 * One line of the full TTMIK transcript, rendered by `kind`:
 *   - `header`       → section heading (Korean text, English fallback).
 *   - `pair`/`dialog`→ clickable Korean + English below.
 *   - `prose`        → explanation note (clickable Korean when present,
 *                      English in the note style).
 *   - `romanization` → subtle italic line, NOT clickable (it isn't Korean).
 */
function TranscriptLineItem({
  line,
  minedIds,
  onTapWord,
}: PanelProps & { line: TtmikTranscriptLine }): JSX.Element {
  switch (line.kind) {
    case 'header':
      return (
        <li style={{ padding: '14px 0 2px' }}>
          <h3 className="km-eyebrow" style={{ margin: 0 }}>
            {line.korean != null && line.korean !== ''
              ? line.korean
              : line.english ?? ''}
          </h3>
        </li>
      );
    case 'romanization':
      // No romanization anywhere (user directive). The loader drops these lines,
      // so this is defensive — render nothing if one ever slips through.
      return <></>;
    case 'prose':
      return (
        <li className="km-reference__row" style={{ padding: '8px 0' }}>
          {line.korean != null && line.korean !== '' ? (
            <p className="kr km-reference__row-kr" style={{ margin: 0 }}>
              <TapKorean
                text={line.korean}
                minedIds={minedIds}
                onTapWord={onTapWord}
              />
            </p>
          ) : null}
          {line.english !== null && line.english !== '' ? (
            <p
              className="km-reference__row-en"
              style={{ margin: '2px 0 0' }}
              role="note"
            >
              {line.english}
            </p>
          ) : null}
        </li>
      );
    case 'pair':
    case 'dialog':
      return (
        <li className="km-reference__row" style={{ padding: '10px 0' }}>
          {line.korean != null && line.korean !== '' ? (
            <p className="kr km-reference__row-kr" style={{ margin: 0 }}>
              <TapKorean
                text={line.korean}
                minedIds={minedIds}
                onTapWord={onTapWord}
              />
            </p>
          ) : null}
          {line.english !== null && line.english !== '' ? (
            <p className="km-reference__row-en" style={{ margin: '2px 0 0' }}>
              {line.english}
            </p>
          ) : null}
        </li>
      );
    default: {
      // Exhaustiveness guard — a new wire kind fails the type-check here
      // instead of silently dropping lines at runtime.
      const exhausted: never = line.kind;
      return <li style={{ display: 'none' }}>{exhausted}</li>;
    }
  }
}

/** TTMIK full transcript — ordered lines rendered by kind. */
function TranscriptPanel({
  lines,
  minedIds,
  onTapWord,
}: PanelProps & { lines: TtmikTranscriptLine[] }): JSX.Element {
  return (
    <Card variant="default" style={{ padding: '20px 22px' }}>
      <ol
        aria-label="Transcript"
        style={{ listStyle: 'none', margin: 0, padding: 0 }}
      >
        {lines.map((line) => (
          <TranscriptLineItem
            key={line.ordinal}
            line={line}
            minedIds={minedIds}
            onTapWord={onTapWord}
          />
        ))}
      </ol>
      {lines.length === 0 ? (
        <p className="km-reference__empty">
          <Bilingual en="No transcript yet." kr="아직 대본이 없어요." />
        </p>
      ) : null}
    </Card>
  );
}
