# legacy-client archive

This directory is a **historical record**, not a code stash. The legacy
navy/gold pages that this archive nominally tracks were already removed
during the Pass 1 fix-pass — they could not survive the move to the new
hanji design system because they all imported `services/supabase.ts`, a
module that Pass 1 deleted with the rest of the Supabase substrate.
Leaving them in the tree would have broken `tsc -b` on every build, so
the fix-pass deleted them up front rather than carry dead code through
Pass 2.

The Pass 3 plan (`CLAUDE_DESIGN_INTEGRATION_PLAN.md` § Pass 3 — "Other
Pass 3 work") originally listed `archive/legacy-client/` as the place to
move those pages once the last legacy screen retired. By the time Pass 3
reached the archiving step the files had already been gone for two
passes, so this README is the archive: a pointer to where the diffs
actually live (git history + `PROJECT_HISTORY.md`) plus an explicit list
of what was removed and what now stands in for each page.

## Deleted in the Pass 1 fix-pass (no in-repo SHA — see git history)

The repository at `/root/Jared/9b. Korean Master -- OVERNIGHT/Repository`
is not a git repository at the time of writing, so a literal commit SHA
isn't available. The Pass 1 → Pass 2 transition is documented in
`/root/Jared/9b. Korean Master -- OVERNIGHT/PROJECT_HISTORY.md`; consult
that for the timeline.

Removed files (all paths relative to `Repository/client/`):

- `src/pages/Dashboard.tsx`
- `src/pages/Curriculum.tsx`
- `src/pages/Vocabulary.tsx`
- `src/pages/GrammarList.tsx`
- `src/pages/GrammarLesson.tsx`
- the original `src/pages/Reading.tsx` (navy/gold variant — predates the
  hanji `KoreanPassage` flow)
- the original `src/pages/Conversation.tsx` (navy/gold variant — predates
  the hanji Chat screen)

All seven shared a single blocker: they imported the deleted
`src/services/supabase.ts`. None of their visual or logic patterns
carried forward to the hanji design system; the design handoff
(`Claude Design/design_handoff_korean_master/`) is the new source of
truth for every screen.

## Replacements in the new design system

The hanji screens at `src/pages/` are the working replacements:

| Removed page              | Replacement (Pass 1 + Pass 2)                |
|---------------------------|----------------------------------------------|
| `Dashboard.tsx`           | `Today.tsx`                                  |
| `Curriculum.tsx`          | folded into `Today.tsx` + `Diagnostic.tsx`   |
| `Vocabulary.tsx`          | `Review.tsx` (FSRS) + `Reference.tsx`        |
| `GrammarList.tsx`         | `Grammar.tsx` (list + bank halves)           |
| `GrammarLesson.tsx`       | `Grammar.tsx` detail mode (Pass 9 drill)     |
| original `Reading.tsx`    | new `Reading.tsx` (hanji + `KoreanPassage`)  |
| original `Conversation.tsx` | `Chat.tsx`                                 |

The full screen roster now lives at:

```
src/pages/Today.tsx
src/pages/Reading.tsx
src/pages/Review.tsx
src/pages/Diagnostic.tsx
src/pages/Topik.tsx
src/pages/Grammar.tsx
src/pages/Hanja.tsx
src/pages/Images.tsx
src/pages/Chat.tsx
src/pages/Reference.tsx
src/pages/Settings.tsx
```

If you need the actual diffs for the removed pages, recover them from
git history once the repository is initialised, or from the project
snapshot referenced in `PROJECT_HISTORY.md`.
