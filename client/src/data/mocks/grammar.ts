/**
 * Grammar screen fixture + loader. Mirrors `GRAMMAR[]` in data.js.
 *
 * Real wiring (Pass 3 list/bank, Pass 9 drill): `GET /grammar`,
 * `GET /grammar/bank`, `POST /grammar-drill`.
 */
import type { GrammarPattern } from '../../types/domain';
import { mockDelay } from './_delay';

export const GRAMMAR_FIXTURE: GrammarPattern[] = [
  {
    id: 'g1',
    pattern: '-더라도',
    title: 'even if / even though',
    desc: 'Strong concession. The speaker grants a hypothetical premise but maintains the main claim.',
    ex_kr: '비가 오더라도 우리는 갈 거예요.',
    ex_en: "Even if it rains, we'll go.",
    state: 'practicing',
    notes:
      'Stronger than -아도/어도. Often hypothetical, sometimes counterfactual. Pairs naturally with 아무리.',
    contrast: '-아도/어도 is neutral; -더라도 is more emphatic and often news/written.',
    examples: [
      {
        kr: '아무리 바쁘더라도 식사는 챙겨 드세요.',
        en: 'No matter how busy you are, please eat.',
      },
      { kr: '실패하더라도 다시 도전하겠다.', en: 'Even if I fail, I will try again.' },
    ],
    drill: {
      context: 'Concede that a colleague has a point — but reluctantly. Use -더라도.',
      seed: '그 의견이 ___ 우리는 일정대로 진행해야 한다.',
      model: '그 의견이 일리가 있더라도 우리는 일정대로 진행해야 한다.',
      model_en: 'Even if that opinion has merit, we must proceed on schedule.',
    },
  },
  {
    id: 'g2',
    pattern: '-느라고',
    title: 'because of doing X (negative result)',
    desc: 'Causal: the action in the first clause prevented or interfered with something in the second.',
    ex_kr: '공부하느라고 잠을 못 잤어요.',
    ex_en: "I couldn't sleep because I was studying.",
    state: 'banked',
    notes: 'Same subject in both clauses. Negative consequence required.',
    contrast:
      'Not interchangeable with -아서/어서 — -느라고 implies the action got in the way.',
    examples: [
      {
        kr: '일하느라고 친구 결혼식에 못 갔어요.',
        en: "I missed my friend's wedding because of work.",
      },
    ],
    drill: {
      context: 'Explain why you missed dinner — you were preparing a presentation. Use -느라고.',
      seed: '발표 자료를 ___ 저녁을 못 먹었어요.',
      model: '발표 자료를 준비하느라고 저녁을 못 먹었어요.',
      model_en: 'I missed dinner because I was preparing the presentation materials.',
    },
  },
  {
    id: 'g3',
    pattern: '-ㄹ 뿐만 아니라',
    title: 'not only … but also',
    desc: 'Additive emphasis. Asserts both clauses with stress on the second.',
    ex_kr: '그는 똑똑할 뿐만 아니라 성실하다.',
    ex_en: "He's not only smart but also diligent.",
    state: 'produced',
    notes: 'Attach to verb/adjective stems. Formal/written register preferred.',
    examples: [
      {
        kr: '이 책은 흥미로울 뿐만 아니라 유익하다.',
        en: 'This book is not only interesting but also informative.',
      },
    ],
    drill: {
      context:
        'Describe the city — it is convenient AND has a developed culture. Use -ㄹ 뿐만 아니라.',
      seed: '이 도시는 교통이 ___ 문화도 발달했다.',
      model: '이 도시는 교통이 편리할 뿐만 아니라 문화도 발달했다.',
      model_en: 'This city is not only convenient in transit but also culturally developed.',
    },
  },
  {
    id: 'g4',
    pattern: '-는 반면에',
    title: 'whereas / while on the contrary',
    desc: 'Strong contrast between two clauses.',
    ex_kr: '수입은 느는 반면에 지출도 늘었다.',
    ex_en: 'Income rose, whereas spending also rose.',
    state: 'practicing',
    notes: 'Often paired with statistical/comparative writing.',
    examples: [
      {
        kr: '도시는 편리한 반면에 자연이 부족하다.',
        en: 'Cities are convenient, while nature is scarce.',
      },
    ],
    drill: {
      context: 'Contrast: remote work cuts commute but hurts communication. Use -는 반면에.',
      seed: '재택근무는 출퇴근 시간을 ___ 소통이 어려워질 수 있다.',
      model: '재택근무는 출퇴근 시간을 줄여 주는 반면에 소통이 어려워질 수 있다.',
      model_en:
        'Remote work reduces commute time, whereas communication can become difficult.',
    },
  },
];

/** Async loader — resolves with all grammar patterns. */
export async function loadGrammarMock(): Promise<GrammarPattern[]> {
  await mockDelay();
  return GRAMMAR_FIXTURE;
}
