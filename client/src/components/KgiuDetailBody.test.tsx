/**
 * KgiuDetailBody — element-shape hardening tests (REVIEW_F018 SF-2).
 *
 * The DB CHECK pins `jsonb_typeof = 'array'` on the three rich columns but
 * NOTHING about element shape, so a malformed loader row used to crash the
 * whole screen to the app ErrorBoundary ("Objects are not valid as a React
 * child" for a non-string formation rule; TypeError at `dialogue.lines.map`
 * for a dialogue missing `lines`). These tests feed a deliberately malformed
 * detail and assert the component renders every VALID part and never throws
 * — they FAIL against the unguarded render (the render call itself throws).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KgiuDetailBody } from './KgiuDetailBody';
import type { KgiuEntryDetail } from '../types/domain';

/** Well-formed baseline detail (arrays empty; wire never carries null here). */
const BASE: KgiuEntryDetail = {
  id: 42,
  corpus: 'kgiu_intermediate',
  source_id: 'KGIU-INT-007',
  pattern: '-더라도',
  title_en: 'even if / even though',
  category: 'concessive',
  proficiency: 'intermediate',
  unit: 'Unit 7',
  source_pages: null,
  explanation: 'Strong concessive — even if the premise holds.',
  formation_rules: [],
  examples: [],
  dialogues: [],
  vocabulary: null,
  tips: null,
  compare_with: null,
  exercises: null,
  cultural_notes: null,
};

/**
 * Every malformation class from the review, mixed with one valid element per
 * section. Cast through `unknown` because this is exactly the case the static
 * types promise can't happen — but an unvalidated JSONB load can produce.
 */
const MALFORMED = {
  ...BASE,
  formation_rules: [
    'Verb stem + 더라도', // valid — must render
    { rule: 'object-not-string' }, // React-child crash pre-guard
    42, // non-string primitive
    null,
  ],
  examples: [
    { korean: '비가 오더라도 갈 거예요.', english: "Even if it rains, we'll go." }, // valid
    { english: 'missing korean' }, // missing korean → skipped
    { korean: 7, english: 'non-string korean' }, // wrong type → skipped
    null,
    'not-an-object',
  ],
  dialogues: [
    { context: 'dialogue with no lines key' }, // .lines.map TypeError pre-guard
    null,
    {
      context: 'Two colleagues at the office.',
      lines: [
        {
          speaker: '수진',
          korean: '일이 많더라도 오늘 끝내야 해요.',
          english: 'Even if there is a lot of work, we must finish today.',
        }, // valid — must render
        { speaker: '민호' }, // turn missing korean/english → skipped
        'not-an-object',
      ],
    },
  ],
} as unknown as KgiuEntryDetail;

describe('KgiuDetailBody — malformed element shapes degrade, never crash', () => {
  it('renders the valid elements of each section and skips malformed ones', () => {
    expect(() => render(<KgiuDetailBody detail={MALFORMED} />)).not.toThrow();

    // Explanation + unit footer untouched by the bad arrays.
    expect(screen.getByText(/Strong concessive/)).toBeInTheDocument();
    expect(screen.getByText(/Unit · Unit 7/)).toBeInTheDocument();

    // Formation: valid bullet renders, non-string elements are dropped.
    expect(screen.getByText('Formation')).toBeInTheDocument();
    expect(screen.getByText('Verb stem + 더라도')).toBeInTheDocument();
    expect(screen.queryByText('42')).not.toBeInTheDocument();

    // Examples: the one valid pair renders; malformed ones are skipped.
    expect(screen.getByText('Examples')).toBeInTheDocument();
    expect(screen.getByText('비가 오더라도 갈 거예요.')).toBeInTheDocument();
    expect(screen.getByText("Even if it rains, we'll go.")).toBeInTheDocument();
    expect(screen.queryByText('missing korean')).not.toBeInTheDocument();
    expect(screen.queryByText('non-string korean')).not.toBeInTheDocument();

    // Dialogues: the lines-less dialogue is skipped; the valid one renders
    // its context + valid turn, and its malformed turn is dropped.
    expect(screen.getByText('Dialogues')).toBeInTheDocument();
    expect(
      screen.queryByText('dialogue with no lines key'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Two colleagues at the office.')).toBeInTheDocument();
    expect(screen.getByText('수진')).toBeInTheDocument();
    expect(
      screen.getByText('일이 많더라도 오늘 끝내야 해요.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('민호')).not.toBeInTheDocument();
  });

  it('suppresses a section header when every element is malformed (matches the empty-array look)', () => {
    const allBad = {
      ...BASE,
      formation_rules: [{ rule: 'object' }, 7],
      examples: [null, 'nope'],
      dialogues: [{ context: 'no lines' }],
    } as unknown as KgiuEntryDetail;

    expect(() => render(<KgiuDetailBody detail={allBad} />)).not.toThrow();

    expect(screen.queryByText('Formation')).not.toBeInTheDocument();
    expect(screen.queryByText('Examples')).not.toBeInTheDocument();
    expect(screen.queryByText('Dialogues')).not.toBeInTheDocument();
    // The well-formed scalar fields still render.
    expect(screen.getByText(/Strong concessive/)).toBeInTheDocument();
    expect(screen.getByText(/Unit · Unit 7/)).toBeInTheDocument();
  });

  it('survives a non-array container (impossible per the DB CHECK, cheap to cover)', () => {
    const nonArray = {
      ...BASE,
      formation_rules: 'not-an-array',
      examples: { korean: 'obj' },
      dialogues: null,
    } as unknown as KgiuEntryDetail;

    expect(() => render(<KgiuDetailBody detail={nonArray} />)).not.toThrow();
    expect(screen.queryByText('Formation')).not.toBeInTheDocument();
    expect(screen.queryByText('Examples')).not.toBeInTheDocument();
    expect(screen.queryByText('Dialogues')).not.toBeInTheDocument();
    expect(screen.getByText(/Unit · Unit 7/)).toBeInTheDocument();
  });
});
