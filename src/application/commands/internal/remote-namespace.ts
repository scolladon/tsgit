import type { Context } from '../../../ports/context.js';
import {
  type RemoteAddInput,
  type RemoteAddResult,
  type RemoteListResult,
  type RemoteRemoveInput,
  type RemoteRemoveResult,
  type RemoteRenameInput,
  type RemoteRenameResult,
  type RemoteSetUrlInput,
  type RemoteSetUrlResult,
  type RemoteShowInput,
  type RemoteShowResult,
  remoteAdd,
  remoteList,
  remoteRemove,
  remoteRename,
  remoteSetUrl,
  remoteShow,
} from '../remote.js';

/**
 * The nested-namespace surface for `repo.remote.*`. Each method runs the
 * caller-supplied `guard()` first (so a disposed repository throws before any
 * work) and then forwards to the corresponding context-aware command in
 * `commands/remote.ts`.
 */
export interface RemoteNamespace {
  readonly list: () => Promise<RemoteListResult>;
  readonly add: (input: RemoteAddInput) => Promise<RemoteAddResult>;
  readonly remove: (input: RemoteRemoveInput) => Promise<RemoteRemoveResult>;
  readonly rename: (input: RemoteRenameInput) => Promise<RemoteRenameResult>;
  readonly setUrl: (input: RemoteSetUrlInput) => Promise<RemoteSetUrlResult>;
  readonly show: (input: RemoteShowInput) => Promise<RemoteShowResult>;
}

/**
 * Bind the `repo.remote.*` nested-namespace dispatcher. `guard()` is the
 * lifecycle gate (typically the disposed/closed check from `openRepository`);
 * it is invoked before every method forwards to its underlying command.
 *
 * The returned object is frozen — callers cannot monkey-patch methods onto
 * the namespace at runtime.
 */
export const bindRemoteNamespace = (ctx: Context, guard: () => void): RemoteNamespace => {
  const ns: RemoteNamespace = {
    list: () => {
      guard();
      return remoteList(ctx);
    },
    add: (input) => {
      guard();
      return remoteAdd(ctx, input);
    },
    remove: (input) => {
      guard();
      return remoteRemove(ctx, input);
    },
    rename: (input) => {
      guard();
      return remoteRename(ctx, input);
    },
    setUrl: (input) => {
      guard();
      return remoteSetUrl(ctx, input);
    },
    show: (input) => {
      guard();
      return remoteShow(ctx, input);
    },
  };
  return Object.freeze(ns);
};
