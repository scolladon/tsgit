/**
 * Resolves the expiry date-expression grammar of `reflog expire` and of
 * the config expiries (`gc.pruneExpire`, `gc.worktreePruneExpire`) to a
 * unix-seconds cutoff. The keyword layer
 * (`never`/`false`/`all`/`now` — see `resolveExpiryCutoff`) is handled
 * before delegation; every remaining form (`yesterday`, ISO-8601,
 * `@<epoch>`, `<n>.<unit>.ago`) goes to `parseApproxidate`.
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
 * git's `parse_expiry_date` grammar, as `reflog expire` reads it, pinned against git 2.55.0:
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

const nowSecondsOf = (opts: ExpiryCutoffOptions): number =>
  Math.floor((opts.now ?? (() => Date.now()))() / 1000);

/**
 * git's `repo_config_get_expiry` gate followed by `parse_expiry_date`, for an
 * expiry read from config (`gc.pruneExpire`, `gc.worktreePruneExpire`). Only the exact `now`
 * may reach the present; every other value must parse to a moment strictly
 * before it — `all` and `false` included, which git's approxidate reads as
 * the present — or git dies on the config value (measured, git 2.55.0).
 */
export const configExpiryCutoff = (raw: string, opts: ExpiryCutoffOptions = {}): number => {
  if (raw === 'now') return Number.POSITIVE_INFINITY;
  const nowSeconds = nowSecondsOf(opts);
  const cutoff =
    raw.trim().toLowerCase() === 'never'
      ? Number.NEGATIVE_INFINITY
      : parseApproxidate(raw, nowSeconds);
  if (cutoff === undefined || cutoff >= nowSeconds) throw configBadDateValue(raw);
  return cutoff;
};
