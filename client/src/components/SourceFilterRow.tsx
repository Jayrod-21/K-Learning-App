/**
 * SourceFilterRow — U1 "sort by source/upload" filter scaffolding for the
 * Review-library vocab + grammar browses (`db/docs/PDF_UPLOAD_DESIGN.md`
 * §"U1 → sort-by-source filter"). Renders exactly like the existing
 * domain/book_level `FilterGroup` chips: lists the user's READY uploads
 * (processing/failed books have no extractable content, so they're not
 * useful as a source filter yet) alongside an "All" sentinel, plus a
 * per-source "View PDF" affordance that opens the viewer for whichever
 * source is currently selected.
 *
 * Provenance coverage: as of F-107, `vocab_entries` rows mined with upload
 * provenance (`POST /vocab/mine`) DO carry `source_upload_id`, so the vocab
 * filter can return real rows; `kgiu_entries` rows still carry none until
 * U2's extraction ships, so the grammar filter returns zero rows today.
 * Both paths are FULLY WIRED (the query param + this UI) — an empty result
 * is data absence, not a bug. See the option docs in services/vocab.ts's
 * `SearchEntriesOptions.source_upload_id` and services/grammar.ts's
 * `ListPatternsOptions.source_upload_id`.
 *
 * Best-effort: a failed uploads fetch just leaves the row hidden (there is
 * nothing to filter by) rather than surfacing an error on a page whose
 * primary content loaded fine.
 */
import { useEffect, useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bilingual } from './Bilingual';
import { Button } from './Button';
import { Icon } from './Icon';
import { FilterGroup } from './LibraryControls';
import { listUploads } from '../services/uploads';
import type { BookUpload } from '../types/domain';

/** Sentinel value meaning "no source filter" — omits the query param. */
export const ALL_SOURCES = 'all';

export interface SourceFilterRowProps {
  ariaLabel: string;
  value: string;
  onChange: (next: string) => void;
}

export function SourceFilterRow({
  ariaLabel,
  value,
  onChange,
}: SourceFilterRowProps): JSX.Element | null {
  const navigate = useNavigate();
  const [uploads, setUploads] = useState<BookUpload[]>([]);

  useEffect(() => {
    let alive = true;
    listUploads()
      .then((rows) => {
        if (!alive) return;
        setUploads(rows.filter((u) => u.status === 'ready'));
      })
      .catch(() => {
        // Best-effort — see the header doc. The row just stays hidden.
      });
    return () => {
      alive = false;
    };
  }, []);

  // Nothing to filter by yet (no ready uploads) — a lone "All" chip would be
  // visual noise with zero function, so the whole row stays hidden.
  if (uploads.length === 0) return null;

  const options = [
    { id: ALL_SOURCES, label: 'All' },
    ...uploads.map((u) => ({ id: u.id, label: u.title })),
  ];
  const selected = uploads.find((u) => u.id === value) ?? null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      }}
    >
      <FilterGroup
        ariaLabel={ariaLabel}
        options={options}
        value={value}
        onChange={onChange}
      />
      {selected ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            navigate(`/uploads/${selected.id}`);
          }}
          leadingIcon={<Icon name="book" size={12} />}
        >
          <Bilingual en="View PDF" kr="PDF 보기" compact />
        </Button>
      ) : null}
    </div>
  );
}
