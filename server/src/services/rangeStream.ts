/**
 * Shared HTTP byte-range file streaming (RFC 9110 single-range) — the ONE
 * place the Range mechanics live. Extracted from routes/ttmik.ts's
 * streamCorpusAudio (F-012) when Track A's user-scoped audio streaming
 * (A-4a, GET /audio/tracks/:id/stream) needed the identical semantics, so
 * the two surfaces can never drift on 206/416 behavior.
 *
 * Callers own everything BEFORE the stream: which table the path came from,
 * ownership checks (user-scoped vs public corpus), path resolution
 * (traversal/symlink defenses), and the fs.stat that produced `size`. This
 * module owns everything AFTER: header emission, Range parsing, status
 * selection, and the createReadStream lifecycle (error + client-disconnect
 * handling).
 *
 * SECURITY (per call site's threat model, restated for the shared part):
 *   - RANGE HANDLING: single `bytes=start-end` ranges per RFC 9110 — 206 +
 *     Content-Range + Accept-Ranges; suffix ranges supported; unsatisfiable →
 *     416 with a total-size Content-Range; a MALFORMED or INVALID (inverted)
 *     Range header is IGNORED (full 200) as the RFC requires, so a weird
 *     client degrades to a working download instead of an error. Multipart/byteranges is
 *     deliberately unsupported (no client we serve sends multi-range for
 *     audio, and coalescing logic is pure attack surface).
 *   - SNIFFING: X-Content-Type-Options: nosniff is ALWAYS set — the caller's
 *     Content-Type is authoritative and the browser must never content-sniff
 *     the bytes into another type (app-level helmet() already sets this
 *     globally; setting it here keeps the guarantee local to the streamer
 *     rather than hostage to middleware ordering).
 *   - DoS: no unbounded buffering — the file is streamed (createReadStream)
 *     with backpressure; Content-Length is always set; a client disconnect
 *     destroys the read stream promptly (frees the fd).
 */
import { createReadStream } from 'node:fs';
import type { NextFunction, Request, Response } from 'express';
import { NotFoundError } from '../middleware/errors.js';
import { getLogger } from '../logging.js';

/** A parsed, satisfiable byte range (inclusive, per RFC 9110). */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse a Range header against a known size.
 * Returns: a ByteRange (→ 206), null (no/malformed/INVALID header → full
 * 200), or 'unsatisfiable' (→ 416). Only single `bytes=` ranges are honored —
 * multipart/byteranges is deliberately unsupported (no client we serve sends
 * multi-range for audio, and coalescing logic is pure attack surface).
 */
export function parseRangeHeader(
  header: string | undefined,
  size: number,
): ByteRange | null | 'unsatisfiable' {
  if (header === undefined) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // Malformed / multi-range / non-bytes unit → ignore per RFC 9110 §14.2.
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    // Suffix range: last N bytes. `bytes=-0` is unsatisfiable by definition.
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  // RFC 9110 §14.1.1 draws a line between two failure modes:
  //   - first-pos >= size: the specifier is VALID but cannot be satisfied
  //     against this representation → 416 (with a `bytes */size` hint).
  if (start >= size) return 'unsatisfiable';
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  //   - first-pos > last-pos (e.g. `bytes=5-2`): the ranges-specifier itself
  //     is INVALID and MUST be ignored → full 200, never 416. Clamping cannot
  //     manufacture this case: start < size here, so end < start implies the
  //     RAW last-pos was below first-pos.
  if (start > end) return null;
  return { start, end };
}

export interface StreamFileOptions {
  /** Authoritative Content-Type — derived by the caller from SERVER-controlled
   *  state (a stored extension / a sniffed mime), never from client input. */
  contentType: string;
  /** Cache-Control header value (all current callers serve authed content and
   *  pass a `private, …` policy). */
  cacheControl: string;
  /** Log prefix identifying the calling surface (e.g. 'corpus audio'). */
  logContext: string;
}

/**
 * Stream an already-resolved, already-stat'ed file, honoring a single
 * byte-range request. `absPath`/`size` MUST come from the caller's own
 * traversal-checked resolution + fs.stat — this function trusts them.
 *
 * Synchronous header/status logic; the only async part is the pipe itself,
 * whose failure paths are wired to `next` (before headers) or a connection
 * teardown (after).
 */
export function streamFileWithRange(
  req: Request,
  res: Response,
  next: NextFunction,
  absPath: string,
  size: number,
  opts: StreamFileOptions,
): void {
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', opts.contentType);
  // nosniff: the browser must honor our Content-Type, never sniff the bytes
  // into an executable/other type (see header).
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', opts.cacheControl);

  const range = parseRangeHeader(req.headers.range, size);
  if (range === 'unsatisfiable') {
    // RFC 9110 §15.5.17: tell the client the actual size so it can re-request.
    res.setHeader('Content-Range', `bytes */${size}`);
    res.status(416).end();
    return;
  }

  // Degenerate empty file (should never ship, but a 0-byte file must not make
  // createReadStream throw on an inverted start/end pair).
  if (size === 0) {
    res.status(200);
    res.setHeader('Content-Length', 0);
    res.end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  } else {
    res.status(200);
  }
  res.setHeader('Content-Length', end - start + 1);

  const stream = createReadStream(absPath, { start, end });
  stream.on('error', (err) => {
    // File vanished / IO error mid-stream. If headers are gone we can only
    // sever the connection; otherwise surface a clean 500 via the handler.
    getLogger().error({ err, absPath }, `${opts.logContext}: stream error`);
    stream.destroy();
    if (res.headersSent) {
      res.destroy();
    } else {
      // stat→open race: the file was unlinked between the caller's fs.stat
      // and our open. That is a missing resource, not a server fault → typed
      // 404 instead of an opaque 500. The real path stays in the server log
      // above; the NotFoundError carries no path.
      const code = (err as NodeJS.ErrnoException).code;
      next(code === 'ENOENT' ? new NotFoundError() : err);
    }
  });
  // Client disconnect: stop reading the file (backpressure would eventually,
  // but destroying promptly frees the fd).
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
