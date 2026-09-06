/**
 * Cross-language contract for the artifact format.
 *
 * The artifact is written by Go and read by TypeScript, and a handful of values
 * must agree exactly for that to work: the format version, the coordinate
 * scale, the layer codes, the alternate-name separator, and the containment
 * grid's geometry. Every one of them fails *silently* when it drifts — a reader
 * with the wrong cell stride finds nothing, one with the wrong layer codes
 * labels every result wrongly, and neither raises an error.
 *
 * Go emits its own values (`make format-constants`), and these assert the
 * TypeScript side matches. Same idea as the fold vectors: make the contract
 * executable rather than trusting a comment.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SUPPORTED_VERSION, COORD_SCALE, ALT_SEP,
  LAYER_STREET, LAYER_PLACE, LAYER_POI,
} from '../src/artifact.js';
import { CELL_CONSTANTS } from '../src/reverse.js';

const go = JSON.parse(
  readFileSync(fileURLToPath(new URL('./format-constants.json', import.meta.url)), 'utf8'),
) as Record<string, number | string>;

describe('artifact format constants match the Go writer', () => {
  it('agrees on the format version', () => {
    expect(SUPPORTED_VERSION).toBe(go['version']);
  });

  it('agrees on the coordinate scale', () => {
    expect(COORD_SCALE).toBe(go['coordScale']);
  });

  it('agrees on the layer codes', () => {
    expect(LAYER_STREET).toBe(go['layerStreet']);
    expect(LAYER_PLACE).toBe(go['layerPlace']);
    expect(LAYER_POI).toBe(go['layerPOI']);
  });

  it('agrees on the alternate-name separator', () => {
    expect(ALT_SEP).toBe(go['altSep']);
  });

  /**
   * The build lists a feature in every cell its bounding box touches, and a
   * lookup recomputes the key. A mismatch here returns no containing regions at
   * all, which reads as "this point is not inside anything" — a plausible
   * answer, and therefore the worst kind of wrong.
   */
  it('agrees on the containment grid geometry', () => {
    expect(CELL_CONSTANTS.deg).toBe(go['cellDeg']);
    expect(CELL_CONSTANTS.origin).toBe(go['cellOrigin']);
    expect(CELL_CONSTANTS.stride).toBe(go['cellStride']);
  });

  it('covers every constant Go publishes', () => {
    // A new shared constant should fail here until it is asserted above, rather
    // than silently going unchecked.
    expect(Object.keys(go).sort()).toEqual([
      'altSep', 'cellDeg', 'cellOrigin', 'cellStride', 'coordScale',
      'kdNodeSize', 'layerPOI', 'layerPlace', 'layerStreet', 'version',
    ]);
  });
});
