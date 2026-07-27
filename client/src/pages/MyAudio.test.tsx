/**
 * My Audio (Track A A-4b) — the Listen page's third collection: upload
 * control (pre-check + progress + fixed-copy failures), the transcript-
 * status listing with the app's FIRST polling loop (starts only while a
 * track is pending/running, stops when everything settles, interval +
 * in-flight request cleared on unmount), and the track detail (real
 * `<audio>` via the REAL `buildAudioSrc` allow-list, ordered segments,
 * transcribing/failed states, uniform 404).
 *
 * Exercised THROUGH the Ttmik page (My Audio is a `?corpus=mine` view of
 * `/learn/listen`, not a route of its own). `services/audio`'s fetchers are
 * mocked; `checkAudioFile` stays REAL so the pre-check copy is the actual
 * shipped copy. `services/ttmik` is NOT mocked at all — no TTMIK/Iyagi view
 * is visited here, and `buildAudioSrc` must stay real so the player-src
 * assertions cover the true allow-list (empty API base in tests →
 * app-relative src).
 *
 * GOTCHA (AudioBlock.test.tsx precedent): `userEvent` deadlocks against
 * `vi.useFakeTimers()` in happy-dom — every fake-timer (polling) test uses
 * `fireEvent` + `advanceTimersByTimeAsync` wrapped in `act`; `userEvent`
 * appears only in real-timer tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/ToastProvider';
import { ApiError } from '../services/api';
import {
  getAudioTrack,
  listMyAudio,
  uploadAudio,
  type UploadAudioOptions,
} from '../services/audio';
import type {
  AudioSource,
  AudioTrackDetail,
  AudioUploadResponse,
} from '../types/domain';

vi.mock('../services/audio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/audio')>();
  return {
    ...actual,
    uploadAudio: vi.fn(),
    listMyAudio: vi.fn(),
    getAudioTrack: vi.fn(),
  };
});

// Import after the mock so the page binds the mocked fetchers.
import Ttmik from './Ttmik';

function source(
  id: number,
  title: string,
  status: AudioSource['tracks'][number]['transcriptStatus'],
  trackId = id * 10,
): AudioSource {
  return {
    id,
    title,
    kind: 'standalone_listening',
    createdAt: '2026-07-18T00:00:00Z',
    tracks: [
      {
        id: trackId,
        trackNumber: 1,
        title,
        byteSize: 1_000_000,
        durationMs: null,
        transcriptStatus: status,
      },
    ],
  };
}

const SETTLED_SOURCES: AudioSource[] = [
  source(1, '팟캐스트 1화', 'done', 34),
  source(2, '망한 녹음', 'failed', 41),
];

const PENDING_SOURCES: AudioSource[] = [source(3, '새 녹음', 'pending', 77)];

/** One track row for a multi-track (corpus-loaded) source. */
function trk(
  id: number,
  trackNumber: number,
  title: string | null,
  status: AudioSource['tracks'][number]['transcriptStatus'],
): AudioSource['tracks'][number] {
  return {
    id,
    trackNumber,
    title,
    byteSize: 1_000_000,
    durationMs: null,
    transcriptStatus: status,
  };
}

/** A multi-track set — the corpus-loaded shape the listing must route to the
 *  track-list view rather than straight to `tracks[0]`. Track 3 has a null
 *  title to exercise the `Track N` fallback label. All settled → no poll. */
const MULTI_SOURCE: AudioSource = {
  id: 5,
  title: 'TTMIK Level 1',
  kind: 'standalone_listening',
  createdAt: '2026-07-27T00:00:00Z',
  tracks: [
    trk(51, 1, 'Intro', 'done'),
    trk(52, 2, 'Track 02', 'done'),
    trk(53, 3, null, 'done'),
  ],
};

/** Same set with an unsettled track — for the source-view poll test. */
const MULTI_SOURCE_PENDING: AudioSource = {
  ...MULTI_SOURCE,
  tracks: [
    trk(51, 1, 'Intro', 'done'),
    trk(52, 2, 'Track 02', 'running'),
    trk(53, 3, null, 'pending'),
  ],
};

/** Segments deliberately OUT of order — the page must sort by segmentNumber. */
const DETAIL_DONE: AudioTrackDetail = {
  track: {
    id: 34,
    title: '팟캐스트 1화',
    transcriptStatus: 'done',
    durationMs: 180_000,
    streamUrl: '/audio/tracks/34/stream',
  },
  segments: [
    { segmentNumber: 2, startMs: 4200, endMs: 8000, body: '오늘은 날씨 이야기를 해요.' },
    { segmentNumber: 1, startMs: 0, endMs: 4200, body: '안녕하세요, 여러분.' },
  ],
};

const DETAIL_RUNNING: AudioTrackDetail = {
  track: {
    id: 77,
    title: '새 녹음',
    transcriptStatus: 'running',
    durationMs: null,
    streamUrl: '/audio/tracks/77/stream',
  },
  segments: [],
};

function renderPage(initialEntry = '/learn/listen?corpus=mine'): ReturnType<typeof render> {
  return render(
    <div className="km-shell__scroll">
      <MemoryRouter initialEntries={[initialEntry]}>
        <ToastProvider>
          <Ttmik />
        </ToastProvider>
      </MemoryRouter>
    </div>,
  );
}

function getFileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]');
  if (input === null) throw new Error('file input not found');
  return input as HTMLInputElement;
}

/** Flush pending microtasks (mock promise settles) under fake timers. */
async function flushAsync(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.mocked(listMyAudio).mockReset().mockResolvedValue(SETTLED_SOURCES);
  vi.mocked(getAudioTrack).mockReset().mockResolvedValue(DETAIL_DONE);
  vi.mocked(uploadAudio).mockReset();
  window.sessionStorage.clear();
});

afterEach(() => {
  // Fake-timer tests restore their own real timers; this is belt-and-
  // suspenders so a mid-test failure can't leak fake timers forward.
  vi.useRealTimers();
});

describe('My Audio — listing', () => {
  // NOTE (R3-N1): this test runs on REAL timers, so it proves the single
  // fetch-on-open only — the "settled list never polls" property is pinned
  // by the fake-timer plateau tests in the polling describe below.
  it('lists the sources with their transcript-status pills (single fetch on open)', async () => {
    renderPage();

    const doneRow = await screen.findByRole('button', {
      name: 'Open audio: 팟캐스트 1화 (Ready)',
    });
    expect(within(doneRow).getByText('Ready')).toBeInTheDocument();
    const failedRow = screen.getByRole('button', {
      name: 'Open audio: 망한 녹음 (Failed)',
    });
    expect(within(failedRow).getByText('Failed')).toBeInTheDocument();

    expect(vi.mocked(listMyAudio)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(listMyAudio)).toHaveBeenCalledWith(
      expect.any(AbortSignal),
    );
  });

  it('shows the giwa empty state when there is no audio yet (upload control still present)', async () => {
    vi.mocked(listMyAudio).mockResolvedValue([]);
    renderPage();

    expect(
      await screen.findByText(/No audio yet\./),
    ).toBeInTheDocument();
    // The empty state MUST still offer the upload path — it is how the
    // first file ever gets in.
    expect(
      screen.getByRole('button', { name: /Upload audio/ }),
    ).toBeInTheDocument();
  });

  it('surfaces a list failure as fixed-copy ErrorCard with a working retry (no server prose)', async () => {
    const user = userEvent.setup();
    vi.mocked(listMyAudio)
      .mockRejectedValueOnce(
        new ApiError('boom internal', { status: 500, code: 'server_error' }),
      )
      .mockResolvedValueOnce(SETTLED_SOURCES);
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Could not load your audio\./);
    expect(alert).not.toHaveTextContent(/boom internal/);

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByRole('button', {
        name: 'Open audio: 팟캐스트 1화 (Ready)',
      }),
    ).toBeInTheDocument();
    expect(vi.mocked(listMyAudio)).toHaveBeenCalledTimes(2);
  });

  it('opening a row navigates to that track detail', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', {
        name: 'Open audio: 팟캐스트 1화 (Ready)',
      }),
    );

    expect(await screen.findByRole('heading', { name: '팟캐스트 1화' })).toBeInTheDocument();
    expect(vi.mocked(getAudioTrack)).toHaveBeenCalledWith(
      34,
      expect.any(AbortSignal),
    );
  });
});

describe('My Audio — upload', () => {
  it('a passing file uploads (title from filename) and the fresh source is spliced in as Queued', async () => {
    let capturedOpts: UploadAudioOptions | undefined;
    vi.mocked(uploadAudio).mockImplementation(
      (_file: File, opts?: UploadAudioOptions) => {
        capturedOpts = opts;
        return Promise.resolve<AudioUploadResponse>({
          sourceId: 9,
          trackId: 91,
          jobId: 5,
          transcriptStatus: 'pending',
        });
      },
    );
    renderPage();
    await screen.findByRole('button', {
      name: 'Open audio: 팟캐스트 1화 (Ready)',
    });

    const file = new File([new Uint8Array(64)], 'my-recording.mp3', {
      type: 'audio/mpeg',
    });
    fireEvent.change(getFileInput(), { target: { files: [file] } });

    // The new row lands at the top with the pending ("Queued") pill —
    // spliced from the upload response, no refetch needed.
    const newRow = await screen.findByRole('button', {
      name: 'Open audio: my-recording (Queued)',
    });
    expect(within(newRow).getByText('Queued')).toBeInTheDocument();
    // Success ack toast (fixed copy).
    expect(
      await screen.findByText('Uploaded — transcription started.'),
    ).toBeInTheDocument();

    expect(vi.mocked(uploadAudio)).toHaveBeenCalledTimes(1);
    expect(capturedOpts?.title).toBe('my-recording');
    expect(capturedOpts?.signal).toBeInstanceOf(AbortSignal);
    // The pre-existing rows survived the splice.
    expect(
      screen.getByRole('button', { name: 'Open audio: 팟캐스트 1화 (Ready)' }),
    ).toBeInTheDocument();
  });

  it('shows real upload progress from the onProgress callback', async () => {
    let capturedOpts: UploadAudioOptions | undefined;
    let settle!: (v: AudioUploadResponse) => void;
    vi.mocked(uploadAudio).mockImplementation(
      (_file: File, opts?: UploadAudioOptions) => {
        capturedOpts = opts;
        return new Promise<AudioUploadResponse>((res) => {
          settle = res;
        });
      },
    );
    renderPage();
    await screen.findByRole('button', {
      name: 'Open audio: 팟캐스트 1화 (Ready)',
    });

    fireEvent.change(getFileInput(), {
      target: {
        files: [new File([new Uint8Array(64)], 'a.mp3', { type: 'audio/mpeg' })],
      },
    });

    // Indeterminate until the first REAL byte-progress tick.
    expect(await screen.findByText('Uploading…')).toBeInTheDocument();
    act(() => {
      capturedOpts?.onProgress?.(42);
    });
    expect(screen.getByText('Uploading… 42%')).toBeInTheDocument();

    await act(async () => {
      settle({ sourceId: 9, trackId: 91, jobId: 5, transcriptStatus: 'pending' });
      await Promise.resolve();
    });
    expect(screen.queryByText(/Uploading…/)).not.toBeInTheDocument();
  });

  it('the client pre-check rejects a non-audio file with fixed copy and never calls the network', async () => {
    renderPage();
    await screen.findByRole('button', {
      name: 'Open audio: 팟캐스트 1화 (Ready)',
    });

    fireEvent.change(getFileInput(), {
      target: {
        files: [new File([new Uint8Array(8)], 'notes.txt', { type: 'text/plain' })],
      },
    });

    expect(
      await screen.findByText(
        'That file isn’t an MP3 or M4A. Choose a .mp3 or .m4a file.',
      ),
    ).toBeInTheDocument();
    expect(vi.mocked(uploadAudio)).not.toHaveBeenCalled();
  });

  it('a server upload failure renders fixed copy (413 → size copy), never the server prose', async () => {
    vi.mocked(uploadAudio).mockRejectedValue(
      new ApiError('PayloadTooLargeError: request entity too large', {
        status: 413,
        code: 'payload_too_large',
      }),
    );
    renderPage();
    await screen.findByRole('button', {
      name: 'Open audio: 팟캐스트 1화 (Ready)',
    });

    fireEvent.change(getFileInput(), {
      target: {
        files: [new File([new Uint8Array(8)], 'big.mp3', { type: 'audio/mpeg' })],
      },
    });

    expect(
      await screen.findByText('That file is too large. Pick one under 100 MB.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/PayloadTooLargeError/),
    ).not.toBeInTheDocument();
  });
});

describe('My Audio — polling (fake timers + fireEvent, never userEvent)', () => {
  it('polls the list while a track is pending and stops once everything settles', async () => {
    vi.useFakeTimers();
    vi.mocked(listMyAudio)
      .mockResolvedValueOnce(PENDING_SOURCES) // initial load
      .mockResolvedValueOnce([source(3, '새 녹음', 'done', 77)]) // poll tick 1
      .mockResolvedValue([source(3, '새 녹음', 'done', 77)]); // safety
    renderPage();
    await flushAsync();

    expect(
      screen.getByRole('button', { name: 'Open audio: 새 녹음 (Queued)' }),
    ).toBeInTheDocument();
    expect(vi.mocked(listMyAudio)).toHaveBeenCalledTimes(1);

    // One poll interval later the row has settled to done.
    await flushAsync(4000);
    expect(
      screen.getByRole('button', { name: 'Open audio: 새 녹음 (Ready)' }),
    ).toBeInTheDocument();
    expect(vi.mocked(listMyAudio)).toHaveBeenCalledTimes(2);

    // Everything settled → the poll STOPPED itself; no further fetches.
    await flushAsync(12_000);
    expect(vi.mocked(listMyAudio)).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('clears the poll interval on unmount — no timer leak, no late fetch', async () => {
    vi.useFakeTimers();
    vi.mocked(listMyAudio).mockResolvedValue(PENDING_SOURCES);
    const { unmount } = renderPage();
    await flushAsync();
    expect(vi.mocked(listMyAudio)).toHaveBeenCalledTimes(1);

    unmount();
    await flushAsync(12_000);
    expect(vi.mocked(listMyAudio)).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('aborts the in-flight poll REQUEST itself on unmount, not just the interval (S1)', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.mocked(listMyAudio)
      .mockImplementationOnce((signal?: AbortSignal) => {
        if (signal !== undefined) signals.push(signal);
        return Promise.resolve(PENDING_SOURCES);
      })
      .mockImplementation((signal?: AbortSignal) => {
        if (signal !== undefined) signals.push(signal);
        // Hangs — the tick is still in flight when the unmount happens.
        return new Promise<AudioSource[]>(() => {});
      });
    const { unmount } = renderPage();
    await flushAsync();
    await flushAsync(4000); // tick 1 fires and hangs in flight
    expect(signals).toHaveLength(2);
    expect(signals[1]!.aborted).toBe(false);

    unmount();
    // The cleanup must abort the in-flight tick's signal, not only clear
    // the interval — a hung request left un-aborted would still occupy the
    // connection and could land a late setState on a dead component.
    expect(signals[1]!.aborted).toBe(true);
    vi.useRealTimers();
  });

  it('an upload splice during an in-flight poll tick keeps the new row (stale tick aborted) and re-wakes the poller (SF-1/SF-2)', async () => {
    vi.useFakeTimers();
    let settleStale!: (v: AudioSource[]) => void;
    vi.mocked(listMyAudio)
      .mockResolvedValueOnce(PENDING_SOURCES) // initial load
      .mockImplementationOnce(
        // Poll tick 1 — its snapshot predates the upload; it HANGS so the
        // upload lands while it is still in flight.
        () =>
          new Promise<AudioSource[]>((res) => {
            settleStale = res;
          }),
      )
      // Server truth after the upload reconciles: both rows, statuses live.
      .mockResolvedValue([
        source(9, 'fresh-take', 'running', 91),
        source(3, '새 녹음', 'done', 77),
      ]);
    vi.mocked(uploadAudio).mockResolvedValue({
      sourceId: 9,
      trackId: 91,
      jobId: 5,
      transcriptStatus: 'pending',
    });
    renderPage();
    await flushAsync();
    expect(
      screen.getByRole('button', { name: 'Open audio: 새 녹음 (Queued)' }),
    ).toBeInTheDocument();

    await flushAsync(4000); // tick 1 now in flight (hanging)

    fireEvent.change(getFileInput(), {
      target: {
        files: [
          new File([new Uint8Array(64)], 'fresh-take.mp3', {
            type: 'audio/mpeg',
          }),
        ],
      },
    });
    await flushAsync(); // upload resolves → splice lands
    expect(
      screen.getByRole('button', { name: 'Open audio: fresh-take (Queued)' }),
    ).toBeInTheDocument();

    // The STALE snapshot (no fresh-take in it) finally lands — it was
    // aborted at splice time, so it must NOT erase the fresh row.
    await act(async () => {
      settleStale(PENDING_SOURCES);
      await Promise.resolve();
    });
    expect(
      screen.getByRole('button', { name: 'Open audio: fresh-take (Queued)' }),
    ).toBeInTheDocument();

    // The poller re-woke (fresh interval + budget): the next tick fetches
    // server truth and reconciles BOTH rows.
    await flushAsync(4000);
    expect(
      screen.getByRole('button', {
        name: 'Open audio: fresh-take (Transcribing)',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Open audio: 새 녹음 (Ready)' }),
    ).toBeInTheDocument();
    // initial + stale tick + reconcile tick — no runaway extra fetches.
    expect(vi.mocked(listMyAudio)).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('the detail poll STOPS on a mid-poll 404 and surfaces the uniform not-found state (SF-3)', async () => {
    vi.useFakeTimers();
    vi.mocked(getAudioTrack)
      .mockResolvedValueOnce(DETAIL_RUNNING) // initial load — unsettled
      .mockRejectedValueOnce(
        new ApiError('track not found', { status: 404, code: 'not_found' }),
      ) // poll tick 1 — the track vanished server-side
      .mockResolvedValue(DETAIL_RUNNING); // safety — must never be reached
    renderPage('/learn/listen?corpus=mine&track=77');
    await flushAsync();
    expect(
      screen.getByText(/Transcribing… the transcript will appear here/),
    ).toBeInTheDocument();

    await flushAsync(4000);
    expect(
      screen.getByText("That audio couldn't be found."),
    ).toBeInTheDocument();
    expect(screen.queryByText('track not found')).not.toBeInTheDocument();
    expect(vi.mocked(getAudioTrack)).toHaveBeenCalledTimes(2);

    // Terminal: the 404 stopped the poll — no further hits on a route that
    // can only 404 again.
    await flushAsync(12_000);
    expect(vi.mocked(getAudioTrack)).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('a never-settling job stops polling at the attempt ceiling — bounded churn (SF-3)', async () => {
    vi.useFakeTimers();
    // Stuck 'pending' forever (dead worker) — the server never settles it.
    vi.mocked(listMyAudio).mockResolvedValue(PENDING_SOURCES);
    renderPage();
    await flushAsync();
    expect(vi.mocked(listMyAudio)).toHaveBeenCalledTimes(1);

    // MY_AUDIO_POLL_MAX_TICKS = 225 (15 min at 4 s). Advance past the whole
    // budget: exactly 225 poll fetches on top of the initial load, then the
    // ceiling clears the interval.
    await flushAsync(4000 * 230);
    expect(vi.mocked(listMyAudio)).toHaveBeenCalledTimes(226);

    // Well past the ceiling — the poll is genuinely stopped, not just slow.
    await flushAsync(40_000);
    expect(vi.mocked(listMyAudio)).toHaveBeenCalledTimes(226);
    vi.useRealTimers();
  });

  it('the detail view polls an unsettled track until the transcript lands', async () => {
    vi.useFakeTimers();
    vi.mocked(getAudioTrack)
      .mockResolvedValueOnce(DETAIL_RUNNING)
      .mockResolvedValueOnce({
        ...DETAIL_RUNNING,
        track: { ...DETAIL_RUNNING.track, transcriptStatus: 'done' },
        segments: [
          { segmentNumber: 1, startMs: 0, endMs: 2000, body: '드디어 도착!' },
        ],
      })
      .mockResolvedValue(DETAIL_DONE); // safety
    renderPage('/learn/listen?corpus=mine&track=77');
    await flushAsync();

    // Transcribing state — but the track is already PLAYABLE.
    expect(
      screen.getByText(/Transcribing… the transcript will appear here/),
    ).toBeInTheDocument();
    expect(document.querySelector('audio')).not.toBeNull();

    await flushAsync(4000);
    expect(screen.getByText('드디어 도착!')).toBeInTheDocument();
    expect(
      screen.queryByText(/Transcribing…/),
    ).not.toBeInTheDocument();
    expect(vi.mocked(getAudioTrack)).toHaveBeenCalledTimes(2);

    // Settled → detail poll stopped too.
    await flushAsync(12_000);
    expect(vi.mocked(getAudioTrack)).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('My Audio — track detail', () => {
  it('renders the real <audio> with the allow-list-resolved src and the transcript in segment order', async () => {
    renderPage('/learn/listen?corpus=mine&track=34');

    expect(
      await screen.findByRole('heading', { name: '팟캐스트 1화' }),
    ).toBeInTheDocument();

    // REAL buildAudioSrc (empty API base in tests → app-relative path).
    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio).toHaveAttribute('controls');
    expect(audio).toHaveAttribute('src', '/audio/tracks/34/stream');

    // Segments render in segmentNumber order (the fixture is reversed).
    const transcript = screen.getByRole('list', { name: 'Transcript' });
    const rows = within(transcript).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('안녕하세요, 여러분.')).toBeInTheDocument();
    expect(
      within(rows[1]!).getByText('오늘은 날씨 이야기를 해요.'),
    ).toBeInTheDocument();

    expect(vi.mocked(getAudioTrack)).toHaveBeenCalledWith(
      34,
      expect.any(AbortSignal),
    );
  });

  // B1 — the component-level allow-list enforcement, proven with the REAL
  // buildAudioSrc (services/ttmik is deliberately unmocked in this file):
  // a tampered streamUrl must resolve to null INSIDE MyAudioDetail so no
  // <audio> element ever mounts, while the rest of the detail (title,
  // status pill) still renders. This test FAILS if a refactor ever bypasses
  // buildAudioSrc and feeds streamUrl to the src raw — the off-origin and
  // near-miss values below would then mount a player.
  it('a tampered streamUrl never mounts an <audio> element (REAL allow-list), while the detail still renders', async () => {
    const tampered = [
      '//evil.example/x.mp3', // protocol-relative → off-origin
      '/audio/tracks/34/streamx', // shape near-miss past the anchor
    ];
    for (const streamUrl of tampered) {
      vi.mocked(getAudioTrack).mockResolvedValue({
        ...DETAIL_DONE,
        track: { ...DETAIL_DONE.track, streamUrl },
      });
      const { unmount } = renderPage('/learn/listen?corpus=mine&track=34');

      // The detail itself renders fine — title and status are intact…
      expect(
        await screen.findByRole('heading', { name: '팟캐스트 1화' }),
      ).toBeInTheDocument();
      expect(screen.getByText('Ready')).toBeInTheDocument();
      // …but NO audio element exists anywhere in the document, and the
      // defensive "no audio" note holds its place.
      expect(document.querySelector('audio')).toBeNull();
      expect(
        screen.getByText(/No audio yet — check back soon\./),
      ).toBeInTheDocument();
      unmount();
    }
  });

  it('a failed transcription shows the fixed failure note while keeping the player', async () => {
    vi.mocked(getAudioTrack).mockResolvedValue({
      ...DETAIL_RUNNING,
      track: { ...DETAIL_RUNNING.track, transcriptStatus: 'failed' },
    });
    renderPage('/learn/listen?corpus=mine&track=77');

    expect(
      await screen.findByText(/Transcription failed for this audio\./),
    ).toBeInTheDocument();
    expect(document.querySelector('audio')).not.toBeNull();
  });

  it('a runtime stream failure shows a distinct alert without unmounting the player (F-160 device)', async () => {
    renderPage('/learn/listen?corpus=mine&track=34');
    await screen.findByRole('heading', { name: '팟캐스트 1화' });

    const audio = document.querySelector('audio');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.error(audio as HTMLAudioElement);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load/i);
    expect(document.querySelector('audio')).toBe(audio);
  });

  it("the uniform 404 renders the fixed not-found state (deleted vs not-yours never distinguished), no server prose", async () => {
    vi.mocked(getAudioTrack).mockRejectedValue(
      new ApiError('track not found', { status: 404, code: 'not_found' }),
    );
    renderPage('/learn/listen?corpus=mine&track=999');

    expect(
      await screen.findByText("That audio couldn't be found."),
    ).toBeInTheDocument();
    expect(screen.queryByText('track not found')).not.toBeInTheDocument();
    expect(document.querySelector('audio')).toBeNull();
  });

  it('a malformed ?track= falls back to the My Audio listing, never into a fetch', async () => {
    renderPage('/learn/listen?corpus=mine&track=abc');

    expect(
      await screen.findByRole('button', {
        name: 'Open audio: 팟캐스트 1화 (Ready)',
      }),
    ).toBeInTheDocument();
    expect(vi.mocked(getAudioTrack)).not.toHaveBeenCalled();
  });

  it('the detail BackButton returns to the My Audio listing', async () => {
    const user = userEvent.setup();
    renderPage('/learn/listen?corpus=mine&track=34');
    await screen.findByRole('heading', { name: '팟캐스트 1화' });

    await user.click(screen.getByRole('button', { name: 'Back to My Audio' }));

    expect(
      await screen.findByRole('button', {
        name: 'Open audio: 팟캐스트 1화 (Ready)',
      }),
    ).toBeInTheDocument();
    expect(document.querySelector('audio')).toBeNull();
  });
});

describe('My Audio — source (track list, multi-track corpus sets)', () => {
  it('a single-track upload still opens its player directly (no middle list)', async () => {
    const user = userEvent.setup();
    renderPage();

    // The single-track row keeps its "Open audio:" label and its date meta —
    // clicking it lands on the track player, never a one-row track list.
    await user.click(
      await screen.findByRole('button', {
        name: 'Open audio: 팟캐스트 1화 (Ready)',
      }),
    );
    expect(
      await screen.findByRole('heading', { name: '팟캐스트 1화' }),
    ).toBeInTheDocument();
    expect(vi.mocked(getAudioTrack)).toHaveBeenCalledWith(
      34,
      expect.any(AbortSignal),
    );
  });

  it('a multi-track source renders a "set" row (track count, not a date) that opens the track list', async () => {
    const user = userEvent.setup();
    vi.mocked(listMyAudio).mockResolvedValue([MULTI_SOURCE]);
    renderPage();

    const setRow = await screen.findByRole('button', {
      // Rollup pill = Ready (all tracks done); the label announces "set" +
      // count so AT knows it opens a list, not a player.
      name: 'Open audio set: TTMIK Level 1, 3 tracks (Ready)',
    });
    expect(within(setRow).getByText('3 tracks')).toBeInTheDocument();
    // A set row must NOT fire a track fetch — it navigates to the list.
    await user.click(setRow);

    expect(
      await screen.findByRole('heading', { name: 'TTMIK Level 1' }),
    ).toBeInTheDocument();
    // One row per track, in play order, with per-track pills; track 3's null
    // title falls back to "Track 3".
    expect(
      screen.getByRole('button', { name: 'Open track 1: Intro (Ready)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Open track 2: Track 02 (Ready)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Open track 3: Track 3 (Ready)' }),
    ).toBeInTheDocument();
    expect(vi.mocked(getAudioTrack)).not.toHaveBeenCalled();
  });

  it('opening a track from the list navigates to that track detail, and Back returns to the SOURCE list', async () => {
    const user = userEvent.setup();
    vi.mocked(listMyAudio).mockResolvedValue([MULTI_SOURCE]);
    renderPage('/learn/listen?corpus=mine&source=5');

    await user.click(
      await screen.findByRole('button', { name: 'Open track 2: Track 02 (Ready)' }),
    );

    // getAudioTrack fired for THAT track (id 52) — the detail loaded.
    expect(vi.mocked(getAudioTrack)).toHaveBeenCalledWith(
      52,
      expect.any(AbortSignal),
    );
    await screen.findByRole('heading', { name: '팟캐스트 1화' });

    // The click-through carried source.id in the track path — Back must
    // land on the SOURCE's track list (heading + track rows), NOT the flat
    // listing. A regression dropping source.id from
    // `myAudioTrackPath(track.id, source.id)` fails here.
    await user.click(screen.getByRole('button', { name: 'Back to My Audio' }));
    expect(
      await screen.findByRole('heading', { name: 'TTMIK Level 1' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Open track 1: Intro (Ready)' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Open audio set:/ }),
    ).not.toBeInTheDocument();
  });

  it('an initial list failure in the source view renders fixed-copy ErrorCard with a working Retry (no server prose)', async () => {
    const user = userEvent.setup();
    vi.mocked(listMyAudio)
      .mockRejectedValueOnce(
        new ApiError('boom internal', { status: 500, code: 'server_error' }),
      )
      .mockResolvedValueOnce([MULTI_SOURCE]);
    renderPage('/learn/listen?corpus=mine&source=5');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Could not load this audio set\./);
    expect(alert).not.toHaveTextContent(/boom internal/);

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByRole('button', {
        name: 'Open track 1: Intro (Ready)',
      }),
    ).toBeInTheDocument();
    expect(vi.mocked(listMyAudio)).toHaveBeenCalledTimes(2);
  });

  it('the source-view BackButton returns to the My Audio listing', async () => {
    const user = userEvent.setup();
    vi.mocked(listMyAudio).mockResolvedValue([MULTI_SOURCE]);
    renderPage('/learn/listen?corpus=mine&source=5');
    await screen.findByRole('heading', { name: 'TTMIK Level 1' });

    await user.click(screen.getByRole('button', { name: 'Back to My Audio' }));

    // Back at the flat listing — the "set" row is the listing surface.
    expect(
      await screen.findByRole('button', {
        name: 'Open audio set: TTMIK Level 1, 3 tracks (Ready)',
      }),
    ).toBeInTheDocument();
  });

  it('a track opened THROUGH a source goes BACK to that source list, not the flat listing', async () => {
    const user = userEvent.setup();
    vi.mocked(listMyAudio).mockResolvedValue([MULTI_SOURCE]);
    // Deep link carrying both — the source rides along for back-nav.
    renderPage('/learn/listen?corpus=mine&source=5&track=51');

    // Track detail first (track wins over source in the parse).
    await screen.findByRole('heading', { name: '팟캐스트 1화' });
    expect(vi.mocked(getAudioTrack)).toHaveBeenCalledWith(
      51,
      expect.any(AbortSignal),
    );

    await user.click(screen.getByRole('button', { name: 'Back to My Audio' }));

    // Back lands on the SOURCE's track list (heading + track rows), NOT the
    // flat listing (no "set" row here).
    expect(
      await screen.findByRole('heading', { name: 'TTMIK Level 1' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Open track 1: Intro (Ready)' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Open audio set:/ }),
    ).not.toBeInTheDocument();
  });

  it('a well-formed but unknown ?source= shows the uniform not-found (never an error card)', async () => {
    // The list resolves fine; the id is simply not among the user's sources.
    vi.mocked(listMyAudio).mockResolvedValue(SETTLED_SOURCES);
    renderPage('/learn/listen?corpus=mine&source=999');

    expect(
      await screen.findByText("That audio set couldn't be found."),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a malformed ?source= falls back to the My Audio listing, never into a source view', async () => {
    renderPage('/learn/listen?corpus=mine&source=abc');

    expect(
      await screen.findByRole('button', {
        name: 'Open audio: 팟캐스트 1화 (Ready)',
      }),
    ).toBeInTheDocument();
  });

  it('the source view polls while a track is unsettled and stops once the set settles', async () => {
    vi.useFakeTimers();
    vi.mocked(listMyAudio)
      .mockResolvedValueOnce([MULTI_SOURCE_PENDING]) // initial — has unsettled
      .mockResolvedValueOnce([MULTI_SOURCE]) // poll tick 1 — all settle
      .mockResolvedValue([MULTI_SOURCE]); // safety
    renderPage('/learn/listen?corpus=mine&source=5');
    await flushAsync();

    // Track 2 is Transcribing, track 3 Queued.
    expect(
      screen.getByRole('button', {
        name: 'Open track 2: Track 02 (Transcribing)',
      }),
    ).toBeInTheDocument();
    expect(vi.mocked(listMyAudio)).toHaveBeenCalledTimes(1);

    await flushAsync(4000);
    expect(
      screen.getByRole('button', { name: 'Open track 2: Track 02 (Ready)' }),
    ).toBeInTheDocument();
    expect(vi.mocked(listMyAudio)).toHaveBeenCalledTimes(2);

    // All settled → the source-view poll stopped itself.
    await flushAsync(12_000);
    expect(vi.mocked(listMyAudio)).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('unmounting the source view clears its poll interval — no timer leak, no late fetch', async () => {
    vi.useFakeTimers();
    vi.mocked(listMyAudio).mockResolvedValue([MULTI_SOURCE_PENDING]);
    const { unmount } = renderPage('/learn/listen?corpus=mine&source=5');
    await flushAsync();
    expect(vi.mocked(listMyAudio)).toHaveBeenCalledTimes(1);

    unmount();
    await flushAsync(12_000);
    expect(vi.mocked(listMyAudio)).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('unmounting the source view aborts the in-flight poll REQUEST itself, not just the interval', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.mocked(listMyAudio)
      .mockImplementationOnce((signal?: AbortSignal) => {
        if (signal !== undefined) signals.push(signal);
        return Promise.resolve([MULTI_SOURCE_PENDING]);
      })
      .mockImplementation((signal?: AbortSignal) => {
        if (signal !== undefined) signals.push(signal);
        // Hangs — the tick is still in flight when the unmount happens.
        return new Promise<AudioSource[]>(() => {});
      });
    const { unmount } = renderPage('/learn/listen?corpus=mine&source=5');
    await flushAsync();
    await flushAsync(4000); // tick 1 fires and hangs in flight
    expect(signals).toHaveLength(2);
    expect(signals[1]!.aborted).toBe(false);

    unmount();
    // The cleanup must abort the in-flight tick's signal, not only clear
    // the interval — a hung request left un-aborted would still occupy the
    // connection and could land a late setState on a dead component.
    expect(signals[1]!.aborted).toBe(true);
    vi.useRealTimers();
  });

  it('a source stuck unsettled stops polling at the attempt ceiling — bounded churn', async () => {
    vi.useFakeTimers();
    // Stuck 'pending'/'running' forever (dead worker) — never settles.
    vi.mocked(listMyAudio).mockResolvedValue([MULTI_SOURCE_PENDING]);
    renderPage('/learn/listen?corpus=mine&source=5');
    await flushAsync();
    expect(vi.mocked(listMyAudio)).toHaveBeenCalledTimes(1);

    // MY_AUDIO_POLL_MAX_TICKS = 225 (15 min at 4 s). Advance past the whole
    // budget: exactly 225 poll fetches on top of the initial load, then the
    // ceiling clears the interval.
    await flushAsync(4000 * 230);
    expect(vi.mocked(listMyAudio)).toHaveBeenCalledTimes(226);

    // Well past the ceiling — the poll is genuinely stopped, not just slow.
    await flushAsync(40_000);
    expect(vi.mocked(listMyAudio)).toHaveBeenCalledTimes(226);
    vi.useRealTimers();
  });

  it('a source that vanishes mid-poll goes terminal not-found and the poll stops', async () => {
    vi.useFakeTimers();
    vi.mocked(listMyAudio)
      .mockResolvedValueOnce([MULTI_SOURCE_PENDING]) // initial — unsettled
      .mockResolvedValueOnce([]) // poll tick 1 — the source vanished
      .mockResolvedValue([MULTI_SOURCE_PENDING]); // safety — must never be reached
    renderPage('/learn/listen?corpus=mine&source=5');
    await flushAsync();
    expect(
      screen.getByRole('button', {
        name: 'Open track 2: Track 02 (Transcribing)',
      }),
    ).toBeInTheDocument();
    expect(vi.mocked(listMyAudio)).toHaveBeenCalledTimes(1);

    await flushAsync(4000);
    expect(
      screen.getByText("That audio set couldn't be found."),
    ).toBeInTheDocument();
    expect(vi.mocked(listMyAudio)).toHaveBeenCalledTimes(2);

    // Terminal (mirrors the track detail's mid-poll 404): no further hits
    // on a list that no longer holds the source.
    await flushAsync(12_000);
    expect(vi.mocked(listMyAudio)).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
