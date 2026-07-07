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
import { Button } from './Button';
import { Card } from './Card';
import { ErrorCard } from './ErrorCard';
import { Eyebrow } from './Eyebrow';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import * as vocabService from '../services/vocab';
import { ApiError } from '../services/api';
import { errorMessageFor } from '../lib/errorCopy';
import type {
  ServerVocabList,
  VocabListEntryRow,
  VocabListKind,
} from '../types/domain';

const KIND_OPTIONS: ReadonlyArray<VocabListKind> = [
  'vocab',
  'grammar',
  'hanja',
  'mixed',
];

export function MyVocabLists(): JSX.Element {
  const [lists, setLists] = useState<ServerVocabList[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newEn, setNewEn] = useState('');
  const [newKind, setNewKind] = useState<VocabListKind>('vocab');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
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
    load();
  }, [load]);

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
      setNewKind('vocab');
      load();
    } catch (err) {
      setCreateError(errorMessageFor(err, 'Could not create the list.'));
    } finally {
      setCreating(false);
    }
  }, [newName, newEn, newKind, creating, load]);

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
        setError(errorMessageFor(err, 'Could not delete the list.'));
      }
    },
    [load],
  );

  return (
    <div className="km-resources__panel">
      <Card className="km-resources__create" variant="flat">
        <Eyebrow>New list</Eyebrow>
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
          <Button
            variant="gold"
            size="sm"
            onClick={() => {
              void create();
            }}
            disabled={newName.trim().length === 0 || creating}
          >
            {creating ? 'Creating…' : 'Create'}
          </Button>
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
        <div
          role="radiogroup"
          aria-label="List kind"
          className="km-review__kindOpts"
        >
          {KIND_OPTIONS.map((k) => (
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
              {k}
            </button>
          ))}
        </div>
        {createError ? <ErrorCard message={createError} /> : null}
      </Card>

      {loading ? (
        <div className="km-grammar__state" role="status">
          Loading your lists…
        </div>
      ) : error && lists.length === 0 ? (
        <ErrorCard message={error} onRetry={load} />
      ) : lists.length === 0 ? (
        <p className="km-reference__empty">
          No lists yet. Create one above, then add words from the Browse view.
        </p>
      ) : (
        <Card className="km-reference__list" variant="flat">
          <ul>
            {lists.map((list) => (
              <li key={`list:${String(list.id)}`} className="km-reference__row">
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
                      {list.entry_count} {list.entry_count === 1 ? 'word' : 'words'}
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
      )}

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
            <Eyebrow>List</Eyebrow>
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
              {list?.entry_count ?? 0}{' '}
              {(list?.entry_count ?? 0) === 1 ? 'word' : 'words'}
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
              {renameBusy ? 'Saving…' : 'Save name'}
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
              Rename
            </Button>
          )}
        </div>

        <hr className="hr-double km-review__sheetRule" />

        {loading ? (
          <div className="km-grammar__state" role="status">
            Loading words…
          </div>
        ) : null}
        {error ? <ErrorCard message={error} onRetry={load} /> : null}
        {!loading && entries.length === 0 && !error ? (
          <p className="km-reference__empty">
            No words in this list yet. Add some from the Browse view.
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
