import { TsgitError } from '../error.js';
import type { FilePath } from '../objects/object-id.js';

export type RepositoryError =
  | { readonly code: 'NOT_A_REPOSITORY'; readonly path: FilePath }
  | { readonly code: 'BARE_REPOSITORY'; readonly operation: string }
  | { readonly code: 'ALREADY_INITIALIZED'; readonly path: FilePath };

export const notARepository = (path: FilePath): TsgitError =>
  new TsgitError({ code: 'NOT_A_REPOSITORY', path });

export const bareRepository = (operation: string): TsgitError =>
  new TsgitError({ code: 'BARE_REPOSITORY', operation });

export const alreadyInitialized = (path: FilePath): TsgitError =>
  new TsgitError({ code: 'ALREADY_INITIALIZED', path });
