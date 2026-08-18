/**
 * TopikImageNote — the image affordance for TOPIK items with `hasImage`
 * (FU-NF-39 follow-up, F-081; real assets F-120 Phase 1). Historically the
 * corpus stored NO image assets for these items — only a bracketed text
 * description (see `lib/topikImage.ts`) — and that path is still the default:
 * the description renders prominently so the item stays answerable, or an
 * honest fallback note when none was captured.
 *
 * F-120 adds the real figure: when the server mapped an image asset
 * (`imageUrl` present on the item), the actual exam crop renders here, with
 * the text description kept as the figure's caption AND as its `alt` text.
 * The URL is NEVER fed raw to the `<img>` — it goes through
 * `buildTopikImageSrc`'s strict route-shape allow-list + API-base join
 * (services/ttmik.ts, the buildStoryImageSrc pattern); a rejected/absent URL
 * falls back to the text-only rendering, so most items (unmapped until the
 * corpus backfill runs) look exactly as they did before.
 *
 * Shared by Study mode (Topik.tsx) and the Mock exam (MockMode.tsx) so the
 * two flows present image items identically. Renders the description as a
 * React text node — a malicious payload becomes literal text, never markup.
 */
import type { JSX } from 'react';
import { Bilingual } from './Bilingual';
import { Eyebrow } from './Eyebrow';
import { buildTopikImageSrc } from '../services/ttmik';

interface TopikImageNoteProps {
  /** The description to feature, or null when the corpus never captured one. */
  description: string | null;
  /**
   * The item's app-relative exam-figure URL (`TopikItem.imageUrl`, F-120),
   * when the server mapped an asset. Optional so every pre-F-120 caller and
   * fixture keeps compiling; absent → the text-only rendering.
   */
  imageUrl?: string;
}

export function TopikImageNote({
  description,
  imageUrl,
}: TopikImageNoteProps): JSX.Element {
  // Strict allow-list + API-base join — null for absent AND for any value
  // that is not exactly a /topik/image/<n>/<1|2>/<n> route shape.
  const src = imageUrl !== undefined ? buildTopikImageSrc(imageUrl) : null;
  return (
    <aside
      className="km-topik__image-note"
      // A complementary landmark labelled for AT users, so the block reads as
      // "image description" rather than floating unexplained text.
      aria-label="Image described in text"
    >
      {/* P3b trim — was the wordy "그림 · Image described in text". */}
      <Eyebrow>
        <Bilingual kr="그림 설명" en="Image description" />
      </Eyebrow>
      {src !== null ? (
        <figure className="km-topik__image-figure">
          <img
            className="km-topik__image"
            src={src}
            // The curated/extracted description doubles as the figure's alt
            // text; a generic label when none was captured (the figure itself
            // is the content — better an image with a thin alt than no image).
            alt={description ?? 'Exam figure for this question'}
            loading="lazy"
          />
          {description !== null ? (
            <figcaption className="kr km-topik__image-desc">
              {description}
            </figcaption>
          ) : null}
        </figure>
      ) : description !== null ? (
        <p className="kr km-topik__image-desc">{description}</p>
      ) : (
        <p className="km-topik__image-hint">
          The original exam shows an image here that isn’t included in this
          app. Answer from the text above.
        </p>
      )}
    </aside>
  );
}
