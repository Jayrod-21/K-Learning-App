/**
 * LIVE tests for src/services/audioConcat.ts — the REAL ffmpeg/ffprobe
 * implementation (F-210 v2 multi-voice concat).
 *
 * GATED BEHIND `FFMPEG_LIVE` (opt-in, mirroring kiwi.live.test.ts's KIWI_LIVE
 * pattern): the unit suites mock the helper (setMp3Concat) so CI and dev
 * machines never need ffmpeg installed; THIS file proves the real subprocess
 * plumbing — mp3 generation aside, the exact properties the runner relies on:
 * probed durations that sum to the concatenated file's duration, and a
 * stream-copy join that plays end to end.
 *
 * Run it where ffmpeg exists (the built server image has it; see
 * server/Dockerfile):
 *   FFMPEG_LIVE=1 npx vitest run tests/services/audioConcat.live.test.ts
 *
 * The input mp3s are themselves generated with ffmpeg (lavfi sine tones at
 * 44.1kHz/128k — the same container/bitrate shape ElevenLabs returns), so the
 * test is fully self-contained: no fixtures, no network.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { FfmpegMp3Concat } from '../../src/services/audioConcat.js';

const execFileAsync = promisify(execFile);

const live = process.env.FFMPEG_LIVE === '1';

/** Generate `seconds` of a sine-tone mp3 (44.1kHz, 128k CBR — the ElevenLabs
 *  output shape) straight to stdout. */
async function sineMp3(seconds: number, hz: number): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error',
     '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${seconds}`,
     '-ar', '44100', '-b:a', '128k', '-f', 'mp3', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
  );
  return stdout;
}

describe.skipIf(!live)('FfmpegMp3Concat (live — real ffmpeg/ffprobe)', () => {
  it('probes a generated clip to within tolerance of its nominal duration', async () => {
    const helper = new FfmpegMp3Concat();
    const clip = await sineMp3(2, 440);
    const ms = await helper.probeDurationMs(clip);
    // mp3 frame granularity (~26ms) + encoder padding — 150ms tolerance.
    expect(Math.abs(ms - 2000)).toBeLessThanOrEqual(150);
  });

  it('concats three clips losslessly; total duration ≈ the sum of the probed parts', async () => {
    const helper = new FfmpegMp3Concat();
    const parts = await Promise.all([sineMp3(1, 330), sineMp3(2, 440), sineMp3(1, 550)]);
    const durations: number[] = [];
    for (const p of parts) durations.push(await helper.probeDurationMs(p));

    const joined = await helper.concatMp3(parts);
    expect(joined.length).toBeGreaterThan(0);
    const total = await helper.probeDurationMs(joined);
    const sum = durations.reduce((a, b) => a + b, 0);
    // The runner's cumulative segment timeline assumes exactly this: the
    // joined file's timeline is the parts laid end to end.
    expect(Math.abs(total - sum)).toBeLessThanOrEqual(150);
  });

  it('a single part round-trips unchanged (no ffmpeg invocation needed)', async () => {
    const helper = new FfmpegMp3Concat();
    const clip = await sineMp3(1, 440);
    const out = await helper.concatMp3([clip]);
    expect(Buffer.compare(out, clip)).toBe(0);
  });

  it('rejects an empty input list', async () => {
    await expect(new FfmpegMp3Concat().concatMp3([])).rejects.toThrow('no input buffers');
  });
});
