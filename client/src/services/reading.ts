/**
 * /reading — U3b digitized chapter reader client (server: routes/reading.ts,
 * `db/docs/U3_READER_DESIGN.md` §U3b). Two read-only GETs: the ordered
 * chapter list for one owned literature `BookUpload`, and one chapter's
 * metadata plus its ordered passages. Mirrors `services/uploads.ts`'s shape
 * — typed wire↔domain boundary, `AbortSignal` on every call.
 *
 * Threat model:
 *   - Auth + session: both routes are `requireAuth` server-side; the session
 *     cookie rides via `withCredentials` on the shared axios instance
 *     (services/api.ts) — no extra plumbing needed here.
 *   - IDOR: every row is scoped server-side to the session `user_id`
 *     (routes/reading.ts's own header) — a foreign or missing
 *     `source_upload_id`/`chapterId` uniformly 404s (never 403, so id-space
 *     probing reveals nothing). This client never has to reason about
 *     ownership; a failed lookup just surfaces as an `ApiError`.
 *   - Read-only: both routes are GET — no CSRF surface of their own.
 *   - Ids: unlike `services/uploads.ts` (whose BIGINT ids arrive as wire
 *     strings and get held as `string`), `routes/reading.ts` already
 *     converts every BIGINT id to a JSON number server-side (`Number(...)`
 *     — see its header), so no string/number split is needed on this side
 *     of the boundary.
 *   - Display fields (`title`, `body`) render as React text children
 *     downstream (Reading.tsx / TapKorean) — escaped, never HTML.
 */
import { api } from './api';
import type {
  ReadingChapter,
  ReadingChapterSummary,
  ReadingPassage,
} from '../types/domain';

/** Wire shape of one row in the chapter-list envelope. */
interface ChapterListRowWire {
  id: number;
  chapter_number: number;
  title: string | null;
  start_page: number | null;
  end_page: number | null;
}

/** Envelope returned by `GET /reading/chapters`. */
interface ChaptersListEnvelope {
  chapters: ChapterListRowWire[];
}

/** Wire shape of the chapter-detail endpoint's `chapter` field. */
interface ChapterWire {
  id: number;
  source_upload_id: number;
  chapter_number: number;
  title: string | null;
  start_page: number | null;
  end_page: number | null;
}

/** Wire shape of one row in the chapter-detail endpoint's `passages` field. */
interface PassageWire {
  id: number;
  passage_number: number;
  body: string;
  page_number: number | null;
}

/** Envelope returned by `GET /reading/chapters/:chapterId`. */
interface ChapterDetailEnvelope {
  chapter: ChapterWire;
  passages: PassageWire[];
}

function toChapterSummary(wire: ChapterListRowWire): ReadingChapterSummary {
  return {
    id: wire.id,
    chapterNumber: wire.chapter_number,
    title: wire.title,
    startPage: wire.start_page,
    endPage: wire.end_page,
  };
}

function toChapter(wire: ChapterWire): ReadingChapter {
  return {
    id: wire.id,
    sourceUploadId: wire.source_upload_id,
    chapterNumber: wire.chapter_number,
    title: wire.title,
    startPage: wire.start_page,
    endPage: wire.end_page,
  };
}

function toPassage(wire: PassageWire): ReadingPassage {
  return {
    id: wire.id,
    passageNumber: wire.passage_number,
    body: wire.body,
    pageNumber: wire.page_number,
  };
}

/**
 * GET /reading/chapters?source_upload_id= — the ordered chapter list for one
 * owned literature upload (the reader's chapter selector). `sourceUploadId`
 * takes `BookUpload.id` (the wire-string upload id) — the server's Zod query
 * schema coerces it to a number, so no client-side parse/validation is
 * needed here. 404s (as `ApiError`) if the upload isn't the caller's or
 * doesn't exist.
 */
export async function listChapters(
  sourceUploadId: string,
  signal?: AbortSignal,
): Promise<ReadingChapterSummary[]> {
  const res = await api.get<ChaptersListEnvelope>('/reading/chapters', {
    params: { source_upload_id: sourceUploadId },
    ...(signal !== undefined ? { signal } : {}),
  });
  return res.chapters.map(toChapterSummary);
}

/**
 * GET /reading/chapters/:chapterId — one chapter's metadata plus its ordered
 * passages (the reader body). 404s (as `ApiError`) for a missing or
 * cross-user chapter id.
 */
export async function getChapter(
  chapterId: number,
  signal?: AbortSignal,
): Promise<{ chapter: ReadingChapter; passages: ReadingPassage[] }> {
  const res = await api.get<ChapterDetailEnvelope>(
    `/reading/chapters/${String(chapterId)}`,
    signal !== undefined ? { signal } : undefined,
  );
  return {
    chapter: toChapter(res.chapter),
    passages: res.passages.map(toPassage),
  };
}
