import { TsgitError } from '../../domain/error.js';
import { tagExists, tagNotFound } from '../../domain/index.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { ZERO_OID } from '../../domain/objects/index.js';
import { validateRefName } from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { updateRef } from '../primitives/update-ref.js';
import { assertRepository, readHeadRaw } from './internal/repo-state.js';

export type TagAction =
  | { readonly kind: 'list' }
  | {
      readonly kind: 'create';
      readonly name: string;
      readonly target?: string;
      readonly force?: boolean;
    }
  | { readonly kind: 'delete'; readonly name: string };

export interface TagInfo {
  readonly name: RefName;
  readonly id: ObjectId;
}

export type TagResult =
  | { readonly kind: 'list'; readonly tags: ReadonlyArray<TagInfo> }
  | { readonly kind: 'create'; readonly name: RefName; readonly id: ObjectId }
  | { readonly kind: 'delete'; readonly name: RefName };

const TAGS_PREFIX = 'refs/tags/';

export const tag = async (ctx: Context, action: TagAction): Promise<TagResult> => {
  await assertRepository(ctx);
  if (action.kind === 'list') return listTags(ctx);
  if (action.kind === 'create') return createTag(ctx, action);
  return deleteTag(ctx, action);
};

const listTags = async (ctx: Context): Promise<TagResult> => {
  const dir = `${ctx.layout.gitDir}/refs/tags`;
  if (!(await ctx.fs.exists(dir))) return { kind: 'list', tags: [] };
  const entries = await ctx.fs.readdir(dir);
  const tags: TagInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile) continue;
    const name = `${TAGS_PREFIX}${entry.name}` as RefName;
    const id = await resolveRef(ctx, name);
    tags.push({ name, id });
  }
  // readdir yields distinct entry names, so a.name === b.name never occurs:
  // a binary -1/1 comparator is sufficient (no equal-case to disambiguate).
  // Stryker disable next-line EqualityOperator: equivalent — names are distinct, so < and <= behave identically
  tags.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { kind: 'list', tags };
};

const createTag = async (
  ctx: Context,
  action: { readonly name: string; readonly target?: string; readonly force?: boolean },
): Promise<TagResult> => {
  const name = validateRefName(`${TAGS_PREFIX}${action.name}`);
  const target = action.target !== undefined ? action.target : await currentHeadId(ctx);
  const id = /^[0-9a-f]{40}$/.test(target)
    ? (target as ObjectId)
    : await resolveRef(ctx, target as RefName);
  const reflogMessage = `tag: ${action.name}`;
  try {
    await updateRef(
      ctx,
      name,
      id,
      action.force === true ? { reflogMessage } : { expected: 'absent', reflogMessage },
    );
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'REF_UPDATE_CONFLICT') {
      throw tagExists(name);
    }
    throw err;
  }
  return { kind: 'create', name, id };
};

const deleteTag = async (ctx: Context, action: { readonly name: string }): Promise<TagResult> => {
  const name = validateRefName(`${TAGS_PREFIX}${action.name}`);
  if (!(await ctx.fs.exists(`${ctx.layout.gitDir}/${name}`))) {
    throw tagNotFound(name);
  }
  await updateRef(ctx, name, ZERO_OID, { delete: true });
  return { kind: 'delete', name };
};

const currentHeadId = async (ctx: Context): Promise<string> => {
  const head = await readHeadRaw(ctx);
  if (head.kind === 'direct') return head.id;
  return resolveRef(ctx, head.target);
};
