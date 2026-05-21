import type { RefName } from '../objects/object-id.js';

/** The `core.*` subset that decides whether a ref update is auto-reflogged. */
export interface LogAllRefUpdates {
  readonly logAllRefUpdates?: boolean | 'always';
  readonly bare?: boolean;
}

/** Ref prefixes git auto-creates a reflog for when logging is merely enabled. */
const DEFAULT_LOGGABLE_PREFIXES: ReadonlyArray<string> = [
  'refs/heads/',
  'refs/remotes/',
  'refs/notes/',
];

/**
 * git's `should_autocreate_reflog`: does config plus the ref prefix call for a
 * new reflog? `always` logs every ref (tags included); `false` logs nothing;
 * `true`/unset logs only the default-loggable refs, with unset defaulting to
 * `!bare`.
 */
export function shouldAutocreateReflog(ref: RefName, cfg: LogAllRefUpdates): boolean {
  if (cfg.logAllRefUpdates === 'always') return true;
  if (cfg.logAllRefUpdates === false) return false;
  const enabled = cfg.logAllRefUpdates === true ? true : cfg.bare !== true;
  return enabled && isDefaultLoggable(ref);
}

function isDefaultLoggable(ref: RefName): boolean {
  return ref === 'HEAD' || DEFAULT_LOGGABLE_PREFIXES.some((prefix) => ref.startsWith(prefix));
}
