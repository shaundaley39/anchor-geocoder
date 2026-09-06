/**
 * The client's own logic — folding, debouncing, cancellation — tested against a
 * stub fetch. What it talks to is covered by the server's integration suite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeocodeClient, GeocodeError, filterLocally } from './index.js';
import type { Feature } from '@anchor-geocoder/core';

const EMPTY = { type: 'FeatureCollection', query: { type: 'forward' }, features: [], attribution: '' };

function stubFetch(impl?: (url: URL, init?: RequestInit) => unknown) {
  const calls: URL[] = [];
  const fn = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(input);
    calls.push(url);
    const body = impl ? impl(url, init) : EMPTY;
    return { ok: true, status: 200, json: async () => body } as Response;
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('query construction', () => {
  beforeEach(() => { stubFetch(); });

  /**
   * Folding client-side is the point of shipping a client rather than a URL
   * template: three spellings become one cache key, using the same rules the
   * index was built with.
   */
  it('folds the query before sending it', async () => {
    const { calls } = stubFetch();
    const c = new GeocodeClient({ baseUrl: 'https://api.test' });
    for (const q of ['Praha', 'praha', '  PRAHA  ', 'Præha'.replace('æ', 'a')]) {
      await c.forward(q);
    }
    const sent = calls.map((u) => u.searchParams.get('q'));
    expect(new Set(sent).size).toBe(1);
    expect(sent[0]).toBe('praha');
  });

  it('folds diacritics the same way the index did', async () => {
    const { calls } = stubFetch();
    const c = new GeocodeClient({ baseUrl: 'https://api.test' });
    await c.forward('Łódź');
    expect(calls[0]!.searchParams.get('q')).toBe('lodz');
  });

  it('passes proximity as lat,lon and honours a default country', async () => {
    const { calls } = stubFetch();
    const c = new GeocodeClient({ baseUrl: 'https://api.test/', country: 'cz' });
    await c.forward('Praha', { proximity: { lat: 50.1, lon: 14.4 }, limit: 3 });
    const u = calls[0]!;
    expect(u.pathname).toBe('/v1/geocode');
    expect(u.searchParams.get('proximity')).toBe('50.1,14.4');
    expect(u.searchParams.get('country')).toBe('cz');
    expect(u.searchParams.get('limit')).toBe('3');
  });

  it('sends reverse coordinates unfolded', async () => {
    const { calls } = stubFetch();
    const c = new GeocodeClient({ baseUrl: 'https://api.test' });
    await c.reverse(50.0813, 14.4262, { radius: 200 });
    expect(calls[0]!.searchParams.get('lat')).toBe('50.0813');
    expect(calls[0]!.searchParams.get('lon')).toBe('14.4262');
    expect(calls[0]!.searchParams.get('radius')).toBe('200');
  });
});

describe('errors', () => {
  it('raises GeocodeError carrying the server message and hint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 400, statusText: 'Bad Request',
      json: async () => ({ message: 'lat and lon may not be combined with q', hint: 'use proximity' }),
    } as Response)));
    const c = new GeocodeClient({ baseUrl: 'https://api.test' });
    await expect(c.forward('x')).rejects.toBeInstanceOf(GeocodeError);
    await expect(c.forward('x')).rejects.toMatchObject({
      status: 400, hint: 'use proximity',
    });
  });
});

describe('autocomplete', () => {
  it('debounces a burst of keystrokes into one request', async () => {
    vi.useFakeTimers();
    const { calls } = stubFetch();
    const c = new GeocodeClient({ baseUrl: 'https://api.test' });
    const search = c.autocomplete({ debounceMs: 100 });

    void search('P'); void search('Pr'); void search('Pra');
    const last = search('Prag');
    await vi.advanceTimersByTimeAsync(150);
    await last;

    expect(calls.length).toBe(1);
    expect(calls[0]!.searchParams.get('q')).toBe('prag');
  });

  /**
   * Without cancellation a slow request for "Pra" can land after a fast one for
   * "Prague" and overwrite it — the classic out-of-order autocomplete bug.
   */
  it('aborts the in-flight request when a newer keystroke arrives', async () => {
    vi.useFakeTimers();
    const seen: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: URL, init?: RequestInit) => {
      if (init?.signal) seen.push(init.signal);
      return { ok: true, status: 200, json: async () => EMPTY } as Response;
    }));
    const c = new GeocodeClient({ baseUrl: 'https://api.test' });
    const search = c.autocomplete({ debounceMs: 10 });

    const first = search('Pra');
    await vi.advanceTimersByTimeAsync(15);
    const second = search('Prague');
    await vi.advanceTimersByTimeAsync(15);
    await Promise.all([first, second]);

    expect(seen.length).toBe(2);
    expect(seen[0]!.aborted).toBe(true);
    expect(seen[1]!.aborted).toBe(false);
  });

  it('resolves null for an empty query without calling the API', async () => {
    const { calls } = stubFetch();
    const c = new GeocodeClient({ baseUrl: 'https://api.test' });
    const search = c.autocomplete();
    expect(await search('   ')).toBeNull();
    expect(await search('!!')).toBeNull();
    expect(calls.length).toBe(0);
  });

  it('cancel() stops a pending request', async () => {
    vi.useFakeTimers();
    const { calls } = stubFetch();
    const c = new GeocodeClient({ baseUrl: 'https://api.test' });
    const search = c.autocomplete({ debounceMs: 50 });
    void search('Praha');
    search.cancel();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.length).toBe(0);
  });
});

describe('filterLocally', () => {
  const feat = (place_name: string) => ({ place_name } as Feature);

  it('narrows a previous response with the same folding as the server', () => {
    const prev = [feat('Praha, CZ'), feat('Prachatice, CZ'), feat('Plzeň, CZ')];
    expect(filterLocally(prev, 'pra').map((f) => f.place_name))
      .toEqual(['Praha, CZ', 'Prachatice, CZ']);
    expect(filterLocally(prev, 'prah').map((f) => f.place_name)).toEqual(['Praha, CZ']);
    // Diacritics fold on both sides, so a plain-keyboard query still matches.
    expect(filterLocally(prev, 'plzen').map((f) => f.place_name)).toEqual(['Plzeň, CZ']);
  });

  it('returns everything for an empty query', () => {
    const prev = [feat('Praha, CZ')];
    expect(filterLocally(prev, '  ')).toEqual(prev);
  });
});
