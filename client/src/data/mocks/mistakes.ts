/**
 * Mock data for the Mistakes-review screen (F-021).
 *
 * Two sample misses (a reading + a listening item) so the dev-mode 🅂 view and
 * the empty-endpoint fallback render a realistic review card each — the shared
 * `correct` flag + `explanation` are present because a mistakes row is a REVIEW
 * of an item the user already attempted.
 */
import type { Mistake } from '../../services/topik';
import { mockDelay } from './_delay';

export const MISTAKES_FIXTURE: Mistake[] = [
  {
    responseId: 'm1',
    picked: 'a',
    answeredAt: '2026-07-06T09:12:00.000Z',
    mode: 'study',
    item: {
      id: 'i-101',
      section: '읽기',
      number: 24,
      level: 4,
      prompt: '밑줄 친 부분과 의미가 가장 비슷한 것을 고르십시오.',
      options: [
        { id: 'a', kr: '비가 와서', en: '', correct: false },
        { id: 'b', kr: '비가 오면', en: '', correct: true },
        { id: 'c', kr: '비가 오지만', en: '', correct: false },
        { id: 'd', kr: '비가 오도록', en: '', correct: false },
      ],
      explanation:
        '밑줄의 "-(으)면"은 조건을 나타냅니다. "비가 오면"이 같은 조건 의미를 유지합니다. "비가 와서"는 이유(-아서), "비가 오지만"은 대조(-지만), "비가 오도록"은 목적/정도(-도록)이라 조건이 아닙니다.',
      hasImage: false,
    },
  },
  {
    responseId: 'm2',
    picked: 'c',
    answeredAt: '2026-07-05T20:40:00.000Z',
    mode: 'mock',
    item: {
      id: 'i-274',
      section: '듣기',
      number: 8,
      level: 3,
      prompt: '들은 내용과 같은 것을 고르십시오.',
      options: [
        { id: 'a', kr: '남자는 회의에 늦었다.', en: '', correct: false },
        { id: 'b', kr: '여자는 서류를 못 찾았다.', en: '', correct: true },
        { id: 'c', kr: '두 사람은 함께 점심을 먹었다.', en: '', correct: false },
        { id: 'd', kr: '회의가 취소되었다.', en: '', correct: false },
      ],
      explanation:
        '여자가 "서류를 못 찾겠어요"라고 말한 부분이 정답의 근거입니다. 나머지 선택지는 대화에 언급되지 않았거나 반대 내용입니다.',
      hasImage: false,
    },
  },
];

export async function loadMistakesMock(): Promise<Mistake[]> {
  await mockDelay();
  return MISTAKES_FIXTURE;
}
