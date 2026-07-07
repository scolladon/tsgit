/**
 * The on-disk prefix for local branch refs. Centralized so the one true
 * spelling lives in a single place — every consumer imports the constant
 * instead of re-typing the string literal.
 */
export const HEADS_PREFIX = 'refs/heads/';
