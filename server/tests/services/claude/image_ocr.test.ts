/**
 * Unit tests for the two highest-risk PURE pieces of the image_ocr (Pass 8)
 * path. Both run WITHOUT Docker / Postgres / Vision — they exercise pure
 * functions only.
 *
 *   1. `buildImageOcrRequest` (prompts/image_ocr.ts) — the Vision request shape.
 *      A regression that dropped or reordered the image block would silently
 *      send the model a malformed request; these assertions pin the exact
 *      `[image, text]` content array and that the sniffed media_type passes
 *      through untouched.
 *
 *   2. `serializeMessages` (index.ts) — the cache-key / log placeholder for an
 *      image block. This is the single most load-bearing SECURITY property of
 *      this pass: the multi-MB base64 payload must NEVER reach the cache key (or
 *      any logged cache key). A future refactor that dropped the image branch
 *      would put the full base64 into every key with no failing test — unless
 *      this test exists. The assertions fail loudly if the raw bytes ever leak.
 */
import { describe, expect, it } from 'vitest';
import { buildImageOcrRequest } from '../../../src/services/claude/prompts/image_ocr';
import { serializeMessages } from '../../../src/services/claude';
import type {
  ContentBlock,
  MessageRequest,
} from '../../../src/services/claude/client';

describe('buildImageOcrRequest — Vision request shape', () => {
  const BASE64 = 'QUJDREVG'; // "ABCDEF" base64; stands in for image bytes.

  it('emits a user message whose content is [image block, text block]', () => {
    const req = buildImageOcrRequest(
      { imageBase64: BASE64, mediaType: 'image/png' },
      'claude-test-model',
    );

    expect(req.messages).toHaveLength(1);
    const msg = req.messages[0]!;
    expect(msg.role).toBe('user');
    expect(msg.content).toHaveLength(2);

    const [imageBlock, textBlock] = msg.content;
    // First block is the image, with a base64 source carrying the exact bytes.
    expect(imageBlock).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: BASE64,
      },
    });
    // Second block is the static instruction text.
    expect(textBlock?.type).toBe('text');
    if (textBlock?.type === 'text') {
      expect(textBlock.text).toMatch(/Transcribe the Korean text/);
      expect(textBlock.text).toMatch(/No bounding boxes/);
    }
  });

  it('passes the sniffed media_type through untouched for every allowed mime', () => {
    for (const mediaType of ['image/jpeg', 'image/png', 'image/webp'] as const) {
      const req = buildImageOcrRequest({ imageBase64: BASE64, mediaType }, 'm');
      const imageBlock = req.messages[0]!.content[0]!;
      expect(imageBlock.type).toBe('image');
      if (imageBlock.type === 'image') {
        expect(imageBlock.source.media_type).toBe(mediaType);
        expect(imageBlock.source.data).toBe(BASE64);
      }
    }
  });

  it('uses temperature 0 (faithful transcription, not generation)', () => {
    const req = buildImageOcrRequest(
      { imageBase64: BASE64, mediaType: 'image/jpeg' },
      'm',
    );
    expect(req.temperature).toBe(0);
  });
});

describe('serializeMessages — image-block placeholder never leaks base64', () => {
  // A large, recognizable base64 payload so a leak is unambiguous in the output.
  const BIG_BASE64 = 'A'.repeat(5000);

  function imageMessages(): MessageRequest['messages'] {
    const content: ContentBlock[] = [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/webp', data: BIG_BASE64 },
      },
      { type: 'text', text: 'transcribe this' },
    ];
    return [{ role: 'user', content }];
  }

  it('serializes an image block to a {type,media_type,dataLength} PLACEHOLDER', () => {
    const out = serializeMessages(imageMessages());
    const parsed = JSON.parse(out) as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;

    const block = parsed[0]!.content[0]!;
    expect(block).toEqual({
      type: 'image',
      media_type: 'image/webp',
      dataLength: BIG_BASE64.length,
    });
    // It records the LENGTH, not the bytes.
    expect(block.dataLength).toBe(5000);
    expect('data' in block).toBe(false);
    expect('source' in block).toBe(false);
  });

  it('NEVER includes the raw base64 payload anywhere in the serialized output', () => {
    // This is the security guard: if a future refactor drops the image branch
    // (e.g. falls through to returning `c`), the full base64 would appear here.
    const out = serializeMessages(imageMessages());
    expect(out).not.toContain(BIG_BASE64);
    expect(out).not.toContain('base64');
  });

  it('leaves text blocks unchanged (no behavior change for text routes)', () => {
    const out = serializeMessages([
      { role: 'user', content: [{ type: 'text', text: '안녕하세요' }] },
    ]);
    const parsed = JSON.parse(out) as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;
    expect(parsed[0]!.content[0]).toEqual({ type: 'text', text: '안녕하세요' });
  });
});
