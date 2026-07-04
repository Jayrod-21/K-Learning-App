/**
 * Navigation manifest — the single source of truth for the app's screens and
 * how they appear in the bottom nav and More sheet.
 *
 * `path` is the React Router route. `kr` is the Korean label that appears as
 * a sublabel on the More sheet rows. `icon` is a key into the `<Icon/>`
 * registry. `headerTitle` is the serif Korean title shown by `ScreenStub` /
 * Pass 2's `Topbar` — it includes the English suffix per design header
 * pattern (e.g. `복습 · Review`).
 *
 * Order in `NAV_ITEMS` is the rendering order in the More sheet.
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
  | 'today'
  | 'topik'
  | 'reading'
  | 'review'
  | 'diagnostic'
  | 'grammar'
  | 'writing'
  | 'hanja'
  | 'images'
  | 'chat'
  | 'reference'
  | 'settings'
  | 'progress';

export const NAV_ITEMS: ReadonlyArray<NavItem> = [
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
    id: 'topik',
    path: '/topik',
    label: 'TOPIK',
    kr: '모의',
    eyebrow: 'Mock test',
    headerTitle: '모의 · TOPIK',
    icon: 'spark',
  },
  {
    id: 'reading',
    path: '/reading',
    label: 'Read',
    kr: '읽기',
    eyebrow: 'Passage',
    headerTitle: '읽기 · Read',
    icon: 'book',
  },
  {
    id: 'review',
    path: '/review',
    label: 'Review',
    kr: '복습',
    eyebrow: 'Flashcards',
    headerTitle: '복습 · Review',
    icon: 'cards',
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
    id: 'grammar',
    path: '/grammar',
    label: 'Grammar',
    kr: '문법',
    eyebrow: 'Production drill',
    headerTitle: '문법 · Grammar',
    icon: 'grammar',
  },
  {
    id: 'writing',
    path: '/writing',
    label: 'Writing',
    kr: '쓰기',
    eyebrow: 'TOPIK writing grader',
    headerTitle: '쓰기 · Writing',
    icon: 'pen',
  },
  {
    id: 'hanja',
    path: '/hanja',
    label: 'Hanja',
    kr: '한자',
    eyebrow: 'The bones inside the words',
    headerTitle: '한자 · Hanja',
    icon: 'hanja',
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
    id: 'chat',
    path: '/chat',
    label: 'Chat',
    kr: '대화',
    eyebrow: 'Tutor conversation',
    headerTitle: '대화 · Chat',
    icon: 'chat',
  },
  {
    id: 'reference',
    path: '/reference',
    label: 'Reference',
    kr: '참고',
    eyebrow: 'Lookup',
    headerTitle: '참고 · Reference',
    icon: 'search',
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
  // F-010: appended at the end (not slotted next to Diagnostic) so the
  // change stays a pure append — parallel work also touches this manifest.
  {
    id: 'progress',
    path: '/progress',
    label: 'Progress',
    kr: '성장',
    eyebrow: 'Diagnostic history',
    headerTitle: '성장 · Progress',
    icon: 'history',
  },
];

// Note: the `as const` is load-bearing — it narrows `typeof X[number]` to a
// literal-string union so the exhaustiveness check below can compare the
// arrays to `NavItemId`. A `ReadonlyArray<NavItemId>` annotation would widen
// the array element type back to `NavItemId` and defeat the check.
export const PRIMARY_TAB_IDS = [
  'today',
  'topik',
  'reading',
  'review',
] as const satisfies ReadonlyArray<NavItemId>;

export const MORE_TAB_IDS = [
  'hanja',
  'images',
  'diagnostic',
  'grammar',
  'writing',
  'chat',
  'reference',
  'settings',
  'progress',
] as const satisfies ReadonlyArray<NavItemId>;

/**
 * Compile-time guarantee: every `NavItemId` is in exactly one of the two
 * arrays above. If a future engineer adds a new union member and forgets
 * to place it, `_MissingFromTabs` widens past `never` and the `extends
 * never ? true : never` const below resolves to `never` — tsc fails the
 * build with a useful error pointing here. Symmetrically, an id that
 * exists in an array but not the union flags via `_ExtraInTabs`.
 *
 * The check is structural-only — erased at runtime under
 * `erasableSyntaxOnly`. The `void` references keep `noUnusedLocals` happy.
 */
type _PrimaryOrMoreId =
  | (typeof PRIMARY_TAB_IDS)[number]
  | (typeof MORE_TAB_IDS)[number];
type _MissingFromTabs = Exclude<NavItemId, _PrimaryOrMoreId>;
type _ExtraInTabs = Exclude<_PrimaryOrMoreId, NavItemId>;
const _navIdExhaustivenessMissing: _MissingFromTabs extends never ? true : never =
  true;
const _navIdExhaustivenessExtra: _ExtraInTabs extends never ? true : never =
  true;
void _navIdExhaustivenessMissing;
void _navIdExhaustivenessExtra;

/**
 * Which integration-plan pass owns the build-out of a given screen. Pinned
 * to the 9-pass plan (`CLAUDE_DESIGN_INTEGRATION_PLAN.md`); update both
 * here and the plan together if a pass is added.
 */
export type PassNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

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
