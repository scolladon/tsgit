/**
 * git's ort rename detection for a merge (`merge-ort.c`
 * `detect_regular_renames`): per side, the merge-base paths that side deleted
 * are paired with the paths it added, renames only — no copies, no breaks, the
 * empty blob never a candidate. A deleted path is a source only when the other
 * side changed it (ort's relevant sources), and a side with no relevant source
 * or no addition skips detection entirely.
 */
import { primaryPath } from '../../domain/diff/change-path.js';
import type {
  AddChange,
  DeleteChange,
  DiffChange,
  RenameChange,
} from '../../domain/diff/diff-change.js';
import type { FlatTree, FlatTreeEntry } from '../../domain/diff/flat-tree.js';
import { sortByPath } from '../../domain/diff/path-compare.js';
import { type MergeRename, type MergeRenames, NO_MERGE_RENAMES } from '../../domain/merge/index.js';
import { emptyBlobOid, type ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { detectSimilarityRenames } from './detect-similarity-renames.js';
import { readMergeRenameConfig } from './internal/merge-rename-config.js';

interface SidePass {
  readonly base: FlatTree;
  readonly side: FlatTree;
  readonly other: FlatTree;
  readonly empty: ObjectId;
  readonly limit: number;
}

const sameEntry = (a: FlatTreeEntry, b: FlatTreeEntry): boolean =>
  a.id === b.id && a.mode === b.mode;

/** ort's content relevance: the other side changed (or deleted) what this side deleted. */
const relevantDeletes = ({ base, side, other, empty }: SidePass): DeleteChange[] => {
  const deletes: DeleteChange[] = [];
  for (const [path, entry] of base.entries) {
    if (side.entries.has(path) || entry.id === empty) continue;
    const kept = other.entries.get(path);
    if (kept !== undefined && sameEntry(kept, entry)) continue;
    deletes.push({ type: 'delete', oldPath: path, oldId: entry.id, oldMode: entry.mode });
  }
  return deletes;
};

const additions = ({ base, side, empty }: SidePass): AddChange[] => {
  const adds: AddChange[] = [];
  for (const [path, entry] of side.entries) {
    if (base.entries.has(path) || entry.id === empty) continue;
    adds.push({ type: 'add', newPath: path, newId: entry.id, newMode: entry.mode });
  }
  return adds;
};

const isRename = (change: DiffChange): change is RenameChange => change.type === 'rename';

const sideRenames = async (ctx: Context, pass: SidePass): Promise<ReadonlyArray<MergeRename>> => {
  const deletes = relevantDeletes(pass);
  const adds = deletes.length === 0 ? [] : additions(pass);
  if (adds.length === 0) return [];
  const changes = sortByPath<DiffChange>([...deletes, ...adds], primaryPath);
  const paired = await detectSimilarityRenames(ctx, { changes }, { limit: pass.limit });
  return paired.changes.filter(isRename).map(({ oldPath, newPath }) => ({ oldPath, newPath }));
};

export const detectMergeRenames = async (
  ctx: Context,
  base: FlatTree | undefined,
  ours: FlatTree,
  theirs: FlatTree,
): Promise<MergeRenames> => {
  const { detect, limit } = await readMergeRenameConfig(ctx);
  if (!detect || base === undefined) return NO_MERGE_RENAMES;
  const empty = emptyBlobOid(ctx.hashConfig);
  const oursRenames = await sideRenames(ctx, { base, side: ours, other: theirs, empty, limit });
  const theirsRenames = await sideRenames(ctx, { base, side: theirs, other: ours, empty, limit });
  return { ours: oursRenames, theirs: theirsRenames };
};
