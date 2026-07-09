/**
 * WCAG contrast guard for the category token twins.
 *
 * The LearnMenu honeycomb (and the chips/labels across the redesign) render
 * TEXT in each category's `--<hue>-ink` twin on top of its `--<hue>-soft`
 * chip background. That pairing must stay AA-safe (>= 4.5:1 for normal-size
 * text) in BOTH themes — the raw bright hues intentionally fail on the soft
 * chips, which is exactly why the ink twins exist. This test parses the
 * token blocks straight out of `index.css` so a future re-tint can't
 * silently regress the pairing.
 *
 * Scope: the base light (`:root`) and dark (`[data-theme="dark"]`) blocks.
 * The runtime accent variants (`[data-accent=...]`) re-point --vermilion-*
 * onto translucent softs whose effective color depends on what's underneath,
 * so a flat-ratio check doesn't apply to them.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Vitest's jsdom env rewrites `import.meta.url` to an http: URL, so resolve
// from the project root instead (vitest runs with root = client/).
const CSS = readFileSync(join(process.cwd(), 'src/styles/index.css'), 'utf8');

/** Hues the honeycomb color map uses (all six category families). */
const HUES = [
  'indigo',
  'violet',
  'ochre',
  'cyan',
  'moss',
  'vermilion',
] as const;

/** Selector patterns (regex source) for the two base token blocks. */
const LIGHT_SEL = String.raw`:root\s*,\s*\[data-theme="light"\]`;
const DARK_SEL = String.raw`\[data-theme="dark"\]`;

/**
 * Collect `--name: value;` declarations from every block whose selector list
 * matches `selRe` exactly (custom-property blocks contain no nested braces).
 * Later declarations win, mirroring the cascade within equal specificity.
 */
function tokenBlock(selRe: string): Map<string, string> {
  const blockRe = new RegExp(`(?:^|\\n)${selRe}\\s*\\{([^}]*)\\}`, 'g');
  const vars = new Map<string, string>();
  for (const block of CSS.matchAll(blockRe)) {
    const body = block[1] ?? '';
    for (const decl of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
      vars.set(decl[1] as string, (decl[2] as string).trim());
    }
  }
  return vars;
}

/** Resolve `var(--x)` chains (the dark block aliases some inks to hues). */
function resolve(vars: Map<string, string>, name: string, depth = 0): string {
  if (depth > 8) throw new Error(`var chain too deep at --${name}`);
  const raw = vars.get(name);
  if (raw === undefined) throw new Error(`missing token --${name}`);
  const ref = /^var\(--([\w-]+)\)$/.exec(raw);
  return ref ? resolve(vars, ref[1] as string, depth + 1) : raw;
}

function srgbChannel(hex255: number): number {
  const c = hex255 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`expected 6-digit hex color, got "${hex}"`);
  const n = parseInt(m[1] as string, 16);
  return (
    0.2126 * srgbChannel((n >> 16) & 0xff) +
    0.7152 * srgbChannel((n >> 8) & 0xff) +
    0.0722 * srgbChannel(n & 0xff)
  );
}

/** WCAG 2.x contrast ratio between two 6-digit hex colors. */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe('category token contrast (ink on soft, WCAG AA)', () => {
  const themes: ReadonlyArray<[string, Map<string, string>]> = [
    ['light (:root)', tokenBlock(LIGHT_SEL)],
    ['dark ([data-theme="dark"])', tokenBlock(DARK_SEL)],
  ];

  for (const [label, own] of themes) {
    // Theme declarations overlay the light base (CSS cascade) — for the
    // light theme this merge is an identity.
    const vars = new Map([...tokenBlock(LIGHT_SEL), ...own]);

    for (const hue of HUES) {
      it(`${label}: --${hue}-ink on --${hue}-soft >= 4.5:1`, () => {
        const ink = resolve(vars, `${hue}-ink`);
        const soft = resolve(vars, `${hue}-soft`);
        expect(contrast(ink, soft)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
