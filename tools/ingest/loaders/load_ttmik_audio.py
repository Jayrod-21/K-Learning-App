"""
TTMIK audio loader (F-012).

Walks the corpus audio tree (``<corpus_root>/TTMIK/``), parses each mp3
filename into either a (lesson_level, lesson_number) pair or an Iyagi
episode number, and writes the file's corpus-RELATIVE path into
``ttmik_lessons.audio_path`` / ``iyagi_episodes.audio_path`` (migration 035).

Filename patterns that map to a DB table. NOTE: the corpus holds 1,179 mp3s
across several TTMIK sets, but only the two below have tables — the ~796
"How To Sound Like A Native Korean Speaker" bonus files (and other sets) have
no table and stay unmatched BY DESIGN; ~383 lesson/Iyagi files map here.

  * Iyagi:   ``TTMIK/이야기들/이야기/<N> TTMIK Iyagi <N>.mp3``
             → ``iyagi_episodes.episode_number = resolve(<N>)`` — NOT ``<N>``
             verbatim; see the "IYAGI SEASON-BLOCK RENUMBERING" note below.
  * Lessons: ``TTMIK/Lessons/Lesson <L>/<track> TTMIK Level <L> Lesson <M>.mp3``
             → ``ttmik_lessons.(lesson_level=<L>, lesson_number=<M>)``

Only the FILENAME is parsed (case-insensitively, whitespace-tolerantly);
the directory layout is never trusted for identity — a re-organized tree
still maps correctly as long as the names keep the ``TTMIK Level L Lesson M``
/ ``TTMIK Iyagi N`` tokens.

CONTRACT: the stored ``audio_path`` is RELATIVE to the corpus root (it always
starts with ``TTMIK/``), never a host-absolute path. The serving route joins
it under its own configured root and enforces containment — see migration 035
and server/src/routes/ttmik.ts.

IYAGI SEASON-BLOCK RENUMBERING (F-185 root cause — read before touching
``_IYAGI_RE`` or ``_resolve_iyagi_episode_number``): the on-disk Iyagi mp3s
are named with a LOCAL, gap-tolerant sequential number (``1`` .. ``146``) that
is NOT the same number space as ``iyagi_episodes.episode_number``, which
carries TTMIK's real site numbering, published in three season blocks
(1-50, 101-150, 201-246 — TTMIK restarts near-``1`` at the start of each
season rather than continuing the raw count). Proven empirically (2026-07-14)
by decoding each mp3's embedded ID3 lyrics (``USLT`` frame) and string-matching
that Korean transcript text against ``iyagi_*.json``'s per-unit sentence text:
local file "51" is content-identical to ``episode_number = 101`` (both are the
혈액형/blood-type episode), local "67" to ``episode_number = 117`` (both are
SNS/소셜), local "110"→"210", "119"→"219", "130"→"230", "146"→"246", every
pair off by exactly +50 (local 51-100) or +100 (local 101-146) — a clean,
2-breakpoint step function, not a gradual drift. Local numbers 1-50 need no
adjustment (season 1 keeps TTMIK's real numbers). ``ordinal`` on
``iyagi_episodes`` does NOT encode this — it's the row's position in its
season's JSON array with gaps collapsed out (e.g. episode_number=110 has
ordinal=10, which coincidentally equals the correct local-block offset only
because no content gap precedes it in that season; it under-counts once a
gap is passed and cannot be used as the season-number source of truth).

Before this fix, ``parse_audio_filename`` returned the LOCAL number verbatim
for Iyagi files, so the loader keyed its UPDATE on the wrong ``episode_number``
for every local file above 50. This was not merely "some files don't map" —
it was live, silent MIS-mapping: local season-3 files (101-146, real content
201-246) numerically collided with DB rows 101-146 (real content is the
season-2 topics) and overwrote their ``audio_path`` with the WRONG episode's
audio, while the true season-2 audio (local 51-100) and season-3 audio
(would-be local 201-246, which doesn't exist under that name) never matched
anything and silently landed in ``files_without_row``. Confirmed live in
``km-db``: ``iyagi_episodes.episode_number = 101`` (혈액형 topic) was serving
``TTMIK/이야기들/이야기/101 TTMIK Iyagi 101.mp3`` — which is actually the
쇼핑/shopping episode (real episode_number 201's audio). ``_resolve_iyagi_episode_number``
below fixes the key computed by ``parse_audio_filename``; running this loader
again (see ``tools/ingest/README.md`` / the runbook in ``BUGS_AND_FEATURES.md``
F-185) corrects the live rows — it does not require a migration or a content
reload, only a loader re-run, and is safe/idempotent per the IDEMPOTENCY note
below.

IDEMPOTENCY: a plain keyed UPDATE per file — re-running against the same tree
rewrites identical values and is a no-op in effect. Rows whose mp3 vanished
keep their last-known path (additive loader; clearing is a deliberate manual
operation, not a side effect of a partial tree).

WHY NO ``load_state`` CHECKPOINT (unlike the JSON loaders): the ``corpus``
enum has no ``ttmik_audio`` member, and the whole pass is ~1,300 single-row
updates inside one transaction — cheap, atomic, and safely re-runnable, so
resume bookkeeping would add a schema change for no benefit.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import structlog
from psycopg_pool import AsyncConnectionPool

from .runtime import LoaderConfig

logger = structlog.get_logger(__name__)

# Subdirectory of the corpus root that holds every TTMIK mp3.
TTMIK_SUBDIR = "TTMIK"

# ``<anything> TTMIK Level <L> Lesson <M>.mp3`` — case-insensitive, flexible
# whitespace. Anchored on the END of the filename so leading track numbers
# ("03 TTMIK Level 1 Lesson 3.mp3") and any future prefix junk are ignored.
_LESSON_RE = re.compile(
    # Trailing ``-<n>`` (e.g. "Lesson 17-1.mp3") is a part suffix on a
    # single-part lesson — map it to the lesson number; duplicate keys are
    # resolved first-wins downstream.
    r"ttmik\s+level\s+(\d{1,2})\s+lesson\s+(\d{1,3})(?:-\d+)?\s*\.mp3$",
    re.IGNORECASE,
)

# ``<anything> TTMIK Iyagi <N>.mp3`` — same tolerance. The optional ``#`` and
# ``episode`` tokens absorb known publisher variance without loosening the
# match into false positives (the number is still required).
_IYAGI_RE = re.compile(
    # Trailing ``-<n>`` (e.g. "Iyagi 67-1.mp3") is a part suffix — map to the
    # episode number (first-wins on duplicate keys downstream).
    r"ttmik\s+iyagi\s+(?:episode\s+)?#?\s*(\d{1,4})(?:-\d+)?\s*\.mp3$",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class LessonKey:
    """Natural key of a ttmik_lessons row (uq_ttmik_lessons_level_lesson)."""

    level: int
    number: int


@dataclass(frozen=True)
class EpisodeKey:
    """Natural key of an iyagi_episodes row (uq_iyagi_episodes_number)."""

    number: int


# Season-block boundaries of the LOCAL (on-disk) Iyagi numbering — see the
# "IYAGI SEASON-BLOCK RENUMBERING" module docstring section for how these
# were derived and verified. Local numbers 1..50 are season 1 and need no
# adjustment; 51..100 are season 2 (real episode_number = local + 50);
# 101.. are season 3 (real episode_number = local + 100).
_IYAGI_SEASON1_MAX = 50
_IYAGI_SEASON2_MAX = 100


def _resolve_iyagi_episode_number(local_number: int) -> int:
    """Map the corpus's on-disk Iyagi track number to the real
    ``iyagi_episodes.episode_number`` TTMIK actually publishes it under.

    The local corpus renames each season's mp3s starting near 1 instead of
    preserving TTMIK's own season-prefixed site numbering (season 2 starts
    at 101, season 3 at 201). See the module docstring for the ID3-lyrics
    cross-reference that proved this exact 2-breakpoint offset.
    """
    if local_number <= _IYAGI_SEASON1_MAX:
        return local_number
    if local_number <= _IYAGI_SEASON2_MAX:
        return local_number + 50
    return local_number + 100


def parse_audio_filename(name: str) -> LessonKey | EpisodeKey | None:
    """Map an mp3 filename to its DB natural key, or None if unrecognized.

    Pure function — unit-tested against fixture names, no filesystem or DB.
    """
    m = _LESSON_RE.search(name)
    if m:
        return LessonKey(level=int(m.group(1)), number=int(m.group(2)))
    m = _IYAGI_RE.search(name)
    if m:
        return EpisodeKey(number=_resolve_iyagi_episode_number(int(m.group(1))))
    return None


@dataclass
class ScanResult:
    """Outcome of walking the audio tree — keys → corpus-relative paths."""

    lessons: dict[LessonKey, str] = field(default_factory=dict)
    episodes: dict[EpisodeKey, str] = field(default_factory=dict)
    # mp3s whose filename parsed to no key (report, never guess — ADR-019 §D10
    # fail-loud applies to visibility; an unparsed file is not an error, it is
    # a reported gap for the operator to inspect).
    unparsed: list[str] = field(default_factory=list)
    # Second-or-later file claiming an already-claimed key. First one (in
    # sorted path order, so deterministic) wins; the rest are reported.
    duplicates: list[str] = field(default_factory=list)


def scan_audio_tree(corpus_root: Path) -> ScanResult:
    """Walk ``<corpus_root>/TTMIK`` and bucket every mp3 by parsed key.

    Paths in the result are POSIX-relative to ``corpus_root`` (they start
    with ``TTMIK/``) — exactly the value stored in ``audio_path``.

    Raises FileNotFoundError when the TTMIK subdirectory is absent, so a
    mispointed ``--audio-dir`` fails loudly instead of "matching zero files".
    """
    ttmik_dir = corpus_root / TTMIK_SUBDIR
    if not ttmik_dir.is_dir():
        raise FileNotFoundError(
            f"{ttmik_dir} is not a directory — --audio-dir must be the corpus "
            f"root CONTAINING the {TTMIK_SUBDIR}/ tree, not the tree itself"
        )
    result = ScanResult()
    # Sorted for deterministic first-wins duplicate resolution across runs.
    for path in sorted(p for p in ttmik_dir.rglob("*") if p.is_file()):
        if path.suffix.lower() != ".mp3":
            continue  # cover art, playlists, .DS_Store — not audio, not "unparsed"
        rel = path.relative_to(corpus_root).as_posix()
        key = parse_audio_filename(path.name)
        if key is None:
            result.unparsed.append(rel)
            continue
        bucket: dict = result.lessons if isinstance(key, LessonKey) else result.episodes
        if key in bucket:
            result.duplicates.append(rel)
            continue
        bucket[key] = rel
    return result


async def load(pool: AsyncConnectionPool, source_path: Path, cfg: LoaderConfig) -> dict:
    """Scan ``source_path`` (the corpus ROOT) and update audio_path columns.

    All updates run in ONE transaction — a failure mid-pass leaves every
    ``audio_path`` exactly as it was (no partially-mapped corpus).

    Returns a report dict: matched / file-without-row / row-without-file
    counts plus the unparsed + duplicate path lists.
    """
    log = logger.bind(corpus="ttmik_audio", source_path=str(source_path))
    scan = scan_audio_tree(source_path)
    log.info(
        "scan_complete",
        lesson_files=len(scan.lessons),
        episode_files=len(scan.episodes),
        unparsed=len(scan.unparsed),
        duplicates=len(scan.duplicates),
    )
    for rel in scan.unparsed:
        log.warning("unparsed_mp3", path=rel)
    for rel in scan.duplicates:
        log.warning("duplicate_key_mp3", path=rel)

    lessons_matched = 0
    episodes_matched = 0
    files_without_row: list[str] = []

    async with pool.connection() as conn:
        async with conn.transaction():
            async with conn.cursor() as cur:
                for lkey, rel in sorted(
                    scan.lessons.items(), key=lambda kv: (kv[0].level, kv[0].number)
                ):
                    await cur.execute(
                        """
                        UPDATE ttmik_lessons
                           SET audio_path = %s
                         WHERE lesson_level = %s AND lesson_number = %s
                        """,
                        (rel, lkey.level, lkey.number),
                    )
                    if cur.rowcount == 1:
                        lessons_matched += 1
                    else:
                        files_without_row.append(rel)
                for ekey, rel in sorted(
                    scan.episodes.items(), key=lambda kv: kv[0].number
                ):
                    await cur.execute(
                        """
                        UPDATE iyagi_episodes
                           SET audio_path = %s
                         WHERE episode_number = %s
                        """,
                        (rel, ekey.number),
                    )
                    if cur.rowcount == 1:
                        episodes_matched += 1
                    else:
                        files_without_row.append(rel)

                # Rows the tree did NOT cover — visibility for the operator
                # (e.g. a lesson whose mp3 was never published). Read inside
                # the same transaction so the numbers are consistent with the
                # updates above.
                await cur.execute(
                    "SELECT COUNT(*) FROM ttmik_lessons WHERE audio_path IS NULL"
                )
                row = await cur.fetchone()
                lessons_without_audio = int(row[0]) if row else 0
                await cur.execute(
                    "SELECT COUNT(*) FROM iyagi_episodes WHERE audio_path IS NULL"
                )
                row = await cur.fetchone()
                episodes_without_audio = int(row[0]) if row else 0

    for rel in files_without_row:
        log.warning("file_without_db_row", path=rel)
    report = {
        "status": "complete",
        "lessons_matched": lessons_matched,
        "episodes_matched": episodes_matched,
        "files_without_row": len(files_without_row),
        "files_unparsed": len(scan.unparsed),
        "files_duplicate_key": len(scan.duplicates),
        "lessons_without_audio": lessons_without_audio,
        "episodes_without_audio": episodes_without_audio,
    }
    log.info("load_complete", **report)
    return report
