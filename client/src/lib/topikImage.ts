/**
 * topikImage — presentation split for image-dependent TOPIK items.
 *
 * 145 items in the live pool have `has_image=true` but NO stored image asset:
 * the source PDFs showed pictures (e.g. listening "pick the matching picture"
 * items whose four choices are pictures, or reading items built on a banner /
 * notice graphic), and the corpus captured only a bracketed TEXT description,
 * embedded in the item's stem — e.g.
 *
 *   여자: 어디가 아파서 오셨어요? …
 *   [알맞은 그림 고르기: ①진료실 진찰 ②병원 접수처 ③입원 병실 ④대기실]
 *
 * Buried at the end of a transcript (or rendered as the entire prompt with no
 * framing), that description reads as noise and the item looks unanswerable.
 * `splitImageItem` pulls the bracketed description(s) out of the prompt so the
 * screens can render them prominently in a labelled "image described in text"
 * block, with the remaining prompt text shown as the normal prompt.
 *
 * Deliberately applied ONLY to `hasImage` items (the callers gate on the
 * flag): square brackets in a normal item's text are never touched.
 */

/** The prompt split for an image-dependent item. */
export interface ImageItemSplit {
  /** The prompt with the bracketed image description(s) removed. May be ''
   *  when the whole prompt was the description (common for reading items). */
  body: string;
  /**
   * The image description to render prominently: the curated `imageText` when
   * the corpus captured one, else the bracketed `[…]` segment(s) extracted
   * from the prompt (joined by newlines), else null — the item references an
   * image whose description was never captured.
   */
  description: string | null;
}

/**
 * Matches one non-nested bracketed segment. `[^\][]` keeps the match inside a
 * single pair (no spanning across `][`), and the `*` tolerates an empty pair.
 */
const BRACKET_SEGMENT = /\[[^\][]*\]/g;

/**
 * Split an image-dependent item's prompt into the visible body and the image
 * description to feature. Pure and total: any string input yields a result,
 * so a malformed prompt can never break the render.
 */
export function splitImageItem(
  prompt: string,
  imageText?: string,
): ImageItemSplit {
  // A curated description wins; the prompt is left intact alongside it.
  const curated = imageText?.trim() ?? '';
  if (curated !== '') {
    return { body: prompt.trim(), description: curated };
  }

  const segments = prompt.match(BRACKET_SEGMENT) ?? [];
  const descriptions = segments
    .map((seg) => seg.slice(1, -1).trim()) // drop the enclosing brackets
    .filter((seg) => seg !== '');
  if (descriptions.length === 0) {
    return { body: prompt.trim(), description: null };
  }

  // Remove the extracted segments and collapse the whitespace they leave
  // behind, preserving intentional line structure in what remains.
  const body = prompt
    .replace(BRACKET_SEGMENT, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');

  return { body, description: descriptions.join('\n') };
}
