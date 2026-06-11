import type { FlatTree, FlatTreeEntry } from '../diff/flat-tree.js';
import { MAX_FLAT_TREE_ENTRIES } from '../diff/flat-tree.js';
import { isSameKind, kindOf } from '../diff/mode-kind.js';
import { sortByPath } from '../diff/path-compare.js';
import type { FileMode, FilePath } from '../objects/index.js';
import { FILE_MODE } from '../objects/index.js';
import { invalidMergeInput, invalidMergeTree } from './error.js';
import { DEFAULT_MERGE_LABELS, type MergeLabels } from './merge-labels.js';
import type {
  ContentMergeContext,
  ContentMergeResult,
  MergeConflict,
  MergeOutcome,
  TreeMergeResult,
} from './merge-types.js';
import { MAX_CONFLICT_OUTPUT_BYTES } from './merge-types.js';

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
): Set<FilePath> {
  const paths = new Set<FilePath>();
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
    if (result.bytes.length > MAX_CONFLICT_OUTPUT_BYTES) {
      throw invalidMergeInput('contentMerger returned oversize clean bytes');
    }
    if (result.id !== undefined) {
      return { status: 'resolved-known', path, id: result.id, mode };
    }
    return { status: 'resolved-merged', path, bytes: result.bytes, mode };
  }
  if (result.markedBytes.length > MAX_CONFLICT_OUTPUT_BYTES) {
    throw invalidMergeInput('contentMerger returned oversize marked bytes');
  }
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
  labels: MergeLabels,
  reserved: Set<FilePath>,
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
    return symlinkPairConflict(path, base, our, their);
  }
  if (ourSymlink || theirSymlink) {
    if (isGitlink(base.mode)) {
      return typeChangeConflict(path, base, our, their);
    }
    return distinctTypesConflict(path, our, their, labels, reserved, base);
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
  labels: MergeLabels,
  reserved: Set<FilePath>,
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
  return resolveKindDispatch(path, base, our, their, contentMerger, labels, reserved);
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
        return { status: 'resolved-known', path, id: result.id, mode: our.mode };
      }
      return { status: 'resolved-merged', path, bytes: result.bytes, mode: our.mode };
    }
    return conflictOutcome({
      type: 'content',
      path,
      baseId: base.id,
      baseMode: base.mode,
      ourId: our.id,
      ourMode: our.mode,
      theirId: their.id,
      theirMode: their.mode,
      conflictContent: result.bytes,
      contentVerdict: 'clean',
    });
  }
  enforceOutputCap(result.markedBytes, 'marked bytes');
  return conflictOutcome({
    type: result.conflictType,
    path,
    baseId: base.id,
    baseMode: base.mode,
    ourId: our.id,
    ourMode: our.mode,
    theirId: their.id,
    theirMode: their.mode,
    conflictContent: result.markedBytes,
  });
}

function enforceOutputCap(bytes: Uint8Array, label: string): void {
  if (bytes.length > MAX_CONFLICT_OUTPUT_BYTES) {
    throw invalidMergeInput(`contentMerger returned oversize ${label}`);
  }
}

async function resolveAddAdd(
  path: FilePath,
  our: FlatTreeEntry,
  their: FlatTreeEntry,
  contentMerger: ContentMerger,
  labels: MergeLabels,
  reserved: Set<FilePath>,
): Promise<MergeOutcome> {
  if (entriesEqual(our, their)) {
    return { status: 'resolved-known', path, id: our.id, mode: our.mode };
  }
  const ourRegular = isRegularKind(our.mode);
  const theirRegular = isRegularKind(their.mode);
  const ourSymlink = isSymlinkKind(our.mode);
  const theirSymlink = isSymlinkKind(their.mode);
  if ((ourRegular && theirSymlink) || (ourSymlink && theirRegular)) {
    return distinctTypesConflict(path, our, their, labels, reserved);
  }
  if (!ourRegular || !theirRegular) {
    return addAddConflict(path, our, their);
  }
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
        return { status: 'resolved-known', path, id: result.id, mode: our.mode };
      }
      return { status: 'resolved-merged', path, bytes: result.bytes, mode: our.mode };
    }
    return conflictOutcome({
      type: 'add-add',
      path,
      ourId: our.id,
      theirId: their.id,
      ourMode: our.mode,
      theirMode: their.mode,
      conflictContent: result.bytes,
      contentVerdict: 'clean',
    });
  }
  enforceOutputCap(result.markedBytes, 'marked bytes');
  return conflictOutcome({
    type: 'add-add',
    path,
    ourId: our.id,
    theirId: their.id,
    ourMode: our.mode,
    theirMode: their.mode,
    conflictContent: result.markedBytes,
    contentVerdict: result.conflictType,
  });
}

function resolvePath(
  path: FilePath,
  base: FlatTreeEntry | undefined,
  our: FlatTreeEntry | undefined,
  their: FlatTreeEntry | undefined,
  contentMerger: ContentMerger,
  labels: MergeLabels,
  reserved: Set<FilePath>,
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
    return resolveAddAdd(path, our, their, contentMerger, labels, reserved);
  }
  return resolveBothPresent(path, base, our, their, contentMerger, labels, reserved);
}

function extractConflicts(outcomes: ReadonlyArray<MergeOutcome>): ReadonlyArray<MergeConflict> {
  const out: MergeConflict[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'conflict') out.push(outcome.conflict);
  }
  return out;
}

export async function mergeTrees(
  base: FlatTree | undefined,
  ours: FlatTree | undefined,
  theirs: FlatTree | undefined,
  contentMerger: ContentMerger,
  labels: MergeLabels = DEFAULT_MERGE_LABELS,
): Promise<TreeMergeResult> {
  enforcePerInputCap(base, 'base');
  enforcePerInputCap(ours, 'ours');
  enforcePerInputCap(theirs, 'theirs');

  const paths = buildUnionPaths(base, ours, theirs);
  const sortedPaths = sortByPath([...paths], (p) => p);
  const reserved = new Set<FilePath>(paths);

  const outcomes: MergeOutcome[] = [];
  for (const path of sortedPaths) {
    const result = resolvePath(
      path,
      base?.entries.get(path),
      ours?.entries.get(path),
      theirs?.entries.get(path),
      contentMerger,
      labels,
      reserved,
    );
    const outcome = result instanceof Promise ? await result : result;
    outcomes.push(outcome);
  }

  const conflicts = extractConflicts(outcomes);
  return { outcomes, conflicts, cleanMerge: conflicts.length === 0 };
}
