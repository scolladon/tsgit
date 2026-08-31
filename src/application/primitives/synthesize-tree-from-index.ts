/**
 * Synthesise a nested `Tree` object from a flat `GitIndex` and return the
 * root tree's `ObjectId`. Sub-trees are written to the object store as a
 * side-effect of an explicit-stack descent over the index's prefix trie —
 * only stage-0 entries contribute.
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
 * - **Path validation**: segment-level validation is hoisted into
 *  `parseIndex` (`src/domain/git-index/path-validator.ts`). Every
 *  `IndexEntry` reaching this primitive THROUGH THE CANONICAL PARSER
 *  carries a `FilePath` value already free of `..`, `.`, empty segments,
 *  and leading-slash absolute paths. However, the primitive is also
 *  reachable from callers that construct `IndexEntry` records outside
 *  the parser (test fixtures, in-memory adapters, future synthesisers).
 *  Defence-in-depth: every entry is re-validated here so the primitive
 *  stays safe even when the parser-trusted path is bypassed.
 * - **Depth cap**: synthesis bounds nesting at `core.maxTreeDepth`
 *  (repository-local config, default 2048, honoured unclamped). Git
 *  itself imposes no such limit on `write-tree` — it accepts paths 4097,
 *  8000, even 28000 segments deep, and its only failure mode is a
 *  segfault whose threshold moves with `ulimit -s`. Capping this surface
 *  at all is a deliberate residual divergence: refusing cleanly is
 *  strictly better than crashing with a stale 0-byte `index.lock`. The
 *  cap is enforced at the input boundary by counting slashes, before any
 *  tree is written.
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
import { treeEntry } from '../../domain/objects/tree.js';
import type { Context } from '../../ports/context.js';
import { resolveMaxTreeDepth } from './internal/resolve-max-tree-depth.js';
import { writeTree } from './write-tree.js';

interface PendingEntry {
  readonly path: string;
  readonly id: ObjectId;
  readonly mode: FileMode;
}

const assertDepthBounded = (path: string, maxDepth: number): void => {
  // Count slashes — each one corresponds to one level of tree nesting.
  // Enforced at the input boundary so adversarial inputs fail fast without
  // building any part of the trie. Path-level safety (segment-level
  // rejection of `..` etc.) lives upstream in `parseIndex`.
  let slashCount = 0;
  for (const ch of path) {
    if (ch === '/') slashCount += 1;
  }
  if (slashCount > maxDepth) {
    throw treeDepthExceeded(slashCount);
  }
};

const stage0Entries = (entries: ReadonlyArray<IndexEntry>, maxDepth: number): PendingEntry[] => {
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
    validateIndexPath(entry.path, NO_PARSER_OFFSET, entry.mode);
    assertDepthBounded(entry.path, maxDepth);
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

/**
 * Sentinel `parentIndex` meaning "this frame's parent is the root" — the
 * root is never itself a member of `frames` (see `TrieFrame`), so it can't
 * be addressed by a real array index.
 */
const ROOT_PARENT_INDEX = -1;

/**
 * One NAMED node of the prefix trie below the root, already grouped into its
 * own files and flattened into `frames` at a fixed index. The root itself is
 * excluded from `frames` — it's the one node with no name, so keeping it out
 * of the array (its files live in `rootFiles` instead) makes `name`
 * non-optional for every real frame. `parentIndex` is either
 * `ROOT_PARENT_INDEX` or another index into `frames`, and when it IS another
 * index it's always strictly less than this node's own index —
 * `buildTrieFrames` only appends a child after its parent has already been
 * pushed, so a plain reverse scan of `frames` is a valid post-order (every
 * descendant is visited before its ancestor).
 */
interface TrieFrame {
  readonly name: FilePath;
  readonly files: ReadonlyArray<PendingEntry>;
  readonly parentIndex: number;
}

interface Trie {
  readonly rootFiles: ReadonlyArray<PendingEntry>;
  readonly frames: ReadonlyArray<TrieFrame>;
}

/**
 * Discover the whole prefix trie with an explicit stack instead of recursion
 * — depth costs a queue entry, not a JS call frame, so this never overflows
 * regardless of how deeply nested `rootEntries` is (bounded separately by
 * `assertDepthBounded` at the input boundary).
 */
const buildTrieFrames = (rootEntries: ReadonlyArray<PendingEntry>): Trie => {
  const { files: rootFiles, subdirs: rootSubdirs } = groupByPrefix(rootEntries);
  const frames: TrieFrame[] = [];
  const toVisit: Array<{
    readonly name: FilePath;
    readonly entries: ReadonlyArray<PendingEntry>;
    readonly parentIndex: number;
  }> = [];
  for (const [prefix, subEntries] of rootSubdirs) {
    toVisit.push({ name: prefix as FilePath, entries: subEntries, parentIndex: ROOT_PARENT_INDEX });
  }
  while (toVisit.length > 0) {
    const { name, entries, parentIndex } = toVisit.pop()!;
    const { files, subdirs } = groupByPrefix(entries);
    const index = frames.length;
    frames.push({ name, files, parentIndex });
    for (const [prefix, subEntries] of subdirs) {
      toVisit.push({ name: prefix as FilePath, entries: subEntries, parentIndex: index });
    }
  }
  return { rootFiles, frames };
};

const filesToTreeEntries = (files: ReadonlyArray<PendingEntry>): TreeEntry[] =>
  files.map((file) => treeEntry(file.mode, file.path as FilePath, file.id));

/**
 * Write every frame bottom-up: a plain reverse scan over `frames` visits
 * every child before its parent (see `TrieFrame`), so by the time a frame is
 * written, its own sub-tree entries have already been appended to it — either
 * to its parent frame's entry list, or to `rootTreeEntries` when the parent
 * is the root. The root itself is written last, once the scan has appended
 * every top-level subtree to `rootTreeEntries`.
 */
const writeTrieFrames = async (ctx: Context, trie: Trie): Promise<ObjectId> => {
  const { rootFiles, frames } = trie;
  const rootTreeEntries = filesToTreeEntries(rootFiles);
  const treeEntries = frames.map((frame) => filesToTreeEntries(frame.files));
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index]!;
    const subId = await writeTree(ctx, treeEntries[index]!);
    const parentEntries =
      frame.parentIndex === ROOT_PARENT_INDEX ? rootTreeEntries : treeEntries[frame.parentIndex]!;
    parentEntries.push(treeEntry(FILE_MODE.DIRECTORY, frame.name, subId));
  }
  return writeTree(ctx, rootTreeEntries);
};

/**
 * Public entry: pass the `entries` array directly (typically
 * `index.entries`, but callers holding a filtered list may supply it
 * without wrapping in a fake `GitIndex`).
 */
export const synthesizeTreeFromIndex = async (
  ctx: Context,
  entries: ReadonlyArray<IndexEntry>,
): Promise<ObjectId> => {
  const maxDepth = await resolveMaxTreeDepth(ctx);
  const pending = stage0Entries(entries, maxDepth);
  return writeTrieFrames(ctx, buildTrieFrames(pending));
};
