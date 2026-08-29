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

/**
 * git's `parse_expiry_date` grammar, shared by `gc.pruneExpire` and
 * `reflog expire`: `never` and `false` mean nothing ever expires, `all`
 * means everything does (measured, git 2.55.0: `--expire=false` keeps every
 * entry, `--expire=all` truncates to zero); everything else goes to
 * `parseApproxidate` (`now` included). Returns `undefined` when the
 * expression parses as nothing — each caller owns its own refusal, because
 * an expression this grammar mis-parses silently moves the cutoff, and
 * moving the cutoff destroys data.
 */
export const resolveExpiryCutoff = (raw: string, nowSeconds: number): number | undefined => {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'never' || normalized === 'false') return Number.NEGATIVE_INFINITY;
  if (normalized === 'all') return nowSeconds;
  return parseApproxidate(raw, nowSeconds);
};

/** Resolve `pruneExpire` (a raw `gc.pruneExpire` value, already defaulted by the caller) to a unix-seconds cutoff. */
export const expiryCutoff = (pruneExpire: string, opts: ExpiryCutoffOptions = {}): number => {
  const now = opts.now ?? (() => Date.now());
  const nowSeconds = Math.floor(now() / 1000);
  const cutoff = resolveExpiryCutoff(pruneExpire, nowSeconds);
  if (cutoff === undefined) throw configBadDateValue(pruneExpire);
  return cutoff;
};
