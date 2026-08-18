import { MAX_FLAT_TREE_ENTRIES } from '../../domain/diff/index.js';
import { operationAborted } from '../../domain/error.js';
import { treeDepthExceeded, treeEntryLimitExceeded } from '../../domain/objects/error.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import { isDotGitWalkEntry } from '../../domain/path/verify-path.js';
import { validateWalkedEntryPath } from '../../domain/working-tree-path.js';
import type { Context } from '../../ports/context.js';
import type { DirEntry, FileStat } from '../../ports/file-system.js';
import { joinPathSegment } from './internal/join-path-segment.js';
import { joinPath } from './internal/join-working-tree-path.js';
import { requireWorkTree } from './internal/repo-state.js';
import { resolveMaxTreeDepth } from './internal/resolve-max-tree-depth.js';
import type { WorkingTreeStatMap } from './internal/working-tree-stat-map.js';
import type { WalkIgnorePredicate, WalkWorkingTreeEntry, WalkWorkingTreeOptions } from './types.js';

interface WalkConfig {
  readonly ctx: Context;
  /** Resolved once per walk via `requireWorkTree` — every caller of this
   *  exported primitive is expected to have already proved a work tree
   *  exists, but the primitive re-checks so it never dereferences an absent
   *  `layout.workDir` under a misuse. */
  readonly workDir: string;
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly ignore: WalkIgnorePredicate | undefined;
  readonly stats: WorkingTreeStatMap | undefined;
}

interface Counter {
  value: number;
}

/**
 * One directory entered on the explicit DFS stack: its entries plus the
 * cursor (`index`) of the next one to process. Pushed once per directory, in
 * the same place the former recursive descent used to happen, so the depth
 * guard and embedded-repo gate fire exactly once per directory, not once per
 * entry.
 */
interface WalkFrame {
  readonly entries: ReadonlyArray<DirEntry>;
  index: number;
  readonly prefix: string;
  readonly depth: number;
}

/** Guard a directory on entry (depth), `readdir` it, and build its stack frame. */
async function readDirectoryFrame(
  config: WalkConfig,
  prefix: string,
  depth: number,
): Promise<WalkFrame> {
  if (depth > config.maxDepth) throw treeDepthExceeded(depth);
  const entries = await config.ctx.fs.readdir(directoryPath(config, prefix));
  return { entries, index: 0, prefix, depth };
}

/**
 * `readDirectoryFrame` plus the embedded-repo gate: `undefined` when the
 * directory itself is an embedded repository (a `.git` directory or
 * worktree-pointer file among its entries), in which case nothing under it
 * is walked. Never applied to the workDir root — the host repository's own
 * `.git` is not an embedded-repo marker, so the root always enters via
 * `readDirectoryFrame` directly.
 */
async function enterSubdirectory(
  config: WalkConfig,
  prefix: string,
  depth: number,
): Promise<WalkFrame | undefined> {
  const frame = await readDirectoryFrame(config, prefix, depth);
  // Embedded-repo gate: a directory containing a `.git` DIRECTORY (or a
  // `.git` regular file pointing at a worktree gitdir) is treated as an
  // embedded clone and yields nothing. A spurious file literally named
  // `.git` is filtered by `isDotGitWalkEntry` in the main loop but must NOT
  // collapse the parent directory.
  if (frame.entries.some(isEmbeddedGitMarker)) return undefined;
  return frame;
}

type StackStep =
  | { readonly kind: 'skip' }
  | { readonly kind: 'push'; readonly frame: WalkFrame }
  | { readonly kind: 'yield'; readonly entry: WalkWorkingTreeEntry };

/**
 * Decide what one directory entry does to the walk: descend (`push` a new
 * frame, or `skip` when ignored / gated as embedded), drop (`skip`, a
 * non-file/dir/symlink entry or an ignored leaf), or surface (`yield`).
 * Extracted so the driving loop in {@link walkWorkingTree} stays flat.
 */
async function stepEntry(
  config: WalkConfig,
  counter: Counter,
  frame: WalkFrame,
  entry: DirEntry,
): Promise<StackStep> {
  const path = joinPathSegment(frame.prefix, entry.name) as FilePath;
  // Defence-in-depth: a malicious adapter could return `..` etc. Narrow
  // (validateWalkedEntryPath, not validateWorkingTreePath): a legitimate
  // on-disk `git~1`/`.git:stream`/HFS-alias entry is not a traversal hazard
  // and must reach the yield below, exactly as git's own directory walk
  // treats it.
  validateWalkedEntryPath(path);

  if (entry.isDirectory && !entry.isSymbolicLink) {
    if (config.ignore !== undefined && (await config.ignore(path, true))) return { kind: 'skip' };
    const childFrame = await enterSubdirectory(config, path, frame.depth + 1);
    return childFrame === undefined ? { kind: 'skip' } : { kind: 'push', frame: childFrame };
  }
  if (!entry.isFile && !entry.isSymbolicLink) return { kind: 'skip' };
  if (config.ignore !== undefined && (await config.ignore(path, false))) return { kind: 'skip' };
  counter.value += 1;
  if (counter.value > config.maxEntries) {
    throw treeEntryLimitExceeded(counter.value, config.maxEntries);
  }
  return {
    kind: 'yield',
    entry: {
      path,
      isFile: entry.isFile,
      isDirectory: entry.isDirectory,
      isSymbolicLink: entry.isSymbolicLink,
      stat: lazyStat(config, path),
    },
  };
}

/**
 * Depth-first walk of the working tree starting at `ctx.layout.workDir`.
 *
 * Yields leaf entries (files and symlinks) as `{ path, isFile, isDirectory,
 * isSymbolicLink, stat }`. The three kind bits come straight off the
 * underlying `readdir` `DirEntry`; `stat` is a lazily fetched, per-entry
 * memoised accessor — a consumer that only reads `path` never pays an
 * `lstat`. Directories are descended into, not yielded. `.git` at any level
 * is skipped, folded only by case (`isDotGitWalkEntry`, matching git's own
 * `read_directory` under `core.ignorecase`) — an NTFS/HFS-obscured alias
 * (`git~1`, a `.git:`-stream name, a trailing-dot/space variant, an HFS
 * ignorable-codepoint form) is walked like any other entry, exactly as
 * real git's directory walk does; that widened matrix applies only at the
 * index-write boundary (`verifyPath`), not here. Embedded repositories
 * (directories containing a `.git` child) are skipped entirely — yields
 * nothing under them. Symlinks are surfaced via `lstat` (no follow); a
 * symlink to a directory is yielded as a leaf, not descended into.
 *
 * The host repository's own `.git` is NOT treated as an embedded-repo
 * marker — at the workDir root we only skip the `.git` entry itself, not
 * the workDir.
 *
 * Descends with an explicit stack of directory frames instead of recursion
 * — depth costs an array push, not a JS/generator call frame — so `maxDepth`
 * is the only ceiling on how deep a walk can go.
 *
 * `maxDepth` defaults to `core.maxTreeDepth`, read from the repository-local
 * config (default 2048, honoured unclamped) — never from `~/.gitconfig` or
 * any other scope, which tsgit does not read for this key.
 */
export async function* walkWorkingTree(
  ctx: Context,
  options?: WalkWorkingTreeOptions,
): AsyncIterable<WalkWorkingTreeEntry> {
  const config: WalkConfig = {
    ctx,
    workDir: requireWorkTree(ctx, 'walk-working-tree'),
    maxDepth: options?.maxDepth ?? (await resolveMaxTreeDepth(ctx)),
    maxEntries: options?.maxEntries ?? MAX_FLAT_TREE_ENTRIES,
    ignore: options?.ignore,
    stats: options?.stats,
  };
  const counter: Counter = { value: 0 };
  const stack: WalkFrame[] = [await readDirectoryFrame(config, '', 0)];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.index >= frame.entries.length) {
      stack.pop();
      continue;
    }
    const entry = frame.entries[frame.index]!;
    frame.index += 1;
    if (config.ctx.signal?.aborted) throw operationAborted();
    if (isDotGitWalkEntry(entry.name)) continue;

    const step = await stepEntry(config, counter, frame, entry);
    if (step.kind === 'push') stack.push(step.frame);
    if (step.kind === 'yield') yield step.entry;
  }
}

/**
 * Builds a memoised stat accessor for one leaf entry. `lstat` is deferred
 * until a consumer actually reads the stat, and — unchanged from the prior
 * eager fetch — carries no `.catch()`: a file deleted between `readdir` and
 * the accessor's first call still throws, just later (on first read instead
 * of on yield). When a shared {@link WorkingTreeStatMap} is supplied, a prior
 * sample for this path (recorded by another pass) short-circuits the `lstat`
 * entirely; a fresh fetch is recorded back into the map for a later pass.
 */
const lazyStat = (config: WalkConfig, path: FilePath): (() => Promise<FileStat>) => {
  let memo: Promise<FileStat> | undefined;
  return () => {
    memo ??= fetchStat(config, path);
    return memo;
  };
};

const fetchStat = async (config: WalkConfig, path: FilePath): Promise<FileStat> => {
  const sampled = config.stats?.sampled(path);
  if (sampled !== undefined) return sampled;
  const stat = await config.ctx.fs.lstat(joinPath(config.workDir, path));
  config.stats?.record(path, stat);
  return stat;
};

const directoryPath = (config: WalkConfig, prefix: string): string =>
  prefix === '' ? config.workDir : joinPath(config.workDir, prefix);

const isEmbeddedGitMarker = (entry: {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}): boolean => {
  if (!isDotGitWalkEntry(entry.name)) return false;
  // A `.git` directory marks an embedded clone. A `.git` regular file is
  // git's worktree-pointer (`gitdir: /path/to/.git/worktrees/...`) — also
  // an embedded checkout. Symlinks are NOT treated as markers because the
  // walker never follows symlinks; treating a stray `.git` symlink as a
  // marker would let an attacker silently hide siblings.
  return entry.isDirectory || (entry.isFile && !entry.isSymbolicLink);
};
