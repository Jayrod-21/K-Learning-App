/**
 * displayableStoryImages — the `done`-envelope images that actually clear
 * `buildStoryImageSrc`'s allow-list, sorted to ordinal order. Pulled out of
 * `components/StoryIllustrations.tsx` (rather than just exported from
 * there) so it's usable from a plain module: a component file can only
 * export components without breaking React Fast Refresh
 * (`react-refresh/only-export-components`), and this pure filter/sort is
 * shared by TWO callers — the gallery component's own done-state grid, and
 * the Story Reader's inline webtoon panels (pages/Reading.tsx) — so both
 * stay in lockstep on which images are actually displayable rather than
 * each re-implementing the allow-list/sort themselves.
 */
import { buildStoryImageSrc } from '../services/ttmik';
import type { StoryImage, StoryImagesEnvelope } from '../services/reading';

/**
 * Returns `[]` for anything other than a `done` envelope. Defensive ordinal
 * sort: the server already orders by `image_number`, this just doesn't
 * trust that to stay true forever. A tampered/off-origin `blobUrl` drops
 * out via the `buildStoryImageSrc` filter — the caller never sees a raw
 * wire value it didn't clear.
 */
export function displayableStoryImages(
  images: StoryImagesEnvelope | null,
): { img: StoryImage; src: string }[] {
  if (images === null || images.status !== 'done') return [];
  return [...images.images]
    .sort((a, b) => a.imageNumber - b.imageNumber)
    .map((img) => ({ img, src: buildStoryImageSrc(img.blobUrl) }))
    .filter((x): x is { img: StoryImage; src: string } => x.src !== null);
}
