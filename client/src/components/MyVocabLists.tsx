/**
 * MyVocabLists — THE canonical "My Lists" surface (Overhaul P1.2 dedup).
 *
 * Before P1.2 two pages implemented a My-Lists UI over the same
 * `vocabService.listLists()` / `createList()` endpoints:
 *   - pages/Reference.tsx  → ListsTab (create / browse / open / remove-entry)
 *   - pages/Review.tsx     → ListsPanel "My lists" + CreateListSheet +
 *                            ListDetailSheet (rename / delete)
 * This component unifies BOTH into one owner, mounted in the Review library
 * under `/review/vocab` (the "My lists" view). It carries the UNION of the
 * two surfaces' capabilities so nothing was lost in the merge:
 *   - create a named list (Korean name + optional English label + kind)
 *   - list every list with entry counts; delete (confirm-gated)
 *   - open a list → real entries; remove an entry (optimistic w/ rollback)
 *   - rename a list from the detail sheet (`PATCH /vocab/lists/:id`)
 * The LEARN flashcards page (`/learn/vocab`) links here instead of rendering
 * its own copy.
 *
 * Batch-2 fix-pass (F-144 BLOCKER + F-147, `REVIEW_batch2-vocab.md` B-1):
 * the create form used to be an always-visible inline card whose "List
 * kind" radiogroup unconditionally offered vocab/grammar/hanja/mixed — so
 * navigating to `/review/vocab` (a page that must NEVER surface grammar UI)
 * showed a live "Grammar · 문법" option before the user touched anything.
 * Two independent fixes, both here:
 *   - F-147: the create form is now a `Sheet` popup behind a "New list"
 *     trigger button, matching every other create/add flow already on the
 *     Vocab page (`AddToListSheet`, the "This Week" sheet) instead of an
 *     always-inline card.
 *   - F-144: the `kinds` prop lets a mount restrict which kinds it offers.
 *     A single-kind mount (e.g. `kinds={['vocab']}` on the Vocab page) skips
 *     the radiogroup ENTIRELY — there's nothing to choose, so there's
 *     nothing labelled "Grammar" to see. `kinds` defaults to the full
 *     vocab/grammar/hanja/mixed set for backward compatibility with any
 *     future second consumer that genuinely needs the full picker.
 *
 * Threat model:
 *   - List CRUD is POST/PATCH/DELETE → CSRF surface, defended by the session
 *     cookie's `SameSite=Strict` (services/api.ts). Names render as React
 *     text children — no innerHTML. Error copy is fixed via errorMessageFor;
 *     server prose is never echoed.
 *   - Ownership (IDOR) is a server property: the routes 404 a list the
 *     session user doesn't own. The client passes numeric ids only.
 *   - Delete is confirm-gated (destructive, no undo yet); the optimistic
 *     entry-removal rolls back on failure so the view never lies.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { Bilingual } from './Bilingual';
import { Button } from './Button';
import { Card } from './Card';
import { ErrorCard } from './ErrorCard';
import { Eyebrow } from './Eyebrow';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { useToast } from './useToast';
import * as vocabService from '../services/vocab';
import { ApiError } from '../services/api';
import { errorMessageFor } from '../lib/errorCopy';
import type {
  ServerVocabList,
  VocabListEntryRow,
  VocabListKind,
} from '../types/domain';

/** Every list kind the server model supports — the default `kinds` set for
 * backward compatibility with a mount that doesn't narrow it. */
const ALL_KINDS: ReadonlyArray<VocabListKind> = [
  'vocab',
  'grammar',
  'hanja',
  'mixed',
];

/** Korean chrome labels for the list-kind radios (P3b). */
const KIND_KR: Record<VocabListKind, string> = {
  vocab: '단어',
  grammar: '문법',
  hanja: '한자',
  mixed: '혼합',
};

export interface MyVocabListsProps {
  /**
   * Which list kinds this mount offers when creating a new list. Defaults
   * to the full vocab/grammar/hanja/mixed set (backward-compatible with any
   * consumer that needs the full picker). Pass a narrower array — e.g.
   * `['vocab']` — to scope a mount to one domain: with exactly one kind,
   * the kind picker doesn't render at all (nothing to choose), and every
   * list this mount creates uses that one kind.
   */
  kinds?: ReadonlyArray<VocabListKind>;
}

export function MyVocabLists({
  kinds = ALL_KINDS,
}: MyVocabListsProps): JSX.Element {
  const { toast } = useToast();
  const [lists, setLists] = useState<ServerVocabList[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [openList, setOpenList] = useState<ServerVocabList | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    vocabService
      .listLists()
      .then((rows) => {
        setLists(rows);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(errorMessageFor(err, 'Could not load lists.'));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    // Sync-to-external-system (a network fetch) — the same kickoff-fetch
    // exception `useEndpointOrMock`/ReviewGrammar's mount effects document.
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    load();
  }, [load]);

  // Stable across renders (empty deps) — this is passed as `<Sheet>`'s
  // `onClose` inside `CreateListSheet` below. A NEW function identity every
  // render would re-run `useModalA11y`'s open/close effect on every
  // keystroke inside the sheet (its dep array includes `onClose`), and that
  // effect's cleanup re-focuses whatever was active before the sheet opened
  // — silently stealing focus back out of the name input after the first
  // character. `useCallback` (not an inline arrow) is load-bearing here, not
  // stylistic.
  const closeCreate = useCallback(() => {
    setCreateOpen(false);
  }, []);

  const remove = useCallback(
    async (list: ServerVocabList): Promise<void> => {
      const ok =
        typeof window !== 'undefined'
          ? window.confirm(`Delete "${list.name_kr}"? This cannot be undone.`)
          : true;
      if (!ok) return;
      try {
        await vocabService.deleteList(list.id);
        load();
      } catch (err) {
        // A failed delete happens while rows are still on screen, where the
        // load-error card never renders (it's the empty-state branch) — so a
        // toast is the feedback, not `setError`. Fixed copy via
        // errorMessageFor; server prose is never echoed. The rows are left
        // untouched (nothing was deleted), so the view stays honest.
        toast({
          message: errorMessageFor(err, 'Could not delete the list.'),
          tone: 'error',
        });
      }
    },
    [load, toast],
  );

  return (
    <div className="km-resources__panel">
      {/* F-147 — the create form is a Sheet popup behind this trigger,
          matching every other create/add flow on the Vocab page instead of
          an always-visible inline card. */}
      <div className="km-resources__createTrigger">
        <Button
          variant="gold"
          size="sm"
          leadingIcon={<Icon name="plus" size={14} />}
          onClick={() => {
            setCreateOpen(true);
          }}
        >
          <Bilingual en="New list" kr="새 목록" compact />
        </Button>
      </div>

      {loading ? (
        <div className="km-grammar__state" role="status">
          <Bilingual en="Loading your lists…" kr="목록을 불러오는 중…" />
        </div>
      ) : error && lists.length === 0 ? (
        <ErrorCard message={error} onRetry={load} />
      ) : lists.length === 0 ? (
        <p className="km-reference__empty">
          <Bilingual
            en="No lists yet. Create one above, then add words from the Browse view."
            kr="아직 목록이 없어요. 위에서 만든 뒤 둘러보기에서 단어를 추가하세요."
          />
        </p>
      ) : (
        <>
          {/* A refresh that failed while rows are on screen (e.g. the
              background reload after create/rename/delete) must not be
              silent — the rows below may be stale. Mirrors the
              WordMasterySection stale-banner pattern. */}
          {error ? (
            <ErrorCard
              message="Couldn't refresh your lists — showing the last loaded set."
              onRetry={load}
            />
          ) : null}
          <Card className="km-reference__list" variant="flat">
            <ul>
              {lists.map((list) => (
                <li
                  key={`list:${String(list.id)}`}
                  className="km-reference__row"
                >
                  <div className="km-resources__list-row">
                    <button
                      type="button"
                      className="km-resources__list-open focusring"
                      onClick={() => {
                        setOpenList(list);
                      }}
                      aria-label={`Open ${list.name_kr}`}
                    >
                      <span className="kr km-reference__row-kr">
                        {list.name_kr}
                      </span>
                      {list.name_en ? (
                        <span className="km-reference__row-en">
                          {list.name_en}
                        </span>
                      ) : null}
                      <span className="km-pill km-pill--default">
                        <Bilingual
                          en={`${String(list.entry_count)} ${list.entry_count === 1 ? 'word' : 'words'}`}
                          kr={`단어 ${String(list.entry_count)}개`}
                          compact
                        />
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void remove(list);
                      }}
                      aria-label={`Delete ${list.name_kr}`}
                    >
                      <Icon name="close" size={14} />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}

      <CreateListSheet
        open={createOpen}
        kinds={kinds}
        onClose={closeCreate}
        onCreated={load}
      />

      <ListDetailSheet
        list={openList}
        onClose={() => {
          setOpenList(null);
        }}
        onChanged={load}
      />
    </div>
  );
}

interface CreateListSheetProps {
  open: boolean;
  kinds: ReadonlyArray<VocabListKind>;
  onClose: () => void;
  /** Fired after a successful create so the parent refreshes its rows. */
  onCreated: () => void;
}

/**
 * F-147 — the "New list" create form, as its OWN component (not inline in
 * `MyVocabLists`), mirroring `ListDetailSheet`/`AddToListSheet`'s existing
 * split. This isn't just tidiness: the form's own keystroke state (name/
 * English label/kind) must NOT live in the same component that constructs
 * the `<Sheet>`'s `onClose` — if it did, every keystroke would re-render
 * that component, produce a brand-new inline `onClose` reference, and
 * re-trigger `useModalA11y`'s open/close effect (whose cleanup restores
 * focus to whatever was active before the sheet opened) on every
 * keystroke — silently kicking focus back out of the input after the very
 * first character. Keeping the form state HERE, in its own component,
 * means typing only re-renders this component, not `MyVocabLists`, so
 * `onClose`/`kinds` (received as already-stable props) never change
 * identity mid-type.
 */
function CreateListSheet({
  open,
  kinds,
  onClose,
  onCreated,
}: CreateListSheetProps): JSX.Element {
  const [newName, setNewName] = useState('');
  const [newEn, setNewEn] = useState('');
  const [newKind, setNewKind] = useState<VocabListKind>(kinds[0] ?? 'vocab');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const create = useCallback(async (): Promise<void> => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const en = newEn.trim();
      await vocabService.createList({
        name_kr: name,
        kind: newKind,
        ...(en ? { name_en: en } : {}),
      });
      setNewName('');
      setNewEn('');
      setNewKind(kinds[0] ?? 'vocab');
      onClose();
      onCreated();
    } catch (err) {
      setCreateError(errorMessageFor(err, 'Could not create the list.'));
    } finally {
      setCreating(false);
    }
  }, [newName, newEn, newKind, creating, kinds, onClose, onCreated]);

  return (
    <Sheet open={open} onClose={onClose} ariaLabel="New list">
      <div className="km-review__sheetBody">
        <div className="km-review__sheetHead">
          <div>
            <Eyebrow>
              <Bilingual en="New list" kr="새 목록" />
            </Eyebrow>
            <div className="kr-display km-review__sheetTitle">
              <Bilingual en="Create a list" kr="목록 만들기" />
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close new list"
          >
            <Icon name="close" size={14} />
          </Button>
        </div>
        <hr className="hr-double km-review__sheetRule" />

        <div className="km-resources__create-row">
          <input
            type="text"
            value={newName}
            onChange={(e) => {
              setNewName(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void create();
              }
            }}
            placeholder="List name (Korean)"
            className="kr focusring km-resources__create-input"
            aria-label="New list name"
            maxLength={120}
          />
        </div>
        <div className="km-resources__create-row">
          <input
            type="text"
            value={newEn}
            onChange={(e) => {
              setNewEn(e.target.value);
            }}
            placeholder="English label (optional)"
            className="focusring km-resources__create-input"
            aria-label="English label"
            maxLength={120}
          />
        </div>
        {/* F-144 — the kind picker only renders when this mount actually
            offers a CHOICE between kinds. A single-kind mount (e.g. the
            Vocab page's `kinds={['vocab']}`) never shows it — every list
            this mount creates just uses `kinds[0]`, and no other kind
            (grammar included) is ever a visible, tappable option. */}
        {kinds.length > 1 ? (
          <div
            role="radiogroup"
            aria-label="List kind"
            className="km-review__kindOpts"
          >
            {kinds.map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={newKind === k}
                onClick={() => {
                  setNewKind(k);
                }}
                className={`km-review__kindOpt focusring${newKind === k ? ' km-review__kindOpt--on' : ''}`}
                disabled={creating}
              >
                <Bilingual en={k} kr={KIND_KR[k]} compact />
              </button>
            ))}
          </div>
        ) : null}
        {createError ? <ErrorCard message={createError} /> : null}

        <div className="km-review__sheetActions">
          <Button
            variant="gold"
            size="md"
            onClick={() => {
              void create();
            }}
            disabled={newName.trim().length === 0 || creating}
          >
            {creating ? (
              <Bilingual en="Creating…" kr="만드는 중…" />
            ) : (
              <Bilingual en="Create" kr="만들기" />
            )}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

interface ListDetailSheetProps {
  list: ServerVocabList | null;
  onClose: () => void;
  /** Fired after a membership/name mutation so the parent refreshes rows. */
  onChanged: () => void;
}

function ListDetailSheet({
  list,
  onClose,
  onChanged,
}: ListDetailSheetProps): JSX.Element {
  const [entries, setEntries] = useState<VocabListEntryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<number | null>(null);
  // Rename state (ported from the old Review.tsx ListDetailSheet so the
  // capability survived the dedup). `displayName` shadows the row prop after
  // a successful rename so the header updates without waiting on the parent
  // refetch.
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  const listId = list?.id ?? null;

  const load = useCallback(() => {
    if (listId === null) return;
    const ctrl = new AbortController();
    ctrlRef.current?.abort();
    ctrlRef.current = ctrl;
    setLoading(true);
    setError(null);
    vocabService
      .getListDetail(listId, ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setEntries(res.entries);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(errorMessageFor(err, 'Could not load the list.'));
        setLoading(false);
      });
  }, [listId]);

  useEffect(() => {
    if (listId === null) {
      setEntries([]);
      setError(null);
      setRenaming(false);
      setRenameValue('');
      setDisplayName(null);
      return;
    }
    load();
    return () => {
      ctrlRef.current?.abort();
    };
  }, [listId, load]);

  const removeEntry = useCallback(
    async (entryId: number): Promise<void> => {
      if (listId === null) return;
      setRemovingId(entryId);
      // Optimistic removal — drop the row immediately; restore on failure.
      const prev = entries;
      setEntries((cur) => cur.filter((e) => e.entry_id !== entryId));
      try {
        await vocabService.removeListEntry(listId, entryId);
        onChanged();
      } catch (err) {
        setEntries(prev);
        setError(errorMessageFor(err, 'Could not remove the word.'));
      } finally {
        setRemovingId(null);
      }
    },
    [listId, entries, onChanged],
  );

  const currentName = displayName ?? list?.name_kr ?? '';

  const submitRename = useCallback(async (): Promise<void> => {
    if (listId === null || renameBusy) return;
    const next = renameValue.trim();
    if (!next || next === currentName) {
      setRenaming(false);
      return;
    }
    setRenameBusy(true);
    setError(null);
    try {
      const res = await vocabService.patchList(listId, { name_kr: next });
      setDisplayName(res.list.name_kr);
      setRenaming(false);
      onChanged();
    } catch (err) {
      setError(errorMessageFor(err, 'Rename failed.'));
    } finally {
      setRenameBusy(false);
    }
  }, [listId, renameBusy, renameValue, currentName, onChanged]);

  return (
    <Sheet open={list !== null} onClose={onClose} ariaLabel="List detail">
      <div className="km-review__sheetBody">
        <div className="km-review__sheetHead">
          <div>
            <Eyebrow>
              <Bilingual en="List" kr="목록" />
            </Eyebrow>
            {renaming ? (
              <input
                className="kr-display km-review__input"
                value={renameValue}
                onChange={(e) => {
                  setRenameValue(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void submitRename();
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setRenaming(false);
                    setRenameValue(currentName);
                  }
                }}
                aria-label="List name"
                disabled={renameBusy}
                maxLength={120}
              />
            ) : (
              <div className="kr-display km-review__sheetTitle">
                {currentName}
              </div>
            )}
            <div className="km-review__sheetMeta">
              {list?.name_en ? `${list.name_en} · ` : ''}
              <Bilingual
                en={`${String(list?.entry_count ?? 0)} ${(list?.entry_count ?? 0) === 1 ? 'word' : 'words'}`}
                kr={`단어 ${String(list?.entry_count ?? 0)}개`}
                compact
              />
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close list detail"
          >
            <Icon name="close" size={14} />
          </Button>
        </div>

        <div className="km-review__sheetActions">
          {renaming ? (
            <Button
              variant="ghost"
              size="md"
              onClick={() => {
                void submitRename();
              }}
              disabled={renameBusy}
            >
              {renameBusy ? (
                <Bilingual en="Saving…" kr="저장 중…" />
              ) : (
                <Bilingual en="Save name" kr="이름 저장" />
              )}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="md"
              leadingIcon={<Icon name="pen" size={14} />}
              onClick={() => {
                setRenameValue(currentName);
                setRenaming(true);
              }}
              disabled={list === null}
            >
              <Bilingual en="Rename" kr="이름 변경" />
            </Button>
          )}
        </div>

        <hr className="hr-double km-review__sheetRule" />

        {loading ? (
          <div className="km-grammar__state" role="status">
            <Bilingual en="Loading words…" kr="단어를 불러오는 중…" />
          </div>
        ) : null}
        {error ? <ErrorCard message={error} onRetry={load} /> : null}
        {!loading && entries.length === 0 && !error ? (
          <p className="km-reference__empty">
            <Bilingual
              en="No words in this list yet. Add some from the Browse view."
              kr="아직 단어가 없어요. 둘러보기에서 추가하세요."
            />
          </p>
        ) : null}
        {entries.length > 0 ? (
          <ul className="km-resources__list-entries">
            {entries.map((e) => (
              <li
                key={`entry:${String(e.entry_id)}`}
                className="km-resources__list-entry"
              >
                <span className="kr km-reference__row-kr">{e.korean ?? ''}</span>
                <span className="km-reference__row-en">{e.english ?? ''}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void removeEntry(e.entry_id);
                  }}
                  disabled={removingId === e.entry_id}
                  aria-label={`Remove ${e.korean ?? 'word'} from the list`}
                >
                  <Icon name="close" size={12} />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Sheet>
  );
}
