/**
 * Hanja screen — 한자 character study.
 *
 * Two views, locally state-toggled:
 *   - `today` — `HanjaFeature` card for the day's featured character,
 *               vermilion 田 grid backdrop, 96px serif glyph, compound
 *               word chips beneath a `GoldRule`.
 *   - `index` — filter chips (All / Banked / Practicing / New) over a
 *               grid of `<HanjaCell>`s.
 *
 * Tapping any cell or the feature card opens a `<Sheet>` with the
 * etymology + compound network + drill / bank CTAs. Per design
 * `screens-c.jsx` HanjaDetailSheet — only the studied character is
 * vermilion inside each compound; the other glyphs stay paper ink.
 *
 * Data (Pass 7 — live):
 *   - `GET /hanja`          via `fetchHanjaList` (mock: `loadHanjaMock`) →
 *                            the whole character pool; the screen filters the
 *                            pool locally over the four state chips.
 *   - `GET /hanja/today`    via `fetchHanjaToday` (mock: `loadHanjaTodayMock`)
 *                            → the server-weighted featured character, or null
 *                            (empty corpus) → an empty state.
 *   - `GET /hanja/progress` via `fetchHanjaProgress` (mock:
 *                            `loadHanjaProgressMock`) → the Encountered band.
 *   - `POST /hanja/:char/state` via `setHanjaState` → the detail-sheet
 *                            bank/practice control; on success the new state is
 *                            applied OPTIMISTICALLY to a local overlay (no
 *                            data-resetting refetch), so the open detail sheet
 *                            stays mounted and the screen never flashes its
 *                            skeleton. The overlay is layered over the fetched
 *                            list / featured card / progress counts.
 *   All reads flow through `useEndpointOrMock`, so the dev-only 🅂 badge lights
 *   only while a source is still on its mock fallback.
 *
 * Accessibility:
 *   - The view toggle is a `role="tablist"` of `role="tab"` buttons whose
 *     selected state is `aria-selected` (matching Grammar.tsx / Review.tsx).
 *     `aria-pressed` is NOT valid on `role="tab"` and is deliberately absent.
 *   - The filter chips are plain `<button>`s (a `role="toolbar"`), so they use
 *     `aria-pressed` for their toggled state — correct for buttons.
 *   - `HanjaCell` and `HanjaFeature` carry their own labels — featured
 *     card aria-labels the day's character.
 *   - Sheet has `aria-label="Hanja detail"` (handled in the Sheet
 *     component's contract).
 *
 * Threat model: reads are GETs (no CSRF surface); the one write is a POST
 * defended by the `SameSite=Strict` session cookie. No user input flows into
 * HTML outside React's escaping. A failed `setHanjaState` surfaces an inline
 * error and applies NO optimistic overlay entry (the overlay is written only
 * after the await resolves), so a rejected write can never corrupt the screen's
 * rendered state.
 */
import { useCallback, useMemo, useState, type JSX } from 'react';
import { Card } from '../components/Card';
import { CornerMark } from '../components/CornerMark';
import { Eyebrow } from '../components/Eyebrow';
import { GoldRule } from '../components/GoldRule';
import { HanjaCell } from '../components/HanjaCell';
import { Icon } from '../components/Icon';
import { MockBadge } from '../components/MockBadge';
import { Pill } from '../components/Pill';
import { SealStamp } from '../components/SealStamp';
import { Sheet } from '../components/Sheet';
import { TianGrid } from '../components/TianGrid';
import { Topbar } from '../components/Topbar';
import {
  loadHanjaMock,
  loadHanjaProgressMock,
  loadHanjaTodayMock,
} from '../data/mocks/hanja';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import {
  fetchHanjaList,
  fetchHanjaProgress,
  fetchHanjaToday,
  setHanjaState,
} from '../services/hanja';
import type {
  Hanja,
  HanjaProgress,
  HanjaState,
} from '../types/domain';

type ViewMode = 'today' | 'index';
type FilterMode = 'all' | HanjaState;

const FILTER_OPTIONS: ReadonlyArray<{ id: FilterMode; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'banked', label: 'Banked' },
  { id: 'practicing', label: 'Practicing' },
  { id: 'new', label: 'New' },
];

const STATE_PILL_LABEL: Record<HanjaState, string> = {
  banked: 'Banked',
  practicing: 'Practicing',
  new: 'New',
};

const STATE_PILL_TONE = {
  banked: 'green',
  practicing: 'gold',
  new: 'default',
} as const;

export default function Hanja(): JSX.Element {
  // Whole-pool fetch; the screen filters locally over the four state chips, so
  // the key stays constant and `realFn` requests the whole pool (no filter).
  const charsResult = useEndpointOrMock<Hanja[]>('hanja:list', loadHanjaMock, {
    realFn: () => fetchHanjaList(),
  });
  const progressResult = useEndpointOrMock<HanjaProgress>(
    'hanja:progress',
    loadHanjaProgressMock,
    { realFn: () => fetchHanjaProgress() },
  );
  // The server owns the "today" weighting (recently-mined words → frequency →
  // deterministic-by-day) and may return null on an empty corpus.
  const todayResult = useEndpointOrMock<Hanja | null>(
    'hanja:today',
    loadHanjaTodayMock,
    { realFn: () => fetchHanjaToday() },
  );

  const [view, setView] = useState<ViewMode>('today');
  const [filter, setFilter] = useState<FilterMode>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  // Tracks an in-flight `setHanjaState` so the detail control can disable
  // itself and surface a failure without ever mutating the rendered pool.
  const [stateError, setStateError] = useState<string | null>(null);
  const [pendingChar, setPendingChar] = useState<string | null>(null);
  // Optimistic overlay: char → its locally-applied state after a successful
  // write. Layered over the fetched data so a bank/practice updates the screen
  // WITHOUT a refetch that would reset the list to null — which would unmount
  // the open detail sheet and flash the loading skeleton. An entry is written
  // only after `setHanjaState` resolves, so a failed write adds nothing and the
  // rendered state stays exactly as fetched.
  const [stateOverrides, setStateOverrides] = useState<Record<string, HanjaState>>(
    {},
  );

  // Apply the optimistic overlay over the fetched pool. Keyed by `ch` (the
  // server identity used by the write), so an override follows the character
  // across both the index grid and the featured card.
  const chars = useMemo<Hanja[] | null>(() => {
    const fetched = charsResult.data;
    if (!fetched) return null;
    if (Object.keys(stateOverrides).length === 0) return fetched;
    return fetched.map((h) => {
      const to = stateOverrides[h.ch];
      return to && to !== h.state ? { ...h, state: to } : h;
    });
  }, [charsResult.data, stateOverrides]);

  // Recompute the progress band from the overlay deltas so the Banked /
  // Practicing / New counts move in lockstep with the optimistic list. Only
  // characters present in the fetched pool contribute a delta (the counts are
  // pool-derived), so an overlay for an off-pool char is a no-op here.
  const progress = useMemo<HanjaProgress | null>(() => {
    const base = progressResult.data;
    if (!base) return null;
    const fetched = charsResult.data;
    if (!fetched || Object.keys(stateOverrides).length === 0) return base;
    const counts = { banked: base.banked, practicing: base.practicing, new: base.new };
    let encountered = base.encountered;
    for (const h of fetched) {
      const to = stateOverrides[h.ch];
      if (!to || to === h.state) continue;
      counts[h.state] = Math.max(0, counts[h.state] - 1);
      counts[to] += 1;
      // A character leaving 'new' for the first time becomes "encountered".
      if (h.state === 'new') encountered += 1;
    }
    return { ...base, ...counts, encountered };
  }, [progressResult.data, charsResult.data, stateOverrides]);

  const featured = useMemo<Hanja | null>(() => {
    const f = todayResult.data ?? null;
    if (!f) return null;
    const to = stateOverrides[f.ch];
    return to && to !== f.state ? { ...f, state: to } : f;
  }, [todayResult.data, stateOverrides]);

  const isMock =
    charsResult.isMock || progressResult.isMock || todayResult.isMock;

  // Set a character's state, then apply it optimistically to the local overlay.
  // The write is gated: the overlay entry is written only AFTER the await
  // resolves, so a rejected call surfaces an inline error and leaves the
  // rendered data untouched (no optimistic mutation to roll back). No refetch
  // fires, so the open detail sheet stays mounted and the screen never flashes
  // its skeleton.
  const onSetState = useCallback(
    async (ch: string, next: HanjaState): Promise<void> => {
      setPendingChar(ch);
      setStateError(null);
      try {
        await setHanjaState(ch, next);
        setStateOverrides((prev) => ({ ...prev, [ch]: next }));
      } catch {
        setStateError("We couldn't update that hanja. Try again in a moment.");
      } finally {
        setPendingChar(null);
      }
    },
    [],
  );

  const filtered = useMemo<Hanja[]>(() => {
    if (!chars) return [];
    if (filter === 'all') return chars;
    return chars.filter((h) => h.state === filter);
  }, [chars, filter]);

  const opened = useMemo<Hanja | null>(() => {
    if (!openId || !chars) return null;
    return chars.find((h) => h.id === openId) ?? null;
  }, [openId, chars]);

  const loading =
    charsResult.loading || progressResult.loading || todayResult.loading;
  // The list + progress are required to paint anything; `today` is not — a null
  // featured character (empty corpus) is a valid state the Today view handles
  // on its own, so `todayResult.error` is intentionally excluded here.
  const fatal =
    !loading && (!chars || !progress) && (charsResult.error ?? progressResult.error);

  return (
    <section
      className="screen km-hanja"
      style={{ position: 'relative' }}
      aria-labelledby="km-hanja-title"
    >
      {isMock ? <MockBadge /> : null}
      <Topbar
        krTitle={
          <>
            한자{' '}
            <span className="km-topbar__title-en">· Hanja</span>
          </>
        }
        eyebrow="the bones inside the words"
      />

      {loading ? (
        <Card className="km-hanja__skeleton" aria-busy="true">
          <Eyebrow>Loading hanja</Eyebrow>
          <div className="km-hanja__skeleton-line" />
          <div className="km-hanja__skeleton-line" />
        </Card>
      ) : fatal ? (
        <Card className="km-hanja__error" role="alert">
          <Eyebrow>Hanja unavailable</Eyebrow>
          <p>We couldn&apos;t load 한자 right now. Pull to retry shortly.</p>
        </Card>
      ) : progress && chars ? (
        <>
          <EncounteredBand progress={progress} />
          <ViewToggle view={view} onChange={setView} />
          {view === 'today' &&
            (featured ? (
              <HanjaFeature
                h={featured}
                onOpen={() => {
                  setOpenId(featured.id);
                }}
              />
            ) : (
              <Card className="km-hanja__empty">
                <Eyebrow>No featured 한자 yet</Eyebrow>
                <p>
                  Read a passage to start mining 한자 — your daily character
                  will surface here.
                </p>
              </Card>
            ))}
          {view === 'index' && (
            <IndexView
              chars={filtered}
              filter={filter}
              onFilter={setFilter}
              onOpen={setOpenId}
            />
          )}
        </>
      ) : (
        <Card className="km-hanja__empty">
          <Eyebrow>No hanja yet</Eyebrow>
          <p>Read a passage to start encountering 한자.</p>
        </Card>
      )}

      <Sheet
        open={Boolean(opened)}
        onClose={() => {
          setOpenId(null);
        }}
        ariaLabel="Hanja detail"
      >
        {opened ? (
          <HanjaDetail
            h={opened}
            pending={pendingChar === opened.ch}
            error={stateError}
            onSetState={onSetState}
          />
        ) : null}
      </Sheet>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Pieces — kept in-file because they're consumed only here.
// ─────────────────────────────────────────────────────────────

function EncounteredBand({
  progress,
}: {
  progress: HanjaProgress;
}): JSX.Element {
  const pct =
    progress.targetL4 > 0
      ? Math.min(100, (progress.encountered / progress.targetL4) * 100)
      : 0;
  return (
    <Card className="km-hanja__band">
      <CornerMark />
      <Eyebrow>
        Encountered · {progress.encountered} of ~{progress.targetL4} at L4
      </Eyebrow>
      <div className="km-hanja__chips">
        <StateChip label="Banked" count={progress.banked} tone="moss" />
        <StateChip
          label="Practicing"
          count={progress.practicing}
          tone="vermilion"
        />
        <StateChip label="New" count={progress.new} tone="mute" />
      </div>
      <div
        className="km-hanja__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={progress.targetL4}
        aria-valuenow={progress.encountered}
        aria-label="Hanja encountered out of L4 target"
      >
        <div
          className="km-hanja__bar-fill"
          style={{ width: `${pct.toFixed(1)}%` }}
        />
      </div>
      <p className="km-hanja__note">{progress.note}</p>
    </Card>
  );
}

function StateChip({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: 'moss' | 'vermilion' | 'mute';
}): JSX.Element {
  return (
    <div className={`km-hanja__statechip km-hanja__statechip--${tone}`}>
      <span className="km-hanja__statechip-count">{count}</span>
      <span className="km-hanja__statechip-label">{label}</span>
    </div>
  );
}

function ViewToggle({
  view,
  onChange,
}: {
  view: ViewMode;
  onChange: (next: ViewMode) => void;
}): JSX.Element {
  const tabs: ReadonlyArray<{ id: ViewMode; label: string }> = [
    { id: 'today', label: "Today's 한자" },
    { id: 'index', label: 'Index' },
  ];
  return (
    <div className="km-hanja__viewtoggle" role="tablist" aria-label="Hanja view">
      {tabs.map((t) => {
        const active = view === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={
              'km-hanja__viewtab focusring' +
              (active ? ' km-hanja__viewtab--active' : '')
            }
            onClick={() => {
              if (!active) onChange(t.id);
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function HanjaFeature({
  h,
  onOpen,
}: {
  h: Hanja;
  onOpen: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="km-hanja__feature focusring"
      aria-label={`Today's hanja ${h.ch} — ${h.gloss} ${h.sound}`}
    >
      <span className="km-hanja__feature-seal">
        <SealStamp char="韓" size="md" />
      </span>

      <div className="km-hanja__feature-row">
        <div className="km-hanja__feature-square">
          <TianGrid />
          <span className="hanja km-hanja__feature-char">{h.ch}</span>
        </div>

        <div className="km-hanja__feature-meta">
          <Eyebrow>Today&apos;s 한자</Eyebrow>
          <div className="kr kr-display km-hanja__feature-gloss">
            <span className="km-hanja__feature-gloss-kr">{h.gloss}</span>{' '}
            <span className="km-hanja__feature-gloss-sound">{h.sound}</span>
          </div>
          <div className="km-hanja__feature-en">{h.en}</div>
          <div className="km-hanja__feature-pills">
            <Pill>{h.strokes} strokes</Pill>
            <Pill>{h.level}</Pill>
            <Pill tone={STATE_PILL_TONE[h.state]}>
              {STATE_PILL_LABEL[h.state]}
            </Pill>
          </div>
        </div>
      </div>

      <GoldRule />

      <div className="km-hanja__feature-compounds">
        <Eyebrow>Words you unlock · {h.compounds.length}</Eyebrow>
        <div className="km-hanja__compound-row">
          {h.compounds.map((c, i) => (
            <span key={`${c.kr}-${String(i)}`} className="km-hanja__compound-chip kr">
              <span className="hanja km-hanja__compound-han">{c.kr}</span>
              <span className="km-hanja__compound-en">{c.en}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="km-hanja__feature-foot">
        <span>Tap for etymology + drill</span>
        <Icon name="arrow-right" size={16} />
      </div>
    </button>
  );
}

function IndexView({
  chars,
  filter,
  onFilter,
  onOpen,
}: {
  chars: Hanja[];
  filter: FilterMode;
  onFilter: (next: FilterMode) => void;
  onOpen: (id: string) => void;
}): JSX.Element {
  return (
    <>
      <div className="km-hanja__filters" role="toolbar" aria-label="Filter hanja by state">
        {FILTER_OPTIONS.map((f) => {
          const active = filter === f.id;
          return (
            <button
              key={f.id}
              type="button"
              aria-pressed={active}
              onClick={() => {
                if (!active) onFilter(f.id);
              }}
              className={
                'km-pill focusring km-hanja__filter' +
                (active ? ' km-pill--gold' : ' km-pill--default')
              }
            >
              {f.label}
            </button>
          );
        })}
      </div>
      {chars.length === 0 ? (
        <p className="km-hanja__index-empty">No hanja match that filter yet.</p>
      ) : (
        <div className="km-hanja__grid">
          {chars.map((h) => (
            <HanjaCell
              key={h.id}
              char={h.ch}
              sound={h.sound}
              gloss={h.gloss}
              state={h.state}
              onClick={() => {
                onOpen(h.id);
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}

function HanjaDetail({
  h,
  pending,
  error,
  onSetState,
}: {
  h: Hanja;
  /** True while this character's `setHanjaState` call is in flight. */
  pending: boolean;
  /** Inline error from the last failed state write, or null. */
  error: string | null;
  onSetState: (ch: string, next: HanjaState) => void;
}): JSX.Element {
  // The single bank/practice control toggles the character between the SRS
  // ("practicing") and mastered ("banked") states. A banked character offers
  // "Practice again"; anything else offers "Bank this hanja".
  const nextState: HanjaState = h.state === 'banked' ? 'practicing' : 'banked';
  const bankLabel =
    h.state === 'banked' ? 'Practice again' : 'Bank this hanja';
  return (
    <div className="km-hanja__detail">
      <div className="km-hanja__detail-head">
        <span className="hanja km-hanja__detail-char">{h.ch}</span>
        <div className="km-hanja__detail-meta">
          <div className="kr kr-display km-hanja__detail-gloss">
            <span>{h.gloss}</span>{' '}
            <span className="km-hanja__detail-sound">{h.sound}</span>
          </div>
          <div className="km-hanja__detail-en">{h.en}</div>
          <div className="km-hanja__detail-pills">
            <Pill>{h.strokes} strokes</Pill>
            <Pill>{h.level}</Pill>
            <Pill tone={STATE_PILL_TONE[h.state]}>
              {STATE_PILL_LABEL[h.state]}
            </Pill>
          </div>
        </div>
      </div>

      <Eyebrow className="km-hanja__detail-eyebrow">Etymology</Eyebrow>
      <p className="km-hanja__detail-note">{h.note}</p>

      <Eyebrow className="km-hanja__detail-eyebrow">
        Compound words · {h.compounds.length}
      </Eyebrow>
      <ul className="km-hanja__detail-compounds">
        {h.compounds.map((c, i) => (
          <li key={`${c.kr}-${String(i)}`} className="km-hanja__detail-row">
            <span className="hanja km-hanja__detail-compound-han">
              {Array.from(c.han).map((glyph, gi) => (
                <span
                  key={`${glyph}-${String(gi)}`}
                  className={
                    glyph === h.ch
                      ? 'km-hanja__detail-han km-hanja__detail-han--studied'
                      : 'km-hanja__detail-han'
                  }
                >
                  {glyph}
                </span>
              ))}
            </span>
            <div className="km-hanja__detail-compound-meta">
              <div className="kr km-hanja__detail-compound-reading">{c.kr}</div>
              <div className="km-hanja__detail-compound-en">{c.en}</div>
            </div>
            <span className="km-hanja__detail-compound-with">
              + <span className="hanja">{c.with}</span>
            </span>
          </li>
        ))}
      </ul>

      <div className="km-hanja__detail-cta">
        <button
          type="button"
          className="km-btn km-btn--gold km-btn--md focusring km-hanja__detail-drill"
        >
          <Icon name="pen" size={14} />
          <span>Drill · recall 음 &amp; 뜻</span>
        </button>
        <button
          type="button"
          className="km-btn km-btn--ghost km-btn--md focusring km-hanja__detail-bank"
          disabled={pending}
          aria-busy={pending}
          onClick={() => {
            onSetState(h.ch, nextState);
          }}
        >
          <Icon name="plus" size={14} />
          <span>{pending ? 'Saving…' : bankLabel}</span>
        </button>
      </div>
      {error ? (
        <p className="km-hanja__detail-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
