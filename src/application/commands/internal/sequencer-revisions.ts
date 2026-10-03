import { emptyCommitSet, invalidOption } from '../../../domain/commands/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { limitList, resolveLimitOptions } from '../../primitives/internal/limit-list.js';
import { revParse } from '../rev-parse.js';
import { resolveCommitIsh } from './commit-ish.js';

const RANGE = /^(.*)\.\.(.*)$/;
const SYMMETRIC_RANGE = '...';
const EXCLUDE_PREFIX = '^';
/** A revision suffix (`A^`, `A~2`, `A@{1}`) needs the full revision grammar, not a ref lookup. */
const REVISION_OPERATOR = /[~^@]/;
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

interface Seeds {
  readonly tips: ReadonlyArray<ObjectId>;
  readonly excluded: ReadonlyArray<ObjectId>;
  /** Every named commit in argument order, a range's excluded side first. */
  readonly named: ReadonlyArray<ObjectId>;
}

interface SeedLists {
  readonly tips: ObjectId[];
  readonly excluded: ObjectId[];
  readonly named: ObjectId[];
}

/** git's `setup_revisions` + `prepare_revs` over a cherry-pick / revert argument list. */
export const resolveSequencerRevisions = async (
  ctx: Context,
  args: ReadonlyArray<string>,
): Promise<SequencerRevisions> => {
  const seeds = await resolveSeeds(ctx, args);
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

const resolveSeeds = async (ctx: Context, args: ReadonlyArray<string>): Promise<Seeds> => {
  const seeds: SeedLists = { tips: [], excluded: [], named: [] };
  for (const arg of args) await addSeed(ctx, arg, seeds);
  return seeds;
};

/** One argument as git's `setup_revisions` reads it: `A..B`, `^A`, or a commit-ish. */
const addSeed = async (ctx: Context, arg: string, seeds: SeedLists): Promise<void> => {
  if (arg.includes(SYMMETRIC_RANGE)) {
    throw invalidOption('commits', `unsupported revision form '${arg}' (use a commit-ish or A..B)`);
  }
  const range = RANGE.exec(arg);
  if (range !== null) {
    addExcluded(seeds, await revParse(ctx, orHead(range[1] as string)));
    addTip(seeds, await revParse(ctx, orHead(range[2] as string)));
    return;
  }
  if (arg.startsWith(EXCLUDE_PREFIX)) {
    addExcluded(seeds, await revParse(ctx, arg.slice(EXCLUDE_PREFIX.length)));
    return;
  }
  const resolve = REVISION_OPERATOR.test(arg) ? revParse : resolveCommitIsh;
  addTip(seeds, await resolve(ctx, arg));
};

const addTip = (seeds: SeedLists, id: ObjectId): void => {
  seeds.tips.push(id);
  seeds.named.push(id);
};

const addExcluded = (seeds: SeedLists, id: ObjectId): void => {
  seeds.excluded.push(id);
  seeds.named.push(id);
};

const walkSeeds = async (ctx: Context, seeds: Seeds): Promise<ReadonlyArray<ObjectId>> => {
  const options = await resolveLimitOptions(
    ctx,
    { from: seeds.tips },
    { seeds: seeds.named, until: new Set(seeds.excluded), firstParent: false, settle: 'slop' },
  );
  return (await limitList(ctx, options)).shown;
};
