/**
 * The candidates git's `get_short_oid` lists under an ambiguous abbreviated
 * id: ordered as `sort_ambiguous` orders them — unreadable objects, tags,
 * commits, trees, then blobs, each kind by id — and described as
 * `show_ambiguous_object` shows them. The type comes from the object's header,
 * so a blob is never inflated.
 */
import type {
  AmbiguousCandidate,
  CandidateDate,
  CandidateReadFault,
} from '../../../domain/objects/ambiguous-candidate.js';
import { foldSubject } from '../../../domain/objects/commit-message.js';
import type { GitObject, ObjectId, ObjectType } from '../../../domain/objects/index.js';
import {
  feedParseAcceptance,
  parseAcceptanceVerdict,
  startParseAcceptance,
} from '../../../domain/objects/parse-acceptance.js';
import type { Context } from '../../../ports/context.js';
import { readDeclaredObjectHeader, readObject, readRawObject } from '../read-object.js';

/** `sort_ambiguous`'s `type % 4`: an unreadable object (`-1`) sorts first, then tag, commit, tree and blob. */
const UNREADABLE_RANK = -1;
const TYPE_RANK: Readonly<Record<ObjectType, number>> = { tag: 0, commit: 1, tree: 2, blob: 3 };

/** git shows a tag's date with zone 0, and the epoch for a tag without a tagger. */
const UTC = '+0000';
const UNDATED: CandidateDate = { timestamp: 0, timezoneOffset: UTC };

/** A candidate's type as `odb_read_object_info` answers it: `undefined` when unreadable, with the fault each read reports. */
interface ProbedCandidate {
  readonly id: ObjectId;
  readonly type: ObjectType | undefined;
  readonly fault: CandidateReadFault | undefined;
}

/** The listing and every failed type read made while building it, in git's read order. */
export interface DescribedCandidates {
  readonly candidates: ReadonlyArray<AmbiguousCandidate>;
  readonly readFaults: ReadonlyArray<CandidateReadFault>;
}

/**
 * What a failed type read of candidate `id` reports: an inflate failure is
 * git's fault pair, an absent object reads silently as unreadable, and any
 * other failure is not a candidate's to absorb — it propagates.
 */
export const candidateReadFault = (
  id: ObjectId,
  error: unknown,
): CandidateReadFault | undefined => {
  const data = (error as { readonly data?: { readonly code?: unknown; readonly reason?: unknown } })
    .data;
  if (data?.code === 'OBJECT_NOT_FOUND') return undefined;
  if (data?.code !== 'DECOMPRESS_FAILED') throw error;
  return { id, reason: String(data.reason) };
};

/** git's disambiguation hint: whether a candidate is the kind the caller reads. */
export type CandidateFilter = (id: ObjectId) => Promise<boolean>;

/** git's hint over one candidate: an unreadable one fails it, its failed read handed to `report`. */
export const passesHint = async (
  id: ObjectId,
  accepts: CandidateFilter,
  report: (fault: CandidateReadFault) => void,
): Promise<boolean> => {
  try {
    return await accepts(id);
  } catch (error) {
    const fault = candidateReadFault(id, error);
    if (fault !== undefined) report(fault);
    return false;
  }
};

/** git's two `error:` lines for one failed read of a loose object's header. */
export const logCandidateReadFault = (ctx: Context, { id, reason }: CandidateReadFault): void => {
  ctx.logger?.error?.(`inflate: data stream error (${reason})`, { id, reason });
  ctx.logger?.error?.(`unable to unpack ${id} header`, { id });
};

const unreadable = (id: ObjectId, error: unknown): ProbedCandidate => ({
  id,
  type: undefined,
  fault: candidateReadFault(id, error),
});

const probed = async (ctx: Context, id: ObjectId): Promise<ProbedCandidate> => {
  try {
    return { id, type: (await readDeclaredObjectHeader(ctx, id)).type, fault: undefined };
  } catch (error) {
    return unreadable(id, error);
  }
};

const rankOf = (candidate: ProbedCandidate): number =>
  candidate.type === undefined ? UNREADABLE_RANK : TYPE_RANK[candidate.type];

/** `sort_ambiguous`: same type by id, otherwise by rank — each side's type read once per call. */
const comparedInGitOrder =
  (reads: CandidateReadFault[]) =>
  (a: ProbedCandidate, b: ProbedCandidate): number => {
    for (const side of [a, b]) if (side.fault !== undefined) reads.push(side.fault);
    if (a.type === b.type) return a.id < b.id ? -1 : 1;
    return rankOf(a) > rankOf(b) ? 1 : -1;
  };

/** git's `git_qsort_s` merge sort, comparison for comparison, so the reads it makes replay in order. */
const gitMergeSort = <T>(items: ReadonlyArray<T>, compare: (a: T, b: T) => number): T[] => {
  if (items.length <= 1) return [...items];
  const half = Math.floor(items.length / 2);
  const left = gitMergeSort(items.slice(0, half), compare);
  const right = gitMergeSort(items.slice(half), compare);
  const merged: T[] = [];
  let [l, r] = [0, 0];
  while (l < left.length && r < right.length) {
    if (compare(left[l] as T, right[r] as T) <= 0) merged.push(left[l++] as T);
    else merged.push(right[r++] as T);
  }
  return [...merged, ...left.slice(l), ...right.slice(r)];
};

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

/** `parse_tag`'s verdict on the tag's own bytes: a body git refuses lists as a bad tag. */
const describedTag = async (ctx: Context, id: ObjectId): Promise<AmbiguousCandidate> => {
  const { content } = await readRawObject(ctx, id);
  const scan = feedParseAcceptance(startParseAcceptance('tag', ctx.hashConfig.hexLength), content);
  if (parseAcceptanceVerdict(scan, { parentLookups: 'checked' }) !== undefined)
    return { id, type: 'bad-tag' };
  return candidateOf(await readObject(ctx, id));
};

const described = async (ctx: Context, candidate: ProbedCandidate): Promise<AmbiguousCandidate> => {
  const { id, type } = candidate;
  if (type === undefined) return { id, type: 'bad-object' };
  if (type === 'tag') return describedTag(ctx, id);
  if (type === 'blob') return { id, type };
  return candidateOf(await readObject(ctx, id));
};

/**
 * `show_ambiguous_object` over one sorted candidate: a hinted listing first
 * re-runs the hint, skipping what fails it; what is shown has its type read
 * again, so an unreadable one reports a fault per read.
 */
const shownCandidate = async (
  ctx: Context,
  candidate: ProbedCandidate,
  accepts: CandidateFilter | undefined,
  readFaults: CandidateReadFault[],
): Promise<AmbiguousCandidate | undefined> => {
  const report = (fault: CandidateReadFault): number => readFaults.push(fault);
  if (accepts !== undefined && !(await passesHint(candidate.id, accepts, report))) return undefined;
  if (candidate.fault !== undefined) report(candidate.fault);
  return described(ctx, candidate);
};

/**
 * The candidates git lists among `ids`, in its listing order, each described:
 * `sort_ambiguous` over the id-sorted unique set, then `show_ambiguous_object`
 * per candidate, keeping only those passing `accepts` when the listing is hinted.
 */
export const describeCandidates = async (
  ctx: Context,
  ids: ReadonlyArray<ObjectId>,
  accepts?: CandidateFilter,
): Promise<DescribedCandidates> => {
  const unique = [...new Set(ids)].sort();
  const probes = await Promise.all(unique.map((id) => probed(ctx, id)));
  const readFaults: CandidateReadFault[] = [];
  const ordered = gitMergeSort(probes, comparedInGitOrder(readFaults));
  const candidates: AmbiguousCandidate[] = [];
  for (const candidate of ordered) {
    const shown = await shownCandidate(ctx, candidate, accepts, readFaults);
    if (shown !== undefined) candidates.push(shown);
  }
  return { candidates, readFaults };
};
