/**
 * Images screen fixtures + loader. The prototype hand-authors three demo
 * captures; we model them against the real `ImageCapture` domain shape so the
 * screen renders the upload card, recent grid, and CaptureView as a fallback
 * when the real `/images` endpoint is unavailable.
 *
 * The OCR domain types (`OcrWord`, `ImageCapture`) now live in
 * `types/domain.ts` (Pass 8) — there are NO bounding boxes (Claude Vision
 * returns word transcription + glosses, not coordinates), so the fixtures
 * carry no `box` field. The capture view renders the real photo via `blobUrl`;
 * the mock has no real bytes, so each fixture leaves `blobUrl` empty and keeps
 * the `scene`/`gradient` placeholder fields the render falls back to when
 * `blobUrl` is absent.
 *
 * Real wiring (Pass 8): `POST /images/ocr` (upload + Claude Vision),
 * `GET /images` (history), `GET /images/:id` (single capture) — see
 * `services/images.ts`.
 */
import type { ImageCapture } from '../../types/domain';
import { mockDelay } from './_delay';

export const IMAGE_CAPTURES_FIXTURE: ImageCapture[] = [
  {
    id: 'img1',
    name: '카페 메뉴판',
    caption_kr: '카페 메뉴판 — 음료 가격표',
    caption_en: 'Café menu board — drink prices.',
    // No real bytes in the mock — empty `blobUrl` makes the capture view fall
    // back to the gradient placeholder below.
    blobUrl: '',
    gradient: 'linear-gradient(135deg, #f3e5d8 0%, #d9c6a8 100%)',
    scene: [
      { text: '오늘의 음료', x: 12, y: 8, size: 22 },
      { text: '아메리카노 ₩4,500', x: 12, y: 32, size: 16 },
      { text: '라떼 ₩5,000', x: 12, y: 50, size: 16 },
      { text: '녹차 ₩4,800', x: 12, y: 68, size: 16 },
    ],
    words: [
      { id: 'w1', kr: '음료', en: 'beverage', pos: 'n.', gloss: 'beverage, drink' },
      {
        id: 'w2',
        kr: '아메리카노',
        en: 'americano',
        pos: 'n.',
        gloss: 'americano coffee',
      },
      { id: 'w3', kr: '라떼', en: 'latte', pos: 'n.', gloss: 'caffè latte' },
      { id: 'w4', kr: '녹차', en: 'green tea', pos: 'n.', gloss: 'green tea' },
    ],
    capturedAt: '2026-05-28T10:14:00+09:00',
  },
  {
    id: 'img2',
    name: '지하철 안내판',
    caption_kr: '지하철역 안내판 — 출구 표시',
    caption_en: 'Subway station sign — exit indicators.',
    blobUrl: '',
    gradient: 'linear-gradient(180deg, #e7d9c0 0%, #b89e7c 100%)',
    scene: [
      { text: '2호선 강남역', x: 14, y: 14, size: 24 },
      { text: '← 출구 1·2·3', x: 14, y: 46, size: 18 },
      { text: '출구 4·5·6 →', x: 14, y: 68, size: 18 },
    ],
    words: [
      {
        id: 'w5',
        kr: '강남역',
        en: 'Gangnam Station',
        pos: 'pn.',
        gloss: 'Gangnam subway station',
      },
      {
        id: 'w6',
        kr: '출구',
        en: 'exit',
        pos: 'n.',
        gloss: 'exit (from a station/building)',
      },
    ],
    capturedAt: '2026-05-27T18:22:00+09:00',
  },
  {
    id: 'img3',
    name: '식당 영수증',
    caption_kr: '한식당 영수증 — 결제 내역',
    caption_en: 'Korean restaurant receipt — payment details.',
    blobUrl: '',
    gradient: 'linear-gradient(160deg, #fbf6e6 0%, #d8c8a0 100%)',
    scene: [
      { text: '맛있는 식당', x: 10, y: 6, size: 20 },
      { text: '비빔밥 ₩9,000', x: 10, y: 28, size: 15 },
      { text: '김치찌개 ₩8,500', x: 10, y: 44, size: 15 },
      { text: '합계 ₩17,500', x: 10, y: 70, size: 17 },
    ],
    words: [
      {
        id: 'w7',
        kr: '식당',
        en: 'restaurant',
        pos: 'n.',
        gloss: 'restaurant, eatery',
      },
      {
        id: 'w8',
        kr: '비빔밥',
        en: 'bibimbap',
        pos: 'n.',
        gloss: 'bibimbap (mixed rice dish)',
      },
      {
        id: 'w9',
        kr: '김치찌개',
        en: 'kimchi stew',
        pos: 'n.',
        gloss: 'kimchi jjigae (stew)',
      },
      { id: 'w10', kr: '합계', en: 'total', pos: 'n.', gloss: 'sum, total amount' },
    ],
    capturedAt: '2026-05-26T20:48:00+09:00',
  },
];

/** Async loader — resolves with the user's capture history. */
export async function loadImagesMock(): Promise<ImageCapture[]> {
  await mockDelay();
  return IMAGE_CAPTURES_FIXTURE;
}
