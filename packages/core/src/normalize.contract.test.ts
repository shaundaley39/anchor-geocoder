/**
 * Index terms are folded by Go at build time, queries by TypeScript at request
 * time; any divergence makes queries silently miss. Fixtures come from real
 * corpus names plus hand-picked edge cases — `make fold-vectors`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fold, tokens } from './normalize.js';

interface Vector { in: string; fold: string; tokens: string[] }

const vectors: Vector[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fold-vectors.json', import.meta.url)), 'utf8'),
);

describe('fold/tokens match the Go implementation', () => {
  it('has a meaningful number of fixtures', () => {
    expect(vectors.length).toBeGreaterThan(1000);
  });

  it('reproduces every Go fold() result', () => {
    const mismatches = vectors
      .filter((v) => fold(v.in) !== v.fold)
      .slice(0, 20)
      .map((v) => ({ input: v.in, go: v.fold, ts: fold(v.in) }));
    expect(mismatches).toEqual([]);
  });

  it('reproduces every Go Tokens() result', () => {
    const mismatches = vectors
      .filter((v) => JSON.stringify(tokens(v.in)) !== JSON.stringify(v.tokens))
      .slice(0, 20)
      .map((v) => ({ input: v.in, go: v.tokens, ts: tokens(v.in) }));
    expect(mismatches).toEqual([]);
  });
});

describe('folding invariants the index depends on', () => {
  it('folds Cyrillic and Latin spellings to the same tokens', () => {
    for (const [cyr, lat] of [
      ['Бања Лука', 'Banja Luka'],
      ['Сарајево', 'Sarajevo'],
      ['Мостар', 'Mostar'],
    ] as const) {
      expect(tokens(cyr)).toEqual(tokens(lat));
    }
  });

  it('converges abbreviated, spelled-out and bare street names', () => {
    expect(tokens('ul. Marszałkowska')).toEqual(tokens('Marszałkowska'));
    expect(tokens('ulica Marszałkowska')).toEqual(tokens('Marszałkowska'));
    expect(tokens('nám. Míru')).toEqual(tokens('Míru'));
  });

  it('handles the stroked l that NFD cannot decompose', () => {
    expect(fold('Łódź')).toBe('lodz');
  });

  it('splits Czech composed house numbers into both parts', () => {
    expect(tokens('248/39')).toEqual(['248', '39']);
  });

  it('never returns an empty token list for a generic-only name', () => {
    expect(tokens('Rynek')).toEqual(['rynek']);
    expect(tokens('Plac')).toEqual(['plac']);
  });
});
