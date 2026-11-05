import {
  cannotPickNonCommit,
  emptyCommitSet,
  invalidOption,
  invalidRevisionRange,
} from '../../../domain/commands/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { limitList, resolveLimitOptions } from '../../primitives/internal/limit-list.js';
import { type PeeledRef, peelRefToCommit } from '../../primitives/internal/peel-ref-to-commit.js';
import { readObject } from '../../primitives/read-object.js';
import { evaluateRevision } from '../rev-parse.js';
import {
  isObjectReadFault,
  readRevisionObject,
  refusingObjectReadFault,
  resolveCommitIshObject,
} from './commit-ish.js';
import { previousCheckoutArg } from './prior-checkout.js';

const RANGE = /^(.*)\.\.(.*)$/;
const SYMMETRIC_RANGE = '...';
const EXCLUDE_PREFIX = '^';
/** A revision suffix (`A^`, `A~2`, `A@{1}`) or path (`A:path`) needs the full revision grammar, not a ref lookup. */
const REVISION_OPERATOR = /[~^@:]/;
/** git reads a range side left out (`A..`, `..B`) as `HEAD`. */
const orHead = (side: string): string => (side === '' ? 'HEAD' : side);

/**
 * The commits a cherry-pick or revert sequence works through. `listed`: no
 * argument excludes anything, so each named commit is taken once, in argument
 * order (git's `no_walk` + `unsorted_input`). `walked`: some argument excludes,
 * so every named commit seeds ONE limited walk (`limit_list`), newest commit
 * date first — the order a revert uses, and a cherry-pick reverses.
 */
export interface SequencerRevisions {
  readonly kind: 'listed' | 'walked';
  readonly commits: ReadonlyArray<ObjectId>;
}

/** A named object and the name it was given — a whole argument, or one side of a range. */
interface NamedObject {
  readonly name: string;
  readonly id: ObjectId;
}

interface Seeds {
  readonly tips: ReadonlyArray<ObjectId>;
  readonly excluded: ReadonlyArray<ObjectId>;
  /** Every named commit in argument order, a range's excluded side first. */
  readonly named: ReadonlyArray<ObjectId>;
}

type SeedRole = 'tip' | 'excluded';

interface Seed extends NamedObject {
  readonly role: SeedRole;
}

/** git's `setup_revisions` + `prepare_revs` over a cherry-pick / revert argument list. */
export const resolveSequencerRevisions = async (
  ctx: Context,
  args: ReadonlyArray<string>,
): Promise<SequencerRevisions> => {
  // git's `parse_args`: only the first revision may be the `-` shorthand.
  const spelt = args.map((arg, position) => (position === 0 ? previousCheckoutArg(arg) : arg));
  const seeds = await resolveSeeds(ctx, spelt);
  const resolved =
    seeds.excluded.length === 0
      ? { kind: 'listed' as const, commits: [...new Set(seeds.tips)] }
      : { kind: 'walked' as const, commits: await walkSeeds(ctx, seeds) };
  if (resolved.commits.length === 0) throw emptyCommitSet();
  return resolved;
};

/**
 * git's lone-commit shortcut (`sequencer_pick_revisions`): exactly one plain
 * commit-ish is replayed without sequencer state; any other argument list —
 * a one-commit range, the same commit named twice — runs as a sequence.
 */
export const isSequence = (args: ReadonlyArray<string>, revisions: SequencerRevisions): boolean =>
  args.length > 1 || revisions.kind === 'walked';

/** Both of git's phases: `setup_revisions` resolves every argument, then `sequencer_pick_revisions` rereads and type-checks each name. */
const resolveSeeds = async (ctx: Context, args: ReadonlyArray<string>): Promise<Seeds> => {
  const named: Seed[] = [];
  for (const arg of args) named.push(...(await argSeeds(ctx, arg)));
  const picked: Seed[] = [];
  for (const seed of named) picked.push({ ...seed, id: await pickedCommit(ctx, seed) });
  const idsOf = (role: SeedRole): ObjectId[] =>
    picked.filter((seed) => seed.role === role).map((seed) => seed.id);
  return { tips: idsOf('tip'), excluded: idsOf('excluded'), named: picked.map((seed) => seed.id) };
};

/**
 * git's second `repo_get_oid` on a name, then its type check: the name must peel to a
 * commit. The pick itself is the first read's object, as `setup_revisions`' pending list
 * holds it; the second read decides nothing but the refusal.
 */
const pickedCommit = async (ctx: Context, { name, id }: Seed): Promise<ObjectId> => {
  const reread = await evaluateRevision(ctx, name);
  const checked = await peelToCommit(ctx, reread);
  if (checked === undefined) throw cannotPickNonCommit(name, (await readObject(ctx, reread)).type);
  return reread === id ? checked.commit.id : commitOf(ctx, name, id);
};

/** The first read's object peeled to its commit, when the second read named another object. */
const commitOf = async (ctx: Context, name: string, id: ObjectId): Promise<ObjectId> => {
  const peeled = await peelToCommit(ctx, id);
  if (peeled === undefined) throw cannotPickNonCommit(name, (await readObject(ctx, id)).type);
  return peeled.commit.id;
};

/** A chain ending at an object that does not read peels to no commit, as git's `lookup_commit_reference` finds none. */
const peelToCommit = async (ctx: Context, id: ObjectId): Promise<PeeledRef | undefined> => {
  try {
    return await peelRefToCommit(ctx, id);
  } catch (error) {
    if (isObjectReadFault(error)) return undefined;
    throw error;
  }
};

/** One argument as git's `setup_revisions` reads it: `A..B`, `^A`, or a commit-ish. */
const argSeeds = async (ctx: Context, arg: string): Promise<ReadonlyArray<Seed>> => {
  if (arg.includes(SYMMETRIC_RANGE)) {
    throw invalidOption('commits', `unsupported revision form '${arg}' (use a commit-ish or A..B)`);
  }
  const range = RANGE.exec(arg);
  if (range !== null) {
    return rangeSeeds(ctx, arg, orHead(range[1] as string), orHead(range[2] as string));
  }
  if (arg.startsWith(EXCLUDE_PREFIX)) {
    return [await excludedSeed(ctx, arg.slice(EXCLUDE_PREFIX.length))];
  }
  return [await plainSeed(ctx, arg)];
};

/** git's `handle_dotdot`: both ends are read, and a side that does not read makes the range invalid. */
const rangeSeeds = async (
  ctx: Context,
  arg: string,
  excluded: string,
  tip: string,
): Promise<ReadonlyArray<Seed>> => {
  const seeds = [
    await evaluatedSeed(ctx, excluded, 'excluded'),
    await evaluatedSeed(ctx, tip, 'tip'),
  ];
  for (const seed of seeds) await readRangeSide(ctx, seed.id, arg);
  return seeds;
};

const readRangeSide = async (ctx: Context, id: ObjectId, arg: string): Promise<void> => {
  await refusingObjectReadFault(
    () => readObject(ctx, id),
    () => invalidRevisionRange(arg),
  );
};

/** git's `get_reference` on an excluded side: the named object must read. */
const excludedSeed = async (ctx: Context, name: string): Promise<Seed> => {
  const seed = await evaluatedSeed(ctx, name, 'excluded');
  await readRevisionObject(ctx, seed.id, name);
  return seed;
};

const evaluatedSeed = async (ctx: Context, name: string, role: SeedRole): Promise<Seed> => ({
  name,
  role,
  id: await evaluateRevision(ctx, name),
});

const plainSeed = async (ctx: Context, name: string): Promise<Seed> => {
  if (REVISION_OPERATOR.test(name)) return evaluatedSeed(ctx, name, 'tip');
  const id = await resolveCommitIshObject(ctx, name);
  await readRevisionObject(ctx, id, name);
  return { name, role: 'tip', id };
};

const walkSeeds = async (ctx: Context, seeds: Seeds): Promise<ReadonlyArray<ObjectId>> => {
  const options = await resolveLimitOptions(
    ctx,
    { from: seeds.tips },
    {
      seeds: seeds.named,
      until: new Set(seeds.excluded),
      firstParent: false,
      settle: 'slop',
      bodyRetention: 'none',
    },
  );
  return (await limitList(ctx, options)).shown;
};
