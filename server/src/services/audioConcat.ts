/**
 * MP3 concatenation + duration probing (F-210 v2 — multi-voice story audio).
 *
 * The multi-voice runner synthesizes each story turn as its own MP3 (one TTS
 * call per turn, each with that speaker's voice) and needs (a) the exact
 * duration of every per-turn MP3 — the per-turn transcript segments' cumulative
 * timeline is built from these — and (b) all the parts joined into ONE MP3 the
 * existing player streams unchanged.
 *
 * Both operations shell out to ffmpeg/ffprobe, so they live behind a small
 * injectable interface (the tts.ts get/set/reset pattern): unit tests inject a
 * deterministic mock and never require ffmpeg on the machine running them; the
 * real implementation runs only in the server image, whose Dockerfile installs
 * ffmpeg (which provides both binaries).
 *
 * WHY STREAM-COPY CONCAT IS CORRECT HERE: every input comes from the same
 * ElevenLabs endpoint requesting `output_format=mp3_44100_128` — identical
 * codec, sample rate, channel layout, and bitrate — so the concat demuxer with
 * `-c copy` joins them losslessly with no re-encode (fast, byte-exact frames).
 * Mixed-format inputs are not a case this pipeline can produce.
 *
 * SECURITY: nothing here touches user-controlled paths or strings. Inputs are
 * in-memory buffers written to a private mkdtemp directory with server-chosen
 * ASCII filenames; the ffmpeg list file references only those names. Failure
 * messages are server-authored (never raw ffmpeg stderr — that flows into the
 * runner's generic-error path anyway, which whitelists what users see).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Generous ceiling for one ffmpeg/ffprobe run over ≤200 short clips —
 *  stream-copy concat is I/O-bound and finishes in well under a second; a
 *  hang (bad install, fs stall) must fail the job, not wedge the runner. */
const SUBPROCESS_TIMEOUT_MS = 60_000;

export interface Mp3ConcatHelper {
  /**
   * Join the given MP3 buffers, in order, into one MP3.
   * @throws on empty input or an ffmpeg failure (server-authored message).
   */
  concatMp3(buffers: readonly Buffer[]): Promise<Buffer>;
  /**
   * The exact audio duration of one MP3 buffer, in integer milliseconds.
   * @throws on an ffprobe failure or an unparseable duration.
   */
  probeDurationMs(buffer: Buffer): Promise<number>;
}

/** Real implementation — shells out to `ffmpeg`/`ffprobe` (on PATH in the
 *  server image; see server/Dockerfile). */
export class FfmpegMp3Concat implements Mp3ConcatHelper {
  public async concatMp3(buffers: readonly Buffer[]): Promise<Buffer> {
    if (buffers.length === 0) {
      throw new Error('concatMp3: no input buffers');
    }
    // A single part needs no ffmpeg round-trip — it IS the output.
    if (buffers.length === 1) {
      return buffers[0]!;
    }
    const dir = await mkdtemp(path.join(tmpdir(), 'km-mp3cat-'));
    try {
      const names: string[] = [];
      for (let i = 0; i < buffers.length; i++) {
        const name = `part-${String(i).padStart(4, '0')}.mp3`;
        await writeFile(path.join(dir, name), buffers[i]!);
        names.push(name);
      }
      // Concat-demuxer list. Names are server-generated ASCII (no quotes or
      // newlines possible), so the single-quoted `file` syntax is safe as-is.
      const listPath = path.join(dir, 'list.txt');
      await writeFile(listPath, names.map((n) => `file '${n}'`).join('\n') + '\n');
      const outPath = path.join(dir, 'out.mp3');
      try {
        await execFileAsync(
          'ffmpeg',
          // -safe 0: the list uses relative names inside our private temp dir.
          // -c copy: lossless stream copy — see the module header for why the
          // inputs are guaranteed concat-compatible.
          ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
           '-i', listPath, '-c', 'copy', outPath],
          { timeout: SUBPROCESS_TIMEOUT_MS },
        );
      } catch {
        // Server-authored message only — never raw ffmpeg stderr.
        throw new Error('concatMp3: ffmpeg concat failed');
      }
      return await readFile(outPath);
    } finally {
      // Best-effort temp cleanup; a cleanup failure must never mask the result.
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  public async probeDurationMs(buffer: Buffer): Promise<number> {
    if (buffer.length === 0) {
      throw new Error('probeDurationMs: empty buffer');
    }
    const dir = await mkdtemp(path.join(tmpdir(), 'km-mp3probe-'));
    try {
      const filePath = path.join(dir, 'probe.mp3');
      await writeFile(filePath, buffer);
      let stdout: string;
      try {
        ({ stdout } = await execFileAsync(
          'ffprobe',
          ['-v', 'error', '-show_entries', 'format=duration',
           '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
          { timeout: SUBPROCESS_TIMEOUT_MS },
        ));
      } catch {
        throw new Error('probeDurationMs: ffprobe failed');
      }
      const seconds = Number.parseFloat(stdout.trim());
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new Error('probeDurationMs: ffprobe returned no usable duration');
      }
      return Math.round(seconds * 1000);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

let _helper: Mp3ConcatHelper | null = null;

/** The process-wide helper (real ffmpeg unless a test injected a mock). */
export function getMp3Concat(): Mp3ConcatHelper {
  if (_helper === null) {
    _helper = new FfmpegMp3Concat();
  }
  return _helper;
}

/** Test-only injection point (mirrors tts.ts's setTtsProvider). */
export function setMp3Concat(helper: Mp3ConcatHelper): void {
  _helper = helper;
}

export function resetMp3ConcatForTesting(): void {
  _helper = null;
}
