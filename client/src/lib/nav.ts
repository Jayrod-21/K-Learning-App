/**
 * Navigation manifest — the single source of truth for the app's screens.
 *
 * Overhaul P1.1 model — three buckets:
 *
 *   1. PRIMARY_TAB_IDS — the 4 routed bottom-nav tabs
 *      (today `/` · progress `/progress` · review `/review` · settings
 *      `/settings`). `review` is the LIBRARY index (repurposed — the old
 *      FSRS flashcards page that lived at `/review` is now `flashcards`
 *      at `/learn/vocab`).
 *   2. LEARN_SUBPAGE_IDS — the 7 study pages behind the center hexagon
 *      LEARN launcher, all namespaced under `/learn/*`. The launcher
 *      itself is NOT a NavItem — it has no route; `BottomNav` renders it
 *      as a button that toggles `LearnMenu`.
 *   3. SECONDARY_IDS — routed screens reachable from tabs/pages but not
 *      from the bar (mistakes, reference, diagnostic, images, chat).
 *
 * Hard contract: `chat` stays at `/chat` — `AskAboutThisButton` pins
 * `CHAT_PATH = '/chat'` and F-020 seed state rides router state to it.
 * Never move it.
 *
 * `path` is the React Router route. `kr` is the Korean sublabel (LearnMenu
 * rows, a11y labels). `icon` is a key into the `<Icon/>` registry.
 * `headerTitle` is the serif Korean title pattern (e.g. `복습 · Review`).
 */
import type { IconName } from '../components/Icon';

export interface NavItem {
  readonly id: NavItemId;
  readonly path: string;
  readonly label: string;
  readonly kr: string;
  readonly eyebrow: string;
  readonly headerTitle: string;
  readonly icon: IconName;
}

export type NavItemId =
  // Primary tabs.
  | 'today'
  | 'progress'
  | 'review'
  | 'settings'
  // LEARN sub-pages.
  | 'topik'
  | 'ttmik'
  | 'flashcards'
  | 'grammar'
  | 'writing'
  | 'hanja'
  | 'reading'
  // Secondary routed screens.
  | 'mistakes'
  | 'reference'
  | 'diagnostic'
  | 'images'
  | 'chat';

export const NAV_ITEMS: ReadonlyArray<NavItem> = [
  // ── Primary tabs ────────────────────────────────────────────────────
  {
    id: 'today',
    path: '/',
    label: 'Today',
    kr: '오늘',
    eyebrow: 'Daily plan',
    headerTitle: '오늘 · Today',
    icon: 'home',
  },
  {
    id: 'progress',
    path: '/progress',
    label: 'Progress',
    kr: '성장',
    eyebrow: 'Diagnostic history',
    headerTitle: '성장 · Progress',
    icon: 'history',
  },
  {
    // REPURPOSED id (P1.1): `review` is now the library index at `/review`.
    // The FSRS vocab-flashcards page that used to own this id/path is
    // `flashcards` at `/learn/vocab` below.
    id: 'review',
    path: '/review',
    label: 'Review',
    kr: '복습',
    eyebrow: 'Library',
    headerTitle: '복습 · Review',
    icon: 'folder',
  },
  {
    id: 'settings',
    path: '/settings',
    label: 'Settings',
    kr: '설정',
    eyebrow: 'Profile · notifications · appearance',
    headerTitle: '설정 · Settings',
    icon: 'settings',
  },
  // ── LEARN sub-pages (hexagon launcher menu, /learn/*) ───────────────
  {
    id: 'topik',
    path: '/learn/topik',
    label: 'TOPIK',
    kr: '모의',
    eyebrow: 'Mock test',
    headerTitle: '모의 · TOPIK',
    icon: 'spark',
  },
  {
    // Keeps id `ttmik` (the page component / services keep their names);
    // the user-facing label stays "Listen".
    id: 'ttmik',
    path: '/learn/listen',
    label: 'Listen',
    kr: '듣기',
    eyebrow: 'TTMIK · Iyagi audio',
    headerTitle: '듣기 · Listen',
    icon: 'headphones',
  },
  {
    // NEW id (P1.1) — the old `review` FSRS flashcards page, re-homed.
    id: 'flashcards',
    path: '/learn/vocab',
    label: 'Vocab flashcards',
    kr: '단어 카드',
    eyebrow: 'Flashcards',
    headerTitle: '단어 카드 · Vocab',
    icon: 'cards',
  },
  {
    id: 'grammar',
    path: '/learn/grammar',
    label: 'Grammar practice',
    kr: '문법',
    eyebrow: 'Production drill',
    headerTitle: '문법 · Grammar',
    icon: 'grammar',
  },
  {
    id: 'writing',
    path: '/learn/writing',
    label: 'Writing',
    kr: '쓰기',
    eyebrow: 'TOPIK writing grader',
    headerTitle: '쓰기 · Writing',
    icon: 'pen',
  },
  {
    id: 'hanja',
    path: '/learn/hanja',
    label: 'Hanja',
    kr: '한자',
    eyebrow: 'The bones inside the words',
    headerTitle: '한자 · Hanja',
    icon: 'hanja',
  },
  {
    // NEW (P1.1) — placeholder page until the book scans land (P6). NOT at
    // `/reading`: that legacy path is a live redirect to `/learn/listen`.
    id: 'reading',
    path: '/learn/reading',
    label: 'Reading',
    kr: '읽기',
    eyebrow: 'Coming soon',
    headerTitle: '읽기 · Reading',
    icon: 'book',
  },
  // ── Secondary routed screens ─────────────────────────────────────────
  {
    id: 'mistakes',
    path: '/review/mistakes',
    label: 'Mistakes',
    kr: '틀린 문제',
    eyebrow: 'What you missed, in one place',
    headerTitle: '틀린 문제 · Mistakes',
    icon: 'history',
  },
  {
    // KEEP for P1.1 — the Reference page dissolves into the Review library
    // in P1.2. The library index deep-links into its tabs via `?tab=`.
    id: 'reference',
    path: '/reference',
    label: 'Reference',
    kr: '참고',
    eyebrow: 'Lookup',
    headerTitle: '참고 · Reference',
    icon: 'search',
  },
  {
    id: 'diagnostic',
    path: '/diagnostic',
    label: 'Diagnostic',
    kr: '진단',
    eyebrow: 'Skills check',
    headerTitle: '진단 · Diagnostic',
    icon: 'compass',
  },
  {
    id: 'images',
    path: '/images',
    label: 'Images',
    kr: '이미지',
    eyebrow: 'OCR · mine real-world Korean',
    headerTitle: '이미지 · Images',
    icon: 'image',
  },
  {
    // HARD CONTRACT — `/chat` never moves (AskAboutThisButton CHAT_PATH).
    id: 'chat',
    path: '/chat',
    label: 'Chat',
    kr: '대화',
    eyebrow: 'Tutor conversation',
    headerTitle: '대화 · Chat',
    icon: 'chat',
  },
];

// Note: the `as const` is load-bearing — it narrows `typeof X[number]` to a
// literal-string union so the exhaustiveness check below can compare the
// arrays to `NavItemId`. A `ReadonlyArray<NavItemId>` annotation would widen
// the array element type back to `NavItemId` and defeat the check.

/** The 4 routed bottom-nav tabs, in bar order (hexagon sits between 2 and 3). */
export const PRIMARY_TAB_IDS = [
  'today',
  'progress',
  'review',
  'settings',
] as const satisfies ReadonlyArray<NavItemId>;

/** The 7 LEARN sub-pages, in LearnMenu top-to-bottom order (mockup order). */
export const LEARN_SUBPAGE_IDS = [
  'topik',
  'ttmik',
  'flashcards',
  'grammar',
  'writing',
  'hanja',
  'reading',
] as const satisfies ReadonlyArray<NavItemId>;

/** Routed screens reachable from tabs/pages, not from the bar. */
export const SECONDARY_IDS = [
  'mistakes',
  'reference',
  'diagnostic',
  'images',
  'chat',
] as const satisfies ReadonlyArray<NavItemId>;

/**
 * Compile-time guarantee: every `NavItemId` is in exactly one of the three
 * buckets above. If a future engineer adds a new union member and forgets
 * to place it, `_MissingFromBuckets` widens past `never` and the `extends
 * never ? true : never` const below resolves to `never` — tsc fails the
 * build with a useful error pointing here. Symmetrically, an id that
 * exists in a bucket but not the union flags via `_ExtraInBuckets`, and an
 * id placed in two buckets flags via the pairwise `_Overlap*` checks.
 *
 * The checks are structural-only — erased at runtime under
 * `erasableSyntaxOnly`. The `void` references keep `noUnusedLocals` happy.
 */
type _PrimaryId = (typeof PRIMARY_TAB_IDS)[number];
type _LearnId = (typeof LEARN_SUBPAGE_IDS)[number];
type _SecondaryId = (typeof SECONDARY_IDS)[number];
type _BucketedId = _PrimaryId | _LearnId | _SecondaryId;
type _MissingFromBuckets = Exclude<NavItemId, _BucketedId>;
type _ExtraInBuckets = Exclude<_BucketedId, NavItemId>;
type _OverlapPrimaryLearn = Extract<_PrimaryId, _LearnId>;
type _OverlapPrimarySecondary = Extract<_PrimaryId, _SecondaryId>;
type _OverlapLearnSecondary = Extract<_LearnId, _SecondaryId>;
const _navIdExhaustivenessMissing: _MissingFromBuckets extends never
  ? true
  : never = true;
const _navIdExhaustivenessExtra: _ExtraInBuckets extends never ? true : never =
  true;
const _navIdOverlapPL: _OverlapPrimaryLearn extends never ? true : never = true;
const _navIdOverlapPS: _OverlapPrimarySecondary extends never ? true : never =
  true;
const _navIdOverlapLS: _OverlapLearnSecondary extends never ? true : never =
  true;
void _navIdExhaustivenessMissing;
void _navIdExhaustivenessExtra;
void _navIdOverlapPL;
void _navIdOverlapPS;
void _navIdOverlapLS;

const ITEM_BY_ID = new Map<NavItemId, NavItem>(
  NAV_ITEMS.map((it) => [it.id, it]),
);

export function navItem(id: NavItemId): NavItem {
  const it = ITEM_BY_ID.get(id);
  if (!it) {
    // Unreachable as long as the union and the array stay in sync — the
    // throw is a defence against a future copy-paste mistake leaving an id
    // un-registered.
    throw new Error(`unknown nav item: ${String(id)}`);
  }
  return it;
}
