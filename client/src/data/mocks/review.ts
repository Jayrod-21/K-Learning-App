/**
 * Review screen fixtures + loaders. Bundles the vocab card pool plus the
 * user's vocab-list bundle (custom + textbook-sourced lists).
 *
 * Mirrors `VOCAB[]` and `VOCAB_LISTS` in data.js.
 *
 * Real wiring (Pass 3): `GET /vocab` (cards), `GET /vocab/bank` (user's list),
 * `GET /vocab/lists/*` (lists + sources).
 */
import type { Vocab, VocabListBundle } from '../../types/domain';
import { mockDelay } from './_delay';

export const VOCAB_FIXTURE: Vocab[] = [
  {
    id: 'v1',
    kr: '영향',
    pos: 'n.',
    en: 'influence; effect',
    ex_kr: '그 정책은 경제에 큰 영향을 미쳤다.',
    ex_en: 'That policy had a big effect on the economy.',
    notes: 'Often paired with 미치다 ("to exert"). Academic/news register.',
    extra: [
      { kr: '환경에 영향을 주는 요인', en: 'Factors that influence the environment.' },
      { kr: '서로 영향을 주고받는 관계', en: 'A relationship of mutual influence.' },
    ],
    mined_in: 'Article — "도시화의 영향"',
  },
  {
    id: 'v2',
    kr: '발전',
    pos: 'n.',
    en: 'development; progress',
    ex_kr: '기술의 발전 덕분에 생활이 편리해졌다.',
    ex_en: 'Thanks to tech progress, life got convenient.',
    notes: '발전하다 = to develop. Distinct from 발달 (esp. for skills/organs).',
    extra: [
      { kr: '경제 발전 속도가 빠르다.', en: 'The pace of economic development is fast.' },
      { kr: '꾸준히 발전해 왔다.', en: 'It has steadily developed.' },
    ],
    mined_in: 'Reading — Remote work passage',
  },
  {
    id: 'v3',
    kr: '환경',
    pos: 'n.',
    en: 'environment',
    ex_kr: '환경 문제는 전 세계가 함께 해결해야 한다.',
    ex_en: 'Environmental problems must be solved globally.',
    notes: 'Both physical environment and surrounding conditions.',
    extra: [
      { kr: '근무 환경이 좋다.', en: 'The work environment is good.' },
      { kr: '환경 보호 운동', en: 'Environmental protection movement.' },
    ],
    mined_in: 'Vocab list — Academic Coverage',
  },
  {
    id: 'v4',
    kr: '참여하다',
    pos: 'v.',
    en: 'to participate',
    ex_kr: '많은 시민이 토론에 참여했다.',
    ex_en: 'Many citizens participated in the debate.',
    notes: 'Takes -에 marker. More formal than 함께하다.',
    extra: [
      { kr: '회의에 참여할 예정이다.', en: 'I plan to attend the meeting.' },
      { kr: '적극적으로 참여하다.', en: 'To actively participate.' },
    ],
    mined_in: 'TOPIK II — 2022 Reading #18',
  },
  {
    id: 'v5',
    kr: '증가하다',
    pos: 'v.',
    en: 'to increase',
    ex_kr: '올해 수출이 크게 증가했다.',
    ex_en: 'Exports increased significantly this year.',
    notes: 'Antonym: 감소하다. News/statistics register.',
    extra: [{ kr: '인구가 빠르게 증가하고 있다.', en: 'The population is rapidly increasing.' }],
    mined_in: 'Listening — News clip',
  },
  {
    id: 'v6',
    kr: '반면',
    pos: 'n./adv.',
    en: 'on the other hand',
    ex_kr: '도시는 편리한 반면 공기가 나쁘다.',
    ex_en: 'Cities are convenient, whereas the air is bad.',
    notes: 'Use with -는/은 반면(에) for clauses. Strongly contrastive.',
    extra: [
      { kr: '장점이 있는 반면 단점도 있다.', en: 'There are advantages, but also drawbacks.' },
    ],
    mined_in: 'Reading — Remote work passage',
  },
  {
    id: 'v7',
    kr: '결과',
    pos: 'n.',
    en: 'result; outcome',
    ex_kr: '노력의 결과로 시험에 합격했다.',
    ex_en: 'As a result of effort, I passed the exam.',
    notes: '-의 결과(로) = "as a result of". Distinguish from 효과 (effect).',
    extra: [{ kr: '실험 결과를 발표하다.', en: 'To announce experiment results.' }],
    mined_in: 'TOPIK II — Mock test #4',
  },
];

export const VOCAB_LISTS_FIXTURE: VocabListBundle = {
  active: 'c2',
  custom: [
    {
      id: 'c1',
      name: '병원 어휘',
      en: 'Hospital words',
      kind: 'vocab',
      count: 14,
      mature: 5,
      due: 6,
      lastStudied: '2 days ago',
      preview: ['진료', '처방전', '주사', '증상', '검사'],
    },
    {
      id: 'c2',
      name: '도깨비 — K-drama',
      en: 'Goblin · drama vocab',
      kind: 'vocab',
      count: 31,
      mature: 22,
      due: 9,
      lastStudied: 'Yesterday',
      preview: ['운명', '저주', '소환', '기억', '신부'],
    },
    {
      id: 'c3',
      name: '업무 이메일 · 격식체',
      en: 'Work emails — formal',
      kind: 'vocab',
      count: 22,
      mature: 14,
      due: 4,
      lastStudied: '3 hours ago',
      preview: ['검토', '회신', '첨부', '귀하', '드리다'],
    },
    {
      id: 'c4',
      name: '재택근무 · 기사 마이닝',
      en: 'Mined from articles',
      kind: 'vocab',
      count: 8,
      mature: 1,
      due: 8,
      lastStudied: 'Today · 12 min ago',
      preview: ['재택근무', '출퇴근', '소통', '방식'],
    },
  ],
  sources: [
    {
      source: 'TOPIK II 어휘 50일 완성',
      publisher: '시원스쿨 · 2023',
      cover: '한',
      kind: 'vocab',
      lists: [
        { id: 's1', name: '11일 · 정치', en: 'Politics', count: 24, level: 'L4', added: 0 },
        { id: 's2', name: '12일 · 사회', en: 'Society', count: 24, level: 'L4', added: 12 },
        {
          id: 's3',
          name: '13일 · 환경',
          en: 'Environment',
          count: 28,
          level: 'L4',
          added: 28,
          complete: true,
        },
        { id: 's4', name: '14일 · 경제', en: 'Economy', count: 26, level: 'L4', added: 4 },
        { id: 's5', name: '15일 · 교육', en: 'Education', count: 22, level: 'L4', added: 0 },
      ],
    },
    {
      source: 'Korean Grammar in Use',
      publisher: 'Intermediate · Darakwon',
      cover: '문',
      kind: 'grammar',
      lists: [
        { id: 's6', name: 'Ch 7 · 연결 어미', en: 'Connectives', count: 12, level: 'L3–4', added: 8 },
        {
          id: 's7',
          name: 'Ch 8 · 추측과 의도',
          en: 'Conjecture & intent',
          count: 10,
          level: 'L4',
          added: 3,
        },
        { id: 's8', name: 'Ch 9 · 인용', en: 'Reported speech', count: 8, level: 'L3', added: 0 },
      ],
    },
    {
      source: '연세 한국어 4',
      publisher: '연세대 한국어학당',
      cover: '연',
      kind: 'vocab',
      lists: [
        {
          id: 's9',
          name: '제3과 · 환경 문제',
          en: 'Environmental issues',
          count: 18,
          level: 'L4',
          added: 9,
        },
        {
          id: 's10',
          name: '제4과 · 인간관계',
          en: 'Relationships',
          count: 21,
          level: 'L4',
          added: 0,
        },
        {
          id: 's11',
          name: '제5과 · 직장 생활',
          en: 'Workplace life',
          count: 24,
          level: 'L4',
          added: 0,
        },
      ],
    },
    {
      source: '뉴스로 배우는 한국어',
      publisher: 'Self-mined · KBS clips',
      cover: '뉴',
      kind: 'mixed',
      lists: [
        {
          id: 's12',
          name: '경제 뉴스 — 핵심 100',
          en: 'Economic news · core 100',
          count: 100,
          level: 'L4–5',
          added: 12,
        },
        {
          id: 's13',
          name: '사회 뉴스 — 핵심 80',
          en: 'Social news · core 80',
          count: 80,
          level: 'L4',
          added: 0,
        },
      ],
    },
  ],
};

/** Card pool for the Session sub-tab. */
export async function loadVocabMock(): Promise<Vocab[]> {
  await mockDelay();
  return VOCAB_FIXTURE;
}

/** Vocab-list bundle for the Lists sub-tab + ListDetailSheet. */
export async function loadVocabListsMock(): Promise<VocabListBundle> {
  await mockDelay();
  return VOCAB_LISTS_FIXTURE;
}
