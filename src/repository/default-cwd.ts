import { isNode } from '../adapter-detect.js';

/**
 * Resolved working directory used when the caller does not pass `opts.cwd` to
 * `openRepository`. On Node, `process.cwd()`. On browser/memory adapters, `'/'`
 * (a deterministic root that the in-memory FS treats as repo top).
 *
 * The Node branch reads `process.cwd()` only AFTER `isNode()` has confirmed the
 * pollution-safe runtime check passes — never trust an injected `process` global.
 */
export const defaultCwd = (): string => {
  if (isNode()) {
    return (globalThis as { readonly process: { readonly cwd: () => string } }).process.cwd();
  }
  return '/';
};
