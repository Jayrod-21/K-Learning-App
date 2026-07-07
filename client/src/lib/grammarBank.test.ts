/**
 * lib/grammarBank — bank-body coercion rules.
 *
 * Ports the sanitization coverage Grammar.test.tsx used to drive through the
 * list tab's Bank button (the tab moved to /review/grammar in P1.2/D3; the
 * coercion logic moved here). The server's BankBodySchema is strict — these
 * pin the guarantees that a messy corpus row can never turn a Bank tap into
 * a 400.
 */
import { describe, expect, it } from 'vitest';
import {
  buildBankBody,
  kgiuBankBody,
  toServerProficiency,
  toServerRegister,
} from './grammarBank';
import type { KgiuEntrySummary } from '../types/domain';

const ROW: KgiuEntrySummary = {
  id: 42,
  corpus: 'kgiu_intermediate',
  source_id: 'KGIU-INT-007',
  pattern: '-더라도',
  title_en: 'even if / even though',
  category: 'concessive',
  proficiency: 'intermediate',
  unit: 'Unit 7',
  source_pages: null,
};

describe('toServerProficiency — buckets corpus strings into the closed set', () => {
  it.each([
    ['beginner', 'basic'],
    ['basic', 'basic'],
    ['intermediate', 'L4'],
    ['L3', 'L3'],
    ['L4', 'L4'],
    ['advanced', 'L5+'],
    ['L5+', 'L5+'],
    [null, 'L3'],
    ['weird-corpus-drift', 'L3'],
  ] as const)('%s → %s', (raw, expected) => {
    expect(toServerProficiency(raw)).toBe(expected);
  });
});

describe('toServerRegister — exact enum member or nothing', () => {
  it('passes an exact match through (after a trim)', () => {
    expect(toServerRegister('해요체')).toBe('해요체');
    expect(toServerRegister(' 반말 ')).toBe('반말');
  });

  it('drops composite / free-text values instead of guessing', () => {
    expect(toServerRegister('해요체/합쇼체')).toBeUndefined();
    expect(toServerRegister('formal/written')).toBeUndefined();
    expect(toServerRegister(null)).toBeUndefined();
  });
});

describe('buildBankBody — schema-valid body from a messy source', () => {
  it('builds the happy-path body with the optional register omitted', () => {
    const body = buildBankBody({
      patternKey: 'GR-kgiu-int-007',
      patternDisplay: '-더라도',
      summaryEn: 'even if / even though',
      proficiency: 'L4',
      category: 'concessive',
      register: null,
    });
    expect(body.pattern_key).toBe('GR-kgiu-int-007');
    expect(body.pattern_display).toBe('-더라도');
    expect(body.summary_en).toBe('even if / even though');
    expect(body.proficiency).toBe('L4');
    expect(body.category).toBe('concessive');
    expect(body.discovered_via).toBe('manual');
    // No register on the row → the optional field is omitted, not nulled.
    expect('register' in body).toBe(false);
  });

  it('drops a composite register and defaults empty min-1 fields', () => {
    const body = buildBankBody({
      patternKey: 'GR-kgiu-beginner-002',
      patternDisplay: 'N이다',
      summaryEn: '',
      proficiency: 'basic',
      category: '',
      register: '해요체/합쇼체',
    });
    // Composite register is OMITTED entirely — not sent as an invalid value.
    expect('register' in body).toBe(false);
    // min(1) fields never go out empty.
    expect(body.category).toBe('uncategorized');
    expect(body.summary_en).toBe('N이다'); // falls back to the pattern
    expect(body.pattern_display).toBe('N이다');
  });

  it('passes an exact-match register through', () => {
    const body = buildBankBody({
      patternKey: 'GR-kgiu-int-007',
      patternDisplay: '-더라도',
      summaryEn: 'even if',
      proficiency: 'L4',
      category: 'concessive',
      register: '해요체',
    });
    expect(body.register).toBe('해요체');
  });

  it('clamps over-long fields to the schema ceilings', () => {
    const body = buildBankBody({
      patternKey: 'GR-long',
      patternDisplay: '가'.repeat(300),
      summaryEn: 'x'.repeat(500),
      proficiency: 'L3',
      category: 'c'.repeat(100),
      register: null,
    });
    expect(body.pattern_display.length).toBe(120);
    expect(body.summary_en.length).toBe(240);
    expect(body.category.length).toBe(40);
  });
});

describe('kgiuBankBody — one-step body from a KGIU browse row', () => {
  it('derives the GR-shaped key and buckets the proficiency', () => {
    const body = kgiuBankBody(ROW);
    // grammarKey() derives the GR-shaped dedup key the server's
    // `^GR-[a-z0-9_-]{1,64}$` regex requires (raw source_id would 400).
    expect(body.pattern_key).toBe('GR-kgiu-int-007');
    expect(body.pattern_display).toBe('-더라도');
    expect(body.summary_en).toBe('even if / even though');
    expect(body.proficiency).toBe('L4'); // 'intermediate' bucketed
    expect(body.category).toBe('concessive');
    expect('register' in body).toBe(false);
  });

  it('defaults null title/category and sanitizes a composite register', () => {
    const body = kgiuBankBody({
      ...ROW,
      id: 77,
      source_id: 'kgiu-beginner-002',
      pattern: 'N이다',
      title_en: null,
      category: null,
      proficiency: 'beginner',
      register: '해요체/합쇼체',
    });
    expect(body.pattern_key).toBe('GR-kgiu-beginner-002');
    expect(body.summary_en).toBe('N이다'); // falls back to the pattern
    expect(body.category).toBe('pattern'); // null → 'pattern' (row default)
    expect(body.proficiency).toBe('basic');
    expect('register' in body).toBe(false);
  });
});
