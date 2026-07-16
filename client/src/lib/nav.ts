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
 *      from the bar: the Review-library sub-pages (mistakes, review-vocab,
 *      review-dictionary, review-grammar — the P1.2 dissolution of the old
 *      Reference page, decisions D2/D3) plus diagnostic, images, chat.
 *      `/reference` itself is retired — a redirect shim in lib/redirects
 *      maps it (tab-aware) onto the library routes.
 *
 * Hard contract: `chat` stays at `/chat` — `AskAboutThisButton` pins
 * `CHAT_PATH = '/chat'` and F-020 seed state rides router state to it.
 * Never move it.
 *
 * `path` is the React Router route. `kr` is the Korean sublabel (LearnMenu
 * rows, a11y labels). `icon` is a key into the `<Icon/>` registry.
 * `headerTitle` is the serif Korean title pattern (e.g. `오늘 · Today`).
 *
 * Eyebrows (Overhaul P3b): `eyebrow` is the ENGLISH eyebrow, `krEyebrow` its
 * Korean counterpart — the same flat en/kr convention as `label`/`kr`.
 * Consumers must render the pair through the bilingual-chrome primitive
 * (`<Bilingual en={item.eyebrow} kr={item.krEyebrow} />`) so the
 * language-display setting applies; never hand-compose "kr · en" strings.
 */
import type { IconName } from '../components/Icon';

export interface NavItem {
  readonly id: NavItemId;
  readonly path: string;
  readonly label: string;
  readonly kr: string;
  /** English eyebrow. Render with `krEyebrow` via `<Bilingual/>`. */
  readonly eyebrow: string;
  /** Korean eyebrow — chrome register (bare nouns, no trailing punctuation). */
  readonly krEyebrow: string;
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
  | 'review-exams'
  | 'review-vocab'
  | 'review-dictionary'
  | 'review-grammar'
  | 'diagnostic'
  | 'images'
  | 'chat'
  | 'uploads';

export const NAV_ITEMS: ReadonlyArray<NavItem> = [
  // ── Primary tabs ────────────────────────────────────────────────────
  {
    id: 'today',
    path: '/',
    label: 'Today',
    kr: '오늘',
    eyebrow: 'Daily plan',
    krEyebrow: '오늘의 계획',
    headerTitle: '오늘 · Today',
    icon: 'home',
  },
  {
    id: 'progress',
    path: '/progress',
    label: 'Progress',
    kr: '성장',
    eyebrow: 'Diagnostic history',
    krEyebrow: '진단 기록',
    headerTitle: '성장 · Progress',
    icon: 'history',
  },
  {
    // REPURPOSED id (P1.1): `review` is now the library index at `/review`.
    // The FSRS vocab-flashcards page that used to own this id/path is
    // `flashcards` at `/learn/vocab` below. P3B (F-043): the tab reads
    // "Library" — the id and the `/review` path are hard route contracts
    // and stay as-is.
    id: 'review',
    path: '/review',
    label: 'Library',
    kr: '자료실',
    eyebrow: 'Vocabulary · grammar · exams · uploads',
    krEyebrow: '단어 · 문법 · 기출 · 업로드',
    headerTitle: '자료실 · Library',
    icon: 'folder',
  },
  {
    id: 'settings',
    path: '/settings',
    label: 'Settings',
    kr: '설정',
    eyebrow: 'Profile · notifications · appearance',
    krEyebrow: '프로필 · 알림 · 화면 표시',
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
    krEyebrow: '모의고사',
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
    krEyebrow: 'TTMIK · 이야기 오디오',
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
    krEyebrow: '단어 카드',
    headerTitle: '단어 카드 · Vocab',
    icon: 'cards',
  },
  {
    id: 'grammar',
    path: '/learn/grammar',
    label: 'Grammar practice',
    kr: '문법',
    eyebrow: 'Production drill',
    krEyebrow: '문형 연습',
    headerTitle: '문법 · Grammar',
    icon: 'grammar',
  },
  {
    id: 'writing',
    path: '/learn/writing',
    label: 'Writing',
    kr: '쓰기',
    eyebrow: 'TOPIK writing grader',
    krEyebrow: 'TOPIK 쓰기 채점',
    headerTitle: '쓰기 · Writing',
    icon: 'pen',
  },
  {
    id: 'hanja',
    path: '/learn/hanja',
    label: 'Hanja',
    kr: '한자',
    // P3b verbage trim — was the flowery "The bones inside the words".
    eyebrow: 'Word roots',
    krEyebrow: '한자 어원',
    headerTitle: '한자 · Hanja',
    icon: 'hanja',
  },
  {
    // U3b (2026-07-08) — the real digitized chapter reader (see
    // `db/docs/U3_READER_DESIGN.md` §U3b), replacing the P1.1 placeholder.
    // NOT at `/reading`: that legacy path is a live redirect to
    // `/learn/listen`.
    id: 'reading',
    path: '/learn/reading',
    label: 'Reading',
    kr: '읽기',
    eyebrow: 'Digitized books',
    krEyebrow: '디지털 도서',
    headerTitle: '읽기 · Reading',
    icon: 'book',
  },
  // ── Secondary routed screens ─────────────────────────────────────────
  {
    id: 'mistakes',
    path: '/review/mistakes',
    label: 'Mistakes',
    kr: '틀린 문제',
    // P3b verbage trim — was "What you missed, in one place".
    eyebrow: 'Missed questions',
    krEyebrow: '틀린 문제 모음',
    headerTitle: '틀린 문제 · Mistakes',
    icon: 'history',
  },
  {
    // F-103 — the dedicated "Past TOPIK exams" library surface: completed
    // sittings + scores, re-enter/retake action. Distinct from `mistakes`
    // (per-item wrong-answer review), which this page links out to.
    //
    // Batch-2 fix-pass SHOULD-FIX 2: this copy previously matched
    // `AttemptsReview`'s (`Topik.tsx`) eyebrow/Korean-heading VERBATIM, even
    // though the two screens behave very differently — `AttemptsReview` is
    // an inert LEARN-side quick check with no navigation, while this page's
    // rows are full Review-library re-enter/retake links. `kr`/`eyebrow`/
    // `krEyebrow` are deliberately reworded here (English "Past exams"
    // heading was already distinct) so a Korean-reading user, or anyone
    // skimming the eyebrow, gets a textual signal these are different
    // screens. `kr` now matches `ReviewLibrary`'s own hardcoded shelf label
    // ("기출 시험", `ReviewLibrary.tsx`'s `SECTIONS` entry) instead of
    // colliding with `AttemptsReview`'s "지난 시험" — reinforcing "this page
    // IS the shelf you tapped" rather than reusing the LEARN-side phrase.
    // `AttemptsReview` itself is intentionally untouched (out of scope).
    id: 'review-exams',
    path: '/review/exams',
    label: 'Past exams',
    kr: '기출 시험',
    eyebrow: 'Exam library · re-enter & retake',
    krEyebrow: '기출 자료실 · 재응시',
    headerTitle: '기출 시험 · Past exams',
    icon: 'spark',
  },
  {
    // P1.2 — the old Reference **Vocabulary** tab, now a first-class library
    // page (curated corpus browse + the canonical My-Lists surface).
    id: 'review-vocab',
    path: '/review/vocab',
    label: 'Vocabulary',
    kr: '단어',
    eyebrow: 'Corpus · my lists',
    krEyebrow: '말뭉치 · 내 단어장',
    headerTitle: '단어 · Vocabulary',
    icon: 'cards',
  },
  {
    // P1.2, decision D2 — the KRDICT dictionary stays its OWN page (a
    // lookup corpus, not merged into the vocabulary browse).
    // F-050 (P3B): renamed "Dictionary" → "All Words" — the page is the
    // whole-corpus word browse (KRDICT + a genre lens over the curated
    // corpus), not just a lookup tool. The route/id stay `review-dictionary`
    // (paths are contracts; labels are copy).
    id: 'review-dictionary',
    path: '/review/dictionary',
    label: 'All Words',
    kr: '전체 단어',
    eyebrow: 'KRDICT · 54k entries',
    krEyebrow: 'KRDICT · 표제어 5.4만',
    headerTitle: '전체 단어 · All Words',
    icon: 'search',
  },
  {
    // P1.2, decision D3 — the SINGLE grammar browse (the old Reference
    // Grammar tab + the LEARN Grammar screen's retired list tab).
    id: 'review-grammar',
    path: '/review/grammar',
    label: 'Grammar',
    kr: '문법',
    eyebrow: 'KGIU patterns',
    krEyebrow: 'KGIU 문형',
    headerTitle: '문법 · Grammar',
    icon: 'grammar',
  },
  {
    id: 'diagnostic',
    path: '/diagnostic',
    label: 'Diagnostic',
    kr: '진단',
    eyebrow: 'Skills check',
    krEyebrow: '실력 점검',
    headerTitle: '진단 · Diagnostic',
    icon: 'compass',
  },
  {
    id: 'images',
    path: '/images',
    label: 'Images',
    kr: '이미지',
    // P3b verbage trim — was "OCR · mine real-world Korean".
    eyebrow: 'OCR · real-world Korean',
    krEyebrow: 'OCR · 실생활 한국어',
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
    krEyebrow: '튜터 대화',
    headerTitle: '대화 · Chat',
    icon: 'chat',
  },
  {
    // U1b (book-upload feature) — reached from Review → Uploads (the
    // library row; F-039 moved the area out of Settings). Tapping a row
    // opens the page-image viewer at `/uploads/:id` (that route is NOT its
    // own NavItem — it's a dynamic detail view, same convention as Images'
    // capture view). Comment re-homed per F-100.
    id: 'uploads',
    path: '/uploads',
    label: 'Uploads',
    kr: '업로드',
    eyebrow: 'Your book PDFs',
    krEyebrow: '내 책 PDF',
    headerTitle: '업로드 · Uploads',
    icon: 'upload',
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
  'review-exams',
  'review-vocab',
  'review-dictionary',
  'review-grammar',
  'diagnostic',
  'images',
  'chat',
  'uploads',
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

/**
 * Best-effort human label for an app pathname (F-127: the global "!"
 * feedback FAB, `FeedbackFab.tsx`, stamps the current page's name onto a
 * filed ticket's `source_page`; `Tickets.tsx` re-derives the SAME label at
 * render time from the stored path — see that module's header for why the
 * path, not the label, is the thing persisted).
 *
 * Matching order:
 *   1. Exact `path` match against `NAV_ITEMS` (case-insensitive — React
 *      Router matches routes case-insensitively, so a hand-typed `/Chat`
 *      still renders the real screen; this must agree).
 *   2. Longest-prefix, segment-boundary match (mirrors ChatFab's
 *      `isHiddenPath` convention) — covers dynamic/nested routes with no
 *      manifest entry of their own, e.g. `/uploads/42` → the `uploads`
 *      item's "Uploads" (its detail view is not its own NavItem).
 *   3. Fallback: the raw pathname, so an unmapped route (or `/tickets`
 *      itself, which the FAB never fires from) still reads as SOMETHING
 *      rather than a blank label.
 */
export function pageNameForPath(pathname: string): string {
  const path = pathname.toLowerCase();

  const exact = NAV_ITEMS.find((it) => it.path.toLowerCase() === path);
  if (exact) return exact.label;

  let best: NavItem | null = null;
  for (const it of NAV_ITEMS) {
    const p = it.path.toLowerCase();
    // '/' would prefix-match every path via `${p}/`; it's already covered
    // by the exact-match branch above, so skip it here rather than let it
    // win a "longest prefix" comparison it was never a real candidate for.
    if (p !== '/' && path.startsWith(`${p}/`)) {
      if (best === null || p.length > best.path.length) best = it;
    }
  }
  return best?.label ?? pathname;
}
