/**
 * Typed client for the geocoding API.
 *
 * Isomorphic: the same code runs in a browser and in Node, because it uses
 * `fetch` and nothing else. It exists because the interesting parts of talking
 * to a geocoder live on the caller's side — cancelling superseded keystrokes,
 * holding the last good results while the next request is in flight, folding a
 * query so equivalent spellings share a cache entry — and none of that belongs
 * in every consumer's application code.
 *
 * The folding in particular is why this is worth shipping rather than
 * documenting. `fold` here is the *same module* the index was built with, so
 * a query normalised on the client cannot disagree with the server. A geocoder
 * written in another language would need a third implementation of those rules
 * and a third contract test to keep it honest.
 */
import { fold, type FeatureCollection, type Feature, type Layer } from '@anchor-geocoder/core';

export type { FeatureCollection, Feature, Layer };
export { fold, tokens } from '@anchor-geocoder/core';

export interface ClientOptions {
  /** Base URL of the API, e.g. "https://geocode.example.com". */
  baseUrl: string;
  /** Restrict every request to one country. */
  country?: string;
  /** Passed through to `fetch`, for auth headers or credentials. */
  fetchOptions?: RequestInit;
}

export interface ForwardOptions {
  limit?: number;
  /** Bias results toward this point. */
  proximity?: { lat: number; lon: number };
  country?: string;
  signal?: AbortSignal;
}

export interface ReverseOptions {
  limit?: number;
  /** Search radius in metres. */
  radius?: number;
  country?: string;
  signal?: AbortSignal;
}

export class GeocodeError extends Error {
  constructor(readonly status: number, message: string, readonly hint?: string) {
    super(message);
    this.name = 'GeocodeError';
  }
}

export class GeocodeClient {
  private readonly base: string;

  constructor(private readonly opts: ClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
  }

  private async request(
    params: Record<string, string | number | undefined>,
    signal?: AbortSignal,
  ): Promise<FeatureCollection> {
    const url = new URL(`${this.base}/v1/geocode`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      ...this.opts.fetchOptions,
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        message?: string; hint?: string;
      };
      throw new GeocodeError(res.status, body.message ?? res.statusText, body.hint);
    }
    return (await res.json()) as FeatureCollection;
  }

  /**
   * Text to places.
   *
   * The query is folded before it is sent. That is not cosmetic: "Praha",
   * "praha" and "  PRAHA " become one URL rather than three, so a CDN in front
   * of the API sees a far smaller key space on a workload where the same few
   * thousand queries dominate.
   */
  async forward(query: string, opts: ForwardOptions = {}): Promise<FeatureCollection> {
    return this.request({
      q: fold(query),
      limit: opts.limit,
      country: opts.country ?? this.opts.country,
      proximity: opts.proximity ? `${opts.proximity.lat},${opts.proximity.lon}` : undefined,
    }, opts.signal);
  }

  /** A point to the places at and around it. */
  async reverse(
    lat: number, lon: number, opts: ReverseOptions = {},
  ): Promise<FeatureCollection> {
    return this.request({
      lat, lon,
      limit: opts.limit,
      radius: opts.radius,
      country: opts.country ?? this.opts.country,
    }, opts.signal);
  }

  /**
   * A search box, with the parts everyone otherwise reimplements.
   *
   * Returns a function to call on every keystroke. It debounces, and it aborts
   * the in-flight request when a newer keystroke arrives — without which
   * responses can land out of order and a slow request for "Pra" overwrites the
   * results for "Prague".
   */
  autocomplete(opts: ForwardOptions & { debounceMs?: number } = {}) {
    const wait = opts.debounceMs ?? 150;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: AbortController | undefined;

    const run = (query: string): Promise<FeatureCollection | null> =>
      new Promise((resolve, reject) => {
        if (timer !== undefined) clearTimeout(timer);
        inFlight?.abort();

        if (fold(query) === '') { resolve(null); return; }

        timer = setTimeout(() => {
          const ctrl = new AbortController();
          inFlight = ctrl;
          this.forward(query, { ...opts, signal: ctrl.signal })
            .then(resolve)
            .catch((err: unknown) => {
              // An abort is the expected outcome of typing another character,
              // not a failure the caller should have to filter out.
              if (err instanceof DOMException && err.name === 'AbortError') resolve(null);
              else reject(err instanceof Error ? err : new Error(String(err)));
            });
        }, wait);
      });

    run.cancel = () => {
      if (timer !== undefined) clearTimeout(timer);
      inFlight?.abort();
    };
    return run;
  }
}

/**
 * Narrows a previous response locally, for the gap between keystrokes.
 *
 * Once "Prag" has returned results, "Pragu" is almost certainly a subset of
 * them, so the dropdown can update immediately instead of going blank. Uses the
 * same folding as the server, so it cannot disagree about what matches.
 */
export function filterLocally(previous: Feature[], query: string): Feature[] {
  const q = fold(query);
  if (q === '') return previous;
  return previous.filter((f) => fold(f.place_name).includes(q));
}
