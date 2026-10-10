import type { FlatTree, FlatTreeEntry } from '../diff/flat-tree.js';
import { MAX_FLAT_TREE_ENTRIES } from '../diff/flat-tree.js';
import { isSameKind, kindOf } from '../diff/mode-kind.js';
import { sortByPath } from '../diff/path-compare.js';
import type { FileMode, FilePath, ObjectId } from '../objects/index.js';
import { FILE_MODE } from '../objects/index.js';
import { applyDirectoryRenames } from './directory-renames.js';
import { invalidMergeInput, invalidMergeTree } from './error.js';
import { DEFAULT_MERGE_LABELS, type MergeLabels } from './merge-labels.js';
import {
  applyMergeRenames,
  type MergeRenames,
  NO_MERGE_RENAMES,
  type RenamedMergeInput,
  type SidePaths,
  type SplitRename,
} from './merge-renames.js';
import type {
  ContentMergeContext,
  ContentMergeResult,
  MergeConflict,
  MergeOutcome,
  TreeMergeResult,
} from './merge-types.js';
import { MAX_CONFLICT_OUTPUT_BYTES } from './merge-types.js';
import type { OrtVariant } from './strategy-options.js';

export type ContentMerger = (
  ctx: ContentMergeContext,
  base: Uint8Array | undefined,
  ours: Uint8Array,
  theirs: Uint8Array,
) => Promise<ContentMergeResult> | ContentMergeResult;

// Placeholder handed to ContentMerger callbacks, which read real blob bytes
// via the ids on the context; immutable because it is zero-length.
const EMPTY_BYTES = new Uint8Array(0);

function entriesEqual(a: FlatTreeEntry, b: FlatTreeEntry): boolean {
  return a.id === b.id && a.mode === b.mode;
}

function isGitlink(mode: FileMode): boolean {
  return mode === FILE_MODE.GITLINK;
}

function enforcePerInputCap(tree: FlatTree | undefined, side: string): void {
  if (tree !== undefined && tree.entries.size > MAX_FLAT_TREE_ENTRIES) {
    throw invalidMergeTree(`${side} FlatTree exceeds MAX_FLAT_TREE_ENTRIES`);
  }
}

function buildUnionPaths(
  base: FlatTree | undefined,
  ours: FlatTree | undefined,
  theirs: FlatTree | undefined,
  vacated: ReadonlySet<FilePath>,
): Set<FilePath> {
  const paths = new Set<FilePath>(vacated);
  for (const tree of [base, ours, theirs]) {
    if (tree === undefined) continue;
    for (const path of tree.entries.keys()) paths.add(path);
  }
  if (paths.size > MAX_FLAT_TREE_ENTRIES) {
    throw invalidMergeTree('union FlatTree exceeds MAX_FLAT_TREE_ENTRIES');
  }
  return paths;
}

function conflictOutcome(conflict: MergeConflict): MergeOutcome {
  return { status: 'conflict', conflict };
}

function addAddConflict(
  path: FilePath,
  ourEntry: FlatTreeEntry,
  theirEntry: FlatTreeEntry,
): MergeOutcome {
  return conflictOutcome({
    type: 'add-add',
    path,
    ourId: ourEntry.id,
    theirId: theirEntry.id,
    ourMode: ourEntry.mode,
    theirMode: theirEntry.mode,
  });
}

function modifyDeleteConflict(
  path: FilePath,
  base: FlatTreeEntry,
  our: FlatTreeEntry | undefined,
  their: FlatTreeEntry | undefined,
): MergeOutcome {
  return conflictOutcome({
    type: 'modify-delete',
    path,
    baseId: base.id,
    baseMode: base.mode,
    ...(our === undefined ? {} : { ourId: our.id, ourMode: our.mode }),
    ...(their === undefined ? {} : { theirId: their.id, theirMode: their.mode }),
  });
}

function typeChangeConflict(
  path: FilePath,
  base: FlatTreeEntry,
  our: FlatTreeEntry,
  their: FlatTreeEntry,
): MergeOutcome {
  return conflictOutcome({
    type: 'type-change',
    path,
    baseId: base.id,
    ourId: our.id,
    theirId: their.id,
    baseMode: base.mode,
    ourMode: our.mode,
    theirMode: their.mode,
  });
}

function gitlinkConflict(
  path: FilePath,
  base: FlatTreeEntry,
  our: FlatTreeEntry,
  their: FlatTreeEntry,
): MergeOutcome {
  return conflictOutcome({
    type: 'gitlink',
    path,
    baseId: base.id,
    ourId: our.id,
    theirId: their.id,
    baseMode: base.mode,
    ourMode: our.mode,
    theirMode: their.mode,
  });
}

function resolveOneSideAbsent(
  path: FilePath,
  base: FlatTreeEntry | undefined,
  present: FlatTreeEntry,
  which: 'our' | 'their',
): MergeOutcome {
  if (base === undefined) {
    return { status: 'resolved-known', path, id: present.id, mode: present.mode };
  }
  if (entriesEqual(base, present)) {
    return { status: 'resolved-deleted', path };
  }
  return which === 'our'
    ? modifyDeleteConflict(path, base, present, undefined)
    : modifyDeleteConflict(path, base, undefined, present);
}

async function resolveContentMerge(
  path: FilePath,
  base: FlatTreeEntry,
  our: FlatTreeEntry,
  their: FlatTreeEntry,
  mode: FileMode,
  contentMerger: ContentMerger,
): Promise<MergeOutcome> {
  const ctx: ContentMergeContext = {
    path,
    baseId: base.id,
    ourId: our.id,
    theirId: their.id,
    baseMode: base.mode,
    ourMode: our.mode,
    theirMode: their.mode,
  };
  // The domain tree-merge has no blob bytes on hand; the ContentMerger
  // supplies real content via its closure, using
  // ctx.baseId/ourId/theirId to read blobs. These placeholders are never
  // used by a well-behaved callback.
  const result = await contentMerger(ctx, undefined, EMPTY_BYTES, EMPTY_BYTES);
  if (result.status === 'clean') {
    enforceOutputCap(result.bytes, 'clean bytes');
    if (result.id !== undefined) {
      return { status: 'resolved-known', path, id: result.id, mode };
    }
    return { status: 'resolved-merged', path, bytes: result.bytes, mode };
  }
  enforceOutputCap(result.markedBytes, 'marked bytes');
  return conflictOutcome({
    type: result.conflictType,
    path,
    baseId: base.id,
    ourId: our.id,
    theirId: their.id,
    baseMode: base.mode,
    ourMode: our.mode,
    theirMode: their.mode,
    conflictContent: result.markedBytes,
    mergedMode: mode,
  });
}

function resolveMode(base: FlatTreeEntry, our: FlatTreeEntry, their: FlatTreeEntry): FileMode {
  // Precondition: base, our, their share isSameKind. Within a kind at most two distinct
  // modes exist (file kind: 100644 / 100755), so at least two of the three agree.
  // Stryker disable next-line ConditionalExpression: equivalent — when our.mode === their.mode the fall-through path also yields our.mode (it returns their.mode if our.mode === base.mode, else our.mode); this branch is a fast-path only.
  if (our.mode === their.mode) return our.mode;
  if (our.mode === base.mode) return their.mode;
  return our.mode;
}

function resolveKindDispatch(
  path: FilePath,
  base: FlatTreeEntry,
  our: FlatTreeEntry,
  their: FlatTreeEntry,
  contentMerger: ContentMerger,
  scope: PathScope,
): MergeOutcome | Promise<MergeOutcome> {
  if (isGitlink(our.mode) || isGitlink(their.mode)) {
    if (isGitlink(our.mode) && isGitlink(their.mode) && isGitlink(base.mode)) {
      return gitlinkConflict(path, base, our, their);
    }
    return typeChangeConflict(path, base, our, their);
  }
  const ourSymlink = isSymlinkKind(our.mode);
  const theirSymlink = isSymlinkKind(their.mode);
  if (ourSymlink && theirSymlink) {
    return symlinkPair(path, base, our, their, scope.variant);
  }
  if (ourSymlink || theirSymlink) {
    if (isGitlink(base.mode)) {
      return typeChangeConflict(path, base, our, their);
    }
    return distinctTypesConflict(path, our, their, scope.labels, scope.reserved, base);
  }
  if (!isSameKind(base.mode, our.mode)) {
    return resolveKindChangedBase(path, base, our, their, contentMerger);
  }
  const mode = resolveMode(base, our, their);
  return resolveContentMerge(path, base, our, their, mode, contentMerger);
}

async function resolveBothPresent(
  path: FilePath,
  base: FlatTreeEntry,
  our: FlatTreeEntry,
  their: FlatTreeEntry,
  contentMerger: ContentMerger,
  scope: PathScope,
): Promise<MergeOutcome> {
  const ourUnchanged = entriesEqual(base, our);
  const theirUnchanged = entriesEqual(base, their);
  if (ourUnchanged && theirUnchanged) {
    return { status: 'unchanged', path, id: base.id, mode: base.mode };
  }
  if (ourUnchanged) {
    return { status: 'resolved-known', path, id: their.id, mode: their.mode };
  }
  if (theirUnchanged) {
    return { status: 'resolved-known', path, id: our.id, mode: our.mode };
  }
  if (entriesEqual(our, their)) {
    return { status: 'resolved-known', path, id: our.id, mode: our.mode };
  }
  return resolveKindDispatch(path, base, our, their, contentMerger, scope);
}

function isRegularKind(mode: FileMode): boolean {
  return kindOf(mode) === 'file';
}

function isSymlinkKind(mode: FileMode): boolean {
  return mode === FILE_MODE.SYMLINK;
}

function flattenLabel(label: string): string {
  return label.replace(/\//g, '_');
}

export function uniquePath(reserved: Set<FilePath>, base: FilePath, label: string): FilePath {
  const stem = `${base}~${flattenLabel(label)}`;
  let candidate = stem as FilePath;
  let n = 0;
  while (reserved.has(candidate)) {
    candidate = `${stem}_${n}` as FilePath;
    n += 1;
  }
  reserved.add(candidate);
  return candidate;
}

function distinctTypesConflict(
  path: FilePath,
  our: FlatTreeEntry,
  their: FlatTreeEntry,
  labels: MergeLabels,
  reserved: Set<FilePath>,
  base?: FlatTreeEntry,
): MergeOutcome {
  const ourIsRegular = isRegularKind(our.mode);
  const regularLabel = ourIsRegular ? labels.ours : labels.theirs;
  const renamedPath = uniquePath(reserved, path, regularLabel);
  const ourPath = ourIsRegular ? renamedPath : path;
  const theirPath = ourIsRegular ? path : renamedPath;
  if (base === undefined) {
    return conflictOutcome({
      type: 'distinct-types',
      path,
      ourId: our.id,
      ourMode: our.mode,
      theirId: their.id,
      theirMode: their.mode,
      ourPath,
      theirPath,
    });
  }
  const basePath = isRegularKind(base.mode) ? renamedPath : path;
  return conflictOutcome({
    type: 'distinct-types',
    path,
    baseId: base.id,
    baseMode: base.mode,
    basePath,
    ourId: our.id,
    ourMode: our.mode,
    theirId: their.id,
    theirMode: their.mode,
    ourPath,
    theirPath,
  });
}

/** merge-ort.c's `merge_3way` symlink case: `-X ours` / `-X theirs` keep that side's link cleanly. */
function favouredSymlink(
  path: FilePath,
  our: FlatTreeEntry,
  their: FlatTreeEntry,
  variant: OrtVariant,
): MergeOutcome {
  const kept = variant === 'ours' ? our : their;
  return { status: 'resolved-known', path, id: kept.id, mode: kept.mode };
}

function symlinkPair(
  path: FilePath,
  base: FlatTreeEntry,
  our: FlatTreeEntry,
  their: FlatTreeEntry,
  variant: OrtVariant | undefined,
): MergeOutcome {
  if (variant !== undefined) return favouredSymlink(path, our, their, variant);
  return symlinkPairConflict(path, base, our, their);
}

function symlinkPairConflict(
  path: FilePath,
  base: FlatTreeEntry,
  our: FlatTreeEntry,
  their: FlatTreeEntry,
): MergeOutcome {
  return conflictOutcome({
    type: 'content',
    path,
    baseId: base.id,
    baseMode: base.mode,
    ourId: our.id,
    ourMode: our.mode,
    theirId: their.id,
    theirMode: their.mode,
  });
}

async function resolveKindChangedBase(
  path: FilePath,
  base: FlatTreeEntry,
  our: FlatTreeEntry,
  their: FlatTreeEntry,
  contentMerger: ContentMerger,
): Promise<MergeOutcome> {
  const contentResult = await mergeBaseless(path, our, their, contentMerger);
  if (contentResult.tag === 'resolved') return contentResult.outcome;
  if (contentResult.tag === 'clean-split') {
    return conflictOutcome({
      type: 'content',
      path,
      baseId: base.id,
      baseMode: base.mode,
      ourId: our.id,
      ourMode: our.mode,
      theirId: their.id,
      theirMode: their.mode,
      conflictContent: contentResult.bytes,
      contentVerdict: 'clean',
    });
  }
  return conflictOutcome({
    type: contentResult.conflictType,
    path,
    baseId: base.id,
    baseMode: base.mode,
    ourId: our.id,
    ourMode: our.mode,
    theirId: their.id,
    theirMode: their.mode,
    conflictContent: contentResult.bytes,
  });
}

function enforceOutputCap(bytes: Uint8Array, label: string): void {
  if (bytes.length > MAX_CONFLICT_OUTPUT_BYTES) {
    throw invalidMergeInput(`contentMerger returned oversize ${label}`);
  }
}

type BaselessContentResult =
  | {
      readonly tag: 'resolved';
      readonly outcome: Extract<MergeOutcome, { status: 'resolved-known' | 'resolved-merged' }>;
    }
  | { readonly tag: 'clean-split'; readonly bytes: Uint8Array }
  | {
      readonly tag: 'conflict';
      readonly bytes: Uint8Array;
      readonly conflictType: 'content' | 'binary';
    };

async function mergeBaseless(
  path: FilePath,
  our: FlatTreeEntry,
  their: FlatTreeEntry,
  contentMerger: ContentMerger,
): Promise<BaselessContentResult> {
  const ctx: ContentMergeContext = {
    path,
    ourId: our.id,
    theirId: their.id,
    ourMode: our.mode,
    theirMode: their.mode,
  };
  const result = await contentMerger(ctx, undefined, EMPTY_BYTES, EMPTY_BYTES);
  if (result.status === 'clean') {
    enforceOutputCap(result.bytes, 'clean bytes');
    if (our.mode === their.mode) {
      if (result.id !== undefined) {
        return {
          tag: 'resolved',
          outcome: { status: 'resolved-known', path, id: result.id, mode: our.mode },
        };
      }
      return {
        tag: 'resolved',
        outcome: { status: 'resolved-merged', path, bytes: result.bytes, mode: our.mode },
      };
    }
    return { tag: 'clean-split', bytes: result.bytes };
  }
  enforceOutputCap(result.markedBytes, 'marked bytes');
  return { tag: 'conflict', bytes: result.markedBytes, conflictType: result.conflictType };
}

async function resolveAddAdd(
  path: FilePath,
  our: FlatTreeEntry,
  their: FlatTreeEntry,
  contentMerger: ContentMerger,
  scope: PathScope,
): Promise<MergeOutcome> {
  if (entriesEqual(our, their)) {
    return { status: 'resolved-known', path, id: our.id, mode: our.mode };
  }
  const ourRegular = isRegularKind(our.mode);
  const theirRegular = isRegularKind(their.mode);
  const ourSymlink = isSymlinkKind(our.mode);
  const theirSymlink = isSymlinkKind(their.mode);
  if ((ourRegular && theirSymlink) || (ourSymlink && theirRegular)) {
    return distinctTypesConflict(path, our, their, scope.labels, scope.reserved);
  }
  if (ourSymlink && theirSymlink && scope.variant !== undefined) {
    return favouredSymlink(path, our, their, scope.variant);
  }
  if (!ourRegular || !theirRegular) {
    return addAddConflict(path, our, their);
  }
  return mergeAddAddContent(path, our, their, contentMerger);
}

/** Two regular files added at one path: merge their content without a base. */
async function mergeAddAddContent(
  path: FilePath,
  our: FlatTreeEntry,
  their: FlatTreeEntry,
  contentMerger: ContentMerger,
): Promise<MergeOutcome> {
  const contentResult = await mergeBaseless(path, our, their, contentMerger);
  if (contentResult.tag === 'resolved') return contentResult.outcome;
  return conflictOutcome({
    type: 'add-add',
    path,
    ourId: our.id,
    theirId: their.id,
    ourMode: our.mode,
    theirMode: their.mode,
    conflictContent: contentResult.bytes,
    contentVerdict: contentResult.tag === 'clean-split' ? 'clean' : contentResult.conflictType,
  });
}

/** What every path's resolution shares: marker labels, taken paths, and the `-X` side. */
interface PathScope {
  readonly labels: MergeLabels;
  readonly reserved: Set<FilePath>;
  readonly variant: OrtVariant | undefined;
}

function resolvePath(
  path: FilePath,
  base: FlatTreeEntry | undefined,
  our: FlatTreeEntry | undefined,
  their: FlatTreeEntry | undefined,
  contentMerger: ContentMerger,
  scope: PathScope,
): MergeOutcome | Promise<MergeOutcome> {
  if (our === undefined && their === undefined) {
    return { status: 'resolved-deleted', path };
  }
  if (our === undefined) {
    return resolveOneSideAbsent(path, base, their!, 'their');
  }
  if (their === undefined) {
    return resolveOneSideAbsent(path, base, our, 'our');
  }
  if (base === undefined) {
    return resolveAddAdd(path, our, their, contentMerger, scope);
  }
  return resolveBothPresent(path, base, our, their, contentMerger, scope);
}

const sideIdsAt = (side: 'base' | 'our' | 'their', entry: FlatTreeEntry | undefined) =>
  entry === undefined ? {} : { [`${side}Id`]: entry.id, [`${side}Mode`]: entry.mode };

/** ort's `path_conflict` from a suggested directory rename: the moved path never merges clean. */
function asFileLocation(
  outcome: MergeOutcome,
  path: FilePath,
  entries: ReadonlyArray<FlatTreeEntry | undefined>,
): MergeOutcome {
  if (outcome.status === 'conflict') return outcome;
  const [base, our, their] = entries;
  return conflictOutcome({
    type: 'file-location',
    path,
    ...sideIdsAt('base', base),
    ...sideIdsAt('our', our),
    ...sideIdsAt('their', their),
  });
}

/** Directory renames move paths before file renames pair them; a side-less merge has none. */
function withDirectoryRenames(
  base: FlatTree | undefined,
  ours: FlatTree | undefined,
  theirs: FlatTree | undefined,
  renames: MergeRenames,
) {
  if (ours === undefined || theirs === undefined) {
    return {
      ours,
      theirs,
      renames,
      fileLocations: new Set<FilePath>(),
      vacated: new Set<FilePath>(),
      sidePaths: new Map<FilePath, SidePaths>(),
      clean: true,
    };
  }
  return applyDirectoryRenames(base, ours, theirs, renames);
}

function extractConflicts(outcomes: ReadonlyArray<MergeOutcome>): ReadonlyArray<MergeConflict> {
  const out: MergeConflict[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'conflict') out.push(outcome.conflict);
  }
  return out;
}

/** A rename's content merge learns where each side held the path, for git's `<label>:<path>` markers. */
function withSidePaths(
  contentMerger: ContentMerger,
  sidePaths: ReadonlyMap<FilePath, SidePaths>,
): ContentMerger {
  if (sidePaths.size === 0) return contentMerger;
  return (ctx, base, ours, theirs) => {
    const paths = sidePaths.get(ctx.path);
    const located = paths === undefined ? ctx : { ...ctx, sidePaths: paths };
    return contentMerger(located, base, ours, theirs);
  };
}

/** git's `merge_modes` for a split: a side that kept the base mode yields the other's. */
const splitMode = ({ base, ours, theirs }: SplitRename): FileMode =>
  ours.mode === base.mode ? theirs.mode : ours.mode;

type SplitContent = { readonly id: ObjectId } | { readonly bytes: Uint8Array };

/** ort's `handle_content_merge`: an unchanged side yields the other, else the sides merge. */
async function splitContent(
  split: SplitRename,
  contentMerger: ContentMerger,
): Promise<SplitContent> {
  const { base, ours, theirs } = split;
  if (ours.id === theirs.id || ours.id === base.id) return { id: theirs.id };
  if (theirs.id === base.id) return { id: ours.id };
  const ctx: ContentMergeContext = {
    path: split.paths.base,
    baseId: base.id,
    ourId: ours.id,
    theirId: theirs.id,
    baseMode: base.mode,
    ourMode: ours.mode,
    theirMode: theirs.mode,
    sidePaths: split.paths,
    extraMarkerSize: 1,
  };
  const result = await contentMerger(ctx, undefined, EMPTY_BYTES, EMPTY_BYTES);
  if (result.status === 'conflict') return { bytes: result.markedBytes };
  return result.id === undefined ? { bytes: result.bytes } : { id: result.id };
}

/**
 * ort stages a rename/rename(1to2)'s merged content at both destinations; a
 * merged blob the domain cannot name rides as `conflictContent` for the caller
 * to write.
 */
async function settleSplitRenames(
  forced: ReadonlyMap<FilePath, MergeConflict>,
  splits: ReadonlyArray<SplitRename>,
  contentMerger: ContentMerger,
): Promise<ReadonlyMap<FilePath, MergeConflict>> {
  if (splits.length === 0) return forced;
  const settled = new Map(forced);
  for (const split of splits) {
    const content = await splitContent(split, contentMerger);
    const mode = splitMode(split);
    const staged = (id: 'ourId' | 'theirId') =>
      'id' in content ? { [id]: content.id } : { conflictContent: content.bytes };
    const ours = settled.get(split.paths.ours) as MergeConflict;
    const theirs = settled.get(split.paths.theirs) as MergeConflict;
    settled.set(split.paths.ours, { ...ours, ourMode: mode, ...staged('ourId') });
    settled.set(split.paths.theirs, { ...theirs, theirMode: mode, ...staged('theirId') });
  }
  return settled;
}

export async function mergeTrees(
  base: FlatTree | undefined,
  ours: FlatTree | undefined,
  theirs: FlatTree | undefined,
  contentMerger: ContentMerger,
  labels: MergeLabels = DEFAULT_MERGE_LABELS,
  renames: MergeRenames = NO_MERGE_RENAMES,
  variant?: OrtVariant,
): Promise<TreeMergeResult> {
  enforcePerInputCap(base, 'base');
  enforcePerInputCap(ours, 'ours');
  enforcePerInputCap(theirs, 'theirs');
  const plan = planTreeMerge(base, ours, theirs, renames);
  const scope: PathScope = { labels, reserved: new Set<FilePath>(plan.paths), variant };
  const merger = withSidePaths(contentMerger, plan.sidePaths);
  const { forced, splitRenames } = plan.renamed;
  const forcedConflicts = await settleSplitRenames(forced, splitRenames, contentMerger);
  const outcomes = await resolvePaths(plan, forcedConflicts, merger, scope);
  const conflicts = extractConflicts(outcomes);
  return { outcomes, conflicts, cleanMerge: conflicts.length === 0 && plan.located.clean };
}

/** Every path the merge visits, in git's order, once directory and file renames moved them. */
interface TreeMergePlan {
  readonly located: ReturnType<typeof withDirectoryRenames>;
  readonly renamed: RenamedMergeInput;
  readonly paths: ReadonlySet<FilePath>;
  readonly sortedPaths: ReadonlyArray<FilePath>;
  readonly sidePaths: RenamedMergeInput['sidePaths'];
}

function planTreeMerge(
  base: FlatTree | undefined,
  ours: FlatTree | undefined,
  theirs: FlatTree | undefined,
  renames: MergeRenames,
): TreeMergePlan {
  const located = withDirectoryRenames(base, ours, theirs, renames);
  const renamed = applyMergeRenames(base, located.ours, located.theirs, located.renames);
  const vacated = new Set([...renamed.vacated, ...located.vacated]);
  const paths = buildUnionPaths(renamed.base, renamed.ours, renamed.theirs, vacated);
  const sidePaths = new Map([...located.sidePaths, ...renamed.sidePaths]);
  return { located, renamed, paths, sortedPaths: sortByPath([...paths], (p) => p), sidePaths };
}

type PathEntries = readonly [
  FlatTreeEntry | undefined,
  FlatTreeEntry | undefined,
  FlatTreeEntry | undefined,
];

/** The path's base, ours and theirs entries, in that order. */
function entriesAt(renamed: RenamedMergeInput, path: FilePath): PathEntries {
  return [
    renamed.base?.entries.get(path),
    renamed.ours?.entries.get(path),
    renamed.theirs?.entries.get(path),
  ];
}

/** Resolve every path in order; a forced conflict stands in for its path's own resolution. */
async function resolvePaths(
  plan: TreeMergePlan,
  forcedConflicts: ReadonlyMap<FilePath, MergeConflict>,
  merger: ContentMerger,
  scope: PathScope,
): Promise<MergeOutcome[]> {
  const { renamed, located } = plan;
  const outcomes: MergeOutcome[] = [];
  for (const path of plan.sortedPaths) {
    const forced = forcedConflicts.get(path);
    if (forced !== undefined) {
      outcomes.push(conflictOutcome(forced));
      continue;
    }
    const entries = entriesAt(renamed, path);
    const result = resolvePath(path, ...entries, merger, scope);
    const outcome = result instanceof Promise ? await result : result;
    outcomes.push(
      located.fileLocations.has(path) ? asFileLocation(outcome, path, entries) : outcome,
    );
  }
  return outcomes;
}
