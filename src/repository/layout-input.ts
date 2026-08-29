import type { RepositoryFormatRefusal } from '../ports/context.js';

/**
 * Caller-supplied physical layout for the in-construction Context. The
 * runtime shims resolve this by walking up from `cwd` until a `.git` entry is
 * found (`findLayout`); mirrors `RepositoryLayout` (`ports/context.ts`).
 *
 * @internal
 */
export interface RepositoryLayoutInput {
  /** Absolute path to the working tree. Absent when the repository has none. */
  readonly workDir?: string;
  readonly gitDir: string;
  readonly bare: boolean;
  /**
   * Shared common git dir — set only for a linked worktree, whose `gitDir` is
   * its own admin dir while shared state (objects, refs, config) lives here.
   * Absent for a normal repo or the main worktree (equals `gitDir`).
   */
  readonly commonDir?: string;
  /** `core.bare` and `core.worktree` are both set — git's `work_tree_config_is_bogus`. */
  readonly workTreeConfigBogus?: boolean;
  /** Discovery reached a repository whose metadata the caller does not own. Present only when true. */
  readonly untrusted?: true;
  /** Discovery walked into a gitdir under a name other than `.git`, with `bareRepositories: 'explicit'` set. Present only when true. */
  readonly implicitBare?: true;
  /** The first checked path the ownership predicate reported unowned. Present only when one was found. */
  readonly foreignPath?: string;
  /** The repository-format acceptance verdict — absent when accepted. */
  readonly formatRefusal?: RepositoryFormatRefusal;
  readonly homeDir?: string;
  /**
   * The repository's declared `extensions.objectFormat`. Absent means sha1
   * (git's default when the key is unset). Populated by `finishLayout` —
   * see `RepositoryLayout.objectFormat` (`ports/context.ts`).
   */
  readonly objectFormat?: 'sha1' | 'sha256';
  /**
   * The repository's declared `extensions.refStorage`, resolved by
   * `finishLayout` — see `RepositoryLayout.refStorage` (`ports/context.ts`)
   * for why this is REQUIRED rather than optional.
   */
  readonly refStorage: 'files' | 'reftable';
}
