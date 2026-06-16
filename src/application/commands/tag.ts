/**
 * `tag` porcelain — manage `refs/tags/*`, exposed as the `repo.tag.*` nested
 * namespace (`list` / `create` / `delete`). Each verb is a Context-aware
 * function; the namespace binder lives in `internal/tag-namespace.ts`.
 */
import { TsgitError } from '../../domain/error.js';
import { tagExists, tagNotFound } from '../../domain/index.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { ZERO_OID } from '../../domain/objects/index.js';
import { validateRefName } from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { updateRef } from '../primitives/update-ref.js';
import { assertRepository, readHeadRaw } from './internal/repo-state.js';
import { assertNoValuelessCoreConfig } from './internal/valueless-config-guard.js';

export interface TagInfo {
  readonly name: RefName;
  readonly id: ObjectId;
}

export interface TagListResult {
  readonly tags: ReadonlyArray<TagInfo>;
}

export interface TagCreateInput {
  readonly name: string;
  readonly target?: string;
  readonly force?: boolean;
}
export interface TagCreateResult {
  readonly name: RefName;
  readonly id: ObjectId;
}

export interface TagDeleteInput {
  readonly name: string;
}
export interface TagDeleteResult {
  readonly name: RefName;
}

const TAGS_PREFIX = 'refs/tags/';

export const tagList = async (ctx: Context): Promise<TagListResult> => {
  await assertRepository(ctx);
  await assertNoValuelessCoreConfig(ctx);
  const dir = `${ctx.layout.gitDir}/refs/tags`;
  if (!(await ctx.fs.exists(dir))) return { tags: [] };
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
  return { tags };
};

export const tagCreate = async (ctx: Context, input: TagCreateInput): Promise<TagCreateResult> => {
  await assertRepository(ctx);
  await assertNoValuelessCoreConfig(ctx);
  const name = validateRefName(`${TAGS_PREFIX}${input.name}`);
  const target = input.target !== undefined ? input.target : await currentHeadId(ctx);
  const id = /^[0-9a-f]{40}$/.test(target)
    ? (target as ObjectId)
    : await resolveRef(ctx, target as RefName);
  const reflogMessage = `tag: ${input.name}`;
  try {
    await updateRef(
      ctx,
      name,
      id,
      input.force === true ? { reflogMessage } : { expected: 'absent', reflogMessage },
    );
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'REF_UPDATE_CONFLICT') {
      throw tagExists(name);
    }
    throw err;
  }
  return { name, id };
};

export const tagDelete = async (ctx: Context, input: TagDeleteInput): Promise<TagDeleteResult> => {
  await assertRepository(ctx);
  await assertNoValuelessCoreConfig(ctx);
  const name = validateRefName(`${TAGS_PREFIX}${input.name}`);
  if (!(await ctx.fs.exists(`${ctx.layout.gitDir}/${name}`))) {
    throw tagNotFound(name);
  }
  await updateRef(ctx, name, ZERO_OID, { delete: true });
  return { name };
};

const currentHeadId = async (ctx: Context): Promise<string> => {
  const head = await readHeadRaw(ctx);
  if (head.kind === 'direct') return head.id;
  return resolveRef(ctx, head.target);
};
