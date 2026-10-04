/**
 * git's `handle_revision_arg`: one argument expanded into the tips a walk
 * starts from — `A..B` excludes A and includes B, `A...B` excludes their merge
 * bases and includes both, `X^@` includes X's parents, `X^!` excludes them and
 * `X^-<n>` its n-th parent before X itself is included, and `^X` excludes X.
 * A side or base that names no commit leaves the form unexpanded, so the
 * whole argument is then read as one name.
 */

import { revparseUnresolved } from '../../../domain/commands/error.js';
import { applyGraft } from '../../../domain/commit/graft.js';
import type { Commit, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import type { ObjectTypeTable } from '../../primitives/internal/object-type-table.js';
import { loadShallowSet } from '../../primitives/internal/shallow-set.js';
import { readObject } from '../../primitives/read-object.js';
import {
  type RevisionSource,
  readCommittish,
  readNamedObject,
  readReporting,
} from '../rev-parse.js';
import { requireReference } from './require-reference.js';
import { type DifferenceSides, differenceSides, rangeSides } from './rev-parse-difference.js';
import { symmetricBases } from './symmetric-bases.js';

/** One tip of a walk: `negated` where git marks it uninteresting. */
export interface RevisionTip {
  readonly id: ObjectId;
  readonly negated: boolean;
}

const NEGATION = '^';
const PARENTS_MARK = '^@';
const EXCLUDE_PARENTS_MARK = '^!';
const EXCLUDE_PARENT_MARK = '^-';
/** git's `strtol_i`: an optional sign, then decimal digits to the end. */
const PARENT_NUMBER = /^[+-]?[0-9]+$/;

const tip = (id: ObjectId, negated: boolean): RevisionTip => ({ id, negated });

const SIDES_BY_SOURCE: Readonly<
  Record<RevisionSource, (arg: string) => DifferenceSides | undefined>
> = { 'command-line': differenceSides, stdin: rangeSides };

/** git's `handle_dotdot`: both sides named, the range's tips; otherwise `undefined`. */
const expandRange = async (
  ctx: Context,
  table: ObjectTypeTable,
  arg: string,
  source: RevisionSource,
): Promise<ReadonlyArray<RevisionTip> | undefined> => {
  const sides = SIDES_BY_SOURCE[source](arg);
  if (sides === undefined) return undefined;
  const start = await readCommittish(ctx, table, sides.start);
  if (start === undefined) return undefined;
  const end = await readCommittish(ctx, table, sides.end);
  if (end === undefined) return undefined;
  if (!sides.symmetric) return [tip(start, true), tip(end, false)];
  const bases = await symmetricBases(ctx, arg, [start, end]);
  if (bases === undefined) return undefined;
  return [...bases.map((id) => tip(id, true)), tip(start, false), tip(end, false)];
};

/**
 * git's `add_parents_only` peel: through annotated tags to the commit `id`
 * reaches — each object on the way refused as `bad object <base>` when
 * absent — or `undefined`, silently, when the chain ends on a non-commit.
 */
const peelParentsBase = async (
  ctx: Context,
  table: ObjectTypeTable,
  base: string,
  id: ObjectId,
): Promise<Commit | undefined> => {
  await requireReference(ctx, table, base, id);
  const object = await readObject(ctx, id);
  if (object.type === 'tag') return peelParentsBase(ctx, table, base, object.data.object);
  return object.type === 'commit' ? object : undefined;
};

/**
 * git's `add_parents_only`: the parents of the commit `base` names — only the
 * `exclude`-th when given — marked `negated` (flipped by a leading `^`), or
 * `undefined` when `base` names no commit or has no such parent.
 */
const parentsOf = async (
  ctx: Context,
  table: ObjectTypeTable,
  spelt: string,
  negated: boolean,
  exclude?: number,
): Promise<ReadonlyArray<RevisionTip> | undefined> => {
  const flipped = spelt.startsWith(NEGATION);
  const base = flipped ? spelt.slice(NEGATION.length) : spelt;
  const id = await readCommittish(ctx, table, base);
  if (id === undefined) return undefined;
  const commit = await peelParentsBase(ctx, table, base, id);
  if (commit === undefined) return undefined;
  const { parents } = applyGraft(commit, await loadShallowSet(ctx)).data;
  const chosen = exclude === undefined ? parents : parents.slice(exclude - 1, exclude);
  if (chosen.length === 0 && exclude !== undefined) return undefined;
  return chosen.map((parent) => tip(parent, negated !== flipped));
};

/** The base before `mark` when its first occurrence ends `arg`, as git's search for it requires. */
const endingWith = (arg: string, mark: string): string | undefined => {
  const at = arg.indexOf(mark);
  return at !== -1 && at + mark.length === arg.length ? arg.slice(0, at) : undefined;
};

interface Shrunk {
  readonly excluded: ReadonlyArray<RevisionTip>;
  readonly rest: string;
}

/** `X^!`: X's parents excluded, X left to read; untouched when X names no commit. */
const shrinkExcludeParents = async (
  ctx: Context,
  table: ObjectTypeTable,
  arg: string,
): Promise<Shrunk> => {
  const base = endingWith(arg, EXCLUDE_PARENTS_MARK);
  if (base === undefined) return { excluded: [], rest: arg };
  const excluded = await parentsOf(ctx, table, base, true);
  return excluded === undefined ? { excluded: [], rest: arg } : { excluded, rest: base };
};

/** `X^-<n>`: X's n-th parent excluded, X left to read; a malformed `<n>` is a bad revision. */
const shrinkExcludeParent = async (
  ctx: Context,
  table: ObjectTypeTable,
  arg: string,
): Promise<Shrunk> => {
  const at = arg.indexOf(EXCLUDE_PARENT_MARK);
  if (at === -1) return { excluded: [], rest: arg };
  const spelt = arg.slice(at + EXCLUDE_PARENT_MARK.length);
  const n = spelt === '' ? 1 : Number.parseInt(spelt, 10);
  if (spelt !== '' && (!PARENT_NUMBER.test(spelt) || n < 1)) throw revparseUnresolved(arg);
  const base = arg.slice(0, at);
  const excluded = await parentsOf(ctx, table, base, true, n);
  return excluded === undefined ? { excluded: [], rest: arg } : { excluded, rest: base };
};

const readTip = async (
  ctx: Context,
  table: ObjectTypeTable,
  arg: string,
  source: RevisionSource,
): Promise<RevisionTip> => {
  const negated = arg.startsWith(NEGATION);
  const name = negated ? arg.slice(NEGATION.length) : arg;
  const id =
    source === 'stdin'
      ? await readReporting(ctx, table, name)
      : await readNamedObject(ctx, table, name, arg);
  await requireReference(ctx, table, name, id);
  return tip(id, negated);
};

/** The tips `arg` expands to, in the order git adds them to the walk. */
export const expandRevisionArgument = async (
  ctx: Context,
  table: ObjectTypeTable,
  arg: string,
  source: RevisionSource,
): Promise<ReadonlyArray<RevisionTip>> => {
  const range = await expandRange(ctx, table, arg, source);
  if (range !== undefined) return range;
  const parentsBase = endingWith(arg, PARENTS_MARK);
  const parents =
    parentsBase === undefined ? undefined : await parentsOf(ctx, table, parentsBase, false);
  if (parents !== undefined) return parents;
  const withoutParents = await shrinkExcludeParents(ctx, table, arg);
  const withoutParent = await shrinkExcludeParent(ctx, table, withoutParents.rest);
  const excluded = [...withoutParents.excluded, ...withoutParent.excluded];
  return [...excluded, await readTip(ctx, table, withoutParent.rest, source)];
};

/** A walk tip in git's pending order, excluded or not. */
export interface PendingTip {
  readonly id: ObjectId;
  readonly excluded: boolean;
}

export interface ExpandedRevisions {
  readonly wants: ObjectId[];
  readonly not: ObjectId[];
  /** Every tip of `wants` and `not`, in the order git adds them to the walk. */
  readonly tips: PendingTip[];
}

/**
 * Each argument expanded in turn, `not` ones with every tip's polarity
 * flipped, every object parsed typed into `table`, the invocation's.
 */
export const expandRevisionArguments = async (
  ctx: Context,
  table: ObjectTypeTable,
  args: { readonly wants: ReadonlyArray<string>; readonly not: ReadonlyArray<string> },
  source: RevisionSource,
): Promise<ExpandedRevisions> => {
  const wants: ObjectId[] = [];
  const not: ObjectId[] = [];
  const tips: PendingTip[] = [];
  const place = (expanded: RevisionTip, flip: boolean): void => {
    const excluded = expanded.negated !== flip;
    (excluded ? not : wants).push(expanded.id);
    tips.push({ id: expanded.id, excluded });
  };
  for (const arg of args.wants)
    for (const t of await expandRevisionArgument(ctx, table, arg, source)) place(t, false);
  for (const arg of args.not)
    for (const t of await expandRevisionArgument(ctx, table, arg, source)) place(t, true);
  return { wants, not, tips };
};
