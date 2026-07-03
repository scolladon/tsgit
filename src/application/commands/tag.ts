/**
 * `tag` porcelain — manage `refs/tags/*`, exposed as the `repo.tag.*` nested
 * namespace (`list` / `create` / `delete`). Each verb is a Context-aware
 * function; the namespace binder lives in `internal/tag-namespace.ts`.
 */
import { TsgitError } from '../../domain/error.js';
import { tagExists, tagNotFound } from '../../domain/index.js';
import type { ObjectId, ObjectType, RefName } from '../../domain/objects/index.js';
import { stripspace, ZERO_OID } from '../../domain/objects/index.js';
import { validateRefName } from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { createTag } from '../primitives/create-tag.js';
import { readObject } from '../primitives/read-object.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { updateRef } from '../primitives/update-ref.js';
import { resolveCurrentIdentity } from './internal/current-identity.js';
import { assertOperationalRepository, readHeadRaw } from './internal/repo-state.js';

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
  /** Create an annotated tag object (git's `-a`). Implied by `message`. */
  readonly annotate?: boolean;
  /** Annotated tag message (git's `-m`). Setting this implies `annotate`. */
  readonly message?: string;
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
  await assertOperationalRepository(ctx);
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
  await assertOperationalRepository(ctx);
  const name = validateRefName(`${TAGS_PREFIX}${input.name}`);
  const target = input.target !== undefined ? input.target : await currentHeadId(ctx);
  const targetId = /^[0-9a-f]{40}$/.test(target)
    ? (target as ObjectId)
    : await resolveRef(ctx, target as RefName);
  const id = wantsAnnotatedTag(input) ? await createAnnotatedTag(ctx, input, targetId) : targetId;
  await updateTagRef(ctx, name, id, input.force === true, `tag: ${input.name}`);
  return { name, id };
};

/** git's `-a` — an explicit `annotate: true`, or a `message` (which implies it). */
const wantsAnnotatedTag = (input: TagCreateInput): boolean =>
  input.annotate === true || input.message !== undefined;

/**
 * Build and write the annotated tag object: resolves the tagged object's
 * type (needed for the `type` header) and the tagger identity the same way
 * commands resolve committer identity — via `resolveCurrentIdentity`, which
 * throws `AUTHOR_UNCONFIGURED` when `[user]` is unset.
 */
const createAnnotatedTag = async (
  ctx: Context,
  input: TagCreateInput,
  targetId: ObjectId,
): Promise<ObjectId> => {
  const objectType = await resolveObjectType(ctx, targetId);
  const tagger = await resolveCurrentIdentity(ctx);
  return createTag(ctx, {
    object: targetId,
    objectType,
    tagName: input.name,
    tagger,
    message: stripspace(input.message ?? ''),
  });
};

const resolveObjectType = async (ctx: Context, id: ObjectId): Promise<ObjectType> => {
  const target = await readObject(ctx, id);
  return target.type;
};

/** Point `name` at `id`, mapping the CAS conflict to the faithful `TAG_EXISTS`. */
const updateTagRef = async (
  ctx: Context,
  name: RefName,
  id: ObjectId,
  force: boolean,
  reflogMessage: string,
): Promise<void> => {
  try {
    await updateRef(
      ctx,
      name,
      id,
      force ? { reflogMessage } : { expected: 'absent', reflogMessage },
    );
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'REF_UPDATE_CONFLICT') {
      throw tagExists(name);
    }
    throw err;
  }
};

export const tagDelete = async (ctx: Context, input: TagDeleteInput): Promise<TagDeleteResult> => {
  await assertOperationalRepository(ctx);
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
