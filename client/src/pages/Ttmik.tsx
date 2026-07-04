/**
 * Listen screen (F-012) — TTMIK lesson / Iyagi episode audio + read-along.
 *
 * Two browse sections behind sub-tabs (same tablist idiom as Reference):
 *   - TTMIK Lessons — grouped by level, then lesson number.
 *   - Iyagi Episodes — a numbered list.
 * Each row shows the title plus an audio indicator (`hasAudio`). Selecting a
 * row swaps the screen into the player/detail view: a REAL `<audio controls>`
 * element streaming from the server (HTTP Range → seekable), with the
 * transcript rendered line-by-line underneath — Korean prominent, English +
 * romanization secondary, and a speaker label on dialog turns. Per-line
 * karaoke highlighting is a documented follow-up: the corpus has no
 * per-sentence timestamps, so the read-along is untimed for now.
 *
 * Audio `src` contract: `buildAudioSrc` (services/ttmik.ts) joins the
 * detail's app-relative `audioUrl` onto the SAME API base the axios services
 * use, so the media request is same-origin in prod (empty base → the LB
 * routes it) and same-site in dev (Vite :5173 → API :4000) — either way the
 * `SameSite=Strict` session cookie rides the request with no extra plumbing.
 * `audioUrl === null` / `hasAudio === false` → transcript-only with a small
 * "no audio" note, no player. This deliberately does NOT use the fake
 * `AudioBlock` (that component is the B-004 prototype placeholder).
 *
 * Threat model:
 *   - All data is server corpus text rendered through React text children —
 *     escaped; no dangerouslySetInnerHTML anywhere on this screen.
 *   - The audio src is never free-form: `buildAudioSrc` rejects anything but
 *     an absolute app path, so a tampered response body cannot point the
 *     player at a third-party origin.
 *   - GET-only surface — no CSRF exposure; the session cookie posture is
 *     owned by services/api.ts (ADR-002).
 *   - Stale-response race: every fetch is keyed to an AbortController that
 *     the next fetch (or unmount) aborts; settle handlers check the signal
 *     so a slow response never paints over a newer selection.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ErrorCard } from '../components/ErrorCard';
import { Eyebrow } from '../components/Eyebrow';
import { Icon } from '../components/Icon';
import { Topbar } from '../components/Topbar';
import { ApiError } from '../services/api';
import {
  buildAudioSrc,
  getIyagiEpisode,
  getIyagiEpisodes,
  getTtmikLesson,
  getTtmikLessons,
} from '../services/ttmik';
import type {
  IyagiEpisode,
  TtmikLesson,
  TtmikSentence,
} from '../types/domain';

type Tab = 'ttmik' | 'iyagi';

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'ttmik', label: 'TTMIK Lessons' },
  { id: 'iyagi', label: 'Iyagi Episodes' },
];

/**
 * The open lesson/episode. Discriminated on `corpus` so the detail loader
 * can pick the right endpoint; `title` rides along so the header paints
 * instantly while the transcript loads.
 */
type Selection =
  | { corpus: 'ttmik'; level: number; number: number; title: string }
  | { corpus: 'iyagi'; number: number; title: string };

/** Everything the detail view renders, normalised across the two corpora. */
interface DetailData {
  /** Context line above the title, e.g. `Level 2 · Lesson 21`. */
  eyebrow: string;
  title: string;
  /** Iyagi hosts line; null for TTMIK lessons / hostless episodes. */
  subtitle: string | null;
  sentences: TtmikSentence[];
  /** Fully-resolved `<audio src>`; null → transcript-only. */
  audioSrc: string | null;
}

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
        krTitle={
          <>
            듣기 <span className="km-topbar__title-en">· Listen</span>
          </>
        }
        eyebrow="TTMIK · Iyagi audio"
        right={
          selection !== null ? (
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<Icon name="list" size={14} />}
              onClick={closeDetail}
              aria-label="Back to all lessons and episodes"
            >
              Browse
            </Button>
          ) : undefined
        }
      />
      <span id="km-ttmik-title" className="km-sr-only">
        Listen
      </span>

      {selection !== null ? (
        <DetailView selection={selection} />
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
                  {t.label}
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
          <Icon name="headphones" size={12} /> Audio
        </>
      ) : (
        'No audio'
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
          err instanceof ApiError ? err.message : 'Could not load the lessons.',
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
        Loading lessons…
      </div>
    );
  }
  if (error !== null) {
    return <ErrorCard message={error} onRetry={refetch} />;
  }
  if (groups.length === 0) {
    return <p className="km-reference__empty">No lessons available yet.</p>;
  }

  return (
    <div>
      {groups.map((group) => (
        <div key={`level:${String(group.level)}`} style={{ marginBottom: 18 }}>
          <Eyebrow>Level {group.level}</Eyebrow>
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
          err instanceof ApiError
            ? err.message
            : 'Could not load the episodes.',
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
        Loading episodes…
      </div>
    );
  }
  if (error !== null) {
    return <ErrorCard message={error} onRetry={refetch} />;
  }
  if (ordered.length === 0) {
    return <p className="km-reference__empty">No episodes available yet.</p>;
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
// Detail view — real player + line-by-line read-along transcript
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
      eyebrow: `Level ${String(detail.meta.level)} · Lesson ${String(detail.meta.number)}`,
      title: detail.meta.title,
      subtitle: null,
      sentences: detail.sentences,
      audioSrc: buildAudioSrc(detail.audioUrl),
    };
  }
  const detail = await getIyagiEpisode(selection.number, signal);
  return {
    eyebrow: `Iyagi · Episode ${String(detail.meta.number)}`,
    title: detail.meta.title,
    subtitle: detail.meta.hosts.length > 0 ? detail.meta.hosts.join(' · ') : null,
    sentences: detail.sentences,
    audioSrc: buildAudioSrc(detail.audioUrl),
  };
}

function DetailView({ selection }: { selection: Selection }): JSX.Element {
  const [data, setData] = useState<DetailData | null>(null);
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
          err instanceof ApiError
            ? err.message
            : 'Could not load the transcript.',
        );
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [selection, reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  // Render in ordinal order regardless of wire order (defensive sort — the
  // server already orders by ordinal).
  const orderedSentences = useMemo(
    () =>
      data ? [...data.sentences].sort((a, b) => a.ordinal - b.ordinal) : [],
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

  return (
    <div>
      <Eyebrow>{data.eyebrow}</Eyebrow>
      <h2 className="kr kr-display" style={{ margin: '4px 0 6px' }}>
        {data.title}
      </h2>
      {data.subtitle !== null ? (
        <p className="km-reference__row-en" style={{ margin: '0 0 12px' }}>
          {data.subtitle}
        </p>
      ) : null}

      <div style={{ margin: '12px 0 18px' }}>
        {data.audioSrc !== null ? (
          // Real streaming player (NOT the B-004 AudioBlock placeholder).
          // The server endpoint supports HTTP Range, so seeking works.
          // No timed caption track exists for this corpus; the full
          // line-by-line transcript renders directly below the player
          // (per-line karaoke sync is the documented follow-up once
          // timestamps exist), hence the a11y rule exemption.
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <audio
            controls
            preload="metadata"
            src={data.audioSrc}
            aria-label={`Audio for ${data.title}`}
            style={{ width: '100%' }}
          />
        ) : (
          <p className="km-reference__empty" role="note">
            No audio for this one yet — read along below.
          </p>
        )}
      </div>

      <Card variant="default" style={{ padding: '20px 22px' }}>
        <ol
          aria-label="Transcript"
          style={{ listStyle: 'none', margin: 0, padding: 0 }}
        >
          {orderedSentences.map((sentence) => (
            <TranscriptLine key={sentence.id} sentence={sentence} />
          ))}
        </ol>
        {orderedSentences.length === 0 ? (
          <p className="km-reference__empty">
            No transcript lines for this one.
          </p>
        ) : null}
      </Card>
    </div>
  );
}

/**
 * One read-along row — Korean prominent, English + romanization secondary,
 * speaker label on dialog turns. All strings are server corpus text rendered
 * as React text children (escaped).
 */
function TranscriptLine({
  sentence,
}: {
  sentence: TtmikSentence;
}): JSX.Element {
  const speaker =
    sentence.is_dialog && sentence.speaker !== null && sentence.speaker !== ''
      ? sentence.speaker
      : null;
  return (
    <li className="km-reference__row" style={{ padding: '10px 0' }}>
      {speaker !== null ? (
        <div className="km-eyebrow" style={{ marginBottom: 2 }}>
          {speaker}
        </div>
      ) : null}
      <p className="kr km-reference__row-kr" style={{ margin: 0 }}>
        {sentence.korean}
      </p>
      {sentence.english !== null && sentence.english !== '' ? (
        <p className="km-reference__row-en" style={{ margin: '2px 0 0' }}>
          {sentence.english}
        </p>
      ) : null}
      {sentence.romanization !== null && sentence.romanization !== '' ? (
        <p
          className="km-reference__row-en"
          style={{ margin: '2px 0 0', fontStyle: 'italic' }}
        >
          {sentence.romanization}
        </p>
      ) : null}
    </li>
  );
}
