/**
 * generate-pwa-icons.mjs — rasterise the Korean Master seal into the PNG sizes
 * the PWA manifest + iOS home-screen launcher require.
 *
 * WHY this exists (FU-NF-10): iOS Safari ignores SVG manifest icons for the
 * home-screen launcher and several Android launchers render maskable icons
 * better from raster. The app's existing `public/favicon.svg` is a *placeholder*
 * (gold 韓 on indigo) that predates the locked hanji palette, so this script
 * renders from an inline master SVG built from the real design tokens
 * (vermilion #B83A2E seal, cream #E8DFC5 paper, cream ink #FBF6E6) rather than
 * from that stale file. The seal glyph (韓 = "Korea") matches `SealStamp.tsx`.
 *
 * Outputs (into client/public/):
 *   - pwa-192x192.png             standard any-purpose icon
 *   - pwa-512x512.png             standard any-purpose icon
 *   - apple-touch-icon-180x180.png  iOS launcher (no transparency, full bleed)
 *   - maskable-512x512.png        Android adaptive icon, ~20% safe-zone padding
 *
 * Deterministic + idempotent: re-running overwrites the same four files with
 * byte-stable output for a given sharp/libvips version. Safe to commit the
 * results and re-run at deploy (see package.json `gen:icons`).
 *
 * Robustness: any failure (missing sharp, bad SVG, unwritable dir) rejects the
 * process with a non-zero exit so CI/build surfaces it loudly rather than
 * silently shipping a manifest that points at absent icons.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');

const VERMILION = '#B83A2E';
const CREAM = '#E8DFC5';
const ON_VERMILION = '#FBF6E6';

/**
 * Full-bleed seal artwork for a square canvas of `size`px. The seal fills the
 * canvas (used for the standard + apple-touch icons, which want edge-to-edge
 * art). `inset` shrinks the seal to leave a transparent/painted margin — used
 * by the maskable variant so the launcher's circular/rounded mask never clips
 * the glyph (Android maskable safe zone is the inner 80% / ~40% radius).
 */
function sealSvg(size, { inset = 0, background = CREAM } = {}) {
  const pad = Math.round(size * inset);
  const sealSize = size - pad * 2;
  const radius = Math.round(sealSize * 0.14);
  const fontSize = Math.round(sealSize * 0.6);
  // Center the glyph; the dominant-baseline trick keeps the CJK glyph optically
  // centered across rasterisers (libvips/resvg).
  const cx = size / 2;
  const cy = size / 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${background}"/>
  <rect x="${pad}" y="${pad}" width="${sealSize}" height="${sealSize}" rx="${radius}" ry="${radius}" fill="${VERMILION}"/>
  <text x="${cx}" y="${cy}" font-family="'Noto Serif KR','Noto Serif CJK KR',serif" font-weight="700" font-size="${fontSize}" fill="${ON_VERMILION}" text-anchor="middle" dominant-baseline="central">韓</text>
</svg>`,
    'utf8',
  );
}

/** One PNG target: filename, pixel size, and how to lay out the seal. */
const targets = [
  { file: 'pwa-192x192.png', size: 192, opts: { inset: 0 } },
  { file: 'pwa-512x512.png', size: 512, opts: { inset: 0 } },
  // Apple touch icons must be fully opaque (iOS adds its own rounding/mask) and
  // should not rely on transparency — render full-bleed on cream.
  { file: 'apple-touch-icon-180x180.png', size: 180, opts: { inset: 0 } },
  // Maskable: 20% inset so the seal lives inside the Android safe zone; the
  // cream background bleeds to the edges so the mask reveals paper, not void.
  { file: 'maskable-512x512.png', size: 512, opts: { inset: 0.2 } },
];

/**
 * The seal glyph (韓) only renders if a CJK serif font is installed on the
 * build host; libvips/fontconfig silently substitutes a "tofu" box otherwise,
 * which would ship a glyph-less icon without any error. Probe fontconfig and
 * abort loudly with the exact apt command if no CJK serif is resolvable, so a
 * fresh deploy box can't quietly produce broken icons.
 *
 * Skips the check (best-effort) if `fc-match` is unavailable — e.g. on macOS,
 * where the system already ships CJK fonts and fontconfig may not be present.
 */
function assertCjkFont() {
  let resolved;
  try {
    resolved = execFileSync('fc-match', ['Noto Serif CJK KR'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return; // no fontconfig CLI — assume host (e.g. macOS) supplies CJK fonts.
  }
  if (!/CJK|Noto Serif|Source Han|Nanum/i.test(resolved)) {
    throw new Error(
      `No CJK serif font found (fc-match resolved to "${resolved}"). The seal ` +
        `glyph would render as a blank box. Install one, e.g.:\n` +
        `  sudo apt-get install -y fonts-noto-cjk\n` +
        `then re-run: npm run gen:icons`,
    );
  }
}

async function main() {
  assertCjkFont();
  await mkdir(publicDir, { recursive: true });
  for (const { file, size, opts } of targets) {
    const svg = sealSvg(size, opts);
    // `resize` pins the output to the exact target pixels regardless of how the
    // SVG rasteriser interprets intrinsic size/density, so the manifest's
    // declared sizes always match the bytes on disk.
    await sharp(svg)
      .resize(size, size, { fit: 'contain' })
      .png({ compressionLevel: 9 })
      .toFile(join(publicDir, file));
    console.log(`wrote public/${file} (${size}x${size})`);
  }
}

main().catch((err) => {
  console.error('[generate-pwa-icons] failed:', err);
  process.exitCode = 1;
});
