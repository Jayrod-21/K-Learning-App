/**
 * Corpus-book manifest for the operator bulk-ingest CLI
 * (src/scripts/bulk-ingest-books.ts).
 *
 * One entry per on-disk scanned-book archive (a vFlat-style ZIP of page
 * images, or a PDF) that the operator wants loaded into the app as a
 * `book_uploads` row + its `book_pages`. Kept as a plain, editable const in
 * its own module — adding a book is a one-line edit here, no CLI change.
 *
 * Fields:
 *   - `file`  — the archive's BASENAME inside the `--dir` the CLI is pointed
 *               at (never a path; the CLI joins it onto `--dir` itself).
 *   - `title` — the display title persisted to `book_uploads.title`. Because
 *               `book_uploads` UPSERTs on (user_id, title), the title is also
 *               the IDEMPOTENCY KEY: re-running the CLI with the same title
 *               REPLACES that book's pages rather than duplicating the book.
 *               Renaming a title here therefore creates a NEW book on the
 *               next run (the old one is left untouched).
 *   - `type`  — one of `BOOK_UPLOAD_TYPES` (services/bookUploadIngest.ts).
 *               A changed type re-tags the existing book on re-run.
 */
import type { BookUploadType } from '../services/bookUploadIngest.js';

export interface CorpusBookEntry {
  /** Archive basename inside the CLI's `--dir` (zip or PDF). */
  readonly file: string;
  /** Display title AND per-user idempotency key (`book_uploads.title`). */
  readonly title: string;
  /** `book_uploads.type` — must be a member of `BOOK_UPLOAD_TYPES`. */
  readonly type: BookUploadType;
}

/** Jared's 17 scanned-book archives (see memory: "Content corpus inventoried"). */
export const CORPUS_MANIFEST: readonly CorpusBookEntry[] = [
  {
    file: 'Learning Mindmap for Topik 2300_20260716.zip',
    title: 'Learning Mindmap for TOPIK 2300',
    type: 'both',
  },
  {
    file: '2000 Essential Korean Words Advanced_20260708.zip',
    title: '2000 Essential Korean Words (Advanced)',
    type: 'vocab',
  },
  { file: '그림으로 보는 이순신_20260716.zip', title: '그림으로 보는 이순신', type: 'comic' },
  { file: '그림으로 보는 한국사_20260716.zip', title: '그림으로 보는 한국사', type: 'comic' },
  { file: '이순신 이야기_20260716.zip', title: '이순신 이야기', type: 'comic' },
  { file: '삼국사기 1_20260716.zip', title: '삼국사기 1', type: 'literature' },
  { file: '삼국사기 2_20260716.zip', title: '삼국사기 2', type: 'literature' },
  { file: '삼국사기 5_20260716.zip', title: '삼국사기 5', type: 'literature' },
  { file: '삼국사기 6_20260716.zip', title: '삼국사기 6', type: 'literature' },
  { file: '삼국유사 5_20260716.zip', title: '삼국유사 5', type: 'literature' },
  { file: '너의 이름은._20260716.zip', title: '너의 이름은', type: 'literature' },
  {
    file: '내 삶에 힘이 되는 니체의 말_20260716 (1).zip',
    title: '내 삶에 힘이 되는 니체의 말',
    type: 'literature',
  },
  { file: 'Short Stories in Korean_20260716.zip', title: 'Short Stories in Korean', type: 'literature' },
  {
    file: 'Korean Folktales for Language Learners_20260716.zip',
    title: 'Korean Folktales for Language Learners',
    type: 'literature',
  },
  {
    file: 'Easy Korean Reading for Beginners_20260716.zip',
    title: 'Easy Korean Reading for Beginners',
    type: 'literature',
  },
  {
    file: 'Real-Life Korean Conversations_ Intermediate_20260716.zip',
    title: 'Real-Life Korean Conversations: Intermediate',
    type: 'dialogue',
  },
  { file: 'Korean Slang Expressions_20260716.zip', title: 'Korean Slang Expressions', type: 'vocab' },
];
