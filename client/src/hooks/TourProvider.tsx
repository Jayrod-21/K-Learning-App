/**
 * TourProvider — trigger + persistence brain for the guided tours.
 *
 * Mounted in `Shell` (inside `ExamActiveProvider`, above the routed
 * `<Outlet/>`), so it exists only for authenticated users and every screen
 * (plus the Settings "Help & tours" controls) can reach it.
 *
 * TRIGGER MODEL
 *   - On boot it hydrates the seen-set: localStorage["km.toursSeen"] first
 *     (synchronous), then ONE `GET /settings/prefs` whose `toursSeen` is
 *     union-merged in. Auto-fire decisions WAIT for that fetch to settle
 *     (success or failure) so a tour seen on another device never flashes
 *     here first. A failed fetch falls back to the local set — worst case a
 *     tour re-fires once and is Esc-dismissable.
 *   - After hydration, on every route settle: the FIRST-RUN tour fires if
 *     its id is unseen (its anchors live in the shell chrome, so any screen
 *     works); otherwise the current surface's mini-tour fires if unseen
 *     (`surfaceTourForPath`). A short paint-settle delay lets the page
 *     render before elements are resolved.
 *   - Suppressed while a mock exam is active (`useExamActive` — a popover
 *     over a running timed exam would be hostile), and while another tour
 *     is on screen.
 *   - A tour whose anchored steps ALL fail to resolve (`'unavailable'` from
 *     the runner) is NOT marked seen — it retries on a later visit instead
 *     of burning its one shot on a half-loaded page.
 *
 * PERSISTENCE MODEL (two-tier, the accent/textSize posture)
 *   - Finish/skip → the id enters the in-memory set + localStorage
 *     synchronously (same-device durability), then a best-effort
 *     field-scoped server sync: `PATCH /settings/prefs/tours-seen` with the
 *     local set; the server union-merges into the stored list and writes
 *     ONLY that key (`jsonb_set`). Because no other prefs slice is carried,
 *     this sync structurally CANNOT clobber a palette/textSize change made
 *     meanwhile — the GET→PUT window the old full-blob read-merge-write
 *     sync had is gone. Residual (accepted): concurrent writers of
 *     `toursSeen` itself still resolve last-writer-wins on that one field;
 *     each device's localStorage re-unions on its next sync, so the set
 *     converges upward. Ids the SERVER knew and we didn't ride back on the
 *     PATCH echo and are adopted locally. Concurrent marks coalesce (single
 *     in-flight sync + one pending re-run). Sync failure is non-fatal and
 *     logged; localStorage still suppresses re-fires on this device.
 *   - The Settings screen's own prefs PUTs source `toursSeen` live from
 *     `loadSeenTours()` (see Settings.tsx), so the two writers can't wipe
 *     each other under the route's last-writer-wins posture.
 *
 * LIFECYCLE SAFETY
 *   - Route change or unmount destroys an in-flight tour (the overlay
 *     blocks in-app clicks, but browser back/forward can still navigate);
 *     driver's destroy pipeline funnels through the same single-fire
 *     onFinished, so an engaged-then-left tour counts as seen — never
 *     re-nag.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { fetchPrefs, patchToursSeen } from '../services/settings';
import { startTour, type TourHandle } from '../lib/tourDriver';
import {
  FIRST_RUN_TOUR_ID,
  surfaceTourForPath,
  tourById,
  TOUR_IDS,
  type TourDefinition,
  type TourId,
} from '../lib/tours';
import {
  loadSeenTours,
  storeSeenTours,
  TourContext,
  type TourContextValue,
} from './tour-context';
import { useExamActive } from './useExamActive';

/** Paint-settle delay before an auto-fired tour resolves its anchors — long
 *  enough for the routed screen's first real paint (and most fast data
 *  settles), short enough to still read as "on arrival". */
const START_DELAY_MS = 600;

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export function TourProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => loadSeenTours());
  const [hydrated, setHydrated] = useState(false);
  const [activeTourId, setActiveTourId] = useState<TourId | null>(null);
  const location = useLocation();
  const { examActive } = useExamActive();

  // Live mirrors for callbacks that must read current state without being
  // re-created per change (the accentRef discipline from Settings.tsx).
  const seenRef = useRef(seen);
  useEffect(() => {
    seenRef.current = seen;
  }, [seen]);
  const activeHandleRef = useRef<TourHandle | null>(null);

  // ───── Server sync (read-merge-write, coalesced) ─────
  const syncInFlightRef = useRef(false);
  const syncPendingRef = useRef(false);

  const syncSeenToServer = useCallback(async (): Promise<void> => {
    if (syncInFlightRef.current) {
      // A sync is already running against a possibly-stale snapshot —
      // queue exactly one re-run so the latest marks always land.
      syncPendingRef.current = true;
      return;
    }
    syncInFlightRef.current = true;
    try {
      // Field-scoped write: the server union-merges these ids into the
      // stored list and touches ONLY the toursSeen key, so this can never
      // carry (and therefore never revert) palette/languageDisplay/textSize
      // — see the PERSISTENCE MODEL header note.
      const echoed = await patchToursSeen([...seenRef.current].sort());
      // Rolling-deploy guard: an old server omits the field entirely.
      const serverSeen: string[] = Array.isArray(echoed.toursSeen)
        ? echoed.toursSeen
        : [];
      const merged = new Set([...serverSeen, ...seenRef.current]);
      // Adopt ids the server knew and we didn't (another device marked
      // them between boot and now) — keeps the local cache convergent.
      if (!setsEqual(merged, seenRef.current)) {
        storeSeenTours(merged);
        setSeen(merged);
      }
    } catch (err) {
      // Non-fatal: localStorage already holds the mark, and the next
      // mark/boot re-attempts. No toast — a tour-bookkeeping blip is not
      // worth interrupting anyone over.
      console.warn('tours: syncing seen state to the server failed', err);
    } finally {
      syncInFlightRef.current = false;
      if (syncPendingRef.current) {
        syncPendingRef.current = false;
        void syncSeenToServer();
      }
    }
  }, []);

  const markSeen = useCallback(
    (id: TourId): void => {
      if (seenRef.current.has(id)) return; // idempotent — no state churn, no PUT
      const next = new Set(seenRef.current);
      next.add(id);
      seenRef.current = next; // synchronous — a same-tick second call must see it
      storeSeenTours(next);
      setSeen(next);
      void syncSeenToServer();
    },
    [syncSeenToServer],
  );

  const markAllSeen = useCallback((): void => {
    const next = new Set(seenRef.current);
    let changed = false;
    for (const id of TOUR_IDS) {
      if (!next.has(id)) {
        next.add(id);
        changed = true;
      }
    }
    if (!changed) return;
    seenRef.current = next;
    storeSeenTours(next);
    setSeen(next);
    void syncSeenToServer();
  }, [syncSeenToServer]);

  // ───── Boot hydration — one GET, union-merge, then unblock auto-fire ─────
  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      try {
        const prefs = await fetchPrefs(ctrl.signal);
        if (ctrl.signal.aborted) return;
        const serverSeen: string[] = Array.isArray(prefs.toursSeen)
          ? prefs.toursSeen
          : [];
        if (serverSeen.length > 0) {
          const merged = new Set([...seenRef.current, ...serverSeen]);
          if (!setsEqual(merged, seenRef.current)) {
            seenRef.current = merged;
            storeSeenTours(merged);
            setSeen(merged);
          }
        }
      } catch {
        // Unreachable server / aborted — fall back to the local set. The
        // decision below still waits for THIS settle, so there is no
        // window where a server-seen tour fires spuriously mid-request.
      } finally {
        if (!ctrl.signal.aborted) setHydrated(true);
      }
    })();
    return () => {
      ctrl.abort();
    };
  }, []);

  // ───── Run helper (auto-fire + replay share it) ─────
  const runTour = useCallback(
    (tour: TourDefinition): void => {
      if (activeHandleRef.current !== null) return; // one tour at a time
      const result = startTour(tour, {
        onFinished: () => {
          activeHandleRef.current = null;
          setActiveTourId(null);
          // Finish AND skip both persist — never re-nag (replay of an
          // already-seen tour lands here too; markSeen is idempotent).
          markSeen(tour.id);
        },
      });
      if (result.status === 'started') {
        activeHandleRef.current = result.handle;
        setActiveTourId(tour.id);
      }
      // 'unavailable' (no step resolved an element): deliberately NOT
      // marked seen — the tour retries on a later visit.
    },
    [markSeen],
  );

  /**
   * Replay (Settings "Help & tours"): run a tour NOW regardless of seen
   * state. A surface tour replays ON its surface — navigate there first,
   * then run after the paint-settle delay so the anchors exist. The
   * first-run tour replays from Today (`/`) so its today-plan/chat-fab
   * steps resolve (both are hidden on /settings). Prefix-matched tours
   * have no static route to land on; they run in place (their un-anchored
   * steps still carry the copy).
   */
  const replayTimerRef = useRef<number | null>(null);
  const navigate = useNavigate();
  const locationRef = useRef(location.pathname);
  useEffect(() => {
    locationRef.current = location.pathname;
  }, [location.pathname]);
  const replay = useCallback(
    (id: TourId): void => {
      if (activeHandleRef.current !== null) return;
      const tour = tourById(id);
      const target = tour.match === 'prefix' ? null : (tour.path ?? '/');
      if (target !== null && locationRef.current !== target) {
        navigate(target);
        if (replayTimerRef.current !== null) {
          window.clearTimeout(replayTimerRef.current);
        }
        replayTimerRef.current = window.setTimeout(() => {
          replayTimerRef.current = null;
          runTour(tour);
        }, START_DELAY_MS);
        return;
      }
      runTour(tour);
    },
    [navigate, runTour],
  );
  useEffect(() => {
    return () => {
      if (replayTimerRef.current !== null) {
        window.clearTimeout(replayTimerRef.current);
      }
    };
  }, []);

  // ───── Auto-fire on route settle ─────
  useEffect(() => {
    if (!hydrated) return;
    if (activeTourId !== null) return;
    if (examActive) return;
    const next: TourDefinition | null = !seen.has(FIRST_RUN_TOUR_ID)
      ? tourById(FIRST_RUN_TOUR_ID)
      : (() => {
          const surface = surfaceTourForPath(location.pathname);
          return surface !== null && !seen.has(surface.id) ? surface : null;
        })();
    if (next === null) return;
    const timer = window.setTimeout(() => {
      runTour(next);
    }, START_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [hydrated, activeTourId, examActive, seen, location.pathname, runTour]);

  // ───── Teardown: route change / unmount kills an in-flight tour ─────
  useEffect(() => {
    return () => {
      // Runs on pathname change AND unmount. destroy() funnels through the
      // driver's single-fire onFinished, so an abandoned tour counts as
      // seen rather than re-nagging on the next screen.
      activeHandleRef.current?.destroy();
    };
  }, [location.pathname]);

  const value = useMemo<TourContextValue>(
    () => ({
      seen,
      hydrated,
      activeTourId,
      markSeen,
      markAllSeen,
      replay,
    }),
    [seen, hydrated, activeTourId, markSeen, markAllSeen, replay],
  );

  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
}
