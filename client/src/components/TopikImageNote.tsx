/**
 * TopikImageNote — the "image described in text" affordance for TOPIK items
 * with `hasImage` (FU-NF-39 follow-up). The corpus stores NO image assets for
 * these items — only a bracketed text description (see `lib/topikImage.ts`).
 * This block renders that description prominently so the item stays
 * answerable, or an honest fallback note when no description was captured.
 *
 * Shared by Study mode (Topik.tsx) and the Mock exam (MockMode.tsx) so the
 * two flows present image items identically. Renders the description as a
 * React text node — a malicious payload becomes literal text, never markup.
 */
import type { JSX } from 'react';
import { Bilingual } from './Bilingual';
import { Eyebrow } from './Eyebrow';

interface TopikImageNoteProps {
  /** The description to feature, or null when the corpus never captured one. */
  description: string | null;
}

export function TopikImageNote({
  description,
}: TopikImageNoteProps): JSX.Element {
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
      {description !== null ? (
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
