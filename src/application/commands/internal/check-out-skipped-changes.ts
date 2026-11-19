import type { IndexEntry } from '../../../domain/git-index/index.js';
import {
  escapedPathOf,
  type IndexPathKey,
  indexPathKey,
} from '../../../domain/git-index/index-path-key.js';
import type { Context } from '../../../ports/context.js';
import { limiterFor } from '../../primitives/internal/concurrency.js';
import { withStatData } from '../../primitives/internal/index-entry-from-stat.js';
import { lazily } from '../../primitives/internal/lazily.js';
import {
  attributeBlobLookup,
  buildAttributeProvider,
} from '../../primitives/internal/read-gitattributes.js';
import {
  createWorkingTreeWriter,
  type WorkingTreeWriter,
} from '../../primitives/internal/write-converted-entry.js';
import { readEolSettings } from '../../primitives/resolve-conversion.js';

const createWriter = (ctx: Context, merged: ReadonlyArray<IndexEntry>): WorkingTreeWriter =>
  createWorkingTreeWriter(ctx, {
    provider: lazily(() =>
      buildAttributeProvider(ctx, { kind: 'index-first', index: attributeBlobLookup(merged) }),
    ),
    settings: lazily(() => readEolSettings(ctx)),
    limiter: limiterFor(ctx, 'cpuBound'),
  });

const byPath = (entries: ReadonlyArray<IndexEntry>): ReadonlyMap<IndexPathKey, IndexEntry> =>
  new Map(entries.map((e) => [indexPathKey(e), e]));

const isChangedSkipped = (
  entry: IndexEntry,
  previous: ReadonlyMap<IndexPathKey, IndexEntry>,
): boolean => {
  if (!entry.flags.skipWorktree) return false;
  const was = previous.get(indexPathKey(entry));
  return was === undefined || was.id !== entry.id || was.mode !== entry.mode;
};

/** git's unstage_changes_unless_new step 2: a path the merge changed but left skip-worktree is checked out and loses its bit. Both sides are stage-0 only: stash apply refuses an unmerged index and a clean merge leaves none. */
export const checkOutSkippedChanges = async (
  ctx: Context,
  merged: ReadonlyArray<IndexEntry>,
  before: ReadonlyArray<IndexEntry>,
): Promise<ReadonlyArray<IndexEntry>> => {
  const previous = byPath(before);
  const writer = createWriter(ctx, merged);
  const result: IndexEntry[] = [];
  for (const entry of merged) {
    if (!isChangedSkipped(entry, previous)) {
      result.push(entry);
      continue;
    }
    const stat = await writer.writeBlob(escapedPathOf(entry), entry.id, entry.mode);
    const present = { ...entry, flags: { ...entry.flags, skipWorktree: false } };
    result.push(stat === undefined ? present : withStatData(present, stat));
  }
  return result;
};
