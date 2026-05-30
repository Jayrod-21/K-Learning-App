/**
 * Chat (Conversation) screen fixture + loader. Mirrors `CONVERSATION` in data.js.
 *
 * Tutor messages use 합쇼체 (formal register) per the design's localization note.
 *
 * Real wiring (Pass 3): `GET /conversation` (history), `POST /conversation`
 * (new turn) with FU-NF-4 streaming response folded in.
 */
import type { Conversation } from '../../types/domain';
import { mockDelay } from './_delay';

export const CONVERSATION_FIXTURE: Conversation = [
  {
    role: 'tutor',
    kr: '안녕하십니까. 오늘은 재택근무의 장단점에 대해 이야기해 보겠습니다.',
    en: 'Hello. Today we’ll discuss the pros and cons of remote work.',
  },
  {
    role: 'user',
    kr: '네, 잘 부탁드립니다. 먼저 생산성 측면에서 어떤 영향이 있을까요?',
    en: 'Yes, thank you. First — what about effects on productivity?',
  },
  {
    role: 'tutor',
    kr: '연구에 따르면 집중도가 높아지는 반면, 협업 효율은 떨어질 수 있다고 합니다.',
    en: 'Studies report focus rises whereas collaboration efficiency can drop.',
  },
  {
    role: 'user',
    kr: '그렇군요. 그렇다면 기업은 어떤 방식을 택해야 하겠습니까?',
    en: 'I see. Then what approach should firms take?',
  },
];

/** Async loader — resolves with the seeded conversation. */
export async function loadConversationMock(): Promise<Conversation> {
  await mockDelay();
  return CONVERSATION_FIXTURE;
}
