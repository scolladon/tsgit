import { resolveAttribute } from '../../domain/attributes/index.js';
import type { BinaryOverride } from '../../domain/diff/binary-decision.js';
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
  MAX_FLAT_TREE_ENTRIES,
  type ModifyChange,
  resolveLineKey,
  type StatDiffChange,
  type StatFieldsOptions,
  type StatTreeDiff,
  type TreeDiff,
} from '../../domain/diff/index.js';
import { scanEqual } from '../../domain/diff/line-digest-scanner.js';
import { diffRawTrees } from '../../domain/diff/raw-tree-diff.js';
import type { RenameDetectOptions } from '../../domain/diff/rename-detect.js';
import {
  treeCycleDetected,
  treeDepthExceeded,
  treeEntryLimitExceeded,
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
import type { Context } from '../../ports/context.js';
import { detectSimilarityRenames } from './detect-similarity-renames.js';
import { boundedMapFor, limiterFor } from './internal/concurrency.js';
import type { ConcurrencyLimiter } from './internal/concurrency-limiter.js';
import {
  type FlattenBounds,
  flattenRawTree,
  resolveFlattenBounds,
} from './internal/flatten-raw.js';
import { peelChain } from './internal/peel-chain.js';
import { joinPath, readRawTreeById as readRawTree } from './internal/raw-tree-io.js';
import { type AttributeProvider, buildAttributeProvider } from './internal/read-gitattributes.js';
import { resolveMaxTreeDepth } from './internal/resolve-max-tree-depth.js';
import { walkRawSubtree } from './internal/walk-raw-subtree.js';
import { isWhitespaceOnlyModify } from './internal/whitespace-drop-predicate.js';
import { materialisePatchFiles } from './materialise-patch-files.js';
import { readRawObject } from './read-object.js';
import { readTree } from './read-tree.js';
import type { DiffTreesInput, DiffTreesOptions } from './types.js';
import { exceedsMaxTreeDepth, exceedsMaxTreeEntries } from './validators.js';

const EMPTY = new Uint8Array(0);

/**
 * Diff two tree-like targets, returning the structured `TreeDiff`. Pass
 * `recursive: true` to expand nested directories into per-file leaf changes
 * instead of directory-mode entries, and `withStat: true` to attach per-file
 * line counts (a `StatTreeDiff`).
 *
 * A recursive descent is bounded by `core.maxTreeDepth`, read from the
 * repository-local config (default 2048 when unset) and honoured unclamped —
 * a tree nested deeper than the configured cap throws `TREE_DEPTH_EXCEEDED`.
 */
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
  numstatBinaryOverride: BinaryOverride | undefined,
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
 * When `lineKeyActive`, drops modify changes whose drop verdict comes from
 * `dropVerdict` — the same synchronous scanner and ladder the predicate-only
 * path drives, not the stat counts computed alongside it. When `withStat`,
 * attaches per-file counts to every surviving change. Consistency between
 * the two paths holds by construction: both run the same scanner, rather
 * than two independently maintained verdicts.
 *
 * The verdict runs BEFORE the counts, and both are pure functions of the same
 * two buffers: a dropped file's counts would be discarded, so computing them
 * would be a whole `diffLines` interning pass plus Myers trace thrown away —
 * on a whitespace-only commit, for every file in it.
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
    const oldContent = file.oldContent ?? EMPTY;
    const newContent = file.newContent ?? EMPTY;
    const dropped =
      lineKeyActive &&
      dropVerdict(
        file.change,
        oldContent,
        newContent,
        lineKey,
        ignoreBlankLines,
        file.numstatBinaryOverride,
      );
    if (dropped) continue;
    const stats = computeStatFields(
      oldContent,
      newContent,
      statOptionsFor(lineKey, lineKeyActive, ignoreBlankLines, file.numstatBinaryOverride),
    );
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
  const state: DiffWalkState = {
    counter: { value: 0 },
    maxEntries: MAX_FLAT_TREE_ENTRIES,
    maxDepth: await resolveMaxTreeDepth(ctx),
    limiter: limiterFor(ctx, 'ioBound'),
  };
  const expanded = await boundedMapFor(ctx, 'ioBound', changes, (change) =>
    expandLevelChange(ctx, change, ROOT_CURSOR, state),
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
  const drops = await boundedMapFor(ctx, 'ioBound', diff.changes, (change) =>
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
  // boundedMapFor (materialisePatchFiles' worker) returns exactly one result per input
  // change or rejects — never fewer — so a 1-element input always yields files[0].
  const file = files[0]!;
  return dropVerdict(
    file.change,
    file.oldContent ?? EMPTY,
    file.newContent ?? EMPTY,
    lineKey,
    ignoreBlankLines,
    file.numstatBinaryOverride,
  );
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
 * The stat path's drop verdict — routed through the same synchronous scanner
 * and ladder the predicate-only path drives (`scanEqual`,
 * `line-digest-scanner.ts`), so the two paths cannot answer differently for
 * the same pair of blobs. Only `modify` changes are ever dropped. The
 * `.gitattributes` binary override is threaded into the scanner rather than
 * short-circuited here, so all three of its states are honoured by one decision:
 * a forced-binary side is never dropped, a forced-text side drops a
 * whitespace-only change even over NUL bytes (matching git), and an
 * unattributed path keeps git's NUL-window content sniff.
 */
function dropVerdict(
  change: DiffChange,
  oldContent: Uint8Array,
  newContent: Uint8Array,
  lineKey: LineKey,
  ignoreBlankLines: boolean,
  numstatBinaryOverride: BinaryOverride | undefined,
): boolean {
  if (change.type !== 'modify') return false;
  return scanEqual(oldContent, newContent, lineKey, ignoreBlankLines, numstatBinaryOverride);
}

/**
 * Build the flat preimage map for copies:'harder' — all tree-A paths become copy sources.
 * Returns undefined when copies:'harder' is not active or `a` is absent. An `ObjectId`
 * is peeled to its tree first (a commit or tag oid must resolve exactly like the
 * tree-oid form does) — `flattenRawTree` refuses anything but a tree, so `a` cannot be
 * handed to it unresolved. `peelToTree` already reads the terminal tree's raw bytes as
 * its last peel hop, so they are threaded straight into `flattenRawTree` as `preread`
 * rather than re-read — one read total, not two. A caller-supplied `Tree` has no
 * preread bytes available and is passed through unchanged.
 */
async function buildPreimage(
  ctx: Context,
  a: DiffTreesInput,
  renameOptions: RenameDetectOptions | undefined,
): Promise<FlatTree['entries'] | undefined> {
  if (renameOptions?.copies !== 'harder' || a === undefined) return undefined;
  const bounds = await resolveFlattenBounds(ctx);
  if (typeof a !== 'string') {
    return (await flattenRawTree(ctx, a, bounds)).entries;
  }
  const peeled = await peelToTree(ctx, a);
  return (await flattenRawTree(ctx, peeled.id, bounds, peeled.content)).entries;
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
 * Peel a commit or tag oid down to the tree it ultimately points at. Shares
 * `readTree`'s peel loop (`peelChain`, same `MAX_PEEL_DEPTH` bound, same
 * non-tree refusal) but reads every hop once as raw bytes, parsing only the
 * commit/tag body needed to find the next hop's id — the terminal tree is
 * never parsed, only read, so a peel never pays for a `Tree` parse it
 * immediately discards.
 */
async function peelToTree(ctx: Context, id: ObjectId): Promise<PeeledTree> {
  const { id: currentId, result } = await peelChain(ctx, id, readRawObject, (raw, hopId) => {
    if (raw.type === 'commit') return parseCommitContent(hopId, raw.content).data.tree;
    if (raw.type === 'tag') return parseTagContent(hopId, raw.content).data.object;
    return undefined;
  });
  if (result.type !== 'tree') throw unexpectedObjectType('tree', result.type, currentId);
  return { id: currentId, content: result.content };
}

/** Recursion state threaded through `diffRecursiveLevel` — tracks the full-path
 * prefix plus per-side cycle/depth guards, mirroring `walkTree`'s protection
 * (the merge-join below descends into changed subtrees directly, bypassing
 * `walkTree`, so it must re-establish the same safety net). */
/**
 * The root-to-current path for one side, as an immutable cons list: each level
 * allocates ONE node pointing at its parent, so every sibling shares its
 * ancestors' nodes instead of copying them.
 *
 * Deliberately not a per-level array copy and deliberately not a shared
 * mutable `Set`. An array copy costs O(depth) fresh pointers per level, so a
 * descent holds O(depth^2) of them live — which at a large configured
 * `core.maxTreeDepth` is heap exhaustion, an uncatchable abort rather than the
 * typed refusal the depth cap exists to produce. A mutable `Set` would fix the
 * memory but not survive this walk: `diffRecursiveLevel` fans changed subtrees
 * out through `boundedMapFor`, so several sibling descents share one cursor at
 * the same instant and would observe each other's ancestry. Immutable sharing
 * is what satisfies both constraints at once — O(depth) total memory, and
 * every concurrent sibling still sees exactly its own path.
 */
interface AncestryNode {
  readonly id: ObjectId;
  readonly parent: AncestryNode | undefined;
}

/** Walk the chain looking for `id`. O(depth), the same comparison count the
 *  array's `includes()` cost — only the memory changed. */
const ancestryHas = (node: AncestryNode | undefined, id: ObjectId): boolean => {
  for (let cur = node; cur !== undefined; cur = cur.parent) {
    if (cur.id === id) return true;
  }
  return false;
};

interface DiffCursor {
  readonly prefix: string;
  readonly depth: number;
  readonly oldStack: AncestryNode | undefined;
  readonly newStack: AncestryNode | undefined;
}

const ROOT_CURSOR: DiffCursor = { prefix: '', depth: 0, oldStack: undefined, newStack: undefined };

interface DiffWalkCounter {
  value: number;
}

/** Shared, mutable entry-count budget for one `diffRecursive` call — threaded
 *  through every level of the merge-join and every `diffChangedSubtree`
 *  descent so a diamond DAG (the same subtree pair reached via more than one
 *  path) is bounded by its TOTAL entries visited, not just per level. Without
 *  memoisation across paths, each revisit re-walks the shared subtree, so the
 *  cap is what stops that from growing unbounded.
 *
 *  `limiter` is ONE `ConcurrencyLimiter` for the WHOLE operation, created
 *  once and threaded into every `walkRawSubtree` call `expandAddedSubtree`/
 *  `expandDeletedSubtree` make — sibling subtree expansions (added and
 *  deleted directories, expanded concurrently by the `boundedMapFor` calls
 *  below) queue behind the SAME budget instead of each call minting its own
 *  and multiplying the effective in-flight object-read count. */
interface DiffWalkState {
  readonly counter: DiffWalkCounter;
  readonly maxEntries: number;
  /** Resolved once per `diffRecursive`/`expandDirectoryChanges` call (never
   *  per level) from `core.maxTreeDepth` — see `diffChangedSubtree`'s guard
   *  and `subtreeExpansionBounds`, both of which read it back from here
   *  instead of resolving again. */
  readonly maxDepth: number;
  readonly limiter: ConcurrencyLimiter;
}

/**
 * Diff two raw tree contents recursively. `maxEntries` bounds the total
 * number of merge-join entries the walk may visit (default `MAX_FLAT_TREE_ENTRIES`,
 * the same cap `flattenRawTree` uses) — an explicit parameter rather than an
 * inlined literal so the guard is reachable from a test with a small cap. The
 * recursion depth is bounded separately, by the repository-local
 * `core.maxTreeDepth`, resolved once here.
 */
export async function diffRecursive(
  ctx: Context,
  a: Uint8Array | undefined,
  b: Uint8Array | undefined,
  maxEntries: number = MAX_FLAT_TREE_ENTRIES,
): Promise<TreeDiff> {
  const state: DiffWalkState = {
    counter: { value: 0 },
    maxEntries,
    maxDepth: await resolveMaxTreeDepth(ctx),
    limiter: limiterFor(ctx, 'ioBound'),
  };
  const changes = await diffRecursiveLevel(ctx, a, b, ROOT_CURSOR, state);
  return { changes };
}

/**
 * Merge-join one tree level via the raw byte-cursor diff, then expand only the
 * entries that actually differ. A TREESAME directory entry (identical oid+mode
 * on both sides) never reaches `expandLevelChange` — the merge-join already
 * drops it — so its subtree is never read or flattened, matching git's own
 * diff-tree pruning. Sibling directories that DO differ are expanded
 * concurrently via `boundedMapFor`, bounded to the ioBound policy's limit
 * in-flight reads PER LEVEL — nested levels each open their own bounded
 * batch, so the total in-flight count across a deep recursion is not itself
 * capped, only each level's own fan-out is. Object reads a directory
 * expansion issues BELOW that fan-out (subtree prefetch inside
 * `walkRawSubtree`) are bounded separately, by `state.limiter`.
 */
async function diffRecursiveLevel(
  ctx: Context,
  a: Uint8Array | undefined,
  b: Uint8Array | undefined,
  cursor: DiffCursor,
  state: DiffWalkState,
): Promise<DiffChange[]> {
  const levelChanges = diffRawTrees(a, b, ctx.hashConfig).changes;
  state.counter.value += levelChanges.length;
  if (exceedsMaxTreeEntries(state.counter.value, state.maxEntries)) {
    // A one-at-a-time increment-then-check loop throws at the FIRST value
    // that exceeds the cap — always `maxEntries + 1`, regardless of how far
    // past it a whole-batch addition lands. Report that same value so a
    // multi-entry level batch stays byte-identical to the old per-entry loop.
    throw treeEntryLimitExceeded(state.maxEntries + 1, state.maxEntries);
  }
  const expanded = await boundedMapFor(ctx, 'ioBound', levelChanges, (change) =>
    expandLevelChange(ctx, change, cursor, state),
  );
  return expanded.flat();
}

async function expandLevelChange(
  ctx: Context,
  change: DiffChange,
  cursor: DiffCursor,
  state: DiffWalkState,
): Promise<DiffChange[]> {
  if (change.type === 'modify' && isDirectory(change.oldMode) && isDirectory(change.newMode)) {
    return diffChangedSubtree(ctx, change, cursor, state);
  }
  if (change.type === 'add' && isDirectory(change.newMode)) {
    return expandAddedSubtree(ctx, change.newId, joinPath(cursor.prefix, change.newPath), state);
  }
  if (change.type === 'delete' && isDirectory(change.oldMode)) {
    return expandDeletedSubtree(ctx, change.oldId, joinPath(cursor.prefix, change.oldPath), state);
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

/**
 * This descent was measured honouring `core.maxTreeDepth` to at least
 * 15000 (2026-08-15): a fixture one level past a cap of 15000 refuses cleanly
 * with `TREE_DEPTH_EXCEEDED` at depth 15001. Deeper than that is
 * unmeasured — no raw stack overflow was observed at any depth tried.
 */
async function diffChangedSubtree(
  ctx: Context,
  change: ModifyChange,
  cursor: DiffCursor,
  state: DiffWalkState,
): Promise<DiffChange[]> {
  if (exceedsMaxTreeDepth(cursor.depth, state.maxDepth)) {
    throw treeDepthExceeded(cursor.depth);
  }
  if (ancestryHas(cursor.oldStack, change.oldId)) throw treeCycleDetected(change.oldId);
  if (ancestryHas(cursor.newStack, change.newId)) throw treeCycleDetected(change.newId);

  const [oldContent, newContent] = await Promise.all([
    readRawTree(ctx, change.oldId),
    readRawTree(ctx, change.newId),
  ]);
  const nextCursor: DiffCursor = {
    prefix: joinPath(cursor.prefix, change.path),
    depth: cursor.depth + 1,
    oldStack: { id: change.oldId, parent: cursor.oldStack },
    newStack: { id: change.newId, parent: cursor.newStack },
  };
  return diffRecursiveLevel(ctx, oldContent, newContent, nextCursor, state);
}

function subtreeExpansionBounds(state: DiffWalkState): FlattenBounds {
  return { maxDepth: state.maxDepth, maxEntries: state.maxEntries };
}

/**
 * Expand a whole added/deleted subtree into one leaf change per ENTRY,
 * duplicates included — matching `git diff-tree -r`, which never
 * de-duplicates. `flattenTree`'s `Map` (last-name-wins) is the right shape
 * for worktree materialisation but collapses a duplicate-name tree into a
 * single entry, so this walks the raw bytes directly via `walkRawSubtree`
 * instead. `state.counter` is threaded straight into the walk so a diamond
 * DAG reached via more than one add/delete pays out of the SAME entry
 * budget `diffRecursiveLevel` itself counts against, not a fresh one per
 * subtree; `maxDepth` comes from `state.maxDepth`, the cap resolved once for
 * the whole diff operation.
 */
async function expandAddedSubtree(
  ctx: Context,
  id: ObjectId,
  prefix: string,
  state: DiffWalkState,
): Promise<AddChange[]> {
  const changes: AddChange[] = [];
  await walkRawSubtree(
    ctx,
    id,
    subtreeExpansionBounds(state),
    prefix,
    state.counter,
    (entry) => {
      changes.push(addLeaf(entry.path, entry));
    },
    state.limiter,
  );
  return changes;
}

async function expandDeletedSubtree(
  ctx: Context,
  id: ObjectId,
  prefix: string,
  state: DiffWalkState,
): Promise<DeleteChange[]> {
  const changes: DeleteChange[] = [];
  await walkRawSubtree(
    ctx,
    id,
    subtreeExpansionBounds(state),
    prefix,
    state.counter,
    (entry) => {
      changes.push(deleteLeaf(entry.path, entry));
    },
    state.limiter,
  );
  return changes;
}

function addLeaf(path: FilePath, entry: FlatTreeEntry): AddChange {
  return { type: 'add', newPath: path, newId: entry.id, newMode: entry.mode };
}

function deleteLeaf(path: FilePath, entry: FlatTreeEntry): DeleteChange {
  return { type: 'delete', oldPath: path, oldId: entry.id, oldMode: entry.mode };
}
