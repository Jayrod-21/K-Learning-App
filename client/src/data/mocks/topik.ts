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
import type { TopikItem } from '../../types/domain';
import { mockDelay } from './_delay';

/** The canonical single-item fixture (kept as the basis for the draw). */
export const TOPIK_ITEM_FIXTURE: TopikItem = {
  id: 'mock-topik-28',
  section: '읽기',
  number: 28,
  level: 4,
  prompt: '이 글의 내용과 같은 것은?',
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
    id: 'mock-topik-44',
    section: '듣기',
    number: 44,
    level: 3,
    prompt: '여자가 다음에 할 행동으로 알맞은 것은?',
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
