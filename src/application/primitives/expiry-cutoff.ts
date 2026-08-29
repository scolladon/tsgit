/**
 * Resolves `gc.pruneExpire`'s date-expression grammar to a unix-seconds
 * cutoff for the cruft-pack survival rule `mtime > cutoff`. Delegates to
 * `parseApproxidate` for every form it already covers (`now`, `yesterday`,
 * ISO-8601, `@<epoch>`, `<n>.<unit>.ago`) and adds the one form that has no
 * moment-in-time meaning outside expiry: `never`, mapped to negative
 * infinity so nothing is ever `<= cutoff`.
 *
 * Every other expression refuses rather than being approximated — an
 * expression this helper mis-parses silently moves the cutoff, and moving
 * the cutoff destroys data.
 */
import { configBadDateValue } from '../../domain/commands/error.js';
import { parseApproxidate } from '../../domain/reflog/approxidate.js';

export interface ExpiryCutoffOptions {
  /** Injectable clock — defaults to `Date.now`. Tests override to simulate stale/skewed locks. */
  readonly now?: () => number;
}

/** Resolve `pruneExpire` (a raw `gc.pruneExpire` value, already defaulted by the caller) to a unix-seconds cutoff. */
export const expiryCutoff = (pruneExpire: string, opts: ExpiryCutoffOptions = {}): number => {
  if (pruneExpire.trim().toLowerCase() === 'never') return Number.NEGATIVE_INFINITY;
  const now = opts.now ?? (() => Date.now());
  const nowSeconds = Math.floor(now() / 1000);
  const cutoff = parseApproxidate(pruneExpire, nowSeconds);
  if (cutoff === undefined) throw configBadDateValue(pruneExpire);
  return cutoff;
};
