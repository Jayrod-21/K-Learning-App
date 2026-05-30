/**
 * Icon registry — line-stroke SVGs with `currentColor` strokes, sized in px.
 *
 * Paths are copied directly from
 * `Claude Design/design_handoff_korean_master/shared.jsx → Icon()` so the
 * visual set matches the prototype byte-for-byte. Every consumer renders as
 * `<Icon name="..." size={n} />`; we never reach for a third-party icon
 * library because the prototype's stroke weight (1.6px) and corner rounding
 * are part of the aesthetic.
 */
import type { JSX } from 'react';

export type IconName =
  | 'arrow-right'
  | 'bell'
  | 'book'
  | 'camera'
  | 'cards'
  | 'chat'
  | 'check'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-up'
  | 'close'
  | 'compass'
  | 'drag'
  | 'folder'
  | 'grammar'
  | 'hanja'
  | 'headphones'
  | 'history'
  | 'home'
  | 'image'
  | 'info'
  | 'list'
  | 'mic'
  | 'more'
  | 'palette'
  | 'pause'
  | 'pen'
  | 'plus'
  | 'play'
  | 'search'
  | 'send'
  | 'settings'
  | 'spark'
  | 'theme'
  | 'timer'
  | 'translate'
  | 'trash'
  | 'upload'
  | 'user';

export interface IconProps {
  name: IconName;
  /** Pixel size for both width and height. */
  size?: number;
  /** Stroke width in px. The design uses 1.6 by default. */
  stroke?: number;
  /** Optional class name (passes through to the `<svg>`). */
  className?: string;
  /** Accessible label. Omit to mark as decorative (`aria-hidden`). */
  title?: string;
}

type SvgChildren = JSX.Element | ReadonlyArray<JSX.Element>;

const PATHS: Record<IconName, SvgChildren> = {
  'arrow-right': <path d="M5 12h14M13 5l7 7-7 7" />,
  bell: (
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  ),
  book: [
    <path key="0" d="M4 4h11a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4z" />,
    <path key="1" d="M4 16a4 4 0 0 1 4-4h11" />,
  ],
  camera: [
    <path key="0" d="M3 8h3l2-3h8l2 3h3v12H3z" />,
    <circle key="1" cx="12" cy="13" r="4" />,
  ],
  cards: [
    <rect key="0" x="3" y="5" width="14" height="14" rx="2" />,
    <path key="1" d="M7 3h14v14" />,
  ],
  chat: <path d="M21 12a8 8 0 1 1-3.6-6.6L21 4l-1 4.6A8 8 0 0 1 21 12z" />,
  check: <path d="M5 12l5 5L20 7" />,
  'chevron-down': <path d="M6 9l6 6 6-6" />,
  'chevron-right': <path d="M9 6l6 6-6 6" />,
  'chevron-up': <path d="M6 15l6-6 6 6" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  compass: [
    <circle key="0" cx="12" cy="12" r="9" />,
    <path key="1" d="M15 9l-2 6-6 2 2-6z" />,
  ],
  drag: (
    <>
      <circle cx="9" cy="6" r="1" fill="currentColor" />
      <circle cx="9" cy="12" r="1" fill="currentColor" />
      <circle cx="9" cy="18" r="1" fill="currentColor" />
      <circle cx="15" cy="6" r="1" fill="currentColor" />
      <circle cx="15" cy="12" r="1" fill="currentColor" />
      <circle cx="15" cy="18" r="1" fill="currentColor" />
    </>
  ),
  folder: (
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  ),
  grammar: <path d="M4 6h16M4 12h10M4 18h7" />,
  hanja: [
    <rect key="0" x="4" y="4" width="16" height="16" rx="1" />,
    <path key="1" d="M4 12h16M12 4v16" />,
  ],
  headphones: [
    <path key="0" d="M4 18v-6a8 8 0 0 1 16 0v6" />,
    <path
      key="1"
      d="M4 18a2 2 0 0 0 2 2h2v-6H6a2 2 0 0 0-2 2zM20 18a2 2 0 0 1-2 2h-2v-6h2a2 2 0 0 1 2 2z"
    />,
  ],
  history: [
    <path key="0" d="M3 12a9 9 0 1 0 3-6.7" />,
    <path key="1" d="M3 4v5h5" />,
    <path key="2" d="M12 7v5l3 2" />,
  ],
  home: (
    <path d="M3 11l9-7 9 7v9a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z" />
  ),
  image: [
    <rect key="0" x="3" y="4" width="18" height="16" rx="2" />,
    <circle key="1" cx="9" cy="10" r="1.5" />,
    <path key="2" d="M3 17l5-5 4 4 3-3 6 6" />,
  ],
  info: [
    <circle key="0" cx="12" cy="12" r="9" />,
    <path key="1" d="M12 8h.01M11 12h1v5h1" />,
  ],
  list: <path d="M4 6h16M4 12h16M4 18h10" />,
  mic: [
    <rect key="0" x="9" y="3" width="6" height="12" rx="3" />,
    <path key="1" d="M5 11a7 7 0 0 0 14 0M12 18v3" />,
  ],
  more: (
    <>
      <circle cx="6" cy="12" r="1.4" fill="currentColor" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
      <circle cx="18" cy="12" r="1.4" fill="currentColor" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3a9 9 0 0 0 0 18 2 2 0 0 0 0-4 1.5 1.5 0 0 1 0-3h3a5 5 0 0 0 5-5c0-3-3.5-6-8-6z" />
      <circle cx="7.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  pause: <path d="M7 4v16M17 4v16" />,
  pen: [
    <path key="0" d="M12 20h9" />,
    <path key="1" d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />,
  ],
  play: <path d="M6 4l14 8-14 8z" fill="currentColor" stroke="none" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: [
    <circle key="0" cx="11" cy="11" r="7" />,
    <path key="1" d="M21 21l-4-4" />,
  ],
  send: <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />,
  settings: [
    <circle key="0" cx="12" cy="12" r="3" />,
    <path
      key="1"
      d="M12 2v3M12 19v3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M2 12h3M19 12h3M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12"
    />,
  ],
  spark: (
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6" />
  ),
  theme: <path d="M12 3a9 9 0 1 0 9 9c-2.5 0-9-1-9-9z" />,
  timer: [
    <circle key="0" cx="12" cy="13" r="8" />,
    <path key="1" d="M12 9v4l3 2M9 2h6" />,
  ],
  translate: (
    <path d="M3 5h12M9 3v2M11 5c0 5-7 9-7 9M5 9c0 0 4 4 8 4M14 21l4-9 4 9M16 16h4" />
  ),
  trash: (
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" />
  ),
  upload: <path d="M12 16V4M5 11l7-7 7 7M5 20h14" />,
  user: [
    <circle key="0" cx="12" cy="8" r="4" />,
    <path key="1" d="M4 21a8 8 0 0 1 16 0" />,
  ],
};

export function Icon({
  name,
  size = 18,
  stroke = 1.6,
  className,
  title,
}: IconProps): JSX.Element {
  const decorative = title === undefined;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      // For decorative icons, `aria-hidden` alone is the WAI-ARIA-recommended
      // idiom — `role="presentation"` is redundant once the element is
      // already hidden, and some screen-reader corner cases reject
      // `presentation` on `<svg>`. Keep `role="img"` (+ `<title>`) when the
      // icon carries meaning.
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : title}
      focusable={false}
    >
      {decorative ? null : <title>{title}</title>}
      {PATHS[name]}
    </svg>
  );
}
