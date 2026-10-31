/**
 * git's per-worktree-ref rule (`is_current_worktree_ref`): a root ref — a
 * name of uppercase letters, `-` and `_` only — or a per-worktree namespace.
 * A linked worktree keeps these refs in its own gitdir
 * (`<commonDir>/worktrees/<id>/`); every other ref is shared and lives in the
 * common dir. Pure predicates — no I/O.
 */
import type { RefName } from '../objects/object-id.js';
import { FETCH_HEAD, MERGE_HEAD } from './state-files.js';

/** git's `is_root_ref_syntax`: uppercase letters, `-` and `_`, nothing else. */
const ROOT_REF_SYNTAX = /^[A-Z_-]*$/;

/** Ref namespaces git scopes to a single worktree. */
export const PER_WORKTREE_PREFIXES: ReadonlyArray<string> = [
  'refs/bisect/',
  'refs/worktree/',
  'refs/rewritten/',
];

/** git's `is_pseudo_ref`: the refs read from a file in the git dir whatever the ref backend. */
const PSEUDO_REFS: ReadonlySet<string> = new Set([FETCH_HEAD, MERGE_HEAD]);

/** True when `name` resolves against a worktree's own gitdir, not the common dir. */
export const isPerWorktreeRef = (name: RefName): boolean =>
  ROOT_REF_SYNTAX.test(name) || PER_WORKTREE_PREFIXES.some((prefix) => name.startsWith(prefix));

/** True when git keeps `name` as a file beside the ref backend rather than in it. */
export const isPseudoRef = (name: RefName): boolean => PSEUDO_REFS.has(name);
