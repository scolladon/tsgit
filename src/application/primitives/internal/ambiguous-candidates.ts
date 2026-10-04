/**
 * The candidates git's `get_short_oid` lists under an ambiguous abbreviated
 * id: ordered as `sort_ambiguous` orders them — tags, commits, trees, then
 * blobs, each kind by id — and described as `show_ambiguous_object` shows
 * them. The type comes from the object's header, so a blob is never inflated.
 */
import type {
  AmbiguousCandidate,
  CandidateDate,
} from '../../../domain/objects/ambiguous-candidate.js';
import { foldSubject } from '../../../domain/objects/commit-message.js';
import type { GitObject, ObjectId, ObjectType } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readDeclaredObjectHeader, readObject } from '../read-object.js';

/** `sort_ambiguous`'s `type % 4`: tag sorts first, then commit, tree and blob. */
const TYPE_RANK: Readonly<Record<ObjectType, number>> = { tag: 0, commit: 1, tree: 2, blob: 3 };

/** git shows a tag's date with zone 0, and the epoch for a tag without a tagger. */
const UTC = '+0000';
const UNDATED: CandidateDate = { timestamp: 0, timezoneOffset: UTC };

interface TypedCandidate {
  readonly id: ObjectId;
  readonly type: ObjectType;
}

const typed = async (ctx: Context, id: ObjectId): Promise<TypedCandidate> => ({
  id,
  type: (await readDeclaredObjectHeader(ctx, id)).type,
});

const byIdWithin = (a: TypedCandidate, b: TypedCandidate): number => (a.id < b.id ? -1 : 1);

const inGitOrder = (a: TypedCandidate, b: TypedCandidate): number =>
  TYPE_RANK[a.type] - TYPE_RANK[b.type] || byIdWithin(a, b);

const candidateOf = (object: GitObject): AmbiguousCandidate => {
  if (object.type === 'commit') {
    const { author, message } = object.data;
    const date = { timestamp: author.timestamp, timezoneOffset: author.timezoneOffset };
    return { id: object.id, type: 'commit', date, subject: foldSubject(message) };
  }
  if (object.type === 'tag') {
    const { tagger, tagName } = object.data;
    const date =
      tagger === undefined ? UNDATED : { timestamp: tagger.timestamp, timezoneOffset: UTC };
    return { id: object.id, type: 'tag', date, subject: tagName };
  }
  return { id: object.id, type: object.type };
};

const described = async (ctx: Context, candidate: TypedCandidate): Promise<AmbiguousCandidate> => {
  if (candidate.type === 'blob') return { id: candidate.id, type: 'blob' };
  return candidateOf(await readObject(ctx, candidate.id));
};

/** Every one of `ids` in git's listing order, each described. */
export const describeCandidates = async (
  ctx: Context,
  ids: ReadonlyArray<ObjectId>,
): Promise<ReadonlyArray<AmbiguousCandidate>> => {
  const ordered = (await Promise.all(ids.map((id) => typed(ctx, id)))).sort(inGitOrder);
  return Promise.all(ordered.map((candidate) => described(ctx, candidate)));
};
