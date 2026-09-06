/**
 * The artifact is written by Go and read by TypeScript, and a handful of values
 * must agree exactly. Each fails *silently* on drift: the wrong cell stride
 * finds nothing, the wrong layer codes mislabel everything.
 *
 * Go emits its values (`make format-constants`); these assert the match.
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
   * A mismatch returns no containing regions at all, which reads as "this point
   * is not inside anything" — plausible, and therefore the worst kind of wrong.
   */
  it('agrees on the containment grid geometry', () => {
    expect(CELL_CONSTANTS.deg).toBe(go['cellDeg']);
    expect(CELL_CONSTANTS.origin).toBe(go['cellOrigin']);
    expect(CELL_CONSTANTS.stride).toBe(go['cellStride']);
  });

  it('covers every constant Go publishes', () => {
    // A new shared constant fails here until it is asserted above.
    expect(Object.keys(go).sort()).toEqual([
      'altSep', 'cellDeg', 'cellOrigin', 'cellStride', 'coordScale',
      'kdNodeSize', 'layerPOI', 'layerPlace', 'layerStreet', 'version',
    ]);
  });
});
