import { MAX_FLAT_TREE_ENTRIES } from '../../domain/diff/index.js';
import { operationAborted } from '../../domain/error.js';
import { concatBytes } from '../../domain/objects/encoding.js';
import {
  treeCycleDetected,
  treeDepthExceeded,
  treeEntryLimitExceeded,
  unexpectedObjectType,
} from '../../domain/objects/error.js';
import {
  type FileMode,
  type FilePath,
  isDirectory,
  type ObjectId,
  type Tree,
  type TreeEntry,
} from '../../domain/objects/index.js';
import { foldPathSegment, type PathHasher } from '../../domain/storage/pack-name-hash.js';
import type { Context } from '../../ports/context.js';
import { resolveMaxTreeDepth } from './internal/resolve-max-tree-depth.js';
import { readObject } from './read-object.js';
import type { WalkTreeEntry, WalkTreeOptions } from './types.js';
import { exceedsMaxTreeDepth, exceedsMaxTreeEntries } from './validators.js';

/** The separator as bytes, for joining a full path in {@link joinPrefixBytes}.
 *  The hashing counterpart lives with the fold in the domain. */
const SLASH = Uint8Array.of(0x2f);

interface WalkConfig {
  readonly ctx: Context;
  readonly recursive: boolean;
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly pathBytes: boolean;
  readonly pathHasher?: PathHasher;
  readonly skipTree?: (id: ObjectId) => boolean;
}

interface Counter {
  value: number;
}

/**
 * A frame's inherited path, in the three representations a growing
 * `enterTree` parameter list used to carry separately: the display string,
 * the caller's hash-fold state, and — when `pathBytes` is on — the raw byte
 * prefix. One concept (a frame's own path, before its entries' names are
 * added), one value object.
 */
interface FramePrefix {
  readonly text: string;
  /** Fold state of `text`, in the caller's `pathHasher` (0 when none was
   *  supplied — never read in that case). */
  readonly hashState: number;
  /** This frame's own path bytes — a private copy, `undefined` when the
   *  `pathBytes` option is off, an empty array at the root. */
  readonly bytes: Uint8Array | undefined;
}

/** Full path of `name` appended to this prefix — git's own rule: a root
 *  entry is its bare name, never a leading `/`. */
function joinPrefixPath(prefix: FramePrefix, name: string): string {
  return prefix.text === '' ? name : `${prefix.text}/${name}`;
}

/**
 * Fold `nameBytes` onto this prefix's hash state: git's empty-prefix rule
 * (a root entry hashes its name, never `/name`) then the entry's own bytes
 * — the authoritative on-disk value, never the derived, lossy `name` string.
 */
function foldPrefixHash(hasher: PathHasher, prefix: FramePrefix, nameBytes: Uint8Array): number {
  return foldPathSegment(hasher, prefix.hashState, nameBytes, prefix.text === '');
}

/**
 * Full path of `nameBytes` appended to this prefix, as bytes. A root guard
 * separate from {@link foldPrefixHash}'s — keyed on the byte prefix's own
 * length, not on `text` — because `pathBytes` and `pathHasher` are
 * independent options.
 */
function joinPrefixBytes(prefix: FramePrefix, nameBytes: Uint8Array): Uint8Array {
  const bytes = prefix.bytes!;
  return bytes.length === 0 ? nameBytes.slice() : concatBytes([bytes, SLASH, nameBytes]);
}

/**
 * One tree entered on the explicit DFS stack: its entries plus the cursor
 * (`index`) of the next one to process. Pushed once per tree, in the same
 * place `walkInternal`'s recursive call used to happen, so the cycle and
 * depth guards below still fire exactly once per tree, not once per entry.
 */
interface WalkFrame {
  readonly entries: ReadonlyArray<TreeEntry>;
  index: number;
  readonly framePrefix: FramePrefix;
  readonly depth: number;
  readonly id: ObjectId;
}

/**
 * Guard a tree on entry (cycle, then depth) and build its stack frame.
 *
 * `ancestry` is the single root-to-current path, owned by the walk and mutated
 * as the stack moves: the id is added here and removed when the frame pops.
 * It is deliberately not a per-frame array — rebuilding one at every level
 * costs O(depth²) live pointers, which turns a deep descent into a heap
 * exhaustion (an uncatchable abort) instead of the typed refusal the depth cap
 * exists to produce. Since the cap is a user-supplied config value with no
 * internal ceiling, that ceiling would be reachable by configuration.
 */
function enterTree(
  maxDepth: number,
  tree: Tree,
  framePrefix: FramePrefix,
  depth: number,
  ancestry: Set<ObjectId>,
): WalkFrame {
  if (ancestry.has(tree.id)) throw treeCycleDetected(tree.id);
  if (exceedsMaxTreeDepth(depth, maxDepth)) throw treeDepthExceeded(depth);
  ancestry.add(tree.id);
  return { entries: tree.entries, index: 0, framePrefix, depth, id: tree.id };
}

/** Build the once-per-operation {@link WalkConfig}, resolving `maxDepth` from
 * config only when the caller did not supply one. */
async function resolveWalkConfig(
  ctx: Context,
  options: WalkTreeOptions | undefined,
): Promise<WalkConfig> {
  return {
    ctx,
    recursive: options?.recursive ?? true,
    maxDepth: options?.maxDepth ?? (await resolveMaxTreeDepth(ctx)),
    maxEntries: options?.maxEntries ?? MAX_FLAT_TREE_ENTRIES,
    pathBytes: options?.pathBytes ?? false,
    ...(options?.pathHasher !== undefined ? { pathHasher: options.pathHasher } : {}),
    ...(options?.skipTree !== undefined ? { skipTree: options.skipTree } : {}),
  };
}

interface FrameStep {
  readonly path: FilePath;
  readonly entry: TreeEntry;
  /** The child frame's inherited fold state, `undefined` when no `pathHasher`
   *  was supplied; this IS the entry's own `nameHash`. Declared present-but-
   *  undefined rather than optional: this type is private and destructured at
   *  its only call site, so nothing observes key presence, and a fixed shape
   *  keeps the hot per-entry path off a conditional spread. */
  readonly nameHash: number | undefined;
  /** The entry's own full path as bytes, `undefined` when `pathBytes` was not
   *  supplied; a fresh array, never a view onto `frame.framePrefix.bytes`. */
  readonly pathBytes: Uint8Array | undefined;
  /** Whether `walkTree`'s own loop should enter this entry's subtree —
   *  `shouldRecurse` ANDed with a negated `skipTree` verdict, decided here so
   *  the verdict is fixed before the entry is yielded (see `WalkTreeOptions.skipTree`). */
  readonly descend: boolean;
}

/**
 * Advance `frame` to its next entry: the abort check, the path join, and the
 * entry-count guard — everything that must happen before a value can be
 * yielded — extracted so `walkTree`'s own loop stays flat.
 */
function nextFrameEntry(config: WalkConfig, counter: Counter, frame: WalkFrame): FrameStep {
  const entry = frame.entries[frame.index]!;
  frame.index += 1;
  if (config.ctx.signal?.aborted) throw operationAborted();
  const path = joinPrefixPath(frame.framePrefix, entry.name) as FilePath;
  counter.value += 1;
  if (exceedsMaxTreeEntries(counter.value, config.maxEntries)) {
    throw treeEntryLimitExceeded(counter.value, config.maxEntries);
  }
  return {
    path,
    entry,
    nameHash: config.pathHasher
      ? foldPrefixHash(config.pathHasher, frame.framePrefix, entry.nameBytes)
      : undefined,
    pathBytes: config.pathBytes ? joinPrefixBytes(frame.framePrefix, entry.nameBytes) : undefined,
    descend: shouldRecurse(config.recursive, entry.mode) && !(config.skipTree?.(entry.id) ?? false),
  };
}

/** The walk's own starting prefix — empty text, the hasher's seed (0 when
 *  none was supplied), and an empty byte array exactly when `pathBytes` is on. */
function buildRootPrefix(config: WalkConfig): FramePrefix {
  return {
    text: '',
    hashState: config.pathHasher?.seed ?? 0,
    bytes: config.pathBytes ? new Uint8Array(0) : undefined,
  };
}

/** The prefix a directory `entry`'s own subtree frame inherits: its full
 *  path, its folded hash state, and — when `pathBytes` is on — its full
 *  path as bytes, rebuilt from `frame`'s own prefix rather than reused from
 *  the value already handed to the consumer. */
function buildChildPrefix(
  config: WalkConfig,
  frame: WalkFrame,
  path: FilePath,
  entry: TreeEntry,
  nameHash: number | undefined,
): FramePrefix {
  return {
    text: path,
    hashState: nameHash ?? 0,
    bytes: config.pathBytes ? joinPrefixBytes(frame.framePrefix, entry.nameBytes) : undefined,
  };
}

/** Assembles one yielded entry from a {@link FrameStep}'s fields, keeping
 *  the optional `nameHash`/`pathBytes` keys entirely out of `walkTree`'s
 *  own loop body. */
function buildYieldedEntry(
  path: FilePath,
  entry: TreeEntry,
  nameHash: number | undefined,
  pathBytes: Uint8Array | undefined,
): WalkTreeEntry {
  // `WalkTreeEntry`'s optional keys ARE observed by consumers, so absence has
  // to mean an absent key rather than an undefined value — but that is no
  // reason to make the common path pay for it. Eleven of the twelve callers
  // supply neither option, and this early return gives them the same object
  // shape, and the same cost, they had before either existed.
  const id = entry.id;
  const mode = entry.mode as FileMode;
  if (nameHash === undefined) {
    if (pathBytes === undefined) return { path, id, mode };
    return { path, id, mode, pathBytes };
  }
  if (pathBytes === undefined) return { path, id, mode, nameHash };
  return { path, id, mode, nameHash, pathBytes };
}

/**
 * Lazy pre-order walk of a tree (directory before its contents), one entry
 * at a time. Descends with an explicit stack of tree frames instead of
 * recursion — depth costs an array push, not a JS/generator call frame — so
 * `maxDepth` is the only ceiling on how deep a walk can go.
 *
 * `maxDepth` defaults to `core.maxTreeDepth`, read from the repository-local
 * config (default 2048, honoured unclamped) — never from `~/.gitconfig` or
 * any other scope, which tsgit does not read for this key.
 */
export async function* walkTree(
  ctx: Context,
  treeIdOrObject: ObjectId | Tree,
  options?: WalkTreeOptions,
): AsyncIterable<WalkTreeEntry> {
  const config = await resolveWalkConfig(ctx, options);
  const counter: Counter = { value: 0 };
  const rootTree =
    typeof treeIdOrObject === 'string'
      ? await resolveTree(ctx, treeIdOrObject as ObjectId)
      : treeIdOrObject;

  const ancestry = new Set<ObjectId>();
  const stack: WalkFrame[] = [
    enterTree(config.maxDepth, rootTree, buildRootPrefix(config), 0, ancestry),
  ];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.index >= frame.entries.length) {
      stack.pop();
      ancestry.delete(frame.id);
      continue;
    }
    const { path, entry, nameHash, pathBytes, descend } = nextFrameEntry(config, counter, frame);
    yield buildYieldedEntry(path, entry, nameHash, pathBytes);
    if (!descend) continue;
    const subtreeObj = await readObject(config.ctx, entry.id);
    if (subtreeObj.type === 'tree') {
      const childPrefix = buildChildPrefix(config, frame, path, entry, nameHash);
      stack.push(enterTree(config.maxDepth, subtreeObj, childPrefix, frame.depth + 1, ancestry));
    }
  }
}

function shouldRecurse(recursive: boolean, mode: string): boolean {
  if (!recursive) return false;
  // A gitlink (mode 160000) is never a directory (mode 40000), so isDirectory
  // alone already rejects it — no explicit isGitlink guard needed.
  return isDirectory(mode as FileMode);
}

async function resolveTree(ctx: Context, id: ObjectId): Promise<Tree> {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'tree') {
    throw unexpectedObjectType('tree', obj.type, id);
  }
  return obj;
}
