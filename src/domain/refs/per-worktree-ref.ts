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

/** Directory of a linked worktree's private refs inside the common dir. */
const LINKED_WORKTREES_DIR = 'worktrees/';

/** Namespace under which a bare repository's main worktree spells its private refs. */
const MAIN_WORKTREE_DIR = 'main-worktree/';

/** git's `parse_worktree_ref` display prefix: one leading `worktrees/<id>/`, id free of slashes. */
const LINKED_WORKTREE_PREFIX = /^worktrees\/[^/]+\//;

/** Where a linked worktree's own refs sit, relative to the common dir. */
export const linkedWorktreeRefPrefix = (id: string): string => `${LINKED_WORKTREES_DIR}${id}/`;

/** Drops the display prefix that names a linked worktree's store, leaving the ref as that worktree sees it. */
export const bareStoreRefName = (name: string): string => name.replace(LINKED_WORKTREE_PREFIX, '');

/** The per-worktree ref a `main-worktree/` name stands for, or undefined when it names anything else. */
export const mainWorktreeBareName = (name: RefName): RefName | undefined => {
  if (!name.startsWith(MAIN_WORKTREE_DIR)) return undefined;
  const bare = name.slice(MAIN_WORKTREE_DIR.length) as RefName;
  return isPerWorktreeRef(bare) ? bare : undefined;
};
