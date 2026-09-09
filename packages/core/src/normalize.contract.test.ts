/**
 * Index terms are folded by Go at build time, queries by TypeScript at request
 * time; any divergence makes queries silently miss. Fixtures come from real
 * corpus names plus hand-picked edge cases — `make fold-vectors`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fold, tokens, indexTokens, queryVariants } from './normalize.js';

interface Vector {
  in: string;
  fold: string;
  tokens: string[];
  index_tokens: string[];
  query_variants: string[][];
}

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

  it('reproduces every Go IndexTokens() result', () => {
    const mismatches = vectors
      .filter((v) => JSON.stringify(indexTokens(v.in)) !== JSON.stringify(v.index_tokens))
      .slice(0, 20)
      .map((v) => ({ input: v.in, go: v.index_tokens, ts: indexTokens(v.in) }));
    expect(mismatches).toEqual([]);
  });

  it('reproduces every Go QueryVariants() result', () => {
    const mismatches = vectors
      .filter((v) => JSON.stringify(queryVariants(v.in)) !== JSON.stringify(v.query_variants))
      .slice(0, 20)
      .map((v) => ({ input: v.in, go: v.query_variants, ts: queryVariants(v.in) }));
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

/**
 * Japanese and Chinese are written without spaces between words, so the
 * whitespace split cannot find a token boundary and the whole of an address
 * arrives as one. Overlapping bigrams give a query and a name the same pieces.
 */
describe('scripts written without spaces', () => {
  it('cuts a run of them into overlapping bigrams', () => {
    expect(tokens('千代田区')).toEqual(['千代', '代田', '田区']);
    expect(tokens('北京市朝阳区')).toEqual(['北京', '京市', '市朝', '朝阳', '阳区']);
    // One character has no bigram, so it stands as its own token.
    expect(tokens('日')).toEqual(['日']);
  });

  it('makes part of an address reach the whole of it', () => {
    const whole = new Set(tokens('東京都千代田区千代田1-1'));
    for (const part of ['千代田区', '東京都', '千代田']) {
      for (const t of tokens(part)) expect(whole.has(t), `${part} / ${t}`).toBe(true);
    }
  });

  it('breaks the run on digits, which is how "2丁目" stays reachable', () => {
    expect(tokens('新宿区西新宿2丁目8-1'))
      .toEqual(['新宿', '宿区', '区西', '西新', '新宿', '2', '丁目', '8', '1']);
  });

  it('leaves Korean alone, since it is written with spaces', () => {
    expect(tokens('서울특별시 중구')).toEqual(['서울특별시', '중구']);
  });

  it('leaves everything European alone', () => {
    expect(tokens('Praha')).toEqual(['praha']);
    expect(tokens('Nádražní 1')).toEqual(['nadrazni', '1']);
  });
});

describe('compatibility forms fold to what a keyboard types', () => {
  it('normalises width, ligatures and letterlike symbols', () => {
    expect(fold('１２３')).toBe('123');
    expect(fold('ｶﾀｶﾅ')).toBe('カタカナ');
    expect(fold('Ⅻ')).toBe('xii');
    expect(fold('№ 5')).toBe('no 5');
    expect(fold('㎡')).toBe('m2');
    expect(fold('ﬁ')).toBe('fi');
  });

  /** A dakuten is a combining mark by category and a different sound in fact:
   * stripping it the way a háček is stripped folds ば onto は. */
  it('keeps Japanese voicing', () => {
    expect(fold('ばなな')).not.toBe(fold('はなな'));
    expect(fold('バナナ')).not.toBe(fold('ハナナ'));
    expect(fold('ｶﾞ')).toBe(fold('ガ'));
  });
});

/**
 * German writes an umlaut two ways and ß two more, and folding cannot merge
 * them: "München" and "Muenchen" are different strings that are both correct.
 * So the index carries the alternatives as extra terms and the query widens to
 * the ones it can infer, and between them every spelling reaches the name.
 */
describe('German spellings all reach the same name', () => {
  /** Some form the query looks up is a term the index stores, token for token. */
  const reaches = (name: string, query: string): boolean => {
    const indexed = new Set(indexTokens(name));
    return queryVariants(query).every((forms) => forms.some((f) => indexed.has(f)));
  };

  it('indexes the digraph spelling beside the canonical fold', () => {
    expect(indexTokens('München')).toEqual(['munchen', 'muenchen']);
    expect(indexTokens('Städtle')).toEqual(['stadtle', 'staedtle']);
    // Nothing to add: no umlaut, or already written out.
    expect(indexTokens('Muenchen')).toEqual(['muenchen']);
    expect(indexTokens('Praha')).toEqual(['praha']);
  });

  it('inserts the two-s shortening of an ß compound', () => {
    expect(indexTokens('Schloßstraße')).toEqual(['schlossstrasse', 'schlosstrasse']);
    // Two s stay two: "Strasse" must not become "Strase".
    expect(indexTokens('Straße')).toEqual(['strasse']);
  });

  it('finds a name however the umlaut was typed', () => {
    for (const q of ['München', 'Muenchen', 'Munchen']) {
      expect(reaches('München', q), q).toBe(true);
    }
    expect(reaches('Fürstentum Liechtenstein', 'Fuerstentum Liechtenstein')).toBe(true);
    // Digraph in the data, umlaut typed.
    expect(reaches('Muenchen', 'München')).toBe(true);
  });

  it('finds a name however the ß was typed', () => {
    expect(reaches('Weißenburg', 'Weissenburg')).toBe(true);
    expect(reaches('Weissenburg', 'Weißenburg')).toBe(true);
    for (const q of ['Schloßstraße', 'Schlossstrasse', 'Schlosstrasse']) {
      expect(reaches('Schloßstraße', q), q).toBe(true);
    }
    expect(reaches('Schlosstraße', 'Schloßstraße')).toBe(true);
  });

  it('leaves the vowel pairs that are not umlauts alone', () => {
    for (const s of ['Neue', 'Aue', 'Steuerweg', 'Bauernhof', 'Museum']) {
      expect(queryVariants(s), s).toEqual([tokens(s)]);
    }
  });

  it('widens retrieval without lengthening the query', () => {
    // Downstream scoring divides by the token count, so a variant must ride
    // alongside its token rather than become one.
    expect(queryVariants('München Straße').length).toBe(tokens('München Straße').length);
    expect(tokens('München')).toEqual(['munchen']);
  });
});

/**
 * The Cyrillic table must be total over the catalogue's scripts, and identical
 * in both languages. Letters outside the Serbian alphabet used to pass through
 * raw, producing tokens half Latin and half Cyrillic.
 */
describe('Cyrillic folds completely and in step with Go', () => {
  const pairs: [string, string][] = [
    ['Београд', 'Beograd'], ['Скопје', 'Skopje'], ['Подгорица', 'Podgorica'],
    ['София', 'Sofia'], ['Пловдив', 'Plovdiv'], ['Львів', 'Lviv'],
    ['Мінск', 'Minsk'],
  ];
  it('converges the two scripts of a name', () => {
    for (const [cyr, latin] of pairs) {
      expect(fold(cyr), `${cyr} vs ${latin}`).toBe(fold(latin));
    }
  });

  it('never leaves a token in two scripts at once', () => {
    for (const s of ['София', 'Київ', 'Львів', 'Мінск', 'Бургас', 'Ужгород',
                     'Чернігів', 'Гродна', 'Скопје', 'Београд']) {
      const out = fold(s);
      expect(/[a-z]/.test(out) && /[\u0400-\u04FF]/.test(out), `${s} -> ${out}`)
        .toBe(false);
    }
  });
});
