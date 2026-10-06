/**
 * Stage-0 index entries for the paths a merge line-merged cleanly. Their
 * merged bytes exist only in memory, so each is written as a blob first; git
 * stages them at stage 0 even beside a conflict's unmerged stages.
 */
import type { IndexEntry } from '../../../domain/git-index/index.js';
import type { MergeOutcome } from '../../../domain/merge/index.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { writeObject } from '../write-object.js';
import { stage0Entry } from './synthetic-index-entry.js';

export const mergedBlobEntries = async (
  ctx: Context,
  outcomes: ReadonlyArray<MergeOutcome>,
): Promise<ReadonlyArray<IndexEntry>> => {
  const entries: IndexEntry[] = [];
  for (const outcome of outcomes) {
    if (outcome.status !== 'resolved-merged') continue;
    const blob = { type: 'blob', content: outcome.bytes, id: '' as ObjectId } as const;
    entries.push(stage0Entry(outcome.path, await writeObject(ctx, blob), outcome.mode));
  }
  return entries;
};
