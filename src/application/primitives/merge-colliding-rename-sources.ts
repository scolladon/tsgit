/**
 * ort's rename/add with a source both sides changed (`merge-ort.c`
 * `process_renames`, collision branch): the source is content-merged at its
 * old path — conflict markers included — and the result, stored as a blob,
 * meets the other side's addition as an add/add at the destination. The
 * domain merge stays storage-free, so the blob is written here and handed
 * back as each rename's `mergedSource`.
 */
import type { FlatTree, FlatTreeEntry } from '../../domain/diff/flat-tree.js';
import {
  type CollidingSourceMerge,
  type ContentMerger,
  collidingSourceMerges,
  type MergeRename,
  type MergeRenames,
} from '../../domain/merge/index.js';
import type { ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { writeObject } from './write-object.js';

interface MergeTrees {
  readonly base: FlatTree | undefined;
  readonly ours: FlatTree;
  readonly theirs: FlatTree;
}

// The merger reads each side's bytes through the ids on the merge context.
const UNREAD = new Uint8Array(0);

const mergeSource = async (
  ctx: Context,
  { merge, mode }: CollidingSourceMerge,
  contentMerger: ContentMerger,
): Promise<FlatTreeEntry> => {
  const result = await contentMerger(merge, UNREAD, UNREAD, UNREAD);
  const content = result.status === 'clean' ? result.bytes : result.markedBytes;
  const id = await writeObject(ctx, { type: 'blob', content, id: '' as ObjectId });
  return { id, mode };
};

export const mergeCollidingRenameSources = async (
  ctx: Context,
  { base, ours, theirs }: MergeTrees,
  renames: MergeRenames,
  contentMerger: ContentMerger,
): Promise<MergeRenames> => {
  const merges = collidingSourceMerges(base, ours, theirs, renames);
  if (merges.length === 0) return renames;
  const merged = new Map<MergeRename, FlatTreeEntry>();
  for (const merge of merges)
    merged.set(merge.rename, await mergeSource(ctx, merge, contentMerger));
  const resolve = (rename: MergeRename): MergeRename => {
    const mergedSource = merged.get(rename);
    return mergedSource === undefined ? rename : { ...rename, mergedSource };
  };
  return { ours: renames.ours.map(resolve), theirs: renames.theirs.map(resolve) };
};
