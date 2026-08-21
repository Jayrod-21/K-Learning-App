/**
 * StoryIllustrations — the F-211 story-illustration gallery surface, shared
 * by the Reading story reader and the Listen landing's just-created story
 * card (`pages/Ttmik.tsx` `CreatedStoryCard`). Extracted verbatim from
 * `pages/Reading.tsx`'s inline gallery render (the Listen-tab
 * illustration-visibility work): a hero-plus-grid gallery once `done`, a
 * subtle "Illustrating…" status while pending/running, an on-demand
 * "Generate illustrations" button for an old/never-illustrated story, and
 * NOTHING at all on a dormant deploy (`imageGenConfigured: false`).
 *
 * Deliberately CONTROLLED, not self-fetching: the story reader also needs
 * this same envelope (and its `seed` setter) to drive the F-216 combined
 * "Generate full experience" button, so the `useStoryImages` hook is called
 * ONCE per story by the page that owns that coordination — this component
 * only renders what it is handed. `CreatedStoryCard` has no such
 * coordination need and simply calls the hook itself and forwards the
 * result straight through (the same shape `useStoryAudio` already uses
 * there). Either way there is exactly one hook instance — and so exactly
 * one hydrate/poll — per story on screen.
 *
 * Class names are kept as `km-reading__images*` (unchanged from the
 * pre-extraction Reading.tsx markup) rather than renamed to match this
 * file's own name: Reading.test.tsx pins dozens of assertions to those
 * selectors, and the two surfaces share the exact same gallery look, so
 * renaming would be a cosmetic-only change with real regression risk for
 * zero behavioral benefit. The rules themselves now live in
 * `StoryIllustrations.css`, colocated with this component per the repo's
 * per-component CSS convention.
 */
import { useMemo, useState, type JSX } from 'react';
import { Bilingual } from './Bilingual';
import { Button } from './Button';
import { Icon } from './Icon';
import { IMAGES_FAILED_FALLBACK_COPY } from '../hooks/useStoryImages';
import { displayableStoryImages } from '../lib/storyImages';
import type { StoryImagesEnvelope } from '../services/reading';
import './StoryIllustrations.css';

/**
 * One scene illustration. Owns its own load-failure state so a broken blob
 * degrades to ABSENCE (no broken-image glyph, no dead frame) without
 * touching its siblings. `src` has already passed `buildStoryImageSrc`'s
 * allow-list — this component never sees a raw wire value. `alt` stays a
 * generic ordinal: the envelope's `prompt` is English generation
 * scaffolding, not user-facing copy, so it never reaches the DOM.
 * `width`/`height` reserve layout space before the lazy bytes arrive.
 *
 * Exported (not just used by the gallery below): the Story Reader's inline
 * webtoon panels (pages/Reading.tsx) need the exact same
 * src-already-allow-listed / generic-alt / lazy / reserved-dimensions /
 * per-image-failure-absorbs posture, just under a different frame class —
 * `className` is the only thing that differs between a gallery cell and an
 * inline panel.
 */
export function StoryImageFigure({
  className,
  src,
  imageNumber,
  width,
  height,
}: {
  className: string;
  src: string;
  imageNumber: number;
  width: number;
  height: number;
}): JSX.Element | null {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <figure className={className}>
      <img
        src={src}
        alt={`Story illustration ${String(imageNumber)}`}
        loading="lazy"
        width={width}
        height={height}
        onError={() => {
          setFailed(true);
        }}
      />
    </figure>
  );
}

export interface StoryIllustrationsProps {
  /** Image numbers restart at 1 per story, so the gallery item keys fold
   *  this in — a stale `failed` flag must not survive a story switch. */
  storyId: number;
  /** Purely for the gallery's `aria-label` — never rendered as text. */
  storyTitle: string;
  /** The `useStoryImages` envelope — null while the mount hydrate is in
   *  flight (nothing renders yet, same as the audio card's posture). */
  images: StoryImagesEnvelope | null;
  /** True while the on-demand POST itself is in flight. */
  requesting: boolean;
  /** Request failure copy (429 cap verbatim / fixed copy), or null. */
  requestError: string | null;
  /** `useStoryImages`'s `requestImages` — fires the on-demand POST. */
  onRequest: () => void;
  /** Default `true` (the Listen-tab created-story card's posture,
   *  unchanged): render the hero-plus-grid gallery once `images.status`
   *  is `'done'`. The Story Reader passes `false` — it now interleaves
   *  these same done images as inline webtoon panels between paragraphs
   *  (see `lib/storyImages.ts`'s `displayableStoryImages`), so this
   *  component should keep rendering the busy/request/failed states
   *  verbatim but return `null` on `done` — otherwise every finished
   *  illustration would render twice (once here, once inline). */
  galleryWhenReady?: boolean;
}

/**
 * The story-illustration surface, driven by the envelope status. NOTHING
 * renders while the mount hydrate is in flight (the caller's body never
 * waits on the image probe), and NOTHING renders on a dormant deploy
 * (`imageGenConfigured: false` — no image key): absence, not a dead
 * affordance. Only an explicit `false` hides — a missing flag (older
 * server) keeps the feature visible, forward-compat (the F-210 audio-card
 * gate, exactly).
 */
export function StoryIllustrations({
  storyId,
  storyTitle,
  images,
  requesting,
  requestError,
  onRequest,
  galleryWhenReady = true,
}: StoryIllustrationsProps): JSX.Element | null {
  // Every candidate resolves through the strict allow-list; a tampered or
  // off-origin blobUrl drops out here, so the gallery never touches a raw
  // wire value.
  const displayableImages = useMemo(
    () => displayableStoryImages(images),
    [images],
  );

  if (images === null || images.imageGenConfigured === false) return null;

  if (images.status === 'done') {
    if (displayableImages.length === 0) {
      // Done but nothing displayable (every blobUrl rejected by the
      // allow-list — tampered response): render nothing rather than an
      // empty frame.
      return null;
    }
    if (!galleryWhenReady) {
      // The Story Reader owns these done images as inline webtoon panels
      // instead (pages/Reading.tsx) — rendering the grid here too would
      // duplicate every illustration.
      return null;
    }
    return (
      // Hero-plus-grid gallery: CSS promotes the first surviving figure to
      // a full-width hero, the rest share a two-up grid. Each figure owns
      // its load-failure fallback (absence, no broken-image glyph) — see
      // StoryImageFigure.
      <div
        className="km-reading__images"
        role="group"
        aria-label={`Illustrations for ${storyTitle}`}
      >
        {displayableImages.map(({ img, src }) => (
          <StoryImageFigure
            key={`${String(storyId)}-${String(img.imageNumber)}`}
            className="km-reading__images-item"
            src={src}
            imageNumber={img.imageNumber}
            width={img.width}
            height={img.height}
          />
        ))}
      </div>
    );
  }

  if (images.status === 'pending' || images.status === 'running') {
    // In flight — the hook's bounded poll lands the settle; role=status so
    // AT hears the eventual flip via the re-render.
    return (
      <p className="km-reading__images-busy" role="status">
        <Bilingual en="Illustrating…" kr="삽화 생성 중…" />
      </p>
    );
  }

  // 'none' | 'failed' — the request affordance (old/pre-F-211 stories have
  // no batch job; this is their on-demand path).
  return (
    <div className="km-reading__images-request">
      {images.status === 'failed' ? (
        // Server-authored whitelisted failure copy — verbatim per the
        // same contract as F-210 (see services/reading.ts).
        <p className="km-reading__images-error" role="alert">
          {images.error ?? IMAGES_FAILED_FALLBACK_COPY}
        </p>
      ) : null}
      <div>
        <Button
          variant="gold"
          size="sm"
          // aria-disabled, NOT disabled: the hard attribute would drop
          // keyboard focus to <body> the instant the call starts (the
          // audio card's exact pattern).
          aria-disabled={requesting || undefined}
          leadingIcon={<Icon name="image" size={14} />}
          onClick={() => {
            if (requesting) return; // aria-disabled doesn't block clicks
            onRequest();
          }}
        >
          {requesting ? (
            <Bilingual en="Requesting…" kr="요청 중…" compact />
          ) : images.status === 'failed' ? (
            <Bilingual en="Try again" kr="다시 시도" compact />
          ) : (
            <Bilingual en="Generate illustrations" kr="삽화 생성" compact />
          )}
        </Button>
      </div>
      {requestError !== null ? (
        <div role="alert" className="km-reading__images-error">
          {requestError}
        </div>
      ) : null}
    </div>
  );
}
