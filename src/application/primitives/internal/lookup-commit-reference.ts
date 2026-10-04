import { isObjectNotFound } from '../../../domain/objects/error.js';
import type { Commit, ObjectId, ObjectType } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject, readObjectMetadata } from '../read-object.js';
import {
  type ObjectTypeTable,
  parseTypedObjectOrAbsent,
  typeWalkedCommit,
} from './object-type-table.js';
import { commitHeader, isGraphKnownAbsent } from './read-commit-graph.js';

/**
 * git's `lookup_commit_reference`: peel `id` through its annotated tags to the
 * commit it names, or report — on `error:`, naming `id` as given and the kind
 * the chain reached — that it names none and answer `undefined`.
 */
export const lookupCommitReference = async (
  ctx: Context,
  id: ObjectId,
): Promise<Commit | undefined> => {
  let obj = await readObject(ctx, id);
  while (obj.type === 'tag') obj = await readObject(ctx, obj.data.object);
  if (obj.type === 'commit') return obj;
  ctx.logger?.error?.(`object ${id} is a ${obj.type}, not a commit`, { id, type: obj.type });
  return undefined;
};

const absentAsUndefined = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await read();
  } catch (error) {
    if (isObjectNotFound(error)) return undefined;
    throw error;
  }
};

/** git's `lookup_unknown_object` then `odb_read_object_info`: the type the
 *  table holds, else the stored one, recorded; `undefined` when absent. */
const typeOnSight = async (
  ctx: Context,
  table: ObjectTypeTable,
  id: ObjectId,
): Promise<ObjectType | undefined> => {
  const known = table.get(id);
  if (known !== undefined) return known;
  const stored = await absentAsUndefined(() => readObjectMetadata(ctx, id));
  if (stored !== undefined) table.set(id, stored.type);
  return stored?.type;
};

interface Declared {
  readonly id: ObjectId;
  readonly type: ObjectType;
}

/** git's `peel_object_ext` loop: each tag parsed against the table, then its
 *  target taken as the type its header declares; `undefined` once one fails. */
const peelDeclared = async (
  ctx: Context,
  table: ObjectTypeTable,
  id: ObjectId,
): Promise<Declared | undefined> => {
  let declared: Declared = { id, type: 'tag' };
  while (declared.type === 'tag') {
    const tag = await parseTypedObjectOrAbsent(ctx, table, declared.id);
    if (tag?.type !== 'tag') return undefined;
    declared = { id: tag.data.object, type: tag.data.objectType };
  }
  return declared;
};

const reportUnparsed = (ctx: Context, message: string, id: ObjectId): false => {
  ctx.logger?.error?.(message, { id });
  return false;
};

/** git's `repo_parse_commit_gently`, not quiet: the commit-graph answers
 *  without a read; otherwise the stored commit is parsed, typing its pointers. */
const parseCommit = async (
  ctx: Context,
  table: ObjectTypeTable,
  id: ObjectId,
): Promise<boolean> => {
  if (!isGraphKnownAbsent(ctx) && (await commitHeader(ctx, id)) !== undefined) return true;
  const object = await absentAsUndefined(() => readObject(ctx, id));
  if (object === undefined) return reportUnparsed(ctx, `Could not read ${id}`, id);
  if (object.type !== 'commit') return reportUnparsed(ctx, `Object ${id} not a commit`, id);
  return typeWalkedCommit(ctx, table, object);
};

/**
 * git's `lookup_commit_reference` against the invocation's object table: the
 * commit `id` names through its tags, or `undefined` once git would refuse —
 * an absent object silently, any other failure on the `error:` lines git logs.
 */
export const lookupTypedCommitReference = async (
  ctx: Context,
  table: ObjectTypeTable,
  id: ObjectId,
): Promise<ObjectId | undefined> => {
  const declared = await peelOnSight(ctx, table, id);
  if (declared === undefined) return undefined;
  if (declared.type !== 'commit') {
    ctx.logger?.error?.(`object ${id} is a ${declared.type}, not a commit`, {
      id,
      type: declared.type,
    });
    return undefined;
  }
  return parsedCommit(ctx, table, declared.id);
};

/**
 * git's `lookup_commit_reference_gently` with `quiet` set: as
 * {@link lookupTypedCommitReference}, except that landing on another type is
 * no `error:` line — a failed parse still logs its own.
 */
export const lookupTypedCommitReferenceQuietly = async (
  ctx: Context,
  table: ObjectTypeTable,
  id: ObjectId,
): Promise<ObjectId | undefined> => {
  const declared = await peelOnSight(ctx, table, id);
  if (declared?.type !== 'commit') return undefined;
  return parsedCommit(ctx, table, declared.id);
};

/** `id` typed on sight and peeled through its tags as their headers declare. */
const peelOnSight = async (
  ctx: Context,
  table: ObjectTypeTable,
  id: ObjectId,
): Promise<Declared | undefined> => {
  const type = await typeOnSight(ctx, table, id);
  if (type === undefined) return undefined;
  return type === 'tag' ? peelDeclared(ctx, table, id) : { id, type };
};

const parsedCommit = async (
  ctx: Context,
  table: ObjectTypeTable,
  id: ObjectId,
): Promise<ObjectId | undefined> => ((await parseCommit(ctx, table, id)) ? id : undefined);
