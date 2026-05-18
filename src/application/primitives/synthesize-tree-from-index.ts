/**
 * Synthesise a nested `Tree` object from a flat `GitIndex` and return the
 * root tree's `ObjectId`. Sub-trees are written to the object store as a
 * side-effect of the recursive descent — only stage-0 entries contribute.
 *
 * Used by `checkout({ paths, source: 'index' })` (Phase 13.6) to restore
 * the working tree from staged content even when the index has diverged
 * from HEAD via `add` / `rm`. The previous placeholder fell back to
 * HEAD's tree, which silently lost the divergence.
 *
 * The synthesis is the inverse of Phase 13.2's `buildIndexFromTree`:
 * "tree → index" and "index → tree" form a round-trip identity for any
 * stage-0-only index.
 *
 * Pure with respect to the working tree — never calls `fs.lstat`,
 * `fs.read`, or any working-tree-side API. Only writes git objects via
 * the existing `writeTree` primitive.
 *
 * ## Safety
 *
 * - **Depth cap**: synthesis bounds recursion at `MAX_TREE_DEPTH` (4096,
 *   matching git's canonical limit). An adversarial or corrupted index
 *   with paths like `a/b/c/.../z` of 10 000 levels would otherwise
 *   exhaust the call stack before any async tick yielded.
 * - **Path validation**: defensive segment-level check rejects `..`,
 *   `.`, empty segments, and leading-slash paths at the synthesis
 *   boundary. The git index parser SHOULD also reject these (see
 *   `docs/BACKLOG.md` §13.7); the check here is belt-and-suspenders so
 *   the primitive stays safe even if a parser path admits unsafe data.
 */
import { invalidIndexEntry } from '../../domain/git-index/error.js';
import type { GitIndex } from '../../domain/git-index/index.js';
import { treeDepthExceeded } from '../../domain/objects/error.js';
import {
  FILE_MODE,
  type FileMode,
  type FilePath,
  type ObjectId,
  type TreeEntry,
} from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { writeTree } from './write-tree.js';

const MAX_TREE_DEPTH = 4096;

interface PendingEntry {
  readonly path: string;
  readonly id: ObjectId;
  readonly mode: FileMode;
}

const isUnsafeSegment = (segment: string): boolean =>
  segment === '' || segment === '.' || segment === '..';

const assertSafePath = (path: string): void => {
  if (path.startsWith('/')) {
    throw invalidIndexEntry(0, `unsafe index path '${path}': absolute paths rejected`);
  }
  const segments = path.split('/');
  // Depth check at the input boundary — by the time recursion would catch
  // this the JS engine has already exhausted its call stack. Each segment
  // before the leaf corresponds to one synthesizeLevel recursion.
  if (segments.length - 1 > MAX_TREE_DEPTH) {
    throw treeDepthExceeded(segments.length - 1);
  }
  for (const segment of segments) {
    if (isUnsafeSegment(segment)) {
      throw invalidIndexEntry(0, `unsafe index path '${path}': segment '${segment}' rejected`);
    }
  }
};

const stage0Entries = (index: GitIndex): PendingEntry[] => {
  const out: PendingEntry[] = [];
  for (const entry of index.entries) {
    if (entry.flags.stage !== 0) continue;
    assertSafePath(entry.path);
    out.push({ path: entry.path, id: entry.id, mode: entry.mode });
  }
  return out;
};

const groupByPrefix = (
  entries: ReadonlyArray<PendingEntry>,
): { readonly files: PendingEntry[]; readonly subdirs: Map<string, PendingEntry[]> } => {
  const files: PendingEntry[] = [];
  const subdirs = new Map<string, PendingEntry[]>();
  for (const entry of entries) {
    const slashIndex = entry.path.indexOf('/');
    if (slashIndex === -1) {
      files.push(entry);
      continue;
    }
    const prefix = entry.path.slice(0, slashIndex);
    const rest = entry.path.slice(slashIndex + 1);
    const bucket = subdirs.get(prefix);
    const sub: PendingEntry = { path: rest, id: entry.id, mode: entry.mode };
    if (bucket === undefined) subdirs.set(prefix, [sub]);
    else bucket.push(sub);
  }
  return { files, subdirs };
};

const synthesizeLevel = async (
  ctx: Context,
  entries: ReadonlyArray<PendingEntry>,
  depth: number,
): Promise<ObjectId> => {
  if (depth > MAX_TREE_DEPTH) throw treeDepthExceeded(depth);
  const { files, subdirs } = groupByPrefix(entries);
  const treeEntries: TreeEntry[] = [];
  for (const file of files) {
    treeEntries.push({ name: file.path as FilePath, id: file.id, mode: file.mode });
  }
  for (const [prefix, subEntries] of subdirs) {
    const subId = await synthesizeLevel(ctx, subEntries, depth + 1);
    treeEntries.push({ name: prefix as FilePath, id: subId, mode: FILE_MODE.DIRECTORY });
  }
  return writeTree(ctx, treeEntries);
};

export const synthesizeTreeFromIndex = async (ctx: Context, index: GitIndex): Promise<ObjectId> =>
  synthesizeLevel(ctx, stage0Entries(index), 0);
