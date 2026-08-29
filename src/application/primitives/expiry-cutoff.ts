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
 * `reflog expire`, pinned against git 2.55.0:
 * - exact `false` never expires anything; exact `all`/`now` expire
 *   EVERYTHING, future-dated entries included (git maps them to the
 *   maximum time, not the current one — measured: an entry stamped a year
 *   ahead is deleted by `--expire=all` and `--expire=now`).
 * - the keyword match is exact: `FALSE`, `ALL`, `  all` are all
 *   `fatal: invalid timestamp` in git (measured), so they fall through to
 *   the date parser here and refuse.
 * - `never` alone is case/whitespace tolerant (git's own date parser
 *   accepts `NEVER` and ` never`; measured), so it is matched normalized.
 * Everything else goes to `parseApproxidate`. Returns `undefined` when the
 * expression parses as nothing — each caller owns its own refusal, because
 * an expression this grammar mis-parses silently moves the cutoff, and
 * moving the cutoff destroys data.
 */
export const resolveExpiryCutoff = (raw: string, nowSeconds: number): number | undefined => {
  if (raw === 'false') return Number.NEGATIVE_INFINITY;
  if (raw === 'all' || raw === 'now') return Number.POSITIVE_INFINITY;
  if (raw.trim().toLowerCase() === 'never') return Number.NEGATIVE_INFINITY;
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
