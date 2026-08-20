import { TsgitError } from '../error.js';
import type { FilePath } from '../objects/object-id.js';

export type RepositoryError =
  | { readonly code: 'NOT_A_REPOSITORY'; readonly path: FilePath }
  | { readonly code: 'BARE_REPOSITORY'; readonly operation: string }
  | { readonly code: 'WORK_TREE_REQUIRED'; readonly operation: string }
  | { readonly code: 'WORK_TREE_CONFIG_INVALID'; readonly gitDir: string }
  | { readonly code: 'WORK_TREE_UNRESOLVABLE'; readonly value: string; readonly gitDir: string }
  | { readonly code: 'ALREADY_INITIALIZED'; readonly path: FilePath }
  | { readonly code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED'; readonly version: number }
  | {
      readonly code: 'REPOSITORY_EXTENSIONS_UNSUPPORTED';
      readonly version: number;
      readonly extensions: ReadonlyArray<string>;
    }
  | {
      readonly code: 'REPOSITORY_EXTENSION_UNSUPPORTED';
      readonly extension: string;
      readonly value: string;
    }
  | { readonly code: 'DUBIOUS_OWNERSHIP'; readonly path: FilePath; readonly foreignPath?: FilePath }
  | { readonly code: 'IMPLICIT_BARE_REPOSITORY'; readonly gitDir: string };

export const notARepository = (path: FilePath): TsgitError =>
  new TsgitError({ code: 'NOT_A_REPOSITORY', path });

export const bareRepository = (operation: string): TsgitError =>
  new TsgitError({ code: 'BARE_REPOSITORY', operation });

/**
 * git's `setup_work_tree()` refusal: no work tree resolved for `operation`.
 * `BARE_REPOSITORY` is kept for the narrower `is_bare_repository()`-keyed
 * refusals (`reset --mixed`); this is the general "no work tree" case.
 */
export const workTreeRequired = (operation: string): TsgitError =>
  new TsgitError({ code: 'WORK_TREE_REQUIRED', operation });

/**
 * git's `work_tree_config_is_bogus`: `core.bare` and `core.worktree` are both
 * set, so no work tree can be set up regardless of which command runs.
 */
export const workTreeConfigInvalid = (gitDir: string): TsgitError =>
  new TsgitError({ code: 'WORK_TREE_CONFIG_INVALID', gitDir });

/**
 * A relative `core.worktree` whose physical resolution failed — git resolves
 * the value by changing directory from the gitDir, so a target that does not
 * exist refuses at setup (`fatal: cannot chdir to '<value>'`). `value` is the
 * config's own relative text, exactly what git's message names; an ABSOLUTE
 * `core.worktree` naming a missing directory is not this condition (git
 * records it verbatim and only `setup_work_tree` refuses later).
 */
export const workTreeUnresolvable = (value: string, gitDir: string): TsgitError =>
  new TsgitError({ code: 'WORK_TREE_UNRESOLVABLE', value, gitDir });

export const alreadyInitialized = (path: FilePath): TsgitError =>
  new TsgitError({ code: 'ALREADY_INITIALIZED', path });

/**
 * git's format gate: the effective (last-wins) `core.repositoryformatversion`
 * exceeds the highest version tsgit understands. `version` is the **parsed**
 * integer, never the config literal — `1k` carries `1024`, `0777` carries `511`.
 */
export const repositoryFormatVersionUnsupported = (version: number): TsgitError =>
  new TsgitError({ code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED', version });

/**
 * git's extensions gate: one or more `extensions.*` entries name a key git
 * itself does not know (at version 1) or treats as v1-only (at version 0).
 * `version` selects which of the two conditions applies. `extensions` carries
 * **every** offender in config-file order, duplicates included — each entry
 * is the lower-cased key with the subsection preserved verbatim, joined by
 * `.` (`[extensions "X"] bogus` yields `X.bogus`; `[extensions ""] bogus`
 * yields `.bogus`). Singular vs plural in the rendered message is derived
 * from `extensions.length`, never carried in the payload.
 */
export const repositoryExtensionsUnsupported = (
  version: number,
  extensions: ReadonlyArray<string>,
): TsgitError => new TsgitError({ code: 'REPOSITORY_EXTENSIONS_UNSUPPORTED', version, extensions });

/**
 * A point-of-use refusal: the repository declares an extension git accepts,
 * but tsgit cannot yet act on it, so the first operation that would misread
 * it refuses precisely instead. `extension` follows the same lower-cased,
 * subsection-preserved naming as `repositoryExtensionsUnsupported`; `value`
 * carries what the config declared, since git's own refusal is
 * presence-triggered and value-independent.
 */
export const repositoryExtensionUnsupported = (extension: string, value: string): TsgitError =>
  new TsgitError({ code: 'REPOSITORY_EXTENSION_UNSUPPORTED', extension, value });

/**
 * git's dubious-ownership refusal (`safe.directory`): discovery reached a
 * repository whose metadata is owned by someone other than the current
 * user. `path` names the repository path — the work tree when discovery
 * produced one, else the gitdir. `foreignPath` is diagnostic: it names the
 * FIRST member of the checked set the ownership predicate reported
 * unowned, in the documented check order — one path, never a set — and it
 * is ABSENT, not equal, when it would repeat `path`. A present
 * `foreignPath` therefore always names a directory OTHER than the one the
 * message is about.
 */
export const dubiousOwnership = (path: FilePath, foreignPath?: FilePath): TsgitError =>
  new TsgitError({
    code: 'DUBIOUS_OWNERSHIP',
    path,
    ...(foreignPath !== undefined ? { foreignPath } : {}),
  });

/**
 * Fires when discovery reached the gitdir by the cwd-is-a-gitdir route AND
 * the gitdir's basename is not literally `.git`, with `bareRepositories:
 * 'explicit'` set. Whether the repository is bare — by `core.bare`, or by
 * what a bareness query would report — plays no part in the condition. The
 * name is deliberately imprecise (it follows the wording a user will
 * search for); nothing downstream may infer bareness from it — not a
 * caller branching on the code, not a docs sentence, not a test title.
 */
export const implicitBareRepository = (gitDir: string): TsgitError =>
  new TsgitError({ code: 'IMPLICIT_BARE_REPOSITORY', gitDir });
