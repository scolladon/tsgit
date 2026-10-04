import type { ObjectId } from './object-id.js';

/**
 * One line `git rev-parse` prints: an object, `negated` where git prefixes
 * `^`, or an argument naming no revision but an existing path, printed as given.
 */
export type RevParseEntry =
  | { readonly kind: 'object'; readonly id: ObjectId; readonly negated: boolean }
  | { readonly kind: 'path'; readonly path: string };
