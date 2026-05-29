import type { Context } from '../../../ports/context.js';
import {
  type TagCreateInput,
  type TagCreateResult,
  type TagDeleteInput,
  type TagDeleteResult,
  type TagListResult,
  tagCreate,
  tagDelete,
  tagList,
} from '../tag.js';

/**
 * The nested-namespace surface for `repo.tag.*`. Each method runs the
 * caller-supplied `guard()` first (so a disposed repository throws before any
 * work) and then forwards to the corresponding context-aware command in
 * `commands/tag.ts`.
 */
export interface TagNamespace {
  readonly list: () => Promise<TagListResult>;
  readonly create: (input: TagCreateInput) => Promise<TagCreateResult>;
  readonly delete: (input: TagDeleteInput) => Promise<TagDeleteResult>;
}

/**
 * Bind the `repo.tag.*` nested-namespace dispatcher. `guard()` is the
 * lifecycle gate (typically the disposed/closed check from `openRepository`);
 * it is invoked before every method forwards to its underlying command.
 *
 * The returned object is frozen — callers cannot monkey-patch methods onto
 * the namespace at runtime.
 */
export const bindTagNamespace = (ctx: Context, guard: () => void): TagNamespace => {
  const ns: TagNamespace = {
    list: () => {
      guard();
      return tagList(ctx);
    },
    create: (input) => {
      guard();
      return tagCreate(ctx, input);
    },
    delete: (input) => {
      guard();
      return tagDelete(ctx, input);
    },
  };
  return Object.freeze(ns);
};
