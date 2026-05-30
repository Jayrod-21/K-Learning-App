/**
 * Reading screen fixture + loader. Mirrors `READING_PASSAGE` in data.js.
 *
 * Tokens carry tapword glosses and grammar-span markers (`g4-start/mid/end`)
 * verbatim from the prototype — the KoreanPassage component reads them as-is.
 *
 * Real wiring (Pass 3): `GET /reading/:id` returns this shape; tapword glosses
 * arrive enriched server-side via `/lemmatize` + `/define` + `/enrich`.
 */
import type { ReadingPassage } from '../../types/domain';
import { mockDelay } from './_delay';

export const READING_PASSAGE_FIXTURE: ReadingPassage = {
  title: '재택근무의 두 얼굴',
  level: 'TOPIK II · Intermediate',
  meta: 'Reading · 3 min',
  sentences: [
    {
      en: 'Recently, more companies are choosing remote work.',
      tokens: [
        { w: '최근', vid: null },
        { w: ' ' },
        { w: '들어' },
        { w: ' ' },
        {
          w: '재택근무',
          vid: null,
          gloss: {
            kr: '재택근무',
            pos: 'n.',
            en: 'working from home',
            ex_kr: '재택근무를 신청하다.',
            ex_en: 'To apply for remote work.',
          },
        },
        { w: '를' },
        { w: ' ' },
        {
          w: '선택하는',
          gloss: {
            kr: '선택하다',
            pos: 'v.',
            en: 'to choose',
            ex_kr: '메뉴를 선택하다.',
            ex_en: 'To choose from the menu.',
          },
        },
        { w: ' ' },
        { w: '회사가' },
        { w: ' ' },
        {
          w: '늘고',
          gloss: {
            kr: '늘다',
            pos: 'v.',
            en: 'to increase, grow',
            ex_kr: '인구가 늘다.',
            ex_en: 'The population grows.',
          },
        },
        { w: ' ' },
        { w: '있다' },
        { w: '.' },
      ],
    },
    {
      en: 'Remote work reduces commute time, whereas it can have the downside of making communication with colleagues harder.',
      tokens: [
        {
          w: '재택근무',
          gloss: {
            kr: '재택근무',
            pos: 'n.',
            en: 'working from home',
            ex_kr: '재택근무를 신청하다.',
            ex_en: 'To apply for remote work.',
          },
        },
        { w: '는' },
        { w: ' ' },
        {
          w: '출퇴근',
          gloss: {
            kr: '출퇴근',
            pos: 'n.',
            en: 'commute (to and from work)',
            ex_kr: '출퇴근 시간이 길다.',
            ex_en: 'The commute is long.',
          },
        },
        { w: ' ' },
        { w: '시간을' },
        { w: ' ' },
        {
          w: '줄여',
          gloss: {
            kr: '줄이다',
            pos: 'v.',
            en: 'to reduce',
            ex_kr: '비용을 줄이다.',
            ex_en: 'To cut costs.',
          },
        },
        { w: ' ' },
        { w: '주는', span: 'g4-start' },
        { w: ' ' },
        { w: '반면', span: 'g4-mid' },
        { w: ',', span: 'g4-end' },
        { w: ' ' },
        { w: '동료' },
        { w: '와의' },
        { w: ' ' },
        {
          w: '소통이',
          gloss: {
            kr: '소통',
            pos: 'n.',
            en: 'communication',
            ex_kr: '원활한 소통이 중요하다.',
            ex_en: 'Smooth communication matters.',
          },
        },
        { w: ' ' },
        { w: '어려워질' },
        { w: ' ' },
        { w: '수' },
        { w: ' ' },
        { w: '있다는' },
        { w: ' ' },
        {
          w: '단점',
          gloss: {
            kr: '단점',
            pos: 'n.',
            en: 'drawback; weakness',
            ex_kr: '이 방법은 단점이 있다.',
            ex_en: 'This method has drawbacks.',
          },
        },
        { w: '도' },
        { w: ' ' },
        { w: '있다' },
        { w: '.' },
      ],
    },
    {
      en: 'So many firms use both approaches together.',
      tokens: [
        { w: '그래서' },
        { w: ' ' },
        { w: '많은' },
        { w: ' ' },
        {
          w: '기업이',
          gloss: {
            kr: '기업',
            pos: 'n.',
            en: 'enterprise; firm',
            ex_kr: '대기업에서 일한다.',
            ex_en: 'I work at a large firm.',
          },
        },
        { w: ' ' },
        { w: '두' },
        { w: ' ' },
        { w: '가지' },
        { w: ' ' },
        {
          w: '방식을',
          gloss: {
            kr: '방식',
            pos: 'n.',
            en: 'method; approach',
            ex_kr: '새로운 방식을 도입하다.',
            ex_en: 'To adopt a new method.',
          },
        },
        { w: ' ' },
        { w: '함께' },
        { w: ' ' },
        { w: '사용하고' },
        { w: ' ' },
        { w: '있다' },
        { w: '.' },
      ],
    },
  ],
};

/** Async loader — resolves with the canonical reading passage. */
export async function loadReadingMock(): Promise<ReadingPassage> {
  await mockDelay();
  return READING_PASSAGE_FIXTURE;
}
