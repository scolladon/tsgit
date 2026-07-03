/**
 * `tag` porcelain — manage `refs/tags/*`, exposed as the `repo.tag.*` nested
 * namespace (`list` / `create` / `delete`). Each verb is a Context-aware
 * function; the namespace binder lives in `internal/tag-namespace.ts`.
 */
import { TsgitError } from '../../domain/error.js';
import { tagExists, tagNotFound } from '../../domain/index.js';
import type {
  AuthorIdentity,
  ObjectId,
  ObjectType,
  RefName,
  Tag,
  TagData,
} from '../../domain/objects/index.js';
import { serializeTagContent, stripspace, ZERO_OID } from '../../domain/objects/index.js';
import { validateRefName } from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import type { ParsedConfig } from '../primitives/config-read.js';
import { readConfig } from '../primitives/config-read.js';
import { createTag } from '../primitives/create-tag.js';
import { readObject } from '../primitives/read-object.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { updateRef } from '../primitives/update-ref.js';
import { resolveCurrentIdentity } from './internal/current-identity.js';
import { assertOperationalRepository, readHeadRaw } from './internal/repo-state.js';
import { resolveSignRequest, signOrThrow } from './internal/sign-request.js';

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
  /** Create an annotated tag object (git's `-a`). Implied by `message` and `sign`. */
  readonly annotate?: boolean;
  /** Annotated tag message (git's `-m`). Setting this implies `annotate`. */
  readonly message?: string;
  /** GPG-sign the annotated tag (git's `-s`). Implies `annotate`; falls back to `tag.gpgSign` when unset. */
  readonly sign?: boolean;
  /** Signer key override (git's `-u <keyid>` / `--local-user`). */
  readonly signKey?: string;
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

/**
 * git's `-a` — an explicit `annotate: true`, a `message` (which implies it),
 * or `sign` (a tag object is required to carry a signature; `-s` implies
 * `-a` in real git the same way `-m` does).
 */
const wantsAnnotatedTag = (input: TagCreateInput): boolean =>
  input.annotate === true || input.message !== undefined || input.sign === true;

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
  const message = stripspace(input.message ?? '');
  const gpgSignature = await resolveTagSignature(ctx, input, targetId, objectType, tagger, message);
  return createTag(ctx, {
    object: targetId,
    objectType,
    tagName: input.name,
    tagger,
    message,
    ...(gpgSignature !== undefined ? { gpgSignature } : {}),
  });
};

/**
 * Tri-state signing decision: an explicit `input.sign` always wins; leaving
 * it `undefined` falls back to `tag.gpgSign` from config. Returns `undefined`
 * when signing is off, otherwise the resolved armor (or throws).
 */
const resolveTagSignature = async (
  ctx: Context,
  input: TagCreateInput,
  object: ObjectId,
  objectType: ObjectType,
  tagger: AuthorIdentity,
  message: string,
): Promise<string | undefined> => {
  const config = await readConfig(ctx);
  const wantSign = input.sign ?? config.tag?.gpgSign === true;
  if (!wantSign) return undefined;
  const data: TagData = {
    object,
    objectType,
    tagName: input.name,
    tagger,
    message,
    extraHeaders: [],
  };
  return signTag(ctx, config, data, tagger, input.signKey);
};

/**
 * Sign the unsigned annotated-tag payload. Throws `SIGNING_FAILED`
 * atomically on any signer refusal — the caller must not proceed to
 * `createTag` when this throws.
 */
const signTag = async (
  ctx: Context,
  config: ParsedConfig,
  data: TagData,
  tagger: AuthorIdentity,
  signKey: string | undefined,
): Promise<string> => {
  const request = resolveSignRequest(config, tagger, signKey);
  const unsigned: Tag = { type: 'tag', id: '' as ObjectId, data };
  const payload = serializeTagContent(unsigned);
  // Unlike a commit's `gpgsig` header value, a tag's signature is appended
  // straight onto the message body — the signer's raw armor is stored
  // byte-for-byte, with no trailing-newline trim.
  return signOrThrow(ctx, payload, request);
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
