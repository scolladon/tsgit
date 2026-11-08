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

/** Which store a ref name selects and the name inside it — git's `parse_worktree_ref`. */
export type WorktreeRefTarget =
  /** A per-worktree ref, read in the current worktree's own store. */
  | { readonly kind: 'current'; readonly bare: RefName }
  /** Any other name, read in the common store under its full spelling. */
  | { readonly kind: 'shared'; readonly bare: RefName }
  /** `main-worktree/<per-worktree ref>`: the main worktree's store. */
  | { readonly kind: 'main'; readonly bare: RefName }
  /** `worktrees/<id>/<per-worktree ref>`: the linked worktree `id`'s store. */
  | { readonly kind: 'other'; readonly id: string; readonly bare: RefName };

const linkedWorktreeTarget = (name: RefName): WorktreeRefTarget | undefined => {
  if (!name.startsWith(LINKED_WORKTREES_DIR)) return undefined;
  const rest = name.slice(LINKED_WORKTREES_DIR.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return undefined;
  const bare = rest.slice(slash + 1) as RefName;
  return isPerWorktreeRef(bare) ? { kind: 'other', id: rest.slice(0, slash), bare } : undefined;
};

const mainWorktreeTarget = (name: RefName): WorktreeRefTarget | undefined => {
  if (!name.startsWith(MAIN_WORKTREE_DIR)) return undefined;
  const bare = name.slice(MAIN_WORKTREE_DIR.length) as RefName;
  return isPerWorktreeRef(bare) ? { kind: 'main', bare } : undefined;
};

const unprefixedTarget = (name: RefName): WorktreeRefTarget =>
  isPerWorktreeRef(name) ? { kind: 'current', bare: name } : { kind: 'shared', bare: name };

/** Which store `name` selects, in git's order: a linked worktree's, the main worktree's, then the current or common one. */
export const parseWorktreeRef = (name: RefName): WorktreeRefTarget =>
  linkedWorktreeTarget(name) ?? mainWorktreeTarget(name) ?? unprefixedTarget(name);
