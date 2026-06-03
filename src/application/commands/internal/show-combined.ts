/**
 * Assemble the per-file `CombinedFile` inputs for a merge's combined diff: each
 * parent tree is diffed (non-recursive rename-free, like `git diff-tree -c`)
 * against the result tree, paths are unioned, and the result/parent blob
 * contents are loaded. A parent unchanged at a path reuses the result blob (all
 * context for that parent); a parent missing the path contributes an empty
 * side. Files deleted by the merge are out of scope (v1).
 */
import { comparePaths, type DiffChange } from '../../../domain/diff/index.js';
import type { CommitData, FileMode, FilePath, ObjectId } from '../../../domain/objects/index.js';
import { ZERO_OID } from '../../../domain/objects/index.js';
import type { CombinedFile } from '../../../domain/show/index.js';
import type { Context } from '../../../ports/context.js';
import { diffTrees } from '../../primitives/diff-trees.js';
import { readBlob } from '../../primitives/read-blob.js';
import { treeOf } from './history-rewrite.js';

interface Side {
  readonly id: ObjectId;
  readonly mode: FileMode;
}

const ABSENT = Symbol('absent');
type ParentSide = Side | typeof ABSENT | undefined;

interface PathInfo {
  result?: Side;
  readonly parents: ParentSide[];
}

const EMPTY = new Uint8Array(0);

const recordChange = (info: PathInfo, change: DiffChange, parent: number): void => {
  if (change.type === 'add') {
    info.result = { id: change.newId, mode: change.newMode };
    info.parents[parent] = ABSENT;
  } else if (change.type === 'delete') {
    info.parents[parent] = { id: change.oldId, mode: change.oldMode };
  } else if (change.type !== 'rename') {
    info.result = { id: change.newId, mode: change.newMode };
    info.parents[parent] = { id: change.oldId, mode: change.oldMode };
  }
};

const pathOf = (change: DiffChange): string => {
  if (change.type === 'add') return change.newPath;
  if (change.type === 'delete' || change.type === 'rename') return change.oldPath;
  return change.path;
};

export const buildCombinedFiles = async (
  ctx: Context,
  commit: CommitData,
): Promise<ReadonlyArray<CombinedFile>> => {
  const parentCount = commit.parents.length;
  const parentTrees = await Promise.all(commit.parents.map((p) => treeOf(ctx, p)));
  const byPath = new Map<string, PathInfo>();
  for (let i = 0; i < parentCount; i += 1) {
    const diff = await diffTrees(ctx, parentTrees[i] as ObjectId, commit.tree, { recursive: true });
    for (const change of diff.changes) {
      const path = pathOf(change);
      const info = byPath.get(path) ?? {
        parents: new Array<ParentSide>(parentCount).fill(undefined),
      };
      recordChange(info, change, i);
      byPath.set(path, info);
    }
  }

  const blobCache = new Map<ObjectId, Uint8Array>();
  const loadBlob = async (id: ObjectId): Promise<Uint8Array> => {
    const cached = blobCache.get(id);
    if (cached !== undefined) return cached;
    const content = (await readBlob(ctx, id)).content;
    blobCache.set(id, content);
    return content;
  };

  const files: CombinedFile[] = [];
  for (const path of [...byPath.keys()].sort((a, b) =>
    comparePaths(a as FilePath, b as FilePath),
  )) {
    const info = byPath.get(path) as PathInfo;
    const result = info.result;
    if (result === undefined) continue; // deleted by the merge — out of scope
    const resultContent = await loadBlob(result.id);
    const parents = await Promise.all(
      info.parents.map(async (side) => {
        if (side === undefined)
          return { content: resultContent, blob: result.id, mode: result.mode };
        if (side === ABSENT) return { content: EMPTY, blob: ZERO_OID, mode: result.mode };
        return { content: await loadBlob(side.id), blob: side.id, mode: side.mode };
      }),
    );
    files.push({ path, resultContent, resultBlob: result.id, resultMode: result.mode, parents });
  }
  return files;
};
