/**
 * px→rem font-size guard (F-086 / B-036).
 *
 * The Settings text-size control (S/M/L, F-025) re-points the ROOT font-size
 * via `:root[data-text-size]` in `index.css`. That only moves text sized in
 * rem (or inherited) — a `font-size` pinned in px ignores the root scale and
 * silently opts the setting back out to "does nothing" (the exact bug this
 * ticket fixes). This test sweeps the client's CSS + TSX for regressions:
 *
 *   1. No `font-size: <number>px` remains in any swept CSS file (source-level
 *      regex over the actual files on disk, not a mock).
 *   2. No bare-number (unitless, i.e. px) `fontSize:` remains in any TSX
 *      inline style, except the explicitly documented intentional-fixed
 *      exceptions (dev-only chrome / decorative mock-data overlays that must
 *      NOT track user text-size preference).
 *   3. Representative rem values land exactly right (px÷16, no rounding
 *      drift) at a handful of real call sites spanning different original px
 *      sizes and different files, so a future edit that reintroduces px in
 *      one of these exact spots fails loudly instead of silently.
 *   4. Each documented intentional-fixed exception still carries its
 *      "Intentional-fixed" rationale comment, so an exception can't quietly
 *      lose its justification (or its unit) without this test noticing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd(); // vitest root = client/
const SRC = join(ROOT, 'src');

/** Recursively collect every file under `dir` whose name ends in `ext`. No
 * external glob dependency — this is a small, self-contained tree walk. */
function findFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...findFiles(full, ext));
    } else if (name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

/** Every CSS file under src/ — the full swept set (styles + components + pages). */
function cssFiles(): string[] {
  return findFiles(SRC, '.css');
}

/** Every TSX file under src/ — where inline `style={{ fontSize: ... }}` lives. */
function tsxFiles(): string[] {
  return findFiles(SRC, '.tsx');
}

/** `font-size: <number>px` (not inside a var()/clamp() function-call number
 * that isn't immediately after the colon — this matches the exact shape the
 * sweep converted: a literal px value directly assigned to font-size,
 * including the min/max bounds of a `clamp(...)` expression). */
const CSS_PX_FONT_SIZE = /font-size:\s*[0-9]+(?:\.[0-9]+)?px\b/g;
/** clamp() bounds specifically — belt-and-suspenders, since a naive
 * `font-size:\s*Npx` regex does NOT match `font-size: clamp(34px, 5vw, 48px)`
 * (the number isn't immediately after the colon). */
const CSS_CLAMP_PX = /font-size:\s*clamp\([^)]*[0-9]+(?:\.[0-9]+)?px[^)]*\)/g;

describe('font-size px→rem migration (F-086 / B-036)', () => {
  it('no CSS file under src/ has a bare-px font-size declaration', () => {
    const offenders: string[] = [];
    for (const file of cssFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(CSS_PX_FONT_SIZE)) {
        offenders.push(`${file}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no CSS file under src/ has a px-bounded font-size clamp()', () => {
    const offenders: string[] = [];
    for (const file of cssFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(CSS_CLAMP_PX)) {
        offenders.push(`${file}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no TSX inline style has a bare-number fontSize, except the documented intentional-fixed exceptions', () => {
    // Bare JS number (not a string) assigned to fontSize — React renders an
    // unsuffixed number as px, so `fontSize: 14` is exactly the px pin this
    // migration eliminates. A string value (`fontSize: '0.875rem'` or
    // `fontSize: line.size` — a variable, not a literal) does not match.
    const BARE_NUMBER_FONT_SIZE = /fontSize:\s*-?[0-9]+(?:\.[0-9]+)?\s*[,}]/g;

    // Each entry names the file (relative to src/) and exactly how many
    // intentional-fixed occurrences it's allowed to carry, so a NEW bare-px
    // fontSize anywhere else still fails the test.
    const ALLOWED: Record<string, number> = {
      'src/components/MockBadge.tsx': 1, // dev-only aria-hidden seal glyph, fixed 18x18 box
    };

    const offenders: string[] = [];
    for (const file of tsxFiles()) {
      const text = readFileSync(file, 'utf8');
      const matches = [...text.matchAll(BARE_NUMBER_FONT_SIZE)];
      if (matches.length === 0) continue;
      const rel = file.slice(file.indexOf('src/'));
      const allowed = ALLOWED[rel] ?? 0;
      if (matches.length > allowed) {
        offenders.push(
          `${rel}: found ${String(matches.length)} bare-number fontSize occurrence(s), allowed ${String(allowed)} — ${matches.map((m) => m[0]).join(', ')}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('representative rem conversions are exact (px ÷ 16, no rounding drift)', () => {
    const cases: Array<{ file: string; expect: RegExp; label: string }> = [
      {
        // 16px @ md root — the "no visual change at md" baseline case.
        file: 'src/pages/Chat.css',
        expect: /\.km-chat__text\s*\{\s*font-size:\s*1rem;/,
        label: '16px -> 1rem',
      },
      {
        // 12px, a very common small-copy size across the sheet.
        file: 'src/styles/index.css',
        expect: /\.km-btn--sm\s*\{[^}]*font-size:\s*0\.75rem;/,
        label: '12px -> 0.75rem',
      },
      {
        // 14px, another very common size.
        file: 'src/styles/index.css',
        expect: /\.km-btn--md\s*\{[^}]*font-size:\s*0\.875rem;/,
        label: '14px -> 0.875rem',
      },
      {
        // Non-terminating-in-a-round-number case: 22px -> 1.375rem.
        file: 'src/styles/index.css',
        expect: /\.km-mock__score-unit\s*\{[^}]*font-size:\s*1\.375rem;/,
        label: '22px -> 1.375rem',
      },
      {
        // A `clamp()` px-bounded declaration converted on both bounds,
        // vw component left untouched.
        file: 'src/styles/index.css',
        expect: /\.km-login__title\s*\{[^}]*font-size:\s*clamp\(2\.125rem,\s*5vw,\s*3rem\);/,
        label: 'clamp(34px, 5vw, 48px) -> clamp(2.125rem, 5vw, 3rem)',
      },
      {
        // A large media-query-scoped glyph size — confirms the sweep also
        // converted declarations nested inside @media blocks.
        file: 'src/pages/Hanja.css',
        expect: /font-size:\s*4rem;/,
        label: '64px -> 4rem (inside @media max-width:380px)',
      },
      {
        // Fractional px (13.5px) — confirms non-integer inputs stayed exact.
        file: 'src/components/FilterSelect.css',
        expect: /font-size:\s*0\.84375rem;/,
        label: '13.5px -> 0.84375rem',
      },
    ];

    for (const c of cases) {
      const text = readFileSync(join(ROOT, c.file), 'utf8');
      expect(text, `${c.file}: expected ${c.label}`).toMatch(c.expect);
    }
  });

  it('representative TSX inline fontSize conversions are exact', () => {
    const cases: Array<{ file: string; expect: RegExp; label: string }> = [
      {
        file: 'src/components/KgiuDetailBody.tsx',
        expect: /fontSize:\s*'0\.875rem'/,
        label: '14 -> 0.875rem',
      },
      {
        file: 'src/components/UploadTypeModal.tsx',
        expect: /fontSize:\s*'0\.8125rem'/,
        label: '13 -> 0.8125rem',
      },
    ];
    for (const c of cases) {
      const text = readFileSync(join(ROOT, c.file), 'utf8');
      expect(text, `${c.file}: expected ${c.label}`).toMatch(c.expect);
    }
  });

  it('documented intentional-fixed px exceptions still carry their rationale comment', () => {
    // Guards against someone deleting the justification (or silently
    // "fixing" the exception to rem, which would be wrong — MockBadge is
    // aria-hidden dev-only chrome pinned to a fixed box; Images' mock-scene
    // overlay text is decorative, tied to mock data, not user copy).
    const sites = [
      { file: 'src/components/MockBadge.tsx', needle: 'Intentional-fixed px' },
      { file: 'src/pages/Images.tsx', needle: 'Intentional-fixed px' },
    ];
    for (const s of sites) {
      const text = readFileSync(join(ROOT, s.file), 'utf8');
      expect(text, `${s.file}: missing intentional-fixed rationale comment`).toContain(s.needle);
    }
    // And they must still actually be unitless numbers (px), not accidentally
    // converted to rem strings — that would silently defeat their purpose.
    const mockBadge = readFileSync(join(ROOT, 'src/components/MockBadge.tsx'), 'utf8');
    expect(mockBadge).toMatch(/fontSize:\s*11,/);
    const images = readFileSync(join(ROOT, 'src/pages/Images.tsx'), 'utf8');
    expect(images).toMatch(/fontSize:\s*Math\.max\(6, line\.size/);
    expect(images).toMatch(/fontSize:\s*line\.size,/);
  });

  it(':root[data-text-size] root font-size block is intact (the scaling mechanism this migration makes effective)', () => {
    const text = readFileSync(join(ROOT, 'src/styles/index.css'), 'utf8');
    expect(text).toMatch(/:root\s*\{\s*font-size:\s*100%;\s*\}/);
    expect(text).toMatch(/:root\[data-text-size="sm"\]\s*\{\s*font-size:\s*93\.75%;\s*\}/);
    expect(text).toMatch(/:root\[data-text-size="lg"\]\s*\{\s*font-size:\s*112\.5%;\s*\}/);
  });
});
