/**
 * Synthesise a nested `Tree` object from a flat `GitIndex` and return the
 * root tree's `ObjectId`. Sub-trees are written to the object store as a
 * side-effect of the recursive descent — only stage-0 entries contribute.
 *
 * Used by `checkout({ paths, source: 'index' })` to restore
 * the working tree from staged content even when the index has diverged
 * from HEAD via `add` / `rm`. The previous placeholder fell back to
 * HEAD's tree, which silently lost the divergence.
 *
 * The synthesis is the inverse of `buildIndexFromTree`:
 * "tree → index" and "index → tree" form a round-trip identity for any
 * stage-0-only index.
 *
 * Pure with respect to the working tree — never calls `fs.lstat`,
 * `fs.read`, or any working-tree-side API. Only writes git objects via
 * the existing `writeTree` primitive.
 *
 * ## Safety
 *
 * - **Path validation**:.7 hoisted segment-level validation into
 *  `parseIndex` (`src/domain/git-index/path-validator.ts`). Every
 *  `IndexEntry` reaching this primitive THROUGH THE CANONICAL PARSER
 *  carries a `FilePath` value already free of `..`, `.`, empty segments,
 *  and leading-slash absolute paths. However, the primitive is also
 *  reachable from callers that construct `IndexEntry` records outside
 *  the parser (test fixtures, in-memory adapters, future synthesisers).
 *  Defence-in-depth: every entry is re-validated here so the primitive
 *  stays safe even when the parser-trusted path is bypassed.
 * - **Depth cap**: synthesis bounds recursion at `MAX_TREE_DEPTH` (4096,
 *  matching git's canonical limit). The cap is enforced at the input
 *  boundary by counting slashes — by the time recursion would catch a
 *  pathological depth, the JS engine has already exhausted its call
 *  stack. Path validation does NOT subsume this check: a path can be
 *  safe segment-by-segment (no `..`/`.`/empty) and still be 10 000
 *  levels deep.
 */

import type { IndexEntry } from '../../domain/git-index/index.js';
import { NO_PARSER_OFFSET, validateIndexPath } from '../../domain/git-index/path-validator.js';
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

const assertDepthBounded = (path: string): void => {
  // Count slashes — each one corresponds to a synthesizeLevel recursion.
  // Enforced at the input boundary so adversarial inputs fail fast WITHOUT
  // recursing (the call stack would otherwise overflow before any async
  // tick yielded). Path-level safety (segment-level rejection of `..` etc.)
  // lives upstream in `parseIndex`.
  let slashCount = 0;
  for (const ch of path) {
    if (ch === '/') slashCount += 1;
  }
  if (slashCount > MAX_TREE_DEPTH) {
    throw treeDepthExceeded(slashCount);
  }
};

const stage0Entries = (entries: ReadonlyArray<IndexEntry>): PendingEntry[] => {
  const out: PendingEntry[] = [];
  for (const entry of entries) {
    if (entry.flags.stage !== 0) continue;
    // Defence-in-depth: re-validate paths. `parseIndex` already calls
    // this on every entry it constructs, so this is a no-op for
    // parser-sourced indices. Callers constructing IndexEntry records
    // outside the parser (test fixtures, future in-memory builders)
    // benefit from the second check. We pass NO_PARSER_OFFSET because
    // these entries did not come from a parsed byte buffer — see
    // `path-validator.ts` for the contract.
    validateIndexPath(entry.path, NO_PARSER_OFFSET);
    assertDepthBounded(entry.path);
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

// Recursion depth is NOT re-checked here: `assertDepthBounded` already
// caps every entry's slash count at `MAX_TREE_DEPTH` at the input
// boundary, so the deepest leaf this descent can reach is exactly that
// cap. A secondary `depth > MAX_TREE_DEPTH` guard would be dead code —
// the JS call stack would overflow long before it could ever fire.
const synthesizeLevel = async (
  ctx: Context,
  entries: ReadonlyArray<PendingEntry>,
): Promise<ObjectId> => {
  const { files, subdirs } = groupByPrefix(entries);
  const treeEntries: TreeEntry[] = [];
  for (const file of files) {
    treeEntries.push({ name: file.path as FilePath, id: file.id, mode: file.mode });
  }
  for (const [prefix, subEntries] of subdirs) {
    const subId = await synthesizeLevel(ctx, subEntries);
    treeEntries.push({ name: prefix as FilePath, id: subId, mode: FILE_MODE.DIRECTORY });
  }
  return writeTree(ctx, treeEntries);
};

/**
 * Public entry: pass the `entries` array directly (typically
 * `index.entries`, but callers holding a filtered list may supply it
 * without wrapping in a fake `GitIndex`).
 */
export const synthesizeTreeFromIndex = async (
  ctx: Context,
  entries: ReadonlyArray<IndexEntry>,
): Promise<ObjectId> => synthesizeLevel(ctx, stage0Entries(entries));
