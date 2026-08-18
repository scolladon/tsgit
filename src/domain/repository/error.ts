import { TsgitError } from '../error.js';
import type { FilePath } from '../objects/object-id.js';

export type RepositoryError =
  | { readonly code: 'NOT_A_REPOSITORY'; readonly path: FilePath }
  | { readonly code: 'BARE_REPOSITORY'; readonly operation: string }
  | { readonly code: 'WORK_TREE_REQUIRED'; readonly operation: string }
  | { readonly code: 'WORK_TREE_CONFIG_INVALID'; readonly gitDir: string }
  | { readonly code: 'ALREADY_INITIALIZED'; readonly path: FilePath };

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

export const alreadyInitialized = (path: FilePath): TsgitError =>
  new TsgitError({ code: 'ALREADY_INITIALIZED', path });
