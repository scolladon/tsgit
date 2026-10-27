import { applyDiffOnto } from '../../../domain/diff/apply-hunks.js';
import { pairIsBinary } from '../../../domain/diff/binary-decision.js';
import type { FlatTreeEntry } from '../../../domain/diff/flat-tree.js';
import { isSameKind, kindOf } from '../../../domain/diff/mode-kind.js';
import { comparePaths } from '../../../domain/diff/path-compare.js';
import { TsgitError } from '../../../domain/error.js';
import { viewOfEscaped } from '../../../domain/git-index/index-path-key.js';
import { validateTreePath } from '../../../domain/git-index/path-validator.js';
import type { FileMode, FilePath, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { flattenEscapedTree } from '../../primitives/flatten-tree.js';
import { hashBlob } from '../../primitives/hash-blob.js';
import {
  parentDirectory,
  survivingDirectoriesOf,
} from '../../primitives/internal/prune-emptied-directories.js';
import { stage0Entry } from '../../primitives/internal/synthetic-index-entry.js';
import { readBlob } from '../../primitives/read-blob.js';
import { synthesizeTreeFromIndex } from '../../primitives/synthesize-tree-from-index.js';
import { type BinaryOverrideOf, binaryOverrideReader } from './staged-binary-override.js';

export type StagedPatchVerdict =
  | { readonly kind: 'applies'; readonly tree: ObjectId }
  | { readonly kind: 'refused'; readonly paths: ReadonlyArray<FilePath> };

interface Trees {
  readonly bTree: ObjectId;
  readonly cTree: ObjectId;
  readonly iTree: ObjectId;
}

interface Sides {
  readonly b: FlatTreeEntry | undefined;
  readonly i: FlatTreeEntry | undefined;
  readonly c: FlatTreeEntry | undefined;
}

type Flat = ReadonlyMap<FilePath, FlatTreeEntry>;

interface Judge {
  readonly ctx: Context;
  readonly overrideOf: BinaryOverrideOf;
}

type Outcome =
  | { readonly kind: 'set'; readonly entry: FlatTreeEntry }
  | { readonly kind: 'patched'; readonly bytes: Uint8Array; readonly mode: FileMode }
  | { readonly kind: 'remove' }
  | { readonly kind: 'fails' };

const FAILS: Outcome = { kind: 'fails' };
const REMOVE: Outcome = { kind: 'remove' };

const sameEntry = (a: FlatTreeEntry | undefined, b: FlatTreeEntry | undefined): boolean =>
  a?.id === b?.id && a?.mode === b?.mode;

/** The mode of I when the stash changed it, else the one C already carries. */
const patchedMode = (b: FlatTreeEntry, i: FlatTreeEntry, c: FlatTreeEntry): FileMode =>
  b.mode === i.mode ? c.mode : i.mode;

const bytesOf = async (ctx: Context, id: ObjectId): Promise<Uint8Array> =>
  (await readBlob(ctx, id)).content;

const setOf = (id: ObjectId, mode: FileMode): Outcome => ({ kind: 'set', entry: { id, mode } });

const judgeCreation = (i: FlatTreeEntry, c: FlatTreeEntry | undefined): Outcome =>
  c === undefined ? { kind: 'set', entry: i } : FAILS;

/** C must hold the very content B had, whatever its mode, for the path to be deleted or change kind. */
const judgeReplacement = (
  b: FlatTreeEntry,
  c: FlatTreeEntry | undefined,
  onMatch: Outcome,
): Outcome => (c !== undefined && isSameKind(b.mode, c.mode) && c.id === b.id ? onMatch : FAILS);

const judgeGitlink = (b: FlatTreeEntry, i: FlatTreeEntry, c: FlatTreeEntry): Outcome =>
  c.id === b.id ? setOf(i.id, i.mode) : FAILS;

const judgeModeOnly = (i: FlatTreeEntry, c: FlatTreeEntry): Outcome => setOf(c.id, i.mode);

const judgeText = async (
  ctx: Context,
  [b, i, c]: readonly [FlatTreeEntry, FlatTreeEntry, FlatTreeEntry],
  [base, target]: readonly [Uint8Array, Uint8Array],
): Promise<Outcome> => {
  const bytes = applyDiffOnto({ base, target, current: await bytesOf(ctx, c.id) });
  return bytes === undefined ? FAILS : { kind: 'patched', bytes, mode: patchedMode(b, i, c) };
};

const judgeContent = async (
  { ctx, overrideOf }: Judge,
  path: FilePath,
  entries: readonly [FlatTreeEntry, FlatTreeEntry, FlatTreeEntry],
): Promise<Outcome> => {
  const [b, i] = entries;
  const sides = await Promise.all([bytesOf(ctx, b.id), bytesOf(ctx, i.id)] as const);
  if (pairIsBinary(sides[0], sides[1], await overrideOf(path))) return FAILS;
  return judgeText(ctx, entries, sides);
};

const judgeModify = (
  judge: Judge,
  path: FilePath,
  [b, i, c]: readonly [FlatTreeEntry, FlatTreeEntry, FlatTreeEntry],
): Promise<Outcome> | Outcome => {
  if (kindOf(b.mode) === 'gitlink') return judgeGitlink(b, i, c);
  if (b.id === i.id) return judgeModeOnly(i, c);
  if (c.id === b.id) return setOf(i.id, patchedMode(b, i, c));
  return judgeContent(judge, path, [b, i, c]);
};

/** git's `verify_path` on the name a patch creates: a refused name fails the check phase. */
const isAdmissibleName = (path: FilePath, entry: FlatTreeEntry): boolean => {
  try {
    validateTreePath(path, entry.mode);
    return true;
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'INVALID_INDEX_ENTRY') return false;
    throw err;
  }
};

const judgePath = async (judge: Judge, path: FilePath, { b, i, c }: Sides): Promise<Outcome> => {
  if (i !== undefined && !isAdmissibleName(path, i)) return FAILS;
  if (b === undefined) return judgeCreation(i as FlatTreeEntry, c);
  if (i === undefined) return judgeReplacement(b, c, REMOVE);
  if (!isSameKind(b.mode, i.mode)) return judgeReplacement(b, c, { kind: 'set', entry: i });
  if (c === undefined || !isSameKind(b.mode, c.mode)) return FAILS;
  return judgeModify(judge, path, [b, i, c]);
};

const changedPaths = (b: Flat, i: Flat): FilePath[] =>
  [...new Set([...b.keys(), ...i.keys()])]
    .filter((path) => !sameEntry(b.get(path), i.get(path)))
    .sort(comparePaths);

const hasOccupiedAncestor = (path: FilePath, occupied: ReadonlySet<FilePath>): boolean => {
  for (let dir = parentDirectory(path); dir !== ''; dir = parentDirectory(dir)) {
    if (occupied.has(dir as FilePath)) return true;
  }
  return false;
};

const isPlacement = (outcome: Outcome): boolean => outcome.kind === 'set';

/** git refuses a path that is both a file and a directory, but only once the check phase has passed, and at the first one. */
const firstClash = (c: Flat, outcomes: ReadonlyMap<FilePath, Outcome>): FilePath | undefined => {
  const occupied = new Set(c.keys());
  for (const [path, outcome] of outcomes) {
    if (outcome.kind === 'remove') occupied.delete(path);
  }
  const directories = survivingDirectoriesOf(occupied);
  return [...outcomes]
    .filter(([, outcome]) => isPlacement(outcome))
    .map(([path]) => path)
    .find((path) => directories.has(path) || hasOccupiedAncestor(path, occupied));
};

const judgeAll = async (
  judge: Judge,
  [b, c, i]: readonly [Flat, Flat, Flat],
): Promise<Map<FilePath, Outcome>> => {
  const outcomes = new Map<FilePath, Outcome>();
  for (const path of changedPaths(b, i)) {
    const sides = { b: b.get(path), i: i.get(path), c: c.get(path) };
    outcomes.set(path, await judgePath(judge, path, sides));
  }
  return outcomes;
};

const entryOf = async (ctx: Context, outcome: Outcome): Promise<FlatTreeEntry | undefined> => {
  if (outcome.kind === 'set') return outcome.entry;
  if (outcome.kind !== 'patched') return undefined;
  return { id: await hashBlob(ctx, outcome.bytes, { write: true }), mode: outcome.mode };
};

const writeResultTree = async (
  ctx: Context,
  c: Flat,
  outcomes: ReadonlyMap<FilePath, Outcome>,
): Promise<ObjectId> => {
  const result = new Map(c);
  for (const [path, outcome] of outcomes) {
    const entry = await entryOf(ctx, outcome);
    if (entry === undefined) result.delete(path);
    else result.set(path, entry);
  }
  const entries = [...result].map(([path, { id, mode }]) => stage0Entry(path, id, mode));
  return synthesizeTreeFromIndex(ctx, entries);
};

const refused = (paths: ReadonlyArray<FilePath>): StagedPatchVerdict => ({
  kind: 'refused',
  paths: paths.map(viewOfEscaped),
});

/** git's `diff-tree --binary B I | apply --cached` onto the current index C, judged before any write. */
export const judgeStagedPatch = async (ctx: Context, trees: Trees): Promise<StagedPatchVerdict> => {
  const [b, c, i] = await Promise.all([
    flattenEscapedTree(ctx, trees.bTree),
    flattenEscapedTree(ctx, trees.cTree),
    flattenEscapedTree(ctx, trees.iTree),
  ]);
  const judge = { ctx, overrideOf: binaryOverrideReader(ctx, c.entries) };
  const outcomes = await judgeAll(judge, [b.entries, c.entries, i.entries]);
  const failed = [...outcomes].filter(([, outcome]) => outcome.kind === 'fails');
  if (failed.length > 0) return refused(failed.map(([path]) => path));
  const clash = firstClash(c.entries, outcomes);
  if (clash !== undefined) return refused([clash]);
  return { kind: 'applies', tree: await writeResultTree(ctx, c.entries, outcomes) };
};
