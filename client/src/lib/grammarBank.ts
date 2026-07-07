/**
 * Grammar bank-body construction — the single choke point where messy KGIU
 * corpus rows are coerced into a schema-valid `POST /grammar/bank` body.
 *
 * Extracted from pages/Grammar.tsx in Overhaul P1.2 (D3): the browse+bank
 * surface moved to the Review library (`/review/grammar`), and the weekly
 * suggestion strip banks through the same path, so the coercion rules live
 * here (lib/, not a component file — react-refresh/only-export-components
 * keeps page files component-only) and every bank gesture shares them.
 *
 * The server's `BankBodySchema` is strict (min/max lengths, closed register
 * + proficiency enums) and corpus data is messy — these helpers guarantee a
 * data quirk can never turn a user's Bank tap into a 400:
 *   - `register`   — included only when it exactly matches the server enum;
 *                    composite corpus values ("해요체 / 하십시오체") are
 *                    OMITTED (the field is optional).
 *   - `category`   — never empty (min 1): falls back to 'uncategorized';
 *                    clamped to the 40-char ceiling.
 *   - `summary_en` — never empty (min 1): falls back to the Korean pattern,
 *                    then the key; clamped to the 240-char ceiling.
 *   - `pattern_display` — clamped to 120; falls back to the key if blank.
 *   - `pattern_key` — NOT rewritten here; `grammarKey()` already derives a
 *                    regex-valid `GR-…` key for KGIU rows.
 *
 * Threat model: inputs are corpus strings (server-owned data), not user
 * input; the coercion exists for schema robustness, not sanitisation. The
 * body is sent via the session cookie (`SameSite=Strict` CSRF posture in
 * services/api.ts) and the server re-validates everything with Zod.
 */
import { grammarKey } from './grammarKey';
import type {
  BankGrammarBody,
  KgiuEntrySummary,
  RegisterLevel,
  ServerProficiency,
} from '../types/domain';

/**
 * Bucket KGIU `proficiency` strings into the server's closed set.
 *
 * The corpus uses values like `beginner`/`intermediate`/`advanced`; the
 * `POST /grammar/bank` body requires `'basic' | 'L3' | 'L4' | 'L5+'`.
 * Unknown strings fall back to `L3` so the call never 400s on a corpus
 * vocabulary drift — better to bank with a mild miscategorisation than
 * to refuse the user's gesture.
 */
export function toServerProficiency(
  raw: string | null | undefined,
): ServerProficiency {
  if (!raw) return 'L3';
  const norm = raw.toLowerCase();
  if (
    norm === 'basic' ||
    norm === 'beginner' ||
    norm.startsWith('l1') ||
    norm.startsWith('l2')
  ) {
    return 'basic';
  }
  if (norm === 'l3' || norm.includes('intermediate-low') || norm === 'l3-4') return 'L3';
  if (norm === 'l4' || norm === 'intermediate' || norm.includes('intermediate')) return 'L4';
  if (norm === 'l5+' || norm === 'l5' || norm === 'l6' || norm === 'advanced') return 'L5+';
  return 'L3';
}

/**
 * The server's closed register vocabulary — mirrors `BankBodySchema` in
 * server/src/routes/grammar.ts. The KGIU corpus stores register as FREE TEXT,
 * frequently composite ("해요체 / 하십시오체", "formal/written", "literary"),
 * and the server hard-400s any value outside this set.
 */
const SERVER_REGISTER_LEVELS: ReadonlySet<string> = new Set<RegisterLevel>([
  '반말',
  '해요체',
  '합쇼체',
  '문어체',
  '하오체',
  '하게체',
]);

/** Sanitize a raw corpus register: exact member of the server set (after a
 *  trim) or nothing. Composite values are dropped, never guessed at —
 *  `register` is optional metadata and must not fail the whole bank. */
export function toServerRegister(
  raw: string | null | undefined,
): RegisterLevel | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return SERVER_REGISTER_LEVELS.has(trimmed)
    ? (trimmed as RegisterLevel)
    : undefined;
}

/** The normalised fields `buildBankBody` coerces into a wire body. */
export interface GrammarBankSource {
  /** Server-side dedup key — already `GR-…`-shaped (see `grammarKey`). */
  patternKey: string;
  /** Korean pattern display ("-더라도"). */
  patternDisplay: string;
  /** English summary / title ("even if"). */
  summaryEn: string;
  /** Proficiency already bucketed into the server's closed set. */
  proficiency: ServerProficiency;
  /** Category string (may be blank — defaulted here). */
  category: string;
  /** RAW corpus register string (may be composite / null). */
  register: string | null;
}

/** Build a schema-valid `POST /grammar/bank` body from a normalised source. */
export function buildBankBody(src: GrammarBankSource): BankGrammarBody {
  const display = src.patternDisplay.trim().slice(0, 120) || src.patternKey;
  const summary = (
    src.summaryEn.trim() ||
    src.patternDisplay.trim() ||
    src.patternKey
  ).slice(0, 240);
  const category = (src.category.trim() || 'uncategorized').slice(0, 40);
  const register = toServerRegister(src.register);
  return {
    pattern_key: src.patternKey,
    pattern_display: display,
    summary_en: summary,
    proficiency: src.proficiency,
    category,
    ...(register !== undefined ? { register } : {}),
    discovered_via: 'manual',
  };
}

/** Build a bank body straight from a KGIU browse row (the Review-library
 *  grammar browse + the weekly suggestion strip both bank these). */
export function kgiuBankBody(row: KgiuEntrySummary): BankGrammarBody {
  return buildBankBody({
    patternKey: grammarKey(row),
    patternDisplay: row.pattern,
    summaryEn: row.title_en ?? row.pattern,
    proficiency: toServerProficiency(row.proficiency),
    category: row.category ?? 'pattern',
    register: row.register ?? null,
  });
}
