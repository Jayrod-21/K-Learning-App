/**
 * Tour registry — the single source of truth for the app's guided tours
 * (first-run welcome flow + per-surface mini-tours).
 *
 * Pure data: no React, no driver.js import (the runner lives in
 * `lib/tourDriver.ts`; the trigger/persistence logic in
 * `hooks/TourProvider.tsx`). Keeping the registry inert makes it trivially
 * testable and lets the Settings replay picker enumerate tours without
 * pulling the overlay library into its chunk.
 *
 * Anchoring contract: steps target elements via `data-tour="<key>"`
 * attributes stamped on the REAL controls (BottomNav tabs, page CTAs, …) —
 * NEVER via CSS class names, which are style-owned and renameable (F-098).
 * A step with no `target` renders as a centered modal popover (welcome /
 * outro copy). Elements are looked up at run time; a step whose target is
 * absent is skipped by the runner, so a half-loaded or empty-state page can
 * never wedge a tour — and if NONE of a tour's anchored steps resolve, the
 * runner reports the tour 'unavailable' (not seen; retries later) rather
 * than running connective copy alone (see lib/tourDriver.ts).
 *
 * Tour ids are a CLOSED, client-defined set (`TOUR_IDS`) — they are what is
 * persisted into the `toursSeen` prefs field, never user input. The server
 * stores them as opaque bounded strings (see server routes/settings.ts) so
 * shipping a new tour here needs no server change.
 */

/** One coach-mark step. `target` is a `[data-tour="…"]` selector; omit it
 *  for a centered (un-anchored) popover. `side` hints the popover position
 *  relative to the target — the runner still flips it when out of viewport. */
export interface TourStep {
  readonly target?: string;
  readonly title: string;
  readonly body: string;
  readonly side?: 'top' | 'bottom' | 'left' | 'right';
}

export interface TourDefinition {
  readonly id: TourId;
  /** Human name for the Settings "Help & tours" replay picker — flat en/kr
   *  pair, the `label`/`kr` convention from `lib/nav.ts`. */
  readonly label: string;
  readonly kr: string;
  /**
   * The route this tour belongs to — `null` for the first-run tour (it can
   * fire on any authenticated screen; its anchors live in the shell chrome).
   * `match: 'exact'` fires only on the path itself; `'prefix'` also fires on
   * sub-paths (`/uploads/:id` — dynamic detail routes have no static path).
   */
  readonly path: string | null;
  readonly match?: 'exact' | 'prefix';
  readonly steps: ReadonlyArray<TourStep>;
}

export type TourId =
  | 'first-run'
  | 'library'
  | 'topik'
  | 'listen'
  | 'flashcards'
  | 'grammar'
  | 'writing'
  | 'hanja'
  | 'reading'
  | 'uploads'
  | 'upload-viewer';

/** The id of the one tour that fires on first login regardless of route. */
export const FIRST_RUN_TOUR_ID: TourId = 'first-run';

export const TOURS: ReadonlyArray<TourDefinition> = [
  {
    id: 'first-run',
    label: 'Welcome tour',
    kr: '환영 투어',
    path: null,
    steps: [
      {
        title: 'Welcome to Korean Master 👋',
        body: 'A quick lap around the app — 30 seconds, skippable any time with Esc or the ✕.',
      },
      {
        target: '[data-tour="tab-today"]',
        title: 'Today · 오늘',
        body: 'Your daily plan: due reviews, drills, and suggested study — start here each day.',
        side: 'top',
      },
      {
        target: '[data-tour="tab-progress"]',
        title: 'Progress · 성장',
        body: 'Skill levels and diagnostic history — watch the graph climb.',
        side: 'top',
      },
      {
        target: '[data-tour="tab-review"]',
        title: 'Library · 자료실',
        body: 'Everything you can browse: vocabulary, grammar patterns, past exams, mistakes, and your uploaded books.',
        side: 'top',
      },
      {
        target: '[data-tour="tab-settings"]',
        title: 'Settings · 설정',
        body: 'Profile, notifications, appearance — and a “Help & tours” section to replay this tour later.',
        side: 'top',
      },
      {
        target: '[data-tour="learn-launcher"]',
        title: 'LEARN · 배움',
        body: 'The launcher for all seven study modes: TOPIK, listening, vocab flashcards, grammar drills, writing, Hanja, and reading.',
        side: 'top',
      },
      {
        target: '[data-tour="today-plan"]',
        title: 'Start a session',
        body: 'Tap any card in today’s plan to jump straight into a session — or open LEARN and pick a mode yourself.',
        side: 'bottom',
      },
      {
        // The floating ChatFab is mounted in BOTH chromes (mobile and
        // sidebar layouts), so this target + "dot" copy is chrome-
        // independent. The sidebar's own chat entry carries the distinct
        // `chat-nav` key precisely so it can't shadow this anchor by DOM
        // order (fix-pass SF-1).
        target: '[data-tour="chat-fab"]',
        title: 'Your tutor, everywhere',
        body: 'This dot opens the AI tutor chat from any screen — it already knows what page you’re on.',
        side: 'left',
      },
      {
        title: 'That’s the lap!',
        body: 'Each study page shows its own short intro on first visit. Replay anything from Settings → Help & tours. 화이팅!',
      },
    ],
  },
  {
    id: 'library',
    label: 'Library',
    kr: '자료실',
    path: '/review',
    steps: [
      {
        title: 'The Library · 자료실',
        body: 'This is the browsing side of the app — reference material and your own history, organized in shelves.',
      },
      {
        target: '[data-tour="library-sections"]',
        title: 'Shelves',
        body: 'Vocabulary, All Words (the 54k-entry dictionary), grammar patterns, past exams, your mistakes, and your uploads — each opens its own page.',
        side: 'bottom',
      },
      {
        title: 'Learning vs. browsing',
        body: 'Rule of thumb: LEARN (the hexagon) is where you practice; the Library is where you look things up.',
      },
    ],
  },
  {
    id: 'topik',
    label: 'TOPIK',
    kr: '모의',
    path: '/learn/topik',
    steps: [
      {
        target: '[data-tour="topik-chooser"]',
        title: 'Study or Mock?',
        body: 'Study serves untimed daily questions with explanations. Mock runs a full timed TOPIK exam from real past papers.',
        side: 'bottom',
      },
      {
        title: 'Listening sections',
        body: 'Listening questions play the real exam audio — headphones or sound on. In a mock, the timer keeps running.',
      },
      {
        title: 'Afterwards',
        body: 'Finished sittings land in Library → Past exams (scores, re-enter, retake); every wrong answer is collected in Library → Mistakes.',
      },
    ],
  },
  {
    id: 'listen',
    label: 'Listen',
    kr: '듣기',
    path: '/learn/listen',
    steps: [
      {
        title: 'Listen · 듣기',
        body: 'Graded listening practice — TTMIK lessons, Iyagi conversations, and more real audio.',
      },
      {
        target: '[data-tour="listen-collections"]',
        title: 'Collections',
        body: 'Pick a collection to browse its lessons. Ones with audio are marked — tap a lesson to play it.',
        side: 'bottom',
      },
      {
        title: 'Listen actively',
        body: 'Play a lesson, shadow what you hear, and ask the tutor chat about anything you didn’t catch.',
      },
    ],
  },
  {
    id: 'flashcards',
    label: 'Vocab flashcards',
    kr: '단어 카드',
    path: '/learn/vocab',
    steps: [
      {
        title: 'Vocab flashcards · 단어 카드',
        body: 'Spaced repetition for your vocabulary: cards come back right before you’d forget them.',
      },
      {
        target: '[data-tour="vocab-lists"]',
        title: 'My lists',
        body: 'Your own word lists. Create one here, then add words from anywhere in the Library.',
        side: 'bottom',
      },
      {
        target: '[data-tour="vocab-study"]',
        title: 'The review queue',
        body: 'When cards are due, Study starts a session. Grade yourself honestly — Again, Good, Easy — that’s what drives the scheduler.',
        side: 'bottom',
      },
      {
        title: 'Feed the deck',
        body: 'Words you look up or get wrong elsewhere can be added to review — the queue grows as you study.',
      },
    ],
  },
  {
    id: 'grammar',
    label: 'Grammar practice',
    kr: '문법',
    path: '/learn/grammar',
    steps: [
      {
        title: 'Grammar practice · 문법',
        body: 'Production drills over the KGIU pattern bank — you type real Korean, not multiple choice.',
      },
      {
        target: '[data-tour="grammar-practice"]',
        title: 'Practice',
        body: 'Starts a drill over your learning patterns. Each answer is checked and explained.',
        side: 'bottom',
      },
      {
        title: 'The pattern bank',
        body: 'Browse every pattern with examples in Library → Grammar; mark ones you already know to keep drills focused.',
      },
    ],
  },
  {
    id: 'writing',
    label: 'Writing',
    kr: '쓰기',
    path: '/learn/writing',
    steps: [
      {
        title: 'Writing · 쓰기',
        body: 'TOPIK-style writing practice with AI grading against the real scoring rubrics.',
      },
      {
        target: '[data-tour="writing-task-type"]',
        title: 'Pick a task type',
        body: 'The two TOPIK writing task formats, or AI Prompt for a freshly generated topic at your level.',
        side: 'bottom',
      },
      {
        target: '[data-tour="writing-prompt"]',
        title: 'Write and submit',
        body: 'Draft your response in the card, then submit for feedback — you’ll get a score, corrections, and suggestions.',
        side: 'top',
      },
      {
        title: 'Your history',
        body: 'Graded responses are kept in the My responses tab so you can see your writing improve.',
      },
    ],
  },
  {
    id: 'hanja',
    label: 'Hanja',
    kr: '한자',
    path: '/learn/hanja',
    steps: [
      {
        title: 'Hanja · 한자',
        body: 'The Chinese-character roots inside Korean words — learn one root, unlock whole word families.',
      },
      {
        target: '[data-tour="hanja-view"]',
        title: 'Today’s picks vs. the index',
        body: 'Today’s 한자 serves a daily selection; Index is the full character browse with your mastery states.',
        side: 'bottom',
      },
      {
        target: '[data-tour="hanja-study"]',
        title: 'Flashcards & the drawing pad',
        body: 'Drill due characters here. Inside a character you’ll find the drawing pad: Recall (draw from memory, judge yourself) or Trace (follow the template).',
        side: 'bottom',
      },
      {
        target: '[data-tour="hanja-lists"]',
        title: 'My lists',
        body: 'Curate your own character sets — handy for textbook chapters.',
        side: 'bottom',
      },
    ],
  },
  {
    id: 'reading',
    label: 'Reading',
    kr: '읽기',
    path: '/learn/reading',
    steps: [
      {
        title: 'Reading · 읽기',
        body: 'Read digitized chapters from your uploaded books, plus folktales and stories.',
      },
      {
        target: '[data-tour="reading-shelf"]',
        title: 'Your shelves',
        body: 'Books appear here once uploaded and digitized. Tap one to open its chapter reader.',
        side: 'bottom',
      },
      {
        title: 'Tap any word',
        body: 'In the reader, tapping a word pops an instant dictionary lookup — and you can add it straight to review.',
      },
    ],
  },
  {
    id: 'uploads',
    label: 'Uploads',
    kr: '업로드',
    path: '/uploads',
    steps: [
      {
        title: 'Uploads · 업로드',
        body: 'Bring your own books: upload a PDF or a zip of page photos and the app turns it into ordered pages.',
      },
      {
        target: '[data-tour="uploads-new"]',
        title: 'Upload a book',
        body: 'Starts a new upload. Big books are fine — pages are processed server-side.',
        side: 'bottom',
      },
      {
        title: 'Then read it',
        body: 'Tap an upload to open the page viewer — from there you can extract the text (OCR) and read it as chapters in Reading.',
      },
    ],
  },
  {
    id: 'upload-viewer',
    label: 'Book page viewer',
    kr: '책 페이지 뷰어',
    path: '/uploads/',
    match: 'prefix',
    steps: [
      {
        title: 'The page viewer',
        body: 'Your book, page by page. Swipe or use the pager to move around.',
      },
      {
        target: '[data-tour="viewer-extract"]',
        title: 'Extract text (OCR)',
        body: 'Runs text extraction over the scanned pages so the book becomes searchable, readable chapters. Each run continues where the last stopped.',
        side: 'bottom',
      },
      {
        target: '[data-tour="viewer-zoom"]',
        title: 'View controls',
        body: 'Zoom, fit-to-width, rotate, and reorder pages if a scan came in shuffled.',
        side: 'bottom',
      },
    ],
  },
];

/** Closed id list, derived from the registry (kept in lockstep by the
 *  compile-time `TourId` union + the uniqueness test in tours.test.ts). */
export const TOUR_IDS: ReadonlyArray<TourId> = TOURS.map((t) => t.id);

const TOUR_BY_ID = new Map<TourId, TourDefinition>(TOURS.map((t) => [t.id, t]));

export function tourById(id: TourId): TourDefinition {
  const t = TOUR_BY_ID.get(id);
  if (!t) {
    // Unreachable while the union and the array stay in sync — defensive
    // against a future id being added to one side only (nav.ts convention).
    throw new Error(`unknown tour: ${String(id)}`);
  }
  return t;
}

/** Type guard — narrows an arbitrary persisted string to a known TourId. */
export function isTourId(v: unknown): v is TourId {
  return typeof v === 'string' && (TOUR_IDS as ReadonlyArray<string>).includes(v);
}

/**
 * The surface mini-tour for a pathname, or null. Exact match by default;
 * `prefix` tours match any deeper sub-path (`/uploads/:id`). Exact wins over
 * prefix so `/uploads` gets the uploads tour, not the viewer's.
 */
export function surfaceTourForPath(pathname: string): TourDefinition | null {
  let prefixHit: TourDefinition | null = null;
  for (const t of TOURS) {
    if (t.path === null) continue;
    if (t.match === 'prefix') {
      // A prefix tour's `path` ends with '/'; require at least one further
      // segment so the parent route itself never matches.
      if (pathname.startsWith(t.path) && pathname.length > t.path.length) {
        prefixHit = t;
      }
    } else if (pathname === t.path) {
      return t;
    }
  }
  return prefixHit;
}
