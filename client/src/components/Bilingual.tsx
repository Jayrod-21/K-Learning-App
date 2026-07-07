/**
 * `<Bilingual en kr />` — the single primitive for bilingual UI CHROME text
 * (Overhaul P3a). Every nav/title/section label that today hand-composes
 * "한국어 · English" renders through this instead, so the user's
 * language-display setting (Settings → Appearance) applies everywhere at once.
 *
 * Behaviour by mode (from `useLanguageDisplay`, server-synced prefs):
 *   - 'en'   → English only.
 *   - 'ko'   → Korean only.
 *   - 'both' → the `primary` language as the MAIN text, then a "·" separator,
 *              then the other language as the SUB text. The sub sizes off the
 *              `--lang-sub-scale` CSS var that `SettingsProvider` projects
 *              onto `<html>` (`calc(1em * var(--lang-sub-scale, 0.7))`).
 *
 * Missing-language fallback: if the requested language is absent (P3b fills
 * the catalog incrementally), whatever IS present renders — never a blank.
 * Empty/whitespace strings count as absent.
 *
 * A11y — the accessible name ALWAYS carries both languages when both exist:
 * in a single-language visual mode the visible text is `aria-hidden` and a
 * `.km-sr-only` span provides the full bilingual reading, so a screen-reader
 * user's experience never degrades because of a *visual* preference. (When a
 * parent supplies its own `aria-label` — e.g. BottomNav's buttons — that
 * label wins and this fallback is simply inert.)
 *
 * SCOPE RULE (scout §c): chrome only. Learning-material text (vocab, grammar,
 * examples, TOPIK passages, dictionary/Hanja entries) must never render
 * through this component.
 *
 * No I/O — no threat model.
 */
import type { JSX } from 'react';
import { cn } from '../lib/cn';
import { useLanguageDisplay } from '../hooks/useLanguageDisplay';

export interface BilingualProps {
  /** English text. Optional — see missing-language fallback. */
  en?: string | undefined;
  /** Korean text. Optional — see missing-language fallback. */
  kr?: string | undefined;
  /** Extra class(es) on the wrapper — context styling hooks scope off this. */
  className?: string | undefined;
  /**
   * Compact variant for chrome too tight for two scripts (the BottomNav
   * hexagon): in 'both' mode render only the `primary` language visually —
   * the accessible name still carries both (same sr treatment as the
   * single-language modes). No effect in 'en'/'ko' modes.
   */
  compact?: boolean | undefined;
}

/** Normalise "absent": undefined OR empty/whitespace-only. */
function present(s: string | undefined): s is string {
  return typeof s === 'string' && s.trim() !== '';
}

/** One language segment. Korean gets the `kr` font class + `lang="ko"` so
 *  the correct typeface and screen-reader voice apply wherever it lands. */
function Segment({
  text,
  language,
  sub,
}: {
  text: string;
  language: 'en' | 'ko';
  sub: boolean;
}): JSX.Element {
  return (
    <span
      lang={language === 'ko' ? 'ko' : 'en'}
      className={cn(
        sub ? 'km-bilingual__sub' : 'km-bilingual__main',
        language === 'ko' ? 'kr km-bilingual__kr' : 'km-bilingual__en',
      )}
    >
      {text}
    </span>
  );
}

export function Bilingual({
  en,
  kr,
  className,
  compact = false,
}: BilingualProps): JSX.Element {
  const { mode, primary } = useLanguageDisplay();
  const hasEn = present(en);
  const hasKr = present(kr);
  const rootClass = cn('km-bilingual', className);

  // Only one language exists at all — every mode renders it plainly (the
  // accessible name IS the visible text; nothing to preserve).
  if (!hasEn || !hasKr) {
    const only = hasEn ? en : hasKr ? kr : undefined;
    const lang: 'en' | 'ko' = hasEn ? 'en' : 'ko';
    return (
      <span className={rootClass}>
        {present(only) ? (
          <Segment text={only} language={lang} sub={false} />
        ) : null}
      </span>
    );
  }

  if (mode === 'both' && !compact) {
    const mainIsKr = primary === 'ko';
    return (
      <span className={rootClass}>
        <Segment
          text={mainIsKr ? kr : en}
          language={mainIsKr ? 'ko' : 'en'}
          sub={false}
        />
        {/* The separator stays in the accessible name — screen readers treat
            "·" as punctuation, and keeping it means the computed name equals
            the visible "kr · en" exactly (aria-label call sites already use
            that shape). */}
        <span className="km-bilingual__sep">{' · '}</span>
        <Segment
          text={mainIsKr ? en : kr}
          language={mainIsKr ? 'en' : 'ko'}
          sub
        />
      </span>
    );
  }

  // Single-language VISUAL rendering with both languages available — either
  // a single-language mode, or 'both' in the compact variant (only the
  // primary shows). The accessible name keeps both, visible-language-first.
  const visibleIsEn = mode === 'en' || (mode === 'both' && primary === 'en');
  return (
    <span className={rootClass}>
      <span aria-hidden="true">
        <Segment
          text={visibleIsEn ? en : kr}
          language={visibleIsEn ? 'en' : 'ko'}
          sub={false}
        />
      </span>
      {/* The sr-only reading is composed from lang-tagged spans (not a flat
          template) so the Korean half keeps its screen-reader voice switch —
          accessible-name computation concatenates child text, so the computed
          name is still exactly "visible · other". */}
      <span className="km-sr-only">
        <span lang={visibleIsEn ? 'en' : 'ko'}>{visibleIsEn ? en : kr}</span>
        {' · '}
        <span lang={visibleIsEn ? 'ko' : 'en'}>{visibleIsEn ? kr : en}</span>
      </span>
    </span>
  );
}
