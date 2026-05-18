import { MAX_FLAT_TREE_ENTRIES } from '../../domain/diff/index.js';
import { operationAborted } from '../../domain/error.js';
import { treeDepthExceeded, treeEntryLimitExceeded } from '../../domain/objects/error.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { isForbiddenGitComponent, validatePath } from '../commands/internal/working-tree.js';
import type { WalkWorkingTreeEntry, WalkWorkingTreeOptions } from './types.js';

const DEFAULT_MAX_DEPTH = 4096;

interface WalkConfig {
  readonly ctx: Context;
  readonly maxDepth: number;
  readonly maxEntries: number;
}

interface Counter {
  value: number;
}

/**
 * Depth-first walk of the working tree starting at `ctx.layout.workDir`.
 *
 * Yields leaf entries (files and symlinks) as `{ path, stat }`. Directories
 * are descended into, not yielded. `.git` at any level is skipped
 * (case-insensitive, NTFS-trimmed). Embedded repositories (directories
 * containing a `.git` child) are skipped entirely — yields nothing under
 * them. Symlinks are surfaced via `lstat` (no follow); a symlink to a
 * directory is yielded as a leaf, not descended into.
 *
 * The host repository's own `.git` is NOT treated as an embedded-repo
 * marker — at the workDir root we only skip the `.git` entry itself, not
 * the workDir.
 */
export async function* walkWorkingTree(
  ctx: Context,
  options?: WalkWorkingTreeOptions,
): AsyncIterable<WalkWorkingTreeEntry> {
  const config: WalkConfig = {
    ctx,
    maxDepth: options?.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxEntries: options?.maxEntries ?? MAX_FLAT_TREE_ENTRIES,
  };
  const counter: Counter = { value: 0 };
  yield* walkInternal(config, counter, '', 0, /* isRoot */ true);
}

async function* walkInternal(
  config: WalkConfig,
  counter: Counter,
  prefix: string,
  depth: number,
  isRoot: boolean,
): AsyncIterable<WalkWorkingTreeEntry> {
  if (depth > config.maxDepth) throw treeDepthExceeded(depth);
  const entries = await config.ctx.fs.readdir(directoryPath(config, prefix));
  // Embedded-repo gate: a non-root directory containing a `.git` entry
  // is treated as an embedded clone and yields nothing.
  if (!isRoot && entries.some((e) => isForbiddenGitComponent(e.name))) return;
  for (const entry of entries) {
    if (config.ctx.signal?.aborted) throw operationAborted();
    if (isForbiddenGitComponent(entry.name)) continue;
    yield* visitEntry(config, counter, prefix, depth, entry);
  }
}

async function* visitEntry(
  config: WalkConfig,
  counter: Counter,
  prefix: string,
  depth: number,
  entry: {
    readonly name: string;
    readonly isFile: boolean;
    readonly isDirectory: boolean;
    readonly isSymbolicLink: boolean;
  },
): AsyncIterable<WalkWorkingTreeEntry> {
  const path = joinPath(prefix, entry.name);
  // Defence-in-depth: a malicious adapter could return `..` etc.
  validatePath(path);
  if (entry.isDirectory && !entry.isSymbolicLink) {
    yield* walkInternal(config, counter, path, depth + 1, /* isRoot */ false);
    return;
  }
  if (!entry.isFile && !entry.isSymbolicLink) return;
  counter.value += 1;
  if (counter.value > config.maxEntries) {
    throw treeEntryLimitExceeded(counter.value, config.maxEntries);
  }
  const stat = await config.ctx.fs.lstat(`${config.ctx.layout.workDir}/${path}`);
  yield { path, stat };
}

const directoryPath = (config: WalkConfig, prefix: string): string =>
  prefix === '' ? config.ctx.layout.workDir : `${config.ctx.layout.workDir}/${prefix}`;

const joinPath = (prefix: string, name: string): FilePath =>
  (prefix === '' ? name : `${prefix}/${name}`) as FilePath;
