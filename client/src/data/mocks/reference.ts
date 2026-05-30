/**
 * Reference screen fixture + loader. Mirrors `REFERENCE_INDEX` in data.js.
 *
 * Real wiring (Pass 3): cross-search across `/vocab?q=`, `/grammar?q=`,
 * `/define/:lemma` keyed by the filter chip (vocab / grammar / hanja).
 */
import type { ReferenceEntry } from '../../types/domain';
import { mockDelay } from './_delay';

export const REFERENCE_FIXTURE: ReferenceEntry[] = [
  { kind: 'vocab', kr: '영향', en: 'influence; effect', level: 'L3' },
  { kind: 'vocab', kr: '환경', en: 'environment', level: 'L3' },
  { kind: 'vocab', kr: '발전', en: 'development', level: 'L3' },
  { kind: 'grammar', kr: '-는 반면에', en: 'whereas / while', level: 'L4' },
  { kind: 'grammar', kr: '-더라도', en: 'even if', level: 'L4' },
  { kind: 'vocab', kr: '안녕하세요', en: 'hello (greeting)', level: 'L1', basics: true },
  { kind: 'grammar', kr: '-아요/어요', en: 'polite present', level: 'L1', basics: true },
  { kind: 'vocab', kr: '결과', en: 'result; outcome', level: 'L3' },
  { kind: 'vocab', kr: '참여하다', en: 'to participate', level: 'L3' },
  { kind: 'grammar', kr: '-ㄹ 뿐만 아니라', en: 'not only … but also', level: 'L4' },
];

/** Async loader — resolves with the flat reference index. */
export async function loadReferenceMock(): Promise<ReferenceEntry[]> {
  await mockDelay();
  return REFERENCE_FIXTURE;
}
