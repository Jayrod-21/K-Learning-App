# Review — TTMIK Full-Transcript Data Layer (migration 036 + loader + tests)

**Reviewer:** independent senior read-only review, branch `feat/ttmik-transcripts`
**Scope:** `db/migrations/036_ttmik_transcript.{up,down}.sql`, `tools/ingest/loaders/load_ttmik_transcript.py`,
its registration in `tools/ingest/load_to_postgres.py`, `tools/ingest/tests/test_load_ttmik_transcript.py`.
**Method:** static read of all four files against `SENIOR_ENGINEER_BAR.md` + ADR-013; live read-only
queries against `km-db` (`ttmik_transcript_lines`, 9,525 rows / 232 lessons, as currently loaded); and —
because the DB queries surfaced something the task brief's own numbers didn't predict — a from-scratch
re-run of the *actual* parser (`parse_script_text`/`extract_pdf_text`, unmodified, in a throwaway venv,
no DB writes) against the three real corpus PDFs at
`/home/jared-williams/data/korean-master/corpus/TTMIK/Lessons/Lesson Scripts/` to get ground truth
independent of whatever run produced the current DB snapshot.

## Verdict

**REJECT.** The headline claim — "ZERO romanization anywhere" — is false, and it is false in both
directions on the *same* regex: romanization leaks through it, and it also destroys legitimate,
non-romanization English content that happens to share its bracket syntax. Both are reproducible at
scale (130 leaked rows / 76 corrupted rows across the full 232-lesson corpus, confirmed both in the
live table and by re-running the parser directly against the source PDFs), not one-off OCR flukes.
Migration 036 itself is clean and would pass on its own. The loader's transactional/idempotency
architecture is sound. Do not ship the parser as-is; 2 BLOCKERs below must be fixed and the corpus
reloaded (with `--force` — see footgun note) before this can be re-reviewed.

**BLOCKER count: 2** (both in `_INLINE_ROM_RE` / `_strip_inline_rom`, `load_ttmik_transcript.py:102-111`)

## Findings

### BLOCKER

1. **Romanization leaks through `_INLINE_ROM_RE` whenever the bracket doesn't start with `[A-Za-z]`.**
   `_INLINE_ROM_RE = re.compile(r"\s*\[[A-Za-z][^\]\)\\]*[\]\)\\]")` (line 102) requires the character
   immediately after `[` to be a Latin letter. TTMIK's Lesson Scripts routinely romanize grammar
   *particles/suffixes*, which are written with a leading hyphen (`-도`, `-고 싶어요`, `-을수록`,
   `-(으)ㄹ래요`, `-더라`) or a leading parenthetical (`(이)랑`). Their romanization is therefore written
   as `[-do]`, `[-go si-peo-yo]`, `[-eul-su-rok]`, `[-(eu)l-lae-yo]`, `[-deo-ra]`, `[(i)rang]` — none of
   which match `\[[A-Za-z]`. These lines sail through `_strip_inline_rom` untouched, and the
   "final pass" (line 329-343) re-runs the *same* regex, so it can't catch what the regex structurally
   can't match either. Confirmed in the live table (**130 rows**, `korean ~ E'\\[[^A-Za-z\\]]'`) and
   independently by re-parsing all three source PDFs with the unmodified parser (also **130** leaked
   rows: 45 in Levels 1-3, 73 in Levels 4-6, 12 in Levels 7-9). This is not an edge case — it fires on
   essentially every lesson that introduces a new grammar pattern, i.e. concentrated in the highest-value
   educational content. Examples straight from the DB: `id=29676` `"-고 싶어요 [-go si-peo-yo]"`,
   `id=30380` `"(이)랑 [(i)rang]"`, `id=32860` english=`"-아/어/여도 되다 [-a/eo/yeo-do doe-da] means..."`.
   **This directly violates the stated user directive ("ZERO romanization anywhere") and the loader's
   own reported claim of "0 romanization / 0 inline" is not true of the data actually in the table.**

2. **The same regex over-strips legitimate, non-romanization bracketed English content**, because it
   treats "bracket starting with a Latin letter" as a proxy for "is romanization" with no check that the
   bracket's *content* is phonetic. TTMIK's notes use `[...]` for grammatical category labels and
   sentence-pattern placeholders — e.g. `[past tense]`, `[present tense]`, `[honorific]`, `[noun]`,
   `[verb]`, `[object]`, `[informal]`, `[verb: 가다]`, and — worst — `[Original verb: 닫다 = to close]`.
   All of these get silently deleted by `_strip_inline_rom` because they start with a letter. Confirmed
   by re-parsing the raw PDFs directly (before any DB write): **76 distinct label/annotation brackets**
   removed across the corpus (13× `[past tense]`, 11× `[honorific]`, 11× `[noun]`, 8× `[present tense]`,
   etc. — see "Romanization check" below for the full list). This is not cosmetic: lesson `(8, 17)` in
   Levels 7-9 teaches the pattern *"Noun + -만 아니면 + Verb stem + -(으)ㄹ 텐데요 = If only it were not +
   `[noun]`, I would + `[verb]` = ..."* — after stripping, the stored prose reads **"If only it were not
   +, I would +"**, i.e. the placeholder words that make the grammar template legible are gone. A senior
   reviewer refuses to ship a "lossless verbatim" transcript column (per the migration's own column
   contract at `036_ttmik_transcript.up.sql:14-15`, "the left side is stored VERBATIM ... lossless")
   that deletes live grammatical content on a scale of dozens of instances across the flagship
   explanatory prose.
   **Root cause of both #1 and #2 is the same:** "starts with `[A-Za-z]`" is neither necessary
   (romanization can start with `-`/`(`) nor sufficient (English labels also start with a letter) as a
   test for "this bracket is romanization." The fix needs to positively identify romanization content
   (e.g. bracket body matches a Latin-syllable/hyphen/space/slash grammar shape AND does not itself
   contain the small set of English grammar-label words), not gate on the first character.

### SHOULD-FIX

3. **Idempotency footgun, not documented anywhere:** `load()` (`load_ttmik_transcript.py:413`) skips
   the entire file when `cp.status == "complete" and cp.source_sha256 == sha and not cfg.force` — keyed
   purely on the *PDF's* sha256, with no dependency on the parser code's own version/hash. A fix to
   `classify_line`/`_strip_inline_rom` (such as the one required by findings #1/#2 above) will **silently
   no-op** on the next run against the same, unchanged PDFs unless the operator remembers to pass
   `--force`. Nothing in the module docstring, `load_to_postgres.py`, or any `db/docs/*.md` says this.
   Given this review just found a parser bug that *requires* a forced reload to actually take effect,
   this footgun is not hypothetical — it will bite the very next deploy unless flagged. Recommend either
   (a) documenting it loudly in the module docstring and the corpus's dedicated `db/docs/ADR-019`-style
   note ("bump `--force` after any parser change"), or (b) folding a `PARSER_VERSION` constant into the
   checkpoint identity so a code change auto-invalidates the sha cache — same pattern used for
   cache-busting anywhere content is derived from code, not just from the source file.
4. **Test suite does not cover either BLOCKER, and would not have caught them.**
   `test_dialog_lines_strip_inline_romanization` (`test_load_ttmik_transcript.py:137`) only exercises a
   letter-leading bracket (`[annyeong-haseyo]`), which the current regex already handles — it can't
   catch finding #1. There is no test anywhere with a hyphen-prefixed or paren-prefixed inline
   romanization (`"-도 [-do]"`, `"(이)랑 [(i)rang]"`), which is the exact shape that leaks in production.
   Nor is there a test asserting that a legitimate bracketed grammar label (`[noun]`, `[verb]`,
   `[past tense]`) used inside a sentence-pattern line survives verbatim — which is exactly the assertion
   that would have caught finding #2 (and would fail against the current code). Recommend adding, at
   minimum: (a) parametrized `classify_line`/`parse_script_text` cases for hyphen-/paren-leading
   romanization brackets attached to particles, asserting the bracket is gone AND the particle itself
   (`-도`, `(이)랑`) is preserved; (b) a case with a `[noun]`/`[verb]` placeholder inside an
   english-side sentence template, asserting it is preserved untouched (would fail today).
5. **Resume-skip comparison mixes int-tuple sort order with string comparison of a different shape.**
   Iteration is `sorted(parsed.lessons.items())` (correct int-tuple order), but the skip check compares
   `source_id <= cp.last_item_id` as **strings**, where `source_id = f"ttmik-L{level}-{lesson:02d}"`
   (`load_ttmik_transcript.py:377-379,429-435`). Level is *not* zero-padded (fine today — TTMIK levels
   are single-digit 1-9) and lesson is zero-padded to exactly 2 digits. If any level ever has >99
   lessons, string comparison silently diverges from the true resume order and could skip lessons that
   haven't actually been loaded, or fail to skip ones that have. Not currently triggered (max lesson
   count per level in this corpus is well under 100), but it's a latent correctness trap with no guard
   or comment calling it out — worth either asserting `lesson < 100` at parse time or padding to 3
   digits defensively, mirroring the exact caution `migrate.py`'s own header already applies to its own
   version-padding scheme (see `db/migrate.py`'s `MIGRATION_PATTERN` comment on 3-digit zero-padding).
6. **Stale `cp.last_item_id` reused across a sha-changed resume of an in-progress load.** If a run
   crashes mid-file (`status='in_progress'`, `last_item_id` set) and the source PDF is then replaced
   before the retry, the retry still resumes from the old `last_item_id` against the new file's lesson
   set (`load_ttmik_transcript.py:429-437`) — there's no check that the sha hasn't changed since the
   in-progress checkpoint was written. Low-probability (requires swapping the PDF mid-crash-recovery)
   but silent if it happens; a comment or a `cp.source_sha256 == sha` guard on the resume branch (not
   just the skip-if-complete branch) would close it.

### NIT

7. `_looks_like_section_header` (line 171) is consulted with the loop's raw `line` variable, not the
   already-inline-rom-stripped text that `classify_line` computes internally — harmless today (headers
   are short titles that never carry romanization brackets in practice) but it's an inconsistency worth
   a one-line comment explaining why the two code paths intentionally look at different strings.
8. `DESTRUCTIVE_PATTERNS`-style reasoning in `migrate.py` explicitly justifies why `DROP TABLE` in
   `036 (down)` doesn't need extra ceremony beyond the standard `--allow-destructive` gate; the down
   migration's own comment (lines 1-8) already explains the lossy-by-design tradeoff well — no action
   needed, just noting it reads clearly.

### PRAISE

- Migration 036 is a model example of the Bar's DB conventions: named constraints throughout
  (`ck_ttmik_transcript_lines_kind`, `ck_..._ordinal_pos`, `ck_..._has_text`, `uq_..._lesson_ordinal`,
  `fk_..._lesson`), CHECK-constrained TEXT over a native enum with an explicit rationale (`up.sql:67-69`,
  matches Bar §4.1 verbatim), the FK-serving unique index deliberately reasoned about to avoid
  over-indexing (`up.sql:35-39`, matches Bar §4.4), `updated_at` maintained by a DB trigger rather than
  ORM-side `onupdate` (Bar §4.3), and column comments documenting the korean/english contract precisely
  enough that a client engineer needs nothing else. `down.sql` is honest about being lossy and states
  the recovery path (re-run the loader) rather than pretending the rollback is free.
- The loader's transaction discipline is correct and matches ADR-013: per-lesson `DELETE` + `INSERT` in
  one transaction (`load_ttmik_transcript.py:439-487`) means a crash mid-load can never leave a lesson
  half-replaced, and checkpoint progress is written in the *same* transaction as the batch
  (`checkpoint_progress` call at line 481 is inside the `conn.transaction()` block).
- Fail-loud posture is consistently applied: a PDF with zero `LEVEL n LESSON m` headers raises instead
  of silently completing (`load_ttmik_transcript.py:394-397`), unmatched lesson blocks are logged rather
  than dropped silently (line 516-517), and `--scripts-dir` with zero PDFs raises in the orchestrator
  rather than producing a silent no-op (`load_to_postgres.py:150-155`) — exactly the "report, never
  guess" principle the codebase's own ADR-019 asks for.
- Ordinal contiguity, mojibake/control-char stripping, and the 232/232 lesson-matching claim all verified
  correct against the live table (see below) — those three specific claims in the brief hold up.

## Detailed (file:line)

- `tools/ingest/loaders/load_ttmik_transcript.py:102` — `_INLINE_ROM_RE` definition; root cause of
  BLOCKER #1 and #2.
- `tools/ingest/loaders/load_ttmik_transcript.py:109-111` — `_strip_inline_rom`; called from
  `classify_line` (line 204) and again in the final pass (lines 337-338). Same flawed predicate both
  times, so the "final pass" cannot self-correct either failure mode.
- `tools/ingest/loaders/load_ttmik_transcript.py:329-343` — final normalization pass; correctly handles
  brackets that only complete after wrap-joining (verified: no unclosed `[`/`]`/`)`/`\` fragments survive
  in the live table), but inherits the same first-character heuristic bug.
- `tools/ingest/loaders/load_ttmik_transcript.py:413` — sha256-skip-on-complete check; see SHOULD-FIX #3
  (footgun: a parser fix silently no-ops without `--force`).
- `tools/ingest/loaders/load_ttmik_transcript.py:377-379, 429-437` — `_lesson_source_id` format + resume
  comparison; see SHOULD-FIX #5 (string-vs-tuple order latent trap) and #6 (stale checkpoint on
  sha-changed resume).
- `tools/ingest/tests/test_load_ttmik_transcript.py:137-143` — only test touching inline romanization
  stripping; doesn't cover the hyphen/paren-leading shape that leaks, or the label-preservation case that
  would catch the over-strip. See SHOULD-FIX #4.
- `db/migrations/036_ttmik_transcript.up.sql:14-15` — column-contract comment promising the korean side
  is stored "VERBATIM ... lossless"; contradicted by BLOCKER #2 in the shipped loader (the migration
  text itself is not at fault — the loader fails to meet the contract the migration documents).
- `db/migrations/036_ttmik_transcript.down.sql:1-10` — clean, reversible, honest about being lossy;
  no issues.

## Romanization check (live `km-db`, read-only)

Queried `ttmik_transcript_lines` directly (`docker exec -i km-db psql -U korean_master -d korean_master`):

```
SELECT count(*) FROM ttmik_transcript_lines;                    -- 9525 rows, 232 distinct lesson_id
SELECT kind, count(*) FROM ... GROUP BY kind;                    -- dialog 72, header 408, pair 2639, prose 6406
SELECT count(*) FROM ... WHERE kind='romanization';               -- 0  (standalone romanization-kind rows: correctly absent)
SELECT count(*) FROM ... WHERE korean ~ '\[[A-Za-z]';             -- 0  (the ONLY case the loader's own regex checks for)
SELECT count(*) FROM ... WHERE korean ~ '\[[^A-Za-z\]]';          -- 129 (leaked: bracket present, first char is NOT a letter)
SELECT count(*) FROM ... WHERE english ~ '\[[^A-Za-z\]]';           -- (1 more, e.g. id=32860) → 130 total leaked rows
```

So the loader's own success criterion (`\[[A-Za-z]` count == 0) is satisfied and would report "0
romanization" — while the actual bracket content, tested with the correct character class, shows 130
surviving romanization rows. Representative surviving rows pulled directly from the table:

| id | lesson_id | ordinal | kind | text |
|---|---|---|---|---|
| 29676 | 13 | 7 | pair | `-고 싶어요 [-go si-peo-yo]` |
| 30380 | 29 | 8 | pair | `(이)랑 [(i)rang]` |
| 30639 | 35 | 7 | prose | `- to be -ing = Verb stem + -고 있다 [-go it-da] Present progressive:` |
| 30879 | 42 | 3 | pair | `-(으)ㄹ 수 있다 [-(eu)l su it-da]` |
| 32860 | 89 | 13 | pair (english col) | `-아/어/여도 되다 [-a/eo/yeo-do doe-da] means "it is okay to..."` |

Cross-checked independently by re-extracting and re-parsing the three source PDFs directly (not via the
DB — same unmodified `extract_pdf_text`/`parse_script_text` functions, no DB writes) at
`/home/jared-williams/data/korean-master/corpus/TTMIK/Lessons/Lesson Scripts/`: **130 leaked
romanization rows** (45 in Levels 1-3, 73 in Levels 4-6, 12 in Levels 7-9) — an exact match with the
live table, confirming this is a deterministic parser defect, not a one-off load artifact.

Also confirmed, from the same from-scratch PDF re-parse, **76 non-romanization English bracket
annotations wrongly stripped** (already gone from the DB, since the strip happens before insert — this
can only be seen by re-parsing the raw PDF, not by querying the table): 13× `[past tense]`, 11×
`[honorific]`, 11× `[noun]`, 8× `[present tense]`, 4× `[future tense]`, 3× `[verb]`, 1× each of
`[Original verb: 닫다 = to close]` / `[Original verb: 시작하다 = to start]` / `[Original verb: 들어오다 =
to come in]` / `[Original verb: 가다 = to go]` / `[Original verb: 춥다 = to be cold]`, `[verb: 가다]`,
`[verb: 보다]`, `[verb: 먹다]`, `[verb: 하다]`, `[object]`, `[subject marker]`, `[informal]`,
`[polite/formal]`, `[noun group]`, `[verb stem + -는 것]`, plus capitalized variants (`[Present Tense]`,
`[Past Tense]`, `[Verb A]`, `[Verb B]`). The `(8, 17)` sentence-pattern lesson example in the Findings
section above is directly reproducible from this data.

Separately confirmed clean (claims in the brief that DID hold up): 0 rows with control characters
(`\x00-\x08\x0b\x0c\x0e-\x1f`), 0 rows with the U+FFFD replacement character, ordinals fully contiguous
1..n per lesson with no gaps (`ROW_NUMBER() OVER (...) = ordinal` for every row), every lesson's minimum
ordinal is exactly 1, and `count(DISTINCT lesson_id) = 232` matches the full catalog.
