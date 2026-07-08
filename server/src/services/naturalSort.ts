/**
 * Natural (a.k.a. "alphanumeric") string comparator — shared by the two page
 * normalizers (services/zipPageExtract.ts, services/pdfPageRender.ts) so a
 * ZIP-of-images and a rendered PDF are ordered by the SAME rule: split each
 * name into runs of digits vs. non-digits and compare digit runs
 * numerically, not lexically.
 *
 * WHY this matters (U1a rework — db/docs/PDF_UPLOAD_DESIGN.md §"REVISION
 * (2026-07-08)"): a vFlat export's filenames seed `book_pages.page_number`.
 * Plain lexical sort would put "page10.jpg" before "page2.jpg" (the
 * character '1' < '2'); a scanner or export tool that doesn't zero-pad page
 * numbers would then produce a book whose pages are wildly out of order on
 * first upload, before a human ever gets to `PATCH /uploads/:id/pages/order`.
 * Zero-padded filenames (e.g. vFlat's typical "0001.jpg") already sort
 * correctly under plain lexical order, so this comparator is a superset:
 * correct for both padded and unpadded numeric filenames.
 */

/** Split into alternating digit-run / non-digit-run tokens, e.g.
 *  "page10.jpg" -> ["page", "10", ".jpg"]. */
function tokenize(name: string): string[] {
  return name.match(/(\d+)|(\D+)/g) ?? [name];
}

/**
 * Compare two strings "naturally": corresponding tokens that are both
 * all-digits compare as numbers; otherwise they compare as plain strings.
 * A name with fewer tokens than the other sorts first (matches
 * `Array.prototype.sort`'s comparator contract: negative/zero/positive).
 */
export function naturalCompare(a: string, b: string): number {
  const aTokens = tokenize(a);
  const bTokens = tokenize(b);
  const len = Math.max(aTokens.length, bTokens.length);
  for (let i = 0; i < len; i += 1) {
    const at = aTokens[i];
    const bt = bTokens[i];
    if (at === undefined) return -1;
    if (bt === undefined) return 1;
    const aIsNum = /^\d+$/.test(at);
    const bIsNum = /^\d+$/.test(bt);
    if (aIsNum && bIsNum) {
      const diff = Number(at) - Number(bt);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      // Equal numeric value but different literal (e.g. "01" vs "1") — fall
      // back to string compare so the sort is still total/deterministic.
      if (at !== bt) return at < bt ? -1 : 1;
    } else if (at !== bt) {
      return at < bt ? -1 : 1;
    }
  }
  return 0;
}
