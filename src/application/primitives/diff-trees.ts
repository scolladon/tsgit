import { resolveAttribute } from '../../domain/attributes/index.js';
import { primaryPath } from '../../domain/diff/change-path.js';
import type { FlatTree, FlatTreeEntry } from '../../domain/diff/flat-tree.js';
import {
  type AddChange,
  computeStatFields,
  type DeleteChange,
  type DiffChange,
  diffTrees as domainDiffTrees,
  type LineKey,
  lineKeyIsActive,
  type ModifyChange,
  resolveLineKey,
  type StatDiffChange,
  type StatFields,
  type StatFieldsOptions,
  type StatTreeDiff,
  type TreeDiff,
} from '../../domain/diff/index.js';
import { diffRawTrees } from '../../domain/diff/raw-tree-diff.js';
import type { RenameDetectOptions } from '../../domain/diff/rename-detect.js';
import {
  treeCycleDetected,
  treeDepthExceeded,
  unexpectedObjectType,
} from '../../domain/objects/error.js';
import { isDirectory } from '../../domain/objects/file-mode.js';
import {
  type FilePath,
  type ObjectId,
  parseCommitContent,
  parseTagContent,
  type Tree,
} from '../../domain/objects/index.js';
import { refChainTooDeep } from '../../domain/refs/error.js';
import type { Context } from '../../ports/context.js';
import { detectSimilarityRenames } from './detect-similarity-renames.js';
import { flattenTree } from './flatten-tree.js';
import { boundedMap, MAX_CONCURRENT_BLOB_LOADS } from './internal/bounded-map.js';
import { type AttributeProvider, buildAttributeProvider } from './internal/read-gitattributes.js';
import { isWhitespaceOnlyModify } from './internal/whitespace-drop-predicate.js';
import { materialisePatchFiles } from './materialise-patch-files.js';
import { readRawObject } from './read-object.js';
import { readTree } from './read-tree.js';
import { type DiffTreesInput, type DiffTreesOptions, MAX_PEEL_DEPTH } from './types.js';
import { exceedsMaxTreeDepth } from './validators.js';

const EMPTY = new Uint8Array(0);

export function diffTrees(
  ctx: Context,
  a: DiffTreesInput,
  b: DiffTreesInput,
  options: DiffTreesOptions & { withStat: true },
): Promise<StatTreeDiff>;
export function diffTrees(
  ctx: Context,
  a: DiffTreesInput,
  b: DiffTreesInput,
  options?: DiffTreesOptions,
): Promise<TreeDiff>;
export async function diffTrees(
  ctx: Context,
  a: DiffTreesInput,
  b: DiffTreesInput,
  options?: DiffTreesOptions,
): Promise<TreeDiff | StatTreeDiff> {
  const rawDiff = await resolveAndDiff(ctx, a, b, options);
  const diff =
    options?.detectRenames === true
      ? await detectSimilarityRenames(
          ctx,
          rawDiff,
          options.renameOptions,
          await buildPreimage(ctx, a, options.renameOptions),
        )
      : rawDiff;

  const lineKey = resolveLineKey(options ?? {});
  const lineKeyActive = lineKeyIsActive(lineKey);
  const ignoreBlankLines = options?.ignoreBlankLines === true;
  const withStat = options?.withStat === true;

  if (lineKeyActive || withStat) {
    return applyLinePassAndStat(ctx, diff, lineKey, lineKeyActive, ignoreBlankLines, withStat);
  }
  return diff;
}

/**
 * Resolve both inputs and compute the top-level diff. The recursive branch
 * resolves to raw bytes and walks the byte-cursor merge-join; the
 * non-recursive branch keeps resolving to parsed `Tree` objects — the two
 * branches never both resolve the same input, so only one read path runs.
 */
async function resolveAndDiff(
  ctx: Context,
  a: DiffTreesInput,
  b: DiffTreesInput,
  options: DiffTreesOptions | undefined,
): Promise<TreeDiff> {
  if (options?.recursive === true) {
    const [aContent, bContent] = await Promise.all([
      resolveRawInput(ctx, a),
      resolveRawInput(ctx, b),
    ]);
    return diffRecursive(ctx, aContent, bContent);
  }
  const [treeA, treeB] = await Promise.all([resolveInput(ctx, a), resolveInput(ctx, b)]);
  return domainDiffTrees(treeA, treeB);
}

/** Resolve the stat options for one file: line-key + blank when a mode is active,
 *  blank-only when only `ignoreBlankLines` is set, else none (plain counts).
 *  When `numstatBinaryOverride` is set it is threaded through unchanged. */
function statOptionsFor(
  lineKey: LineKey,
  lineKeyActive: boolean,
  ignoreBlankLines: boolean,
  numstatBinaryOverride: 'binary' | 'text' | undefined,
): StatFieldsOptions | undefined {
  const override = numstatBinaryOverride !== undefined ? { numstatBinaryOverride } : {};
  // equivalent-mutant: `if (lineKeyActive)` -> `if (true)` — when lineKeyActive is false the key is mode 'none' + no ignoreCrAtEol, so normalizeLine is the identity and computeStatFields treats { lineKey: <none> } identically to omitting lineKey; counts are unchanged.
  if (lineKeyActive) return { lineKey, ignoreBlankLines, ...override };
  // equivalent-mutant: `if (ignoreBlankLines)` -> `if (true)` — reached only when lineKeyActive is false; with ignoreBlankLines false, { ignoreBlankLines: false } and undefined both yield lineKey undefined + blankKey undefined in computeStatFields, so counts are identical.
  if (ignoreBlankLines) return { ignoreBlankLines, ...override };
  if (numstatBinaryOverride !== undefined) return { numstatBinaryOverride };
  return undefined;
}

/**
 * Route the drop-pass predicate and the stat pass to the cheapest mechanism
 * for what the caller asked for. `lineKeyActive && !withStat` (the common
 * `git diff -w`-style predicate-only call) never needs blob content beyond
 * the drop verdict, so it streams both blobs directly — skipping
 * `materialisePatchFiles` (full read + textconv + attribute resolution)
 * entirely. Any other combination needs materialised content (for counts
 * and/or textconv-aware bytes) and keeps the full stat pass.
 */
async function applyLinePassAndStat(
  ctx: Context,
  diff: TreeDiff,
  lineKey: LineKey,
  lineKeyActive: boolean,
  ignoreBlankLines: boolean,
  withStat: boolean,
): Promise<TreeDiff | StatTreeDiff> {
  if (lineKeyActive && !withStat) {
    return applyDropPredicate(ctx, diff, lineKey, ignoreBlankLines);
  }
  return applyStatPass(ctx, diff, lineKey, lineKeyActive, ignoreBlankLines, withStat);
}

/**
 * Materialise blobs once, run the drop pass and stat in a single traversal.
 * When `lineKeyActive`, drops modify changes that yield zero real hunks under
 * the active line-key mode. When `withStat`, attaches per-file counts to
 * every surviving change. The stat and drop predicate share one
 * `computeStatFields` call per modify so drop and counts are mutually consistent.
 */
async function applyStatPass(
  ctx: Context,
  diff: TreeDiff,
  lineKey: LineKey,
  lineKeyActive: boolean,
  ignoreBlankLines: boolean,
  withStat: boolean,
): Promise<TreeDiff | StatTreeDiff> {
  const changes = await expandDirectoryChanges(ctx, diff.changes);
  const files = await materialisePatchFiles(ctx, changes, { applyTextconv: true });
  const surviving: Array<DiffChange | StatDiffChange> = [];
  for (const file of files) {
    const stats = computeStatFields(
      file.oldContent ?? EMPTY,
      file.newContent ?? EMPTY,
      statOptionsFor(lineKey, lineKeyActive, ignoreBlankLines, file.numstatBinaryOverride),
    );
    if (lineKeyActive && shouldDrop(file.change, stats)) continue;
    surviving.push(withStat ? { ...file.change, ...stats } : file.change);
  }
  return { changes: surviving };
}

/**
 * Expand directory-mode add/delete/modify entries — a non-recursive diff can
 * legitimately pair two tree oids for a changed/added/removed sub-directory —
 * into full-path leaf changes before any blob content is materialised.
 * Mirrors git's own `diff-tree` behaviour: any output format that needs blob
 * content (`--numstat`/`--stat`/`-p`) implicitly recurses, because a tree
 * pair has no lines to diff. A no-op for already-recursive diffs or diffs
 * with no directory-mode entries — `expandLevelChange` passes leaf changes
 * through unchanged.
 */
async function expandDirectoryChanges(
  ctx: Context,
  changes: ReadonlyArray<DiffChange>,
): Promise<DiffChange[]> {
  const expanded = await Promise.all(
    changes.map((change) => expandLevelChange(ctx, change, ROOT_CURSOR)),
  );
  return expanded.flat();
}

/**
 * Predicate-only drop pass (no `withStat`): stream each `modify` change's
 * blobs to decide keep/drop without materialising content. Non-modify
 * changes are never dropped and need no I/O at all.
 */
async function applyDropPredicate(
  ctx: Context,
  diff: TreeDiff,
  lineKey: LineKey,
  ignoreBlankLines: boolean,
): Promise<TreeDiff> {
  // One lazily-built provider per drop pass: the streaming predicate is
  // blind to `.gitattributes`, so attribute-affected paths must be detected
  // up front and routed through the materialise-based verdict instead.
  let providerPromise: Promise<AttributeProvider> | undefined;
  const getProvider = (): Promise<AttributeProvider> => {
    providerPromise ??= buildAttributeProvider(ctx);
    return providerPromise;
  };
  const drops = await boundedMap(diff.changes, MAX_CONCURRENT_BLOB_LOADS, (change) =>
    changeShouldDrop(ctx, change, lineKey, ignoreBlankLines, getProvider),
  );
  return { changes: diff.changes.filter((_, index) => !drops[index]) };
}

/** `true` when the path's `diff` attribute is anything but unspecified —
 *  `-diff` (forced binary), `diff` (forced text), or a named driver. */
async function hasDiffAttribute(
  change: DiffChange,
  getProvider: () => Promise<AttributeProvider>,
): Promise<boolean> {
  const provider = await getProvider();
  const filePath = primaryPath(change);
  const { sources, macros } = await provider.sourcesForPath(filePath);
  return resolveAttribute(sources, filePath, 'diff', macros) !== 'unspecified';
}

/**
 * The stat-path verdict for one modify change — materialised content,
 * textconv applied, binary override honoured — used whenever an attribute
 * steers the file, so the predicate path can never diverge from
 * `applyStatPass` (or from git) on attribute-marked files.
 */
async function materialisedShouldDrop(
  ctx: Context,
  change: DiffChange,
  lineKey: LineKey,
  ignoreBlankLines: boolean,
  getProvider: () => Promise<AttributeProvider>,
): Promise<boolean> {
  const files = await materialisePatchFiles(ctx, [change], { applyTextconv: true, getProvider });
  // boundedMap (materialisePatchFiles' worker) returns exactly one result per input
  // change or rejects — never fewer — so a 1-element input always yields files[0].
  const file = files[0]!;
  const stats = computeStatFields(
    file.oldContent ?? EMPTY,
    file.newContent ?? EMPTY,
    statOptionsFor(lineKey, true, ignoreBlankLines, file.numstatBinaryOverride),
  );
  return shouldDrop(file.change, stats);
}

/**
 * A non-recursive diff can legitimately carry a directory-mode add/delete/
 * modify (a whole changed/added/removed sub-directory, paired as tree oids).
 * Git cannot line-diff a tree, so under any whitespace-ignore mode every
 * such entry is dropped outright — matching `git diff-tree -w` (no `-r`),
 * which never shows a directory-mode entry regardless of add/delete/modify.
 */
function isDirectoryModeChange(change: DiffChange): boolean {
  if (change.type === 'add') return isDirectory(change.newMode);
  if (change.type === 'delete') return isDirectory(change.oldMode);
  // Stryker disable next-line ConditionalExpression: equivalent — reached only by
  // modify/type-change/rename/copy (add/delete return above). modify: guard is true
  // either way, same body runs. type-change: classifySamePath only emits it when
  // !isSameKind, so exactly 0 or 1 side is a directory, never both — the `&&` below
  // is false regardless. rename/copy: buildRenameChange/buildCopyChange only complete
  // after readBlob succeeds on both sides, which throws unexpectedObjectType for a
  // tree oid — so a directory side can never reach a constructed RenameChange/CopyChange,
  // isDirectory is false on both — `&&` is false either way. Every reachable case matches
  // the unmutated `return false` fallthrough.
  if (change.type === 'modify')
    // Stryker disable next-line LogicalOperator: equivalent — classifySamePath only
    // emits 'modify' when isSameKind(oldMode,newMode), so isDirectory(oldMode) ===
    // isDirectory(newMode) always; X&&X === X||X for any X.
    return isDirectory(change.oldMode) && isDirectory(change.newMode);
  return false;
}

async function changeShouldDrop(
  ctx: Context,
  change: DiffChange,
  lineKey: LineKey,
  ignoreBlankLines: boolean,
  getProvider: () => Promise<AttributeProvider>,
): Promise<boolean> {
  if (isDirectoryModeChange(change)) return true;
  if (change.type !== 'modify') return false;
  if (await hasDiffAttribute(change, getProvider)) {
    return materialisedShouldDrop(ctx, change, lineKey, ignoreBlankLines, getProvider);
  }
  return isWhitespaceOnlyModify(ctx, change, lineKey, ignoreBlankLines);
}

/**
 * Drop predicate for the whitespace drop pass.
 * Only `modify` changes with zero added+deleted non-binary lines are dropped.
 * Type-changes, renames, copies, adds, and deletes are never dropped.
 * Binary modifies are never dropped (binary detection ignores whitespace flags).
 */
function shouldDrop(change: DiffChange, stats: StatFields): boolean {
  return change.type === 'modify' && stats.added === 0 && stats.deleted === 0 && !stats.binary;
}

/**
 * Build the flat preimage map for copies:'harder' — all tree-A paths become copy sources.
 * Returns undefined when copies:'harder' is not active or `a` is absent. An `ObjectId`
 * is peeled to its tree first (a commit or tag oid must resolve exactly like the
 * tree-oid form does) — `flattenTree` refuses anything but a tree, so `a` cannot be
 * handed to it unresolved. A caller-supplied `Tree` is already resolved and passed
 * through unchanged.
 */
async function buildPreimage(
  ctx: Context,
  a: DiffTreesInput,
  renameOptions: RenameDetectOptions | undefined,
): Promise<FlatTree['entries'] | undefined> {
  if (renameOptions?.copies !== 'harder' || a === undefined) return undefined;
  const resolved = typeof a === 'string' ? (await peelToTree(ctx, a)).id : a;
  const flat = await flattenTree(ctx, resolved);
  return flat.entries;
}

async function resolveInput(ctx: Context, input: DiffTreesInput): Promise<Tree | undefined> {
  // Stryker disable next-line ConditionalExpression: equivalent — undefined input is not a string, so skipping this guard falls through to `return input`, which is also undefined; identical outcome.
  if (input === undefined) return undefined;
  if (typeof input === 'string') {
    return readTree(ctx, input);
  }
  return input;
}

/**
 * Read an object raw and require it to be a tree, mirroring `readTree`'s own
 * non-tree refusal but without parsing — used by the recursive path, which
 * only ever needs tree bytes for the byte-cursor merge-join.
 */
async function readRawTree(ctx: Context, id: ObjectId): Promise<Uint8Array> {
  const raw = await readRawObject(ctx, id);
  if (raw.type !== 'tree') throw unexpectedObjectType('tree', raw.type, id);
  return raw.content;
}

/**
 * Raw sibling of `resolveInput`, used only by the recursive branch. A caller-supplied
 * `Tree` is re-read raw by its own `id` — one walk implementation at every level, at
 * the cost of a hand-forged `Tree` whose `id` is not in the store now throwing
 * `OBJECT_NOT_FOUND`. An `ObjectId` is peeled via `peelToTree` — commit -> tree and
 * tag -> tree, same max-peel-depth bound as `readTree` — so a commit/tag oid keeps
 * working, with every hop read raw exactly once (no redundant parse of the tree).
 */
async function resolveRawInput(
  ctx: Context,
  input: DiffTreesInput,
): Promise<Uint8Array | undefined> {
  if (input === undefined) return undefined;
  if (typeof input !== 'string') return readRawTree(ctx, input.id);
  return (await peelToTree(ctx, input)).content;
}

interface PeeledTree {
  readonly id: ObjectId;
  readonly content: Uint8Array;
}

/**
 * Peel a commit or tag oid down to the tree it ultimately points at. Mirrors
 * `readTree`'s peel loop (same `MAX_PEEL_DEPTH` bound, same non-tree refusal)
 * but reads every hop once as raw bytes, parsing only the commit/tag body
 * needed to find the next hop's id — the terminal tree is never parsed, only
 * read, so a peel never pays for a `Tree` parse it immediately discards.
 */
async function peelToTree(ctx: Context, id: ObjectId): Promise<PeeledTree> {
  let currentId = id;
  let raw = await readRawObject(ctx, currentId);
  let depth = 0;
  while (raw.type === 'commit' || raw.type === 'tag') {
    depth += 1;
    if (depth > MAX_PEEL_DEPTH) throw refChainTooDeep(depth, []);
    currentId =
      raw.type === 'commit'
        ? parseCommitContent(currentId, raw.content).data.tree
        : parseTagContent(currentId, raw.content).data.object;
    raw = await readRawObject(ctx, currentId);
  }
  if (raw.type !== 'tree') throw unexpectedObjectType('tree', raw.type, currentId);
  return { id: currentId, content: raw.content };
}

/** Recursion state threaded through `diffRecursiveLevel` — tracks the full-path
 * prefix plus per-side cycle/depth guards, mirroring `walkTree`'s protection
 * (the merge-join below descends into changed subtrees directly, bypassing
 * `walkTree`, so it must re-establish the same safety net). */
interface DiffCursor {
  readonly prefix: string;
  readonly depth: number;
  readonly oldStack: ReadonlyArray<ObjectId>;
  readonly newStack: ReadonlyArray<ObjectId>;
}

const ROOT_CURSOR: DiffCursor = { prefix: '', depth: 0, oldStack: [], newStack: [] };
const MAX_DIFF_RECURSION_DEPTH = 1024;

async function diffRecursive(
  ctx: Context,
  a: Uint8Array | undefined,
  b: Uint8Array | undefined,
): Promise<TreeDiff> {
  const changes = await diffRecursiveLevel(ctx, a, b, ROOT_CURSOR);
  return { changes };
}

/**
 * Merge-join one tree level via the raw byte-cursor diff, then expand only the
 * entries that actually differ. A TREESAME directory entry (identical oid+mode
 * on both sides) never reaches `expandLevelChange` — the merge-join already
 * drops it — so its subtree is never read or flattened, matching git's own
 * diff-tree pruning. Sibling directories that DO differ are expanded
 * concurrently.
 */
async function diffRecursiveLevel(
  ctx: Context,
  a: Uint8Array | undefined,
  b: Uint8Array | undefined,
  cursor: DiffCursor,
): Promise<DiffChange[]> {
  const levelChanges = diffRawTrees(a, b, ctx.hashConfig).changes;
  const expanded = await Promise.all(
    levelChanges.map((change) => expandLevelChange(ctx, change, cursor)),
  );
  return expanded.flat();
}

function joinPath(prefix: string, name: string): FilePath {
  return (prefix === '' ? name : `${prefix}/${name}`) as FilePath;
}

async function expandLevelChange(
  ctx: Context,
  change: DiffChange,
  cursor: DiffCursor,
): Promise<DiffChange[]> {
  if (change.type === 'modify' && isDirectory(change.oldMode) && isDirectory(change.newMode)) {
    return diffChangedSubtree(ctx, change, cursor);
  }
  if (change.type === 'add' && isDirectory(change.newMode)) {
    return expandAddedSubtree(ctx, change.newId, joinPath(cursor.prefix, change.newPath));
  }
  if (change.type === 'delete' && isDirectory(change.oldMode)) {
    return expandDeletedSubtree(ctx, change.oldId, joinPath(cursor.prefix, change.oldPath));
  }
  return [withPrefix(change, cursor.prefix)];
}

/** Rewrite a leaf-level change's path field with the recursion prefix. Rename
 * and copy changes never reach here — the domain merge-join this feeds from
 * only emits add/delete/modify/type-change — but the switch stays exhaustive
 * over `DiffChange` so a future variant fails to compile, not silently drops. */
function withPrefix(change: DiffChange, prefix: string): DiffChange {
  if (prefix === '') return change;
  switch (change.type) {
    case 'add':
      return { ...change, newPath: joinPath(prefix, change.newPath) };
    case 'delete':
      return { ...change, oldPath: joinPath(prefix, change.oldPath) };
    case 'modify':
    case 'type-change':
      return { ...change, path: joinPath(prefix, change.path) };
    case 'rename':
    case 'copy':
      return change;
  }
}

async function diffChangedSubtree(
  ctx: Context,
  change: ModifyChange,
  cursor: DiffCursor,
): Promise<DiffChange[]> {
  if (exceedsMaxTreeDepth(cursor.depth, MAX_DIFF_RECURSION_DEPTH)) {
    throw treeDepthExceeded(cursor.depth);
  }
  if (cursor.oldStack.includes(change.oldId)) throw treeCycleDetected(change.oldId);
  if (cursor.newStack.includes(change.newId)) throw treeCycleDetected(change.newId);

  const [oldContent, newContent] = await Promise.all([
    readRawTree(ctx, change.oldId),
    readRawTree(ctx, change.newId),
  ]);
  const nextCursor: DiffCursor = {
    prefix: joinPath(cursor.prefix, change.path),
    depth: cursor.depth + 1,
    oldStack: [...cursor.oldStack, change.oldId],
    newStack: [...cursor.newStack, change.newId],
  };
  return diffRecursiveLevel(ctx, oldContent, newContent, nextCursor);
}

async function expandAddedSubtree(
  ctx: Context,
  id: ObjectId,
  prefix: string,
): Promise<AddChange[]> {
  const flat = await flattenTree(ctx, id);
  return Array.from(flat.entries, ([name, entry]) => addLeaf(joinPath(prefix, name), entry));
}

async function expandDeletedSubtree(
  ctx: Context,
  id: ObjectId,
  prefix: string,
): Promise<DeleteChange[]> {
  const flat = await flattenTree(ctx, id);
  return Array.from(flat.entries, ([name, entry]) => deleteLeaf(joinPath(prefix, name), entry));
}

function addLeaf(path: FilePath, entry: FlatTreeEntry): AddChange {
  return { type: 'add', newPath: path, newId: entry.id, newMode: entry.mode };
}

function deleteLeaf(path: FilePath, entry: FlatTreeEntry): DeleteChange {
  return { type: 'delete', oldPath: path, oldId: entry.id, oldMode: entry.mode };
}
