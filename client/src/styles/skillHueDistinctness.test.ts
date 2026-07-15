/**
 * Categorical-distinctness guard for the 7 skill hues (F-189 fix-pass
 * round 4, REVIEW_r4-colors.md).
 *
 * The prior batch's two BLOCKERs — Reading(cyan)/Listening(moss) a
 * near-collision in Day (ΔE76 ≈ 21.5), and Grammar/TOPIK rendering as the
 * literal same CSS class — both slipped through review because nothing
 * ever computed the actual perceptual distance between the honeycomb's
 * hues; the old tests only checked ink-on-soft CONTRAST (readability), not
 * hue-to-hue DISTINCTNESS (can a user tell two tiles apart at a glance).
 * This file is the regression guard that would have caught both: it
 * parses the literal hex values back out of `index.css` (not hand-copied
 * constants that could drift from the real tokens) and computes CIE76 ΔE
 * for every pairwise combination of the app's 6 skill hues + TOPIK's
 * dedicated hue, in both themes, asserting each clears a ~28 floor —
 * the threshold conventional categorical palettes use so adjacent swatches
 * read as different colors, not shades of the same one.
 *
 * ΔE76 (not the more modern ΔE2000) is intentionally simple/conservative
 * here: it is monotonically related to ΔE2000 for well-separated colors
 * and is trivial to re-derive by hand for a future re-tint, which matters
 * more for a guard test than sub-JND precision.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_COLOR } from '../lib/skill-colors';

const CSS = readFileSync(join(process.cwd(), 'src/styles/index.css'), 'utf8');

const LIGHT_SEL = String.raw`:root\s*,\s*\[data-theme="light"\]`;
const DARK_SEL = String.raw`\[data-theme="dark"\]`;

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

function resolve(vars: Map<string, string>, name: string, depth = 0): string {
  if (depth > 8) throw new Error(`var chain too deep at --${name}`);
  const raw = vars.get(name);
  if (raw === undefined) throw new Error(`missing token --${name}`);
  const ref = /^var\(--([\w-]+)\)$/.exec(raw);
  return ref ? resolve(vars, ref[1] as string, depth + 1) : raw;
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`expected 6-digit hex color, got "${hex}"`);
  const n = parseInt(m[1] as string, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** D65 white point + sRGB->XYZ->CIELAB, standard reference formulas. */
function hexToLab(hex: string): [number, number, number] {
  const [r8, g8, b8] = hexToRgb(hex);
  const r = srgbToLinear(r8);
  const g = srgbToLinear(g8);
  const b = srgbToLinear(b8);
  const x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = r * 0.0193339 + g * 0.119192 + b * 0.9503041;
  const [xn, yn, zn] = [0.95047, 1.0, 1.08883];
  const f = (t: number): number => {
    const d = 6 / 29;
    return t > d ** 3 ? Math.cbrt(t) : t / (3 * d * d) + 4 / 29;
  };
  const fx = f(x / xn);
  const fy = f(y / yn);
  const fz = f(z / zn);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 ΔE — Euclidean distance in CIELAB space. */
function deltaE76(hexA: string, hexB: string): number {
  const [l1, a1, b1] = hexToLab(hexA);
  const [l2, a2, b2] = hexToLab(hexB);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}

/** The categorical-distinctness floor this batch's fix targets (see the
 *  module doc comment above) — conventional categorical palettes use
 *  ~25-30 for adjacent swatches; this project's fix-pass target is ~28. */
const DISTINCTNESS_FLOOR = 28;

/** The 7 skill hexHue tokens (6 skills + TOPIK), deduped and de-referenced
 *  through `SKILL_COLOR` so this test can never drift from the actual
 *  skill→hue assignment LearnMenu renders. */
const SKILL_HUES = Array.from(
  new Set(Object.values(SKILL_COLOR).map((c) => c.hexHue)),
).sort();

describe('skill hue pairwise distinctness (CIE76 ΔE76, F-189 fix-pass round 4)', () => {
  it('SKILL_COLOR names exactly 7 distinct hexHue tokens (6 skills + TOPIK)', () => {
    expect(SKILL_HUES).toHaveLength(7);
  });

  const themes: ReadonlyArray<[string, Map<string, string>]> = [
    ['Day (:root)', tokenBlock(LIGHT_SEL)],
    ['Night ([data-theme="dark"])', new Map([...tokenBlock(LIGHT_SEL), ...tokenBlock(DARK_SEL)])],
  ];

  for (const [label, vars] of themes) {
    const resolved = new Map(SKILL_HUES.map((hue) => [hue, resolve(vars, hue)]));

    for (let i = 0; i < SKILL_HUES.length; i += 1) {
      for (let j = i + 1; j < SKILL_HUES.length; j += 1) {
        const hueA = SKILL_HUES[i];
        const hueB = SKILL_HUES[j];
        if (hueA === undefined || hueB === undefined) continue;
        it(`${label}: --${hueA} vs --${hueB} clears ΔE76 >= ${DISTINCTNESS_FLOOR}`, () => {
          const hexA = resolved.get(hueA);
          const hexB = resolved.get(hueB);
          expect(hexA).toBeDefined();
          expect(hexB).toBeDefined();
          const de = deltaE76(hexA as string, hexB as string);
          expect(de).toBeGreaterThanOrEqual(DISTINCTNESS_FLOOR);
        });
      }
    }
  }
});

describe('skill→color single source of truth (Today + LearnMenu resolve to the same token)', () => {
  // SHOULD-FIX-6 / NIT-7 (REVIEW_r4-colors.md): LearnMenu's honeycomb reads
  // `--<hexHue>` directly; Today's tile carousels read it indirectly via
  // `.km-tone--<tone>`'s `--km-tone` (seoul-devices.css). Both now source
  // their prop values from the SAME `lib/skill-colors.ts` object — this
  // test proves that structural sharing actually resolves to the same
  // final color in both themes, not just the same object reference.
  const SEOUL_DEVICES_CSS = readFileSync(
    join(process.cwd(), 'src/styles/seoul-devices.css'),
    'utf8',
  );

  /**
   * Parse every `[data-theme="dark"]? .km-tone--<name> { --km-tone: <expr>; }`
   * rule for one `tone` name, in file order. There is either exactly one
   * rule (the light declaration, already theme-branched at its own
   * definition site — e.g. `cyan`/`violet`/`crimson`/`stone`) or exactly
   * two (a light rule followed later in the file by an explicit
   * `[data-theme="dark"]` override — e.g. `blue`/`mint`/`ochre`).
   */
  function kmToneExprs(tone: string): { light: string; dark: string | null } {
    const re = new RegExp(
      String.raw`(\[data-theme="dark"\]\s*)?\.km-tone--${tone}\s*\{\s*--km-tone:\s*([^;]+);`,
      'g',
    );
    let light: string | null = null;
    let dark: string | null = null;
    for (const m of SEOUL_DEVICES_CSS.matchAll(re)) {
      const isDark = m[1] !== undefined;
      const expr = m[2] as string;
      if (isDark) dark = expr;
      else if (light === null) light = expr;
    }
    if (light === null) {
      throw new Error(`no .km-tone--${tone} rule found in seoul-devices.css`);
    }
    return { light, dark };
  }

  function kmToneExpr(tone: string, isDarkTheme: boolean): string {
    const { light, dark } = kmToneExprs(tone);
    return isDarkTheme ? (dark ?? light) : light;
  }

  function resolveExpr(vars: Map<string, string>, expr: string): string {
    const ref = /^var\(--([\w-]+)\)$/.exec(expr);
    return ref ? resolve(vars, ref[1] as string) : expr;
  }

  const themes: ReadonlyArray<[string, Map<string, string>, boolean]> = [
    ['Day', tokenBlock(LIGHT_SEL), false],
    ['Night', new Map([...tokenBlock(LIGHT_SEL), ...tokenBlock(DARK_SEL)]), true],
  ];

  for (const [label, vars, dark] of themes) {
    for (const [skill, color] of Object.entries(SKILL_COLOR)) {
      it(`${label}: ${skill} — LearnMenu's --${color.hexHue} matches Today's tone="${color.tone}"`, () => {
        const learnMenuHex = resolve(vars, color.hexHue);
        const todayExpr = kmToneExpr(color.tone, dark);
        const todayHex = resolveExpr(vars, todayExpr);
        expect(todayHex).toBe(learnMenuHex);
      });
    }
  }
});
