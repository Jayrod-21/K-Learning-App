/**
 * Hanja screen fixtures + loaders. Mirrors `HANJA[]` and `HANJA_PROGRESS`.
 *
 * Real wiring (Pass 7): `GET /hanja`, `GET /hanja/today`, `GET /hanja/:char`.
 * Needs the hanja corpus loader to land first (no `hanja.json` ingested yet).
 */
import type { Hanja, HanjaProgress } from '../../types/domain';
import { mockDelay } from './_delay';

export const HANJA_FIXTURE: Hanja[] = [
  {
    id: 'h1',
    characterId: 1,
    ch: '學',
    sound: '학',
    gloss: '배울',
    en: 'learn / study',
    level: 'L3',
    strokes: 16,
    state: 'practicing',
    note: 'A roof over a child receiving knowledge. The single most common 한자 in academic Korean.',
    compounds: [
      { kr: '學生', han: '學生', en: 'student', with: '生' },
      { kr: '學校', han: '學校', en: 'school', with: '校' },
      { kr: '學習', han: '學習', en: 'study (n./v.)', with: '習' },
      { kr: '大學', han: '大學', en: 'university', with: '大' },
      { kr: '學者', han: '學者', en: 'scholar', with: '者' },
    ],
  },
  {
    id: 'h2',
    characterId: 2,
    ch: '生',
    sound: '생',
    gloss: '날',
    en: 'birth / life',
    level: 'L2',
    strokes: 5,
    state: 'banked',
    note: 'Pictograph of a sprout from the earth. Pairs in dozens of words.',
    compounds: [
      { kr: '學生', han: '學生', en: 'student', with: '學' },
      { kr: '生活', han: '生活', en: 'life', with: '活' },
      { kr: '人生', han: '人生', en: 'human life', with: '人' },
      { kr: '發生', han: '發生', en: 'occurrence', with: '發' },
    ],
  },
  {
    id: 'h3',
    characterId: 3,
    ch: '影',
    sound: '영',
    gloss: '그림자',
    en: 'shadow / image',
    level: 'L4',
    strokes: 15,
    state: 'new',
    note: 'In 영향, "shadow + echo" = influence. The seal-radical hints at sun + reflection.',
    compounds: [
      { kr: '影響', han: '影響', en: 'influence', with: '響' },
      { kr: '撮影', han: '撮影', en: 'filming', with: '撮' },
    ],
  },
  {
    id: 'h4',
    characterId: 4,
    ch: '響',
    sound: '향',
    gloss: '울릴',
    en: 'sound / echo',
    level: 'L4',
    strokes: 22,
    state: 'new',
    note: '"Village" + "sound" — the way sound carries through a town.',
    compounds: [
      { kr: '影響', han: '影響', en: 'influence', with: '影' },
      { kr: '音響', han: '音響', en: 'audio/sound', with: '音' },
    ],
  },
  {
    id: 'h5',
    characterId: 5,
    ch: '環',
    sound: '환',
    gloss: '고리',
    en: 'ring / circle',
    level: 'L3',
    strokes: 17,
    state: 'practicing',
    note: 'A jade ring. Appears in 환경 (environment, lit. "ring + region") and 순환 (circulation).',
    compounds: [
      { kr: '環境', han: '環境', en: 'environment', with: '境' },
      { kr: '循環', han: '循環', en: 'circulation', with: '循' },
    ],
  },
  {
    id: 'h6',
    characterId: 6,
    ch: '境',
    sound: '경',
    gloss: '지경',
    en: 'border / region',
    level: 'L3',
    strokes: 14,
    state: 'practicing',
    note: 'A limit, an area. 국경 = national border. 환경 = surrounding region.',
    compounds: [
      { kr: '環境', han: '環境', en: 'environment', with: '環' },
      { kr: '國境', han: '國境', en: 'border', with: '國' },
      { kr: '境界', han: '境界', en: 'boundary', with: '界' },
    ],
  },
  {
    id: 'h7',
    characterId: 7,
    ch: '發',
    sound: '발',
    gloss: '필',
    en: 'emerge / open up',
    level: 'L3',
    strokes: 12,
    state: 'banked',
    note: 'Bow drawn back, about to release. "To send forth, to develop."',
    compounds: [
      { kr: '發展', han: '發展', en: 'development', with: '展' },
      { kr: '出發', han: '出發', en: 'departure', with: '出' },
      { kr: '發見', han: '發見', en: 'discovery', with: '見' },
      { kr: '發生', han: '發生', en: 'occurrence', with: '生' },
    ],
  },
  {
    id: 'h8',
    characterId: 8,
    ch: '展',
    sound: '전',
    gloss: '펼',
    en: 'unfold / spread',
    level: 'L3',
    strokes: 10,
    state: 'practicing',
    note: 'To open out a scroll. In 발전 ("emerge + unfold") = development.',
    compounds: [
      { kr: '發展', han: '發展', en: 'development', with: '發' },
      { kr: '展示', han: '展示', en: 'exhibition', with: '示' },
      { kr: '展開', han: '展開', en: 'unfolding', with: '開' },
    ],
  },
  {
    id: 'h9',
    characterId: 9,
    ch: '結',
    sound: '결',
    gloss: '맺을',
    en: 'tie / conclude',
    level: 'L3',
    strokes: 12,
    state: 'banked',
    note: 'Silk thread + good fortune — to bind together. Pairs with 과 (fruit) → "tied fruit" = result.',
    compounds: [
      { kr: '結果', han: '結果', en: 'result', with: '果' },
      { kr: '結婚', han: '結婚', en: 'marriage', with: '婚' },
      { kr: '結論', han: '結論', en: 'conclusion', with: '論' },
    ],
  },
  {
    id: 'h10',
    characterId: 10,
    ch: '果',
    sound: '과',
    gloss: '열매',
    en: 'fruit / outcome',
    level: 'L2',
    strokes: 8,
    state: 'banked',
    note: 'Pictograph of fruit on a tree.',
    compounds: [
      { kr: '結果', han: '結果', en: 'result', with: '結' },
      { kr: '果實', han: '果實', en: 'fruit', with: '實' },
      { kr: '效果', han: '效果', en: 'effect', with: '效' },
    ],
  },
  {
    id: 'h11',
    characterId: 11,
    ch: '人',
    sound: '인',
    gloss: '사람',
    en: 'person',
    level: 'L1',
    strokes: 2,
    state: 'banked',
    note: 'Two legs walking. The most common 한자.',
    compounds: [
      { kr: '韓國人', han: '韓國人', en: 'Korean person', with: '韓' },
      { kr: '人生', han: '人生', en: 'human life', with: '生' },
      { kr: '個人', han: '個人', en: 'individual', with: '個' },
    ],
  },
  {
    id: 'h12',
    characterId: 12,
    ch: '國',
    sound: '국',
    gloss: '나라',
    en: 'country',
    level: 'L1',
    strokes: 11,
    state: 'banked',
    note: 'A walled enclosure with weapons inside. 한국 = Han-country.',
    compounds: [
      { kr: '韓國', han: '韓國', en: 'Korea', with: '韓' },
      { kr: '國家', han: '國家', en: 'state / nation', with: '家' },
      { kr: '外國', han: '外國', en: 'foreign land', with: '外' },
    ],
  },
];

export const HANJA_PROGRESS_FIXTURE: HanjaProgress = {
  banked: 6,
  practicing: 4,
  new: 2,
  targetL4: 800,
  encountered: 142,
  note: "You've crossed paths with 142 of the ~800 hanja that recur at L4. Six are anchored.",
};

/** Hanja character pool — drives Today + Index views. */
export async function loadHanjaMock(): Promise<Hanja[]> {
  await mockDelay();
  return HANJA_FIXTURE;
}

/**
 * Featured "today" character — the mock fallback for `GET /hanja/today`.
 *
 * The real server owns the weighting (recently-mined words → frequency →
 * deterministic-by-day). The mock mirrors the original client-side pick: the
 * first character the learner is actively practicing, falling back to the first
 * row. Returns `null` only if the pool is empty (so the screen's empty state is
 * exercised by the mock too).
 */
export async function loadHanjaTodayMock(): Promise<Hanja | null> {
  await mockDelay();
  const first = HANJA_FIXTURE[0];
  if (first === undefined) return null;
  return HANJA_FIXTURE.find((h) => h.state === 'practicing') ?? first;
}

/** Aggregate progress — drives the Encountered band card. */
export async function loadHanjaProgressMock(): Promise<HanjaProgress> {
  await mockDelay();
  return HANJA_PROGRESS_FIXTURE;
}
