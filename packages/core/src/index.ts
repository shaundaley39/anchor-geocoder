/**
 * The shared contract between the API and its consumers. Dependency-free apart
 * from TypeBox and buildable for the browser, so a map UI importing it gets the
 * response types and the exact normalizer the index was built with, rather than
 * a second implementation of the folding rules that can drift.
 */
export * from './schema.js';
export { fold, tokens, indexTokens, queryVariants, tokenVariants } from './normalize.js';
