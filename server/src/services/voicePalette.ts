/**
 * Voice palette (F-210 v2 — multi-voice story audio).
 *
 * Maps the speakers of a generated story's `turns` to ElevenLabs voice ids so
 * each character is read by a distinct Korean voice. Pure assignment logic —
 * no I/O, no config reads — so it unit-tests exhaustively; the caller (the
 * story-audio runner) supplies the narrator voice id from config.
 *
 * The pool ids are ElevenLabs PUBLIC voice-library ids — identifiers, not
 * secrets (they are useless without an API key), so they are hardcoded here
 * as named constants rather than threaded through config. The NARRATOR voice
 * stays env-driven (ELEVENLABS_VOICE_ID) because it predates v2 and the
 * operator may already have tuned it.
 *
 * ASSIGNMENT RULE (deterministic per story):
 *   - The literal speaker 'narrator', a turn tagged gender 'narrator', or a
 *     turn with NO usable gender tag (old rows, a generator that omitted it)
 *     → the narrator voice. Degrading to the narrator is always safe: it is
 *     exactly the v1 behavior.
 *   - gender 'male'  → the next MALE pool voice, round-robin over the story's
 *     DISTINCT male speakers in order of first appearance (speaker index =
 *     count of male speakers assigned so far, modulo the pool size).
 *   - gender 'female' → same rule over the FEMALE pool.
 *   - A speaker keeps their FIRST assignment for the whole story, even if a
 *     later turn carries a conflicting gender tag — one character, one voice.
 */
import type { StoryTurn } from './claude/models.js';

/** Korean male voices (ElevenLabs voice-library ids). */
export const MALE_VOICE_POOL: readonly string[] = [
  '0mlAtfsvMzFpppUuNWkV', // Seunghyeon
  'LS3HmRGCXV8wxCAhUbTt', // Dong
  '7Nah3cbXKVmGX7gQUuwz', // Joon Park
  '7ZVPKvVmVZZERLd1Q6BS', // Min-jun
];

/** Korean female voices (ElevenLabs voice-library ids). */
export const FEMALE_VOICE_POOL: readonly string[] = [
  '8jHHF8rMqMlg8if2mOUe', // Han
  '5n5gqmaQi9Ewevrz7bOS', // Sian
  'Cm89zxZzEGaMu7ajYw2K', // Yoojin
  'tIXHSlSWOafJawXSV1g4', // Miso
  'XuzKX1PtsYzivdEFzo2g', // Tia
];

/**
 * Assign one voice id per distinct speaker (see the module header for the
 * rule). `narratorVoiceId` is REQUIRED — the caller owns the config read —
 * which keeps this function pure and trivially testable.
 */
export function assignVoices(
  turns: readonly StoryTurn[],
  narratorVoiceId: string,
): Map<string, string> {
  const assignment = new Map<string, string>();
  let maleCount = 0;
  let femaleCount = 0;
  for (const turn of turns) {
    if (assignment.has(turn.speaker)) continue; // first assignment sticks
    switch (turn.speaker === 'narrator' ? 'narrator' : turn.gender) {
      case 'male':
        assignment.set(turn.speaker, MALE_VOICE_POOL[maleCount % MALE_VOICE_POOL.length]!);
        maleCount++;
        break;
      case 'female':
        assignment.set(turn.speaker, FEMALE_VOICE_POOL[femaleCount % FEMALE_VOICE_POOL.length]!);
        femaleCount++;
        break;
      default:
        // 'narrator', undefined (old rows / omitted tag), or any future value
        // this build does not know — the narrator voice is always safe.
        assignment.set(turn.speaker, narratorVoiceId);
        break;
    }
  }
  return assignment;
}
