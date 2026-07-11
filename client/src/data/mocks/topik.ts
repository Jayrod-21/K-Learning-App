/**
 * TOPIK Study-mode fixture + loader. Mirrors `TOPIK_ITEM` in data.js.
 *
 * Real wiring (Pass 6): `POST /topik/study` via `services/topik.ts`
 * (`fetchStudyDraw`). This mock is the Study fallback `useEndpointOrMock` lands
 * on when the real endpoint is unavailable — it resolves a small stepped draw
 * (4 items) so the screen exercises the pick→submit→reveal→next→complete flow
 * end-to-end without a server.
 *
 * Each item carries a stable `id` (matching the Pass-6 `TopikItem.id`); the
 * fourth item deliberately ships an empty `explanation` so the screen's
 * conditional explanation block (real items may lack one) is covered by the
 * mock-backed render too.
 */
import type {
  MockResult,
  MockSection,
  MockSubmitBody,
  MockTest,
  TopikItem,
  TopikMockItem,
} from '../../types/domain';
import type { AttemptHistoryResult } from '../../services/topik';
import { mockDelay } from './_delay';

/**
 * The shared reading passage the "remote-work" items are asked about (B-008)
 * — mirrors the live `TopikItem.passage` the server resolves from
 * `topik_tests.passages`, so the offline path exercises the passage block.
 */
const REMOTE_WORK_PASSAGE =
  '최근 재택근무를 도입하는 회사가 늘고 있다. 재택근무는 출퇴근 시간을 줄여 주지만 동료와의 소통이 어려워질 수 있다. 그래서 많은 회사가 사무실 근무와 재택근무를 함께 활용하고 있다.';

/** The canonical single-item fixture (kept as the basis for the draw). */
export const TOPIK_ITEM_FIXTURE: TopikItem = {
  id: 'mock-topik-28',
  section: '읽기',
  number: 28,
  level: 4,
  prompt: '이 글의 내용과 같은 것은?',
  passage: REMOTE_WORK_PASSAGE,
  passageRef: 'remote-work',
  options: [
    {
      id: 'a',
      kr: '재택근무는 출퇴근 시간을 늘린다.',
      en: 'Remote work increases commute time.',
      correct: false,
    },
    {
      id: 'b',
      kr: '재택근무에는 장점과 단점이 모두 있다.',
      en: 'Remote work has both advantages and disadvantages.',
      correct: true,
    },
    {
      id: 'c',
      kr: '대부분의 회사가 재택근무를 폐지했다.',
      en: 'Most companies have abolished remote work.',
      correct: false,
    },
    {
      id: 'd',
      kr: '재택근무는 소통을 더 쉽게 만든다.',
      en: 'Remote work makes communication easier.',
      correct: false,
    },
  ],
  explanation:
    'The passage explicitly states that remote work cuts commute time (장점) but can hurt communication with colleagues (단점), and that firms therefore combine both approaches. Choice B is the only summary consistent with that.',
};

/**
 * A small stepped Study draw (4 items) derived from the fixture + variations.
 *
 * Covers the section/level variety the real draw spans (읽기/듣기, L3/L4) and
 * the empty-explanation case (item 4) so the screen's conditional reveal block
 * is exercised on the mock path.
 */
export const TOPIK_STUDY_DRAW_FIXTURE: TopikItem[] = [
  TOPIK_ITEM_FIXTURE,
  {
    id: 'mock-topik-31',
    section: '읽기',
    number: 31,
    level: 4,
    prompt: '밑줄 친 부분과 의미가 가장 비슷한 것은?',
    options: [
      {
        id: 'a',
        kr: '결국 계획을 미루기로 했다.',
        en: 'In the end, they decided to postpone the plan.',
        correct: false,
      },
      {
        id: 'b',
        kr: '예상보다 일찍 일을 끝냈다.',
        en: 'They finished the work earlier than expected.',
        correct: true,
      },
      {
        id: 'c',
        kr: '회의를 다음 주로 옮겼다.',
        en: 'They moved the meeting to next week.',
        correct: false,
      },
      {
        id: 'd',
        kr: '새로운 직원을 채용했다.',
        en: 'They hired a new employee.',
        correct: false,
      },
    ],
    explanation:
      'The underlined phrase signals completing something ahead of schedule, which choice B restates directly.',
  },
  {
    // Image-dependent item (has_image in the corpus): no image asset exists —
    // only a text description — so the screen must render the description
    // prominently via TopikImageNote. This fixture keeps that path exercised
    // on the offline draw.
    id: 'mock-topik-44',
    section: '듣기',
    number: 44,
    level: 3,
    prompt: '여자가 다음에 할 행동으로 알맞은 것은?',
    hasImage: true,
    imageText: '사무실에서 여자가 달력을 보며 통화하는 그림',
    options: [
      {
        id: 'a',
        kr: '서류를 다시 작성한다.',
        en: 'Rewrite the document.',
        correct: false,
      },
      {
        id: 'b',
        kr: '동료에게 전화한다.',
        en: 'Call a colleague.',
        correct: false,
      },
      {
        id: 'c',
        kr: '회의실을 예약한다.',
        en: 'Reserve the meeting room.',
        correct: true,
      },
      {
        id: 'd',
        kr: '점심을 먹으러 간다.',
        en: 'Go out for lunch.',
        correct: false,
      },
    ],
    explanation:
      'The woman confirms the room is free and says she will book it, so choice C is the next action.',
  },
  {
    // Empty explanation on purpose — real draw items may lack one, and the
    // screen must omit the reveal block (not render an empty card).
    id: 'mock-topik-52',
    section: '읽기',
    number: 52,
    level: 3,
    prompt: '( )에 들어갈 말로 가장 알맞은 것은?',
    options: [
      {
        id: 'a',
        kr: '그러나',
        en: 'However',
        correct: false,
      },
      {
        id: 'b',
        kr: '그래서',
        en: 'Therefore',
        correct: true,
      },
      {
        id: 'c',
        kr: '그리고',
        en: 'And',
        correct: false,
      },
      {
        id: 'd',
        kr: '하지만',
        en: 'But',
        correct: false,
      },
    ],
    explanation: '',
  },
];

/**
 * Async loader — resolves with the Study draw after a brief simulated
 * round-trip so the screen exercises its loading skeleton. Returns a fresh
 * shallow copy each call so a caller that mutates the array (e.g. stepping
 * state) never corrupts the shared fixture.
 */
export async function loadTopikStudyMock(): Promise<TopikItem[]> {
  await mockDelay();
  return [...TOPIK_STUDY_DRAW_FIXTURE];
}

// ── Mock-Test (FU-NF-39) — answer-stripped exam fixtures ─────────────────
//
// The Mock-Test exam is server-graded and answer-stripped: a `TopikMockItem`
// carries NO `correct` flag and NO `explanation`. These fixtures deliberately
// omit both so the offline fallback exercises the exact shape the real
// endpoint emits — there is no answer here for a tampering client to read.

/** A small answer-stripped exam (4 items) covering the reading section. */
const TOPIK_MOCK_ITEMS_FIXTURE: TopikMockItem[] = [
  {
    id: '1001',
    section: '읽기',
    number: 1,
    level: 4,
    prompt: '이 글의 내용과 같은 것은?',
    // Question content, not answer data — survives the answer strip (B-008).
    passage: REMOTE_WORK_PASSAGE,
    passageRef: 'remote-work',
    options: [
      { id: 'a', kr: '재택근무는 출퇴근 시간을 늘린다.', en: 'Remote work increases commute time.' },
      { id: 'b', kr: '재택근무에는 장점과 단점이 모두 있다.', en: 'Remote work has both pros and cons.' },
      { id: 'c', kr: '대부분의 회사가 재택근무를 폐지했다.', en: 'Most companies abolished remote work.' },
      { id: 'd', kr: '재택근무는 소통을 더 쉽게 만든다.', en: 'Remote work makes communication easier.' },
    ],
  },
  {
    id: '1002',
    section: '읽기',
    number: 2,
    level: 4,
    prompt: '밑줄 친 부분과 의미가 가장 비슷한 것은?',
    options: [
      { id: 'a', kr: '결국 계획을 미루기로 했다.', en: 'They decided to postpone the plan.' },
      { id: 'b', kr: '예상보다 일찍 일을 끝냈다.', en: 'They finished earlier than expected.' },
      { id: 'c', kr: '회의를 다음 주로 옮겼다.', en: 'They moved the meeting to next week.' },
      { id: 'd', kr: '새로운 직원을 채용했다.', en: 'They hired a new employee.' },
    ],
  },
  {
    id: '1003',
    section: '읽기',
    number: 3,
    level: 3,
    prompt: '( )에 들어갈 말로 가장 알맞은 것은?',
    options: [
      { id: 'a', kr: '그러나', en: 'However' },
      { id: 'b', kr: '그래서', en: 'Therefore' },
      { id: 'c', kr: '그리고', en: 'And' },
      { id: 'd', kr: '하지만', en: 'But' },
    ],
  },
  {
    id: '1004',
    section: '읽기',
    number: 4,
    level: 3,
    prompt: '글쓴이의 태도로 알맞은 것은?',
    options: [
      { id: 'a', kr: '비판적이다.', en: 'Critical.' },
      { id: 'b', kr: '회의적이다.', en: 'Skeptical.' },
      { id: 'c', kr: '긍정적이다.', en: 'Positive.' },
      { id: 'd', kr: '무관심하다.', en: 'Indifferent.' },
    ],
  },
];

/**
 * Async loader — resolves a section-scoped answer-stripped exam after a brief
 * simulated round-trip. The fixture is reading-flavoured; the `section` the
 * caller asked for is echoed on the envelope so the screen labels it correctly
 * even on the offline path. Returns fresh copies so a caller never mutates the
 * shared fixture.
 */
export async function loadTopikMockTest(section: MockSection): Promise<MockTest> {
  await mockDelay();
  return {
    sourceTest: 0,
    // Offline fixture — an arbitrary fixed level (the 🅂 badge already marks
    // this as non-authoritative; there is no real corpus paper behind it).
    topikLevel: 'TOPIK II',
    section,
    items: TOPIK_MOCK_ITEMS_FIXTURE.map((it) => ({
      ...it,
      options: it.options.map((o) => ({ ...o })),
    })),
  };
}

/**
 * Offline grader for the Mock-Test submit fallback.
 *
 * The real submit grades server-side against the DB key; this fallback cannot
 * — the fixtures carry no answer. So it deterministically treats choice `b` as
 * "correct" purely to produce a coherent results screen offline (a fixed
 * pseudo-key, NOT a real answer). This path is dev-only mock chrome (the 🅂
 * badge fires), never a grading authority. Skipped items grade incorrect.
 */
export async function submitTopikMockTestMock(
  body: MockSubmitBody,
): Promise<MockResult> {
  await mockDelay();
  const PSEUDO_KEY = 'b' as const;
  const totalItems = TOPIK_MOCK_ITEMS_FIXTURE.length;
  const pickedById = new Map(body.answers.map((a) => [a.itemId, a.picked]));
  const items = TOPIK_MOCK_ITEMS_FIXTURE.map((it) => {
    // The submit BODY carries numeric itemIds (server schema z.number());
    // the reveal echoes the item's WIRE id, which is a STRING (`i.id::text`).
    const picked = pickedById.get(Number(it.id)) ?? null;
    return {
      // WIRE FIDELITY: `MockReveal.itemId` is a string on the real wire. The
      // old fixture returned `Number(it.id)`, which masked the results
      // screen's string-vs-number Map lookup bug — real reviews rendered
      // blank while the mock path looked fine.
      itemId: it.id,
      picked,
      correctChoiceId: PSEUDO_KEY,
      isCorrect: picked === PSEUDO_KEY,
      explanation:
        'Offline fixture — the live exam reveals the real explanation here once graded by the server.',
    };
  });
  const correct = items.filter((i) => i.isCorrect).length;
  const answered = body.answers.length;
  const percentage =
    totalItems === 0 ? 0 : Math.round((correct / totalItems) * 1000) / 10;
  const band =
    percentage >= 80
      ? 'On track for L5+'
      : percentage >= 60
        ? 'L4 range'
        : percentage >= 40
          ? 'L3 range'
          : 'Below L3';
  return {
    sourceTest: body.sourceTest,
    section: body.section,
    totalItems,
    answered,
    correct,
    percentage,
    band,
    items,
  };
}

// ── Attempt history (F-104 / A1) — offline fallback for GET /topik/attempts ──
//
// Wired surfaces: F-078's daily total, F-082's "Previous attempts" review.
// One entry dated "today" (so the F-078 offline path renders a nonzero daily
// total) and one from a past date (so the F-082 review list exercises more
// than a single row offline). Real timestamps generated at call time — this
// is a mock LOADER, not a static fixture, since "today" only means something
// relative to when it renders.

/** Build a fresh attempt-history fixture, timestamped relative to now(). */
function buildTopikAttemptHistoryFixture(): AttemptHistoryResult {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return {
    attempts: [
      {
        attemptId: 'mock-attempt-2',
        section: '듣기',
        sourceTest: 91,
        topikLevel: 'TOPIK II',
        correct: 38,
        totalItems: 50,
        completedAt: now.toISOString(),
      },
      {
        attemptId: 'mock-attempt-1',
        section: '읽기',
        sourceTest: 83,
        topikLevel: 'TOPIK II',
        correct: 29,
        totalItems: 50,
        completedAt: yesterday.toISOString(),
      },
    ],
    total: 2,
  };
}

/**
 * Async loader — resolves the offline attempt-history fixture after a brief
 * simulated round-trip. Returns a fresh object each call (timestamps are
 * relative to "now") so a caller can't accidentally hold a stale "today".
 */
export async function loadTopikAttemptHistoryMock(): Promise<AttemptHistoryResult> {
  await mockDelay();
  return buildTopikAttemptHistoryFixture();
}
