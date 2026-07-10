/**
 * Document-attach ingestion for chat (F-035 backend).
 *
 * The chat "+" button lets the user attach a text document to a conversation
 * (POST /conversation/:id/file). Unlike the image path (imageIngest.ts —
 * blob store + Vision OCR + image_captures rows), a text document needs NO
 * new storage: its text BECOMES the turn's `content` (bounded), so it rides
 * the existing messages JSONB, feeds Claude through the unchanged
 * projectHistory → generateConversation pipeline, and is retained/deleted
 * with the conversation. PDFs are out of scope here — the app has no PDF
 * TEXT-extraction infra (the book-upload PDF path renders page IMAGES), and
 * bolting one on for chat would be over-build; photograph a page and use the
 * image path instead.
 *
 * Threat model (mirrors imageIngest.ts's posture):
 *   - MIME spoofing: the declared mime is an early-reject hint only. The
 *     authority is a strict UTF-8 decode of the bytes (fatal: true) + a NUL
 *     check — a renamed binary/exe/PDF fails the decode and 400s regardless
 *     of its declared type.
 *   - Memory/DoS: multer memory storage with a 256 KiB fileSize cap (a chat
 *     attachment is a note/article, not a book) + files: 1.
 *   - Prompt injection: the stored text becomes PERSISTED Claude history. A
 *     poisoned document would make every LATER generateConversation call
 *     throw at its sanitize boundary — permanently wedging the conversation.
 *     So the shared injection guard runs HERE, at upload, and rejects with a
 *     400 before anything persists.
 *   - Path traversal: the client filename is display metadata ONLY — it never
 *     touches the filesystem. It is basename-stripped, control-char-stripped,
 *     and length-capped anyway (defense in depth for whatever renders it).
 *   - JSONB bloat: the stored excerpt is capped at DOC_TURN_MAX_CHARS, which
 *     deliberately equals the ConversationInputSchema per-turn history cap
 *     (4000) — a longer stored turn would fail the proxy's input parse on
 *     every later message and wedge the conversation.
 */
import type { NextFunction, Request, Response } from 'express';
import multer, { MulterError } from 'multer';
import { PayloadTooLargeError, ValidationError } from '../middleware/errors.js';
import { sanitizeUserInput } from './claudeProxy.js';

// ---------------------------------------------------------------------------
// Upload constraints + multer
// ---------------------------------------------------------------------------

/** Declared-mime allowlist — an early-reject hint, never the authority. */
export const ALLOWED_DOC_MIMES = ['text/plain', 'text/markdown'] as const;

/** 256 KiB — a chat attachment is a note or an article, not a book. */
export const MAX_DOC_UPLOAD_BYTES = 256 * 1024;

/**
 * Max characters of document text stored on the turn. MUST stay equal to the
 * per-turn history content cap in ConversationInputSchema (models.ts) — see
 * the header's JSONB-bloat note. Longer documents are truncated (flagged via
 * `truncated` on the turn's file block), never rejected.
 */
export const DOC_TURN_MAX_CHARS = 4_000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOC_UPLOAD_BYTES, files: 1, fields: 4 },
  fileFilter: (_req, file, cb) => {
    // Reject an obviously-wrong declared mime early (don't read 256 KiB of a
    // .exe into memory). Not trusted — the UTF-8 decode below is the
    // authority. Surfaces as no `req.file` → 400 at the presence check.
    cb(null, (ALLOWED_DOC_MIMES as readonly string[]).includes(file.mimetype));
  },
});

const uploadSingle = upload.single('file');

/**
 * Run multer for the document field and translate its errors into typed 4xx
 * (oversize → 413; unexpected field / extra files → 400). Mirrors
 * imageIngest.ts multerImageUpload.
 */
export function multerDocUpload(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  uploadSingle(req, res, (err: unknown) => {
    if (err instanceof MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        next(
          new PayloadTooLargeError(
            `document exceeds the ${MAX_DOC_UPLOAD_BYTES / 1024} KB limit`,
          ),
        );
        return;
      }
      next(new ValidationError(`invalid upload: ${err.code}`));
      return;
    }
    if (err) {
      next(err);
      return;
    }
    next();
  });
}

/** The validated, bounded document ready to append as a turn. */
export interface IngestedDocument {
  /** Sanitized display filename (basename only, never a path). */
  readonly name: string;
  /** The DECLARED mime from the allowlist (informational — bytes verified). */
  readonly mediaType: string;
  /** Original byte size of the upload. */
  readonly sizeBytes: number;
  /** Injection-checked text, ≤ DOC_TURN_MAX_CHARS — the turn's content. */
  readonly text: string;
  /** True when the document was longer than the stored excerpt. */
  readonly truncated: boolean;
}

/**
 * Validate the uploaded document and produce the bounded turn payload.
 * Throws typed 400s; persists nothing (the route owns the transaction).
 */
export function ingestAttachedDocument(
  file: Express.Multer.File | undefined,
): IngestedDocument {
  if (!file || !file.buffer || file.buffer.length === 0) {
    throw new ValidationError(
      `document file missing or empty (field "file"; allowed types: ${ALLOWED_DOC_MIMES.join(', ')})`,
    );
  }

  // Authority check: the BYTES must be valid UTF-8 text. `fatal: true` throws
  // on any ill-formed sequence, which every binary format (PDF, zip, exe,
  // PNG…) contains within its first bytes in practice; the explicit NUL check
  // closes the remaining "binary that happens to decode" hole.
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
  } catch {
    throw new ValidationError('document is not valid UTF-8 text');
  }
  if (decoded.includes('\u0000')) {
    throw new ValidationError('document contains binary content');
  }

  const trimmed = decoded.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('document contains no text');
  }

  // NFC-normalize BEFORE bounding. sanitizeUserInput re-normalizes and checks
  // length on the NORMALIZED text, and NFC can EXPAND certain code points
  // (composition exclusions, e.g. U+0958 → U+0915 U+093C) — so truncating
  // pre-NFC does NOT guarantee the guard's length check passes, and a clean
  // oversized document would 400 with an injection-flavored message.
  // Normalizing here first makes the guard's re-normalization a no-op (NFC is
  // idempotent), so its maxLength genuinely cannot fire on the excerpt below.
  const normalized = trimmed.normalize('NFC');

  // Bound on a CODE POINT boundary, then run the injection guard on exactly
  // what will persist. A raw .slice() cuts on UTF-16 code units and can
  // strand a lone high surrogate when the cap lands mid-astral-char (emoji,
  // CJK Extension B hanja — plausible in Korean-learning material); Postgres
  // rejects unpaired surrogates in ::jsonb input, so the route's INSERT would
  // 500 on a perfectly legitimate document.
  const excerpt = truncateAtCodePointBoundary(normalized, DOC_TURN_MAX_CHARS);
  const truncated = normalized.length > excerpt.length;
  let text: string;
  try {
    text = sanitizeUserInput(excerpt, { maxLength: DOC_TURN_MAX_CHARS });
  } catch {
    // PromptInjectionRejectedError — reject at the boundary (see header). The
    // marker itself is deliberately NOT echoed to the wire.
    throw new ValidationError(
      'document contains content that cannot be sent to the tutor',
    );
  }

  return {
    name: sanitizeFilename(file.originalname),
    mediaType: file.mimetype,
    sizeBytes: file.buffer.length,
    text,
    truncated,
  };
}

/**
 * Truncate to at most `maxUnits` UTF-16 code units without splitting a
 * surrogate pair. The input is well-formed UTF-16 here (it came from a strict
 * `fatal: true` UTF-8 decode, which cannot produce lone surrogates), so the
 * only possible stranding is OUR cut leaving the HIGH half of a pair at the
 * end — drop it. Never returns more than `maxUnits` units.
 */
function truncateAtCodePointBoundary(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  const sliced = text.slice(0, maxUnits);
  const last = sliced.charCodeAt(sliced.length - 1);
  // 0xD800–0xDBFF = high surrogate: its low half was cut off — drop it.
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

/**
 * Display-only filename hygiene: basename over both separator styles, control
 * characters stripped, length-capped, with a stable fallback. The result never
 * enters a filesystem path — this is defense in depth for UI rendering.
 */
function sanitizeFilename(raw: string | undefined): string {
  if (typeof raw !== 'string') return 'document.txt';
  const base = raw.split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (cleaned.length === 0) return 'document.txt';
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
}
