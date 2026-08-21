/**
 * displayableStoryImages — unit tests for the shared filter/sort pulled out
 * of `components/StoryIllustrations.tsx` (see the doc comment on the
 * function itself). Previously only integration-covered via
 * `pages/Reading.test.tsx` and `pages/Ttmik.test.tsx`; this exercises the
 * pure function directly: non-`done` statuses, the allow-list filter, and
 * the defensive ordinal sort.
 *
 * Note: `imageGenConfigured` is NOT read by this function — that gate is
 * applied by the two callers (Reading.tsx's `displayableImages` useMemo,
 * StoryIllustrations.tsx) one layer up, before/instead of calling this
 * helper. So it's out of scope for a test of `displayableStoryImages`
 * itself; those callers' gating is already covered by
 * `Reading.test.tsx`/`Ttmik.test.tsx`.
 */
import { describe, it, expect } from 'vitest';
import { displayableStoryImages } from './storyImages';
import type { StoryImage, StoryImagesEnvelope } from '../services/reading';

function image(overrides: Partial<StoryImage>): StoryImage {
  return {
    imageNumber: 1,
    blobUrl: '/reading/generated/55/image/1/blob',
    prompt: 'a scene',
    width: 512,
    height: 512,
    ...overrides,
  };
}

describe('displayableStoryImages', () => {
  it('returns empty for a null envelope', () => {
    expect(displayableStoryImages(null)).toEqual([]);
  });

  it.each(['none', 'pending', 'running', 'failed'] as const)(
    'returns empty for a non-done status (%s), even with images present',
    (status) => {
      const envelope: StoryImagesEnvelope = {
        status,
        jobId: 1,
        error: status === 'failed' ? 'The image service is unavailable.' : null,
        images: [image({ imageNumber: 1, blobUrl: '/reading/generated/55/image/1/blob' })],
      };
      expect(displayableStoryImages(envelope)).toEqual([]);
    },
  );

  it('returns the resolved, ordinal-sorted images for a done envelope', () => {
    const envelope: StoryImagesEnvelope = {
      status: 'done',
      jobId: 1,
      error: null,
      images: [
        image({ imageNumber: 2, blobUrl: '/reading/generated/55/image/2/blob' }),
        image({ imageNumber: 1, blobUrl: '/reading/generated/55/image/1/blob' }),
      ],
    };
    const result = displayableStoryImages(envelope);
    expect(result).toHaveLength(2);
    // Sorted by imageNumber ascending, regardless of wire order.
    expect(result.map((r) => r.img.imageNumber)).toEqual([1, 2]);
    // `src` resolves through the real buildStoryImageSrc allow-list (empty
    // API base in test env → same-origin relative path, unchanged).
    expect(result[0].src).toBe('/reading/generated/55/image/1/blob');
    expect(result[1].src).toBe('/reading/generated/55/image/2/blob');
    // The original `img` is passed through untouched.
    expect(result[0].img).toEqual(envelope.images[1]);
  });

  it('drops any image whose blobUrl fails buildStoryImageSrc\'s allow-list', () => {
    const envelope: StoryImagesEnvelope = {
      status: 'done',
      jobId: 1,
      error: null,
      images: [
        image({ imageNumber: 1, blobUrl: '/reading/generated/55/image/1/blob' }),
        // Off-shape: not the exact /reading/generated/:id/image/:n/blob route.
        image({ imageNumber: 2, blobUrl: 'https://evil.example.com/steal.png' }),
        image({ imageNumber: 3, blobUrl: '/reading/generated/55/image/3/blob' }),
      ],
    };
    const result = displayableStoryImages(envelope);
    expect(result.map((r) => r.img.imageNumber)).toEqual([1, 3]);
  });

  it('returns empty when every image is filtered out by the allow-list', () => {
    const envelope: StoryImagesEnvelope = {
      status: 'done',
      jobId: 1,
      error: null,
      images: [image({ imageNumber: 1, blobUrl: '/not/an/allowed/route' })],
    };
    expect(displayableStoryImages(envelope)).toEqual([]);
  });

  it('returns empty for a done envelope with no images at all', () => {
    const envelope: StoryImagesEnvelope = {
      status: 'done',
      jobId: 1,
      error: null,
      images: [],
    };
    expect(displayableStoryImages(envelope)).toEqual([]);
  });
});
