/**
 * Tier-1 `rev-list` command — the reachability core of git's `git rev-list`:
 * enumerate the objects reachable from `wants` and not reachable from `not`.
 * Delegates to the shared closure engine, which decides nothing about tier
 * — `rev-list` passes `tier: 'bitmap'` only when `useBitmapIndex` is set AND
 * `maxCount` is absent (git itself abandons the bitmap for a bounded count),
 * `'walk'` otherwise, and nothing else decides. Structured output only: no
 * `--pretty`/`--format`/`--date`/`--abbrev`/`--header`/`-z`/`--object-names`
 * — every one of those is presentation.
 *
 * Ordering is deterministic for a given call but is not git's own order —
 * every equality check against the result compares it as a set.
 */
import { objectNotFound } from '../../domain/objects/error.js';
import type { FilePath, ObjectId, RefName } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { enumerateRefs } from '../primitives/enumerate-refs.js';
import { type ClosureTier, computeClosure } from '../primitives/internal/closure-engine.js';
import { readRefCandidate } from '../primitives/resolve-ref.js';
import { assertOperationalRepository } from './internal/repo-state.js';
import { expandRevisionArguments } from './internal/revision-argument.js';

export interface RevListOptions {
  /** Revisions to walk from. Defaults to `['HEAD']`, unless `all` is set. */
  readonly wants?: ReadonlyArray<string>;
  /** Revisions whose reachability is excluded (git's `--not` / `^rev`). */
  readonly not?: ReadonlyArray<string>;
  /** Include trees and blobs, not just commits and tags. */
  readonly objects?: boolean;
  /**
   * Documents intent only: `entries` is always populated and `count` is
   * always `entries.length` on the same call — there is no separate
   * count-only fast path, since the walk already computes the whole set to
   * count it.
   */
  readonly count?: boolean;
  /**
   * Union the tips of every ref (branches, tags, remotes, `HEAD`) into
   * `wants`, deduplicated. A symbolic ref whose target does not resolve — a
   * `HEAD` on an unborn branch is the live case — is skipped; a ref whose
   * content is unreadable refuses with `OBJECT_NOT_FOUND` naming that ref,
   * as git's `bad object <ref>`.
   */
  readonly all?: boolean;
  /**
   * At most this many commits emitted (under `objects`, those commits and
   * everything they reach). Bounds the commit walk only. `0` yields an
   * empty result.
   */
  readonly maxCount?: number;
  /** Follow only the first parent of each commit. */
  readonly firstParent?: boolean;
  /**
   * Emit the resolved tips themselves and stop — no parent traversal. Ignored
   * once a `not` tip is present (git drops `--no-walk` for a range); with no
   * `not` side and `objects`, each tip's own tree still counts.
   */
  readonly noWalk?: boolean;
  /**
   * Ask for the bitmap tier. **Defaults to `false`** — git's `rev-list`
   * walks unless asked. The bitmap tier returns the exact set difference
   * and **no `path`**; a caller that needs paths must leave this off. It
   * also changes what `firstParent` and `noWalk` mean: the bitmap tier
   * does not traverse, so it ignores them and returns the full closure,
   * exactly as git does. `maxCount` still walks, because git itself
   * abandons the bitmap for it.
   */
  readonly useBitmapIndex?: boolean;
}

export interface RevListEntry {
  readonly id: ObjectId;
  readonly type: 'commit' | 'tree' | 'blob' | 'tag';
  /** Present on trees/blobs under `objects`. */
  readonly path?: FilePath;
}

export interface RevListResult {
  readonly entries: ReadonlyArray<RevListEntry>;
  /** `entries.length`. With `objects` it counts objects; without it, commits and tags. */
  readonly count: number;
}

const DEFAULT_WANTS: ReadonlyArray<string> = ['HEAD'];

const HEAD_REF = 'HEAD' as RefName;

/** git's `--all` iteration order: every ref under `refs/`, then `HEAD`. */
const allRefNames = async (ctx: Context): Promise<RefName[]> => {
  const names = await enumerateRefs(ctx);
  return [...names.filter((name) => name.startsWith('refs/')), HEAD_REF];
};

/**
 * One `--all` tip as git's paranoid ref iteration hands it to
 * `get_reference`: a dangling symref (an unborn `HEAD` included) is omitted,
 * a broken ref dies `bad object <name>`, and any other fault propagates.
 */
const readAllRefTip = async (ctx: Context, name: RefName): Promise<ObjectId | undefined> => {
  const outcome = await readRefCandidate(ctx, name);
  if (outcome.kind === 'broken') throw objectNotFound(name as string as ObjectId);
  return outcome.kind === 'found' ? outcome.id : undefined;
};

const resolveAllRefTips = async (ctx: Context): Promise<ObjectId[]> => {
  const tips: ObjectId[] = [];
  for (const name of await allRefNames(ctx)) {
    const tip = await readAllRefTip(ctx, name);
    if (tip !== undefined) tips.push(tip);
  }
  return tips;
};

interface RevListTips {
  readonly wants: ReadonlyArray<ObjectId>;
  readonly not: ReadonlyArray<ObjectId>;
}

/**
 * Explicit `wants` and `not`, each expanded in turn as git's
 * `handle_revision_arg` reads it, union `all`'s ref tips, deduplicated. `all`
 * supplies its own tips, so the `['HEAD']` default only applies when `all` is unset.
 */
const resolveRevListTips = async (ctx: Context, opts: RevListOptions): Promise<RevListTips> => {
  const explicitInputs = opts.wants ?? (opts.all === true ? [] : DEFAULT_WANTS);
  const tips = await expandRevisionArguments(
    ctx,
    { wants: explicitInputs, not: opts.not ?? [] },
    'command-line',
  );
  if (opts.all !== true) return tips;
  return { ...tips, wants: [...new Set([...tips.wants, ...(await resolveAllRefTips(ctx))])] };
};

/**
 * `useBitmapIndex` requests the bitmap tier, but `maxCount` forces the walk
 * regardless — git itself abandons the bitmap for a bounded count, so
 * declining here is reproduction, not policy. Nothing else narrows the
 * choice: `firstParent`/`noWalk` keep meaning "ignored" on the bitmap tier,
 * never "fall back to the walk".
 */
const closureTierFor = (opts: RevListOptions): ClosureTier =>
  opts.useBitmapIndex === true && opts.maxCount === undefined ? 'bitmap' : 'walk';

export const revList = async (ctx: Context, opts: RevListOptions = {}): Promise<RevListResult> => {
  await assertOperationalRepository(ctx);
  const { wants, not } = await resolveRevListTips(ctx, opts);
  const closure = await computeClosure(ctx, {
    wants,
    not,
    objects: opts.objects ?? false,
    tier: closureTierFor(opts),
    firstParent: opts.firstParent ?? false,
    noWalk: opts.noWalk ?? false,
    ...(opts.maxCount !== undefined ? { maxCount: opts.maxCount } : {}),
  });
  const entries: RevListEntry[] = closure.objects.map((object) =>
    object.path === undefined
      ? { id: object.id, type: object.type }
      : { id: object.id, type: object.type, path: object.path },
  );
  return { entries, count: entries.length };
};
