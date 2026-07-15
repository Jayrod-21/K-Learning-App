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

/**
 * Hues the honeycomb color map uses — the app's 6 skills + TOPIK's own
 * dedicated "assessment" hue (F-189 fix-pass round 4, REVIEW_r4-colors.md
 * BLOCKER-2). `vermilion` itself is deliberately NOT in this list anymore:
 * it is the runtime ACCENT-PRESET token (re-pointed by `[data-accent]`),
 * no longer used for any of the 7 LEARN-sub-page tiles — Grammar reads the
 * new fixed `crimson` token instead (see index.css's `--crimson` doc
 * comment), and TOPIK reads the new fixed `stone` token. `--vermilion`'s
 * own ink-on-fill contrast is covered separately by the accent-preset
 * reasoning documented at its definition site in index.css. */
const HUES = [
  'indigo',
  'violet',
  'ochre',
  'cyan',
  'moss',
  'crimson',
  'stone',
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

describe('secondary text contrast (--paper-mute, WCAG AA)', () => {
  // --paper-mute carries small secondary/meta/eyebrow text app-wide, so it
  // must clear 4.5:1 on EVERY surface token it can sit on, in both themes.
  const themes: ReadonlyArray<[string, Map<string, string>]> = [
    ['light (:root)', tokenBlock(LIGHT_SEL)],
    ['dark ([data-theme="dark"])', tokenBlock(DARK_SEL)],
  ];
  const SURFACES = ['ink', 'ink-1', 'ink-2', 'ink-3'] as const;

  for (const [label, own] of themes) {
    const vars = new Map([...tokenBlock(LIGHT_SEL), ...own]);

    for (const surface of SURFACES) {
      it(`${label}: --paper-mute on --${surface} >= 4.5:1`, () => {
        const mute = resolve(vars, 'paper-mute');
        const host = resolve(vars, surface);
        expect(contrast(mute, host)).toBeGreaterThanOrEqual(4.5);
      });
    }

    it(`${label}: --paper-mute stays visually muted (weaker than --paper-dim)`, () => {
      const card = resolve(vars, 'ink-1');
      const mute = contrast(resolve(vars, 'paper-mute'), card);
      const dim = contrast(resolve(vars, 'paper-dim'), card);
      expect(dim).toBeGreaterThan(mute);
    });
  }
});

describe('secondary text contrast (--paper-dim, WCAG AA)', () => {
  // SF3 (REVIEW_batch1-fidelity.md): a new Wave-2 caption
  // (`.km-progress__trendnote`, Progress.css) originally reused
  // `--paper-faint` at 12px — measured at ~2.0:1 (light) / ~3.2:1 (dark) on
  // this page's card surfaces, well under the 4.5:1 AA floor for real body
  // text (as opposed to `--paper-faint`'s OTHER, decorative-only uses —
  // axis ticks, threshold lines, hairline borders — which only need the
  // graphical-object bar, 3:1). The fix moved that caption to `--paper-dim`,
  // the token every other caption on Progress already uses. This guards
  // that choice the same way the `--paper-mute` block above guards its own
  // token, so a future re-tint can't silently regress either pairing.
  const themes: ReadonlyArray<[string, Map<string, string>]> = [
    ['light (:root)', tokenBlock(LIGHT_SEL)],
    ['dark ([data-theme="dark"])', tokenBlock(DARK_SEL)],
  ];
  const SURFACES = ['ink', 'ink-1', 'ink-2', 'ink-3'] as const;

  for (const [label, own] of themes) {
    const vars = new Map([...tokenBlock(LIGHT_SEL), ...own]);

    for (const surface of SURFACES) {
      it(`${label}: --paper-dim on --${surface} >= 4.5:1`, () => {
        const dim = resolve(vars, 'paper-dim');
        const host = resolve(vars, surface);
        expect(contrast(dim, host)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe('km-tone fill contrast (--on-vermilion text on --km-tone fills, WCAG AA)', () => {
  // CityCard's Night signboard body, DancheongRail's Night edge glow, and
  // SubwayProgress's fill/station dots all resolve `--km-tone` (the shared
  // accent/blue/mint/ochre/cyan/violet/plain mapping in seoul-devices.css).
  // SealStamp's
  // milestone variant is the one consumer that puts TEXT directly on that
  // fill (`background: var(--km-tone); color: var(--on-vermilion);` —
  // index.css .km-seal--milestone), so that's the pairing to guard.
  //
  // `plain` is excluded on purpose: its milestone treatment is
  // `background: transparent; color: var(--paper); border: ...` (index.css
  // .km-seal--milestone.km-tone--plain) — not a text-on-fill pairing at
  // all, so there is nothing for THIS check to assert about it.
  //
  // blue -> dan-cobalt (Day) / neon-blue (Night); mint -> dan-jade (Day) /
  // neon-mint (Night). `accent` itself already tracks --vermilion, which is
  // covered by the existing accent-preset contrast reasoning (index.css
  // comments at the accent-preset block) — not re-derived here.
  //
  // F-189 adds cyan (Reading) and violet (Writing) as two more fixed
  // `--km-tone` mappings (styles/seoul-devices.css) — unlike blue/mint,
  // `.km-tone--cyan`/`.km-tone--violet` read `--cyan`/`--violet` directly
  // (those tokens are ALREADY theme-branched in index.css), so both the Day
  // and Night combos below resolve straight off the SAME token name.
  //
  // F-189 fix-pass round 4 (REVIEW_r4-colors.md): `crimson` (Grammar) and
  // `stone` (TOPIK) complete the set the same way — both fixed, both
  // already theme-branched at their definition site, so one declaration in
  // seoul-devices.css resolves correctly in both themes and one combo
  // entry here covers both.
  const DAY_COMBOS = [
    ['blue', 'dan-cobalt'],
    ['mint', 'dan-jade'],
    ['cyan', 'cyan'],
    ['violet', 'violet'],
    ['crimson', 'crimson'],
    ['stone', 'stone'],
  ] as const;
  const NIGHT_COMBOS = [
    ['blue', 'neon-blue'],
    ['mint', 'neon-mint'],
    ['cyan', 'cyan'],
    ['violet', 'violet'],
    ['crimson', 'crimson'],
    ['stone', 'stone'],
  ] as const;

  for (const [tone, fillToken] of DAY_COMBOS) {
    it(`light (:root): --on-vermilion on --${fillToken} (tone="${tone}") >= 4.5:1`, () => {
      const vars = tokenBlock(LIGHT_SEL);
      const text = resolve(vars, 'on-vermilion');
      const fill = resolve(vars, fillToken);
      expect(contrast(text, fill)).toBeGreaterThanOrEqual(4.5);
    });
  }

  for (const [tone, fillToken] of NIGHT_COMBOS) {
    it(`dark ([data-theme="dark"]): --on-vermilion on --${fillToken} (tone="${tone}") >= 4.5:1`, () => {
      const vars = new Map([...tokenBlock(LIGHT_SEL), ...tokenBlock(DARK_SEL)]);
      const text = resolve(vars, 'on-vermilion');
      const fill = resolve(vars, fillToken);
      expect(contrast(text, fill)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('focus ring contrast (--focus-ring vs page bg, WCAG 1.4.11)', () => {
  // The `.focusring` outline is a non-text UI indicator — it needs >= 3:1
  // against the raw page background (--ink) for every theme x accent combo.
  // Merge order mirrors the cascade: light base -> dark base (1-attr blocks,
  // dark first in the sheet) -> light accent -> dark+accent (2 attrs win).
  const accentSel = (a: string): string => String.raw`\[data-accent="${a}"\]`;
  const darkAccentSel = (a: string): string =>
    String.raw`\[data-theme="dark"\]${accentSel(a)}`;
  const ACCENTS = ['coral', 'blue', 'mint'] as const;

  for (const accent of ACCENTS) {
    for (const dark of [false, true]) {
      const label = `${dark ? 'dark' : 'light'} + ${accent}`;
      it(`${label}: --focus-ring vs --ink >= 3:1`, () => {
        const vars = new Map([
          ...tokenBlock(LIGHT_SEL),
          ...(dark ? tokenBlock(DARK_SEL) : []),
          ...tokenBlock(accentSel(accent)),
          ...(dark ? tokenBlock(darkAccentSel(accent)) : []),
        ]);
        const ring = resolve(vars, 'focus-ring');
        const bg = resolve(vars, 'ink');
        expect(contrast(ring, bg)).toBeGreaterThanOrEqual(3);
      });
    }
  }
});
