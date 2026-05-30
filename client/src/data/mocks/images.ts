/**
 * Images screen fixtures + loader. The prototype hand-authors three demo
 * captures with predetermined OCR boxes; we model them here so the screen
 * renders the upload card, recent grid, and CaptureView against a real shape.
 *
 * `data.js` does NOT define a canonical capture shape — the prototype builds
 * one inline inside `screens-d.jsx`. We invent the shape here to match what
 * Pass 8's `POST /images/ocr` endpoint will return per the integration plan:
 *   `{ id, caption_kr, caption_en, words: [{ id, kr, en, gloss, pos, box }] }`.
 *
 * Real wiring (Pass 8): `POST /images/ocr` (upload + Claude Vision),
 * `GET /images` (history), `GET /images/:id` (single capture).
 */
import type { PartOfSpeech } from '../../types/domain';
import { mockDelay } from './_delay';

/** OCR bounding box, normalised 0–1 against the image's render box. */
export interface OcrBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One detected word in a capture. */
export interface OcrWord {
  id: string;
  kr: string;
  en: string;
  pos: PartOfSpeech;
  gloss: string;
  box: OcrBox;
}

/** One image capture in the user's history. */
export interface ImageCapture {
  id: string;
  /** Display name shown in the recent-captures grid. */
  name: string;
  caption_kr: string;
  caption_en: string;
  /** Decorative gradient seed for the placeholder render. */
  gradient: string;
  /** Korean text rendered absolutely-positioned in the capture preview. */
  scene: { text: string; x: number; y: number; size: number }[];
  words: OcrWord[];
  /** ISO timestamp — drives the "today / yesterday / ..." label. */
  capturedAt: string;
}

export const IMAGE_CAPTURES_FIXTURE: ImageCapture[] = [
  {
    id: 'img1',
    name: '카페 메뉴판',
    caption_kr: '카페 메뉴판 — 음료 가격표',
    caption_en: 'Café menu board — drink prices.',
    gradient: 'linear-gradient(135deg, #f3e5d8 0%, #d9c6a8 100%)',
    scene: [
      { text: '오늘의 음료', x: 12, y: 8, size: 22 },
      { text: '아메리카노 ₩4,500', x: 12, y: 32, size: 16 },
      { text: '라떼 ₩5,000', x: 12, y: 50, size: 16 },
      { text: '녹차 ₩4,800', x: 12, y: 68, size: 16 },
    ],
    words: [
      {
        id: 'w1',
        kr: '음료',
        en: 'beverage',
        pos: 'n.',
        gloss: 'beverage, drink',
        box: { x: 12, y: 8, w: 28, h: 8 },
      },
      {
        id: 'w2',
        kr: '아메리카노',
        en: 'americano',
        pos: 'n.',
        gloss: 'americano coffee',
        box: { x: 12, y: 32, w: 32, h: 7 },
      },
      {
        id: 'w3',
        kr: '라떼',
        en: 'latte',
        pos: 'n.',
        gloss: 'caffè latte',
        box: { x: 12, y: 50, w: 18, h: 7 },
      },
      {
        id: 'w4',
        kr: '녹차',
        en: 'green tea',
        pos: 'n.',
        gloss: 'green tea',
        box: { x: 12, y: 68, w: 18, h: 7 },
      },
    ],
    capturedAt: '2026-05-28T10:14:00+09:00',
  },
  {
    id: 'img2',
    name: '지하철 안내판',
    caption_kr: '지하철역 안내판 — 출구 표시',
    caption_en: 'Subway station sign — exit indicators.',
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
        box: { x: 14, y: 14, w: 36, h: 10 },
      },
      {
        id: 'w6',
        kr: '출구',
        en: 'exit',
        pos: 'n.',
        gloss: 'exit (from a station/building)',
        box: { x: 14, y: 46, w: 20, h: 8 },
      },
    ],
    capturedAt: '2026-05-27T18:22:00+09:00',
  },
  {
    id: 'img3',
    name: '식당 영수증',
    caption_kr: '한식당 영수증 — 결제 내역',
    caption_en: 'Korean restaurant receipt — payment details.',
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
        box: { x: 10, y: 6, w: 22, h: 8 },
      },
      {
        id: 'w8',
        kr: '비빔밥',
        en: 'bibimbap',
        pos: 'n.',
        gloss: 'bibimbap (mixed rice dish)',
        box: { x: 10, y: 28, w: 20, h: 7 },
      },
      {
        id: 'w9',
        kr: '김치찌개',
        en: 'kimchi stew',
        pos: 'n.',
        gloss: 'kimchi jjigae (stew)',
        box: { x: 10, y: 44, w: 24, h: 7 },
      },
      {
        id: 'w10',
        kr: '합계',
        en: 'total',
        pos: 'n.',
        gloss: 'sum, total amount',
        box: { x: 10, y: 70, w: 16, h: 7 },
      },
    ],
    capturedAt: '2026-05-26T20:48:00+09:00',
  },
];

/** Async loader — resolves with the user's capture history. */
export async function loadImagesMock(): Promise<ImageCapture[]> {
  await mockDelay();
  return IMAGE_CAPTURES_FIXTURE;
}
