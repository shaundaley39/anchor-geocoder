/**
 * The shared contract between the geocoding API and its consumers.
 *
 * Deliberately dependency-free apart from TypeBox, and buildable for the
 * browser: a map UI importing this gets the response types *and* the exact
 * query normalizer the index was built with, so it can fold a query before
 * sending it and filter cached results locally without a second, divergent
 * implementation of the folding rules.
 */
export * from './schema.js';
export { fold, tokens } from './normalize.js';
