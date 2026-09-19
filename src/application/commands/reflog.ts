/**
 * Tier-1 `reflog` command — inspect and manage `.git/logs/` reflog files.
 * One command, discriminated `action` (default `show`), mirroring `branch` /
 * `tag`. Writers are gated by `core.logAllRefUpdates`; this command is not —
 * it manages logs that already exist.
 */
import { revparseUnresolved } from '../../domain/commands/error.js';
import { TsgitError } from '../../domain/error.js';
import { isObjectNotFound } from '../../domain/objects/error.js';
import { type ObjectId, type RefName, zeroOid } from '../../domain/objects/index.js';
import { reflogNotFound } from '../../domain/reflog/error.js';
import {
  type ExpiryCuts,
  type ExplicitExpiryCuts,
  expiryPolicyFor,
  parseReflogExpiryEntries,
  type ReflogExpiryPolicy,
} from '../../domain/reflog/expire-policy.js';
import type { ReflogEntry } from '../../domain/reflog/reflog-entry.js';
import { isSafeRefName, refCandidates, validateRefName } from '../../domain/refs/index.js';
import { HEADS_PREFIX } from '../../domain/refs/ref-prefixes.js';
import type { Context } from '../../ports/context.js';
import { readReflogExpiryConfig } from '../primitives/config-read.js';
import { enumerateRefs } from '../primitives/enumerate-refs.js';
import { resolveExpiryCutoff } from '../primitives/expiry-cutoff.js';
import { boundedMapFor } from '../primitives/internal/concurrency.js';
import { type PeeledRef, peelRefToCommit } from '../primitives/internal/peel-ref-to-commit.js';
import { type CommitMeta, readCommitMeta } from '../primitives/internal/read-commit-meta.js';
import { assertRepoSettingsValid } from '../primitives/internal/repo-settings-gate.js';
import { getRefStore, type RefUpdate } from '../primitives/ref-store.js';
import { listReflogs, readReflogLenient } from '../primitives/reflog-store.js';
import { resolveRef, resolveTerminalName } from '../primitives/resolve-ref.js';
import { assertOperationalRepository } from './internal/repo-state.js';
import { resolveRevisionName } from './internal/revision-name.js';

export type { ReflogEntry } from '../../domain/reflog/reflog-entry.js';

export type ReflogAction =
  | { readonly action?: 'show'; readonly ref?: string }
  | { readonly action: 'exists'; readonly ref: string }
  | {
      readonly action: 'delete';
      readonly ref: string;
      readonly index: number;
      readonly rewrite?: boolean;
    }
  | {
      readonly action: 'expire';
      readonly ref?: string;
      readonly all?: boolean;
      readonly expire?: string;
      readonly expireUnreachable?: string;
    };

/** One reflog entry as `show` presents it: newest-first, with a selector. */
export interface ReflogShowEntry {
  readonly index: number;
  readonly selector: string;
  readonly entry: ReflogEntry;
}

export type ReflogResult =
  | {
      readonly kind: 'show';
      readonly ref: RefName;
      readonly entries: ReadonlyArray<ReflogShowEntry>;
    }
  | { readonly kind: 'exists'; readonly exists: boolean }
  | { readonly kind: 'expire'; readonly removed: number; readonly kept: number }
  | {
      readonly kind: 'delete';
      /**
       * Absent when `index` named no entry — git's own silent no-op for an
       * out-of-range `reflog delete`. The reflog is rewritten either way.
       */
      readonly removed?: ReflogEntry;
    };

// git ≥ 2.50's binary `REFLOG_EXPIRE_OPTIONS_INIT` — a documented 90/30 that
// the actual defaults have swapped: total is the SHORT cutoff, unreachable
// the long one. Under these plain defaults `expireKindFor`'s reachability
// walk never runs (`unreachableCut <= expireCut` is always true), so a
// default expire is a flat 30-day cutoff for every entry regardless of
// reachability.
const DEFAULT_EXPIRE = '30.days.ago';
const DEFAULT_EXPIRE_UNREACHABLE = '90.days.ago';

/**
 * Validate a user-supplied ref before it indexes the filesystem. `validateRefName`
 * accepts the `HEAD` pseudo-ref verbatim, so no special-casing is needed — every
 * name, `HEAD` included, goes through the same containment-checking validator.
 */
const resolveUserRef = (ref: string): RefName => validateRefName(ref);

export const reflog = async (ctx: Context, opts: ReflogAction = {}): Promise<ReflogResult> => {
  await assertOperationalRepository(ctx);
  if (opts.action === 'exists') return runExists(ctx, opts.ref);
  if (opts.action === 'expire') return runExpire(ctx, opts);
  // `exists` and `expire` reach the repo-settings class on their own terms
  // (`exists` never — file presence alone; `expire` only once its target
  // resolves, and never with zero targets) — the other two verbs check it
  // unconditionally, before doing anything else.
  await assertRepoSettingsValid(ctx);
  if (opts.action === 'delete') return runDelete(ctx, opts);
  return runShow(ctx, opts.ref ?? 'HEAD');
};

/** One reflog `show` reads from: the entries, and the name they are labelled with. */
interface ShowSource {
  readonly ref: RefName;
  readonly entries: ReadonlyArray<ReflogEntry>;
}

/** The log of the ref the argument resolves to, when the chain ends on
 *  another name — git's read follows a symbolic ref even though
 *  {@link hasReflog} (and so `exists`) never does. */
const entriesViaTarget = async (
  ctx: Context,
  arg: RefName,
): Promise<ReadonlyArray<ReflogEntry>> => {
  const terminal = await resolveTerminalName(ctx, arg);
  if (terminal === undefined || terminal === arg) return [];
  return readReflogLenient(ctx, terminal);
};

/** git's two closing literal prefixes for a short argument, in its order.
 *  `arg` already passed the ref-name grammar, and prefixing a valid name with
 *  a valid component cannot break it, so neither candidate needs re-checking. */
const entriesUnderPrefixes = async (
  ctx: Context,
  arg: RefName,
): Promise<ReadonlyArray<ReflogEntry>> => {
  for (const name of [`refs/${arg}` as RefName, `${HEADS_PREFIX}${arg}` as RefName]) {
    const entries = await readReflogLenient(ctx, name);
    if (entries.length > 0) return entries;
  }
  return [];
};

/** `repo_dwim_log`'s answer — the only source that relabels, to the name it
 *  found the log under. None found leaves the argument labelling no entries. */
const entriesViaCandidates = async (ctx: Context, arg: RefName): Promise<ShowSource> => {
  const found = await findReflogCandidate(ctx, arg);
  if (found === undefined) return { ref: arg, entries: [] };
  return { ref: found, entries: await readReflogLenient(ctx, found) };
};

/**
 * git's `read_complete_reflog`: the argument's own log, then the log of the
 * ref it resolves to, then the logs at `refs/<arg>` and `refs/heads/<arg>` —
 * every one of them labelled with the argument as typed. Only when all four
 * come back empty does {@link entriesViaCandidates} run and relabel.
 */
const showSourceFor = async (ctx: Context, arg: RefName): Promise<ShowSource> => {
  const own = await readReflogLenient(ctx, arg);
  if (own.length > 0) return { ref: arg, entries: own };
  const viaTarget = await entriesViaTarget(ctx, arg);
  if (viaTarget.length > 0) return { ref: arg, entries: viaTarget };
  const viaPrefixes = await entriesUnderPrefixes(ctx, arg);
  if (viaPrefixes.length > 0) return { ref: arg, entries: viaPrefixes };
  return entriesViaCandidates(ctx, arg);
};

/**
 * git parses `show`'s argument as a revision before it walks any log, so the
 * refusal is the revision machinery's, not the reflog's: a name nothing
 * resolves refuses even when a log file survives under it, while a name that
 * resolves but carries no log simply reports nothing.
 */
const assertRevisionResolves = async (ctx: Context, name: string): Promise<void> => {
  if ((await resolveRevisionName(ctx, name)) === undefined) throw revparseUnresolved(name);
};

const runShow = async (ctx: Context, refName: string): Promise<ReflogResult> => {
  await assertRevisionResolves(ctx, refName);
  const { ref, entries: stored } = await showSourceFor(ctx, resolveUserRef(refName));
  const lastIndex = stored.length - 1;
  // Build newest-first directly: output position `index` (0 = newest) reads the
  // entry at file position `lastIndex - index` — no array mutation.
  const entries = stored.map((_, index) => ({
    index,
    selector: `${ref}@{${index}}`,
    entry: stored[lastIndex - index] as ReflogEntry,
  }));
  return { kind: 'show', ref, entries };
};

/**
 * Whether `ref` has a reflog at all — a file-presence question independent of
 * entry count (an emptied-but-present log still counts, matching real git).
 * Routed through the backend-neutral `RefStore.hasReflog` seam verb — one
 * probe scoped to `ref` itself, never `listReflogs`'s whole-`logs/**` walk
 * just to check membership.
 */
const hasReflog = async (ctx: Context, ref: RefName): Promise<boolean> =>
  getRefStore(ctx).hasReflog(ref);

const runExists = async (ctx: Context, refName: string): Promise<ReflogResult> => {
  return { kind: 'exists', exists: await hasReflog(ctx, resolveUserRef(refName)) };
};

/**
 * The file-order position `index` names, counting newest-first — or undefined
 * when it names no entry at all. git's own out-of-range delete is a silent
 * no-op, so this is a selection, not a refusal. Three independent ways to
 * miss: a non-integer index, a negative one, and one past the oldest entry.
 */
const selectTarget = (length: number, index: number): number | undefined => {
  if (!Number.isInteger(index) || index < 0) return undefined;
  const position = length - 1 - index;
  return position < 0 ? undefined : position;
};

const runDelete = async (
  ctx: Context,
  opts: { readonly ref: string; readonly index: number; readonly rewrite?: boolean },
): Promise<ReflogResult> => {
  // git's `reflog_delete` resolves its argument through `repo_dwim_log`, the
  // same walk `expire` uses — so a symbolic ref rewrites its TARGET's log.
  const ref = await dwimReflog(ctx, opts.ref);
  const stored = await readReflogLenient(ctx, ref);
  const target = selectTarget(stored.length, opts.index);
  const survivors =
    target === undefined ? stored : repairChain(stored, target, opts.rewrite === true);
  await getRefStore(ctx).applyRefUpdates([
    { kind: 'reflogReplace', name: ref, entries: survivors },
  ]);
  if (target === undefined) return { kind: 'delete' };
  return { kind: 'delete', removed: stored[target] as ReflogEntry };
};

/**
 * Drop the entry at file-order `target`. With `rewrite`, the entry that
 * followed it inherits the dropped entry's `oldId`, repairing the old→new chain.
 */
const repairChain = (
  entries: ReadonlyArray<ReflogEntry>,
  target: number,
  rewrite: boolean,
): ReadonlyArray<ReflogEntry> => {
  const removed = entries[target] as ReflogEntry;
  const following = entries[target + 1];
  return entries
    .filter((_, position) => position !== target)
    .map((entry) => (rewrite && entry === following ? { ...entry, oldId: removed.oldId } : entry));
};

type ExpireOptions = Extract<ReflogAction, { readonly action: 'expire' }>;

/** The result of sweeping every target: per-ref counts summed. Each target's
 *  rewrite is already on disk by the time this is returned. */
interface ExpireOutcome {
  readonly removed: number;
  readonly kept: number;
}

/** The `--expire`/`--expire-unreachable` flags, parsed — `resolveCutoff`
 *  refuses `REVPARSE_UNRESOLVED` on a bad flag, a residual divergence from
 *  git's own `fatal: invalid timestamp` for this one path. Only a flag
 *  actually given is parsed, so an absent flag never shadows a matching
 *  pattern's own cutoff (see `expiryPolicyFor`). */
const explicitCuts = (opts: ExpireOptions, now: number): ExplicitExpiryCuts => ({
  ...(opts.expire !== undefined ? { total: resolveCutoff(opts.expire, now) } : {}),
  ...(opts.expireUnreachable !== undefined
    ? { unreachable: resolveCutoff(opts.expireUnreachable, now) }
    : {}),
});

const defaultCuts = (now: number): ExpiryCuts => ({
  expireCut: resolveCutoff(DEFAULT_EXPIRE, now),
  unreachableCut: resolveCutoff(DEFAULT_EXPIRE_UNREACHABLE, now),
});

/** git's configuration-then-options sequence: every `gc.reflogExpire*`
 *  entry is parsed — and the first invalid one refused — before either
 *  flag is even looked at, and before the target or the repo-settings
 *  class are reached. */
const resolveExpiryPolicy = async (
  ctx: Context,
  now: number,
  opts: ExpireOptions,
): Promise<ReflogExpiryPolicy> => {
  const config = parseReflogExpiryEntries(await readReflogExpiryConfig(ctx), (raw) =>
    resolveExpiryCutoff(raw, now),
  );
  return expiryPolicyFor(config, explicitCuts(opts, now), defaultCuts(now));
};

/**
 * Strictly sequential: each target's reachability state is built inside
 * `expireReflog`, never shared, so one target's walk never leaks into
 * another's — and each target's rewrite is committed as the sweep reaches
 * it, never batched behind the last one. git rewrites a log the moment that
 * log is swept, on both backends (the files backend replaces the file; the
 * reftable backend appends a table of its own), so a refusal part-way
 * through leaves every earlier target already rewritten on disk. The cost is
 * one transaction per target rather than one per run — on reftable a full
 * stack transaction plus a compaction attempt each time, measured 3.6-5x on
 * a 200-800 ref sweep — paid to keep the on-disk state faithful.
 */
const expireTargets = async (
  ctx: Context,
  targets: ReadonlyArray<RefName>,
  policy: ReflogExpiryPolicy,
): Promise<ExpireOutcome> => {
  let removed = 0;
  let kept = 0;
  for (const ref of targets) {
    const { expireCut, unreachableCut } = policy.cutoffsFor(ref);
    const outcome = await expireReflog(ctx, ref, expireCut, unreachableCut);
    removed += outcome.removed;
    kept += outcome.kept;
    await getRefStore(ctx).applyRefUpdates([outcome.update]);
  }
  return { removed, kept };
};

const runExpire = async (ctx: Context, opts: ExpireOptions): Promise<ReflogResult> => {
  const policy = await resolveExpiryPolicy(ctx, Math.floor(Date.now() / 1000), opts);
  const targets = await resolveExpireTargets(ctx, opts);
  // A named target re-reads the whole configuration before its sweep starts,
  // so the repo-settings class refuses there whatever the cutoffs are — and
  // never with zero targets. A swept target (`--all`) reaches the class only
  // where it would read an object, inside `expireKindFor`.
  if (opts.all !== true && targets.length > 0) await assertRepoSettingsValid(ctx);
  const outcome = await expireTargets(ctx, targets, policy);
  return { kind: 'expire', removed: outcome.removed, kept: outcome.kept };
};

/**
 * Resolves `expire`'s target ref set: under `--all`, every ref that
 * currently carries a reflog; with neither a ref nor `--all`, nothing (git
 * does not default the target to `HEAD`); otherwise the single ref DWIM
 * selects via {@link dwimReflog}.
 */
const resolveExpireTargets = async (
  ctx: Context,
  opts: ExpireOptions,
): Promise<ReadonlyArray<RefName>> => {
  if (opts.all === true) return listReflogs(ctx);
  if (opts.ref === undefined) return [];
  return [await dwimReflog(ctx, opts.ref)];
};

/**
 * git's `repo_dwim_log`: the first `refCandidates` entry that both resolves
 * for reading AND carries a log — its own, else (for a symref) its target's
 * — wins, or `undefined` when no candidate does.
 */
const findReflogCandidate = async (ctx: Context, arg: string): Promise<RefName | undefined> => {
  for (const candidate of refCandidates(arg)) {
    const found = await logForCandidate(ctx, candidate);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** {@link findReflogCandidate} for the verbs that need a target: none found
 *  refuses `REFLOG_NOT_FOUND` with the argument as typed. */
const dwimReflog = async (ctx: Context, arg: string): Promise<RefName> => {
  const found = await findReflogCandidate(ctx, arg);
  if (found === undefined) throw reflogNotFound(arg as RefName);
  return found;
};

const logForCandidate = async (
  ctx: Context,
  candidate: RefName | 'HEAD',
): Promise<RefName | undefined> => {
  if (!isSafeRefName(candidate)) return undefined; // no I/O for an invalid name
  const terminal = await resolveTerminalName(ctx, candidate);
  if (terminal === undefined) return undefined;
  if (await hasReflog(ctx, candidate as RefName)) return candidate as RefName;
  return terminal !== candidate && (await hasReflog(ctx, terminal)) ? terminal : undefined;
};

/**
 * One ref's expiry: computes its reachability kind, filters the stored
 * reflog for survivors, and returns the counts plus the rewrite update for
 * the caller to batch into the single `applyRefUpdates` transaction.
 */
const expireReflog = async (
  ctx: Context,
  ref: RefName,
  expireCut: number,
  unreachableCut: number,
): Promise<{ readonly removed: number; readonly kept: number; readonly update: RefUpdate }> => {
  // Reachability is per-ref: `HEAD` marks from every tip, another ref marks
  // from its own tip alone, and a ref that does not resolve to a commit (or
  // a cutoff pair that can never change the verdict) skips the walk
  // entirely — computed fresh per target, never shared across refs.
  const kind = await expireKindFor(ctx, ref, expireCut, unreachableCut);
  const state = kind.kind === 'walk' ? createReachability(kind.tips) : undefined;
  const stored = await readReflogLenient(ctx, ref);
  const survivors: ReflogEntry[] = [];
  for (const entry of stored) {
    if (!(await shouldExpire(ctx, entry, kind, state, expireCut, unreachableCut))) {
      survivors.push(entry);
    }
  }
  return {
    removed: stored.length - survivors.length,
    kept: survivors.length,
    // Unconditional: git rewrites the reflog on every `expire` run, even when
    // nothing is pruned — the only way a malformed line (which a lenient read
    // silently drops, leaving parsed counts equal) still gets purged from disk.
    update: { kind: 'reflogReplace', name: ref, entries: survivors },
  };
};

const resolveCutoff = (raw: string, now: number): number => {
  // One shared grammar with gc.pruneExpire (git's parse_expiry_date):
  // never (case-tolerant) and exact false → nothing expires; exact
  // all/now → everything, future-dated entries included; anything else —
  // uppercase ALL/FALSE among it — goes to the date parser or refuses.
  const cutoff = resolveExpiryCutoff(raw, now);
  if (cutoff === undefined) throw revparseUnresolved(raw);
  return cutoff;
};

/** Whether `ref`'s log marks from every current tip (`HEAD`), from its own
 *  tip alone, or expires by clock only — no reachability walk at all — because
 *  it does not resolve to a commit, or because the unreachable cutoff can
 *  never move the verdict past what the total cutoff already decides. */
type ExpireKind =
  | { readonly kind: 'always' }
  | { readonly kind: 'walk'; readonly tips: ReadonlyArray<ObjectId> };

/** A named target's kind. git resolves its tip commit BEFORE the cutoff pair
 *  can shortcut the walk, so this target reads objects — and so reaches the
 *  repo-settings class — whatever the cutoffs are. */
const namedTargetKind = async (
  ctx: Context,
  ref: RefName,
  expireCut: number,
  unreachableCut: number,
): Promise<ExpireKind> => {
  await assertRepoSettingsValid(ctx);
  if (unreachableCut <= expireCut) return { kind: 'always' };
  const direct = await getRefStore(ctx).resolveDirect(ref);
  if (direct.kind !== 'direct') return { kind: 'always' };
  // git's `lookup_commit_reference_gently`: a tip naming a missing object
  // never blocks expiry, it just never resolves to a commit — `always`.
  const peeled = await peelGently(ctx, direct.id);
  return peeled === undefined ? { kind: 'always' } : { kind: 'walk', tips: [peeled.commit.id] };
};

const expireKindFor = async (
  ctx: Context,
  ref: RefName,
  expireCut: number,
  unreachableCut: number,
): Promise<ExpireKind> => {
  if (ref !== 'HEAD') return namedTargetKind(ctx, ref, expireCut, unreachableCut);
  // `HEAD` reads no tip of its own: it marks from every ref, and only when
  // the unreachable cutoff can still move a verdict. Under a cutoff pair
  // that cannot, `HEAD`'s sweep reads nothing and never reaches the class.
  if (unreachableCut <= expireCut) return { kind: 'always' };
  await assertRepoSettingsValid(ctx);
  return { kind: 'walk', tips: await resolveTips(ctx) };
};

/** Mark-and-sweep state for one ref's walk: `marked` commits are confirmed
 *  reachable; `failed` holds ids a gentle parse could not resolve, so a
 *  second parent link naming one does not re-read it (never `marked` — a
 *  parse failure proves nothing about reachability); `frontier` holds ids
 *  reached but not yet popped; `leftover` holds marked commits whose
 *  expansion the total-cutoff bound skipped, kept so the bound can be
 *  dropped and retried on a miss — git's `mark_reachable`/`unreachable()`
 *  pair, where the date bound is laziness only, never a permanent verdict.
 *  Mutable by design — the walk is driven incrementally, one query at a
 *  time, and shared across every entry of the same ref. */
interface ReachabilityState {
  readonly marked: Set<ObjectId>;
  readonly failed: Set<ObjectId>;
  readonly frontier: ObjectId[];
  readonly leftover: ObjectId[];
  head: number;
  boundActive: boolean;
}

const createReachability = (tips: ReadonlyArray<ObjectId>): ReachabilityState => ({
  marked: new Set(),
  failed: new Set(),
  frontier: [...tips],
  leftover: [],
  head: 0,
  boundActive: true,
});

/** git's gentle `repo_parse_commit`: a missing ancestor is skipped rather
 *  than aborting the walk. Left unmarked — a parse failure proves nothing
 *  about reachability, so it must never answer a later `isMarked` check. */
const readAncestorMeta = async (ctx: Context, id: ObjectId): Promise<CommitMeta | undefined> => {
  try {
    return await readCommitMeta(ctx, id);
  } catch (err) {
    if (isObjectNotFound(err)) return undefined;
    throw err;
  }
};

/**
 * Pop the next unexpanded frontier commit and mark it reachable; only while
 * the bound is inactive, or the commit is at or above the total cutoff, are
 * its parents themselves enqueued. A commit the bound skips is recorded in
 * `leftover` — reached, but not yet proven to reach further.
 */
const expandFrontier = async (
  ctx: Context,
  state: ReachabilityState,
  expireCut: number,
): Promise<boolean> => {
  if (state.head >= state.frontier.length) return false;
  const id = state.frontier[state.head] as ObjectId;
  state.head += 1;
  if (state.marked.has(id) || state.failed.has(id)) return true;
  const meta = await readAncestorMeta(ctx, id);
  if (meta === undefined) {
    state.failed.add(id);
    return true;
  }
  state.marked.add(id);
  if (state.boundActive && meta.committerDate < expireCut) {
    state.leftover.push(id);
    return true;
  }
  for (const parent of meta.parents) {
    if (!state.marked.has(parent)) state.frontier.push(parent);
  }
  return true;
};

/**
 * Once the bounded frontier is exhausted, a non-empty `leftover` means the
 * date bound only stopped the walk early — git's `unreachable()` miss
 * handler drops the bound (`mark_limit = 0`) and resumes expansion from
 * those commits down to the root. An already-dropped bound, or an empty
 * leftover, means the walk is genuinely exhausted.
 */
const dropBoundAndRetry = (state: ReachabilityState): boolean => {
  // Stryker disable next-line LogicalOperator: equivalent — && only differs while the bound is active with an empty leftover, and this runs solely on an exhausted frontier, so the re-queue loop adds nothing and the very next call returns false through the same arm.
  if (!state.boundActive || state.leftover.length === 0) return false;
  state.boundActive = false;
  // Loop form, not `frontier.push(...leftover)` — same reason `ref-store.ts`
  // spells out for its own ref-name accumulation: V8 caps spread-call
  // argument counts (~10^5), and `leftover` holds one entry per aged commit
  // reached from every tip the repository has, which a mirror's unpacked
  // `refs/pull/*` space alone can push past that cap.
  for (const id of state.leftover) {
    state.marked.delete(id);
    state.frontier.push(id);
  }
  state.leftover.length = 0;
  return true;
};

/** Whether `id` is reachable, extending the walk from the frontier before
 *  answering — as many steps as it takes to find it, dropping the
 *  total-cutoff bound once and retrying from the leftover commits if the
 *  first, bounded pass misses. */
const isMarked = async (
  ctx: Context,
  state: ReachabilityState,
  expireCut: number,
  id: ObjectId,
): Promise<boolean> => {
  while (!state.marked.has(id)) {
    const expanded = await expandFrontier(ctx, state, expireCut);
    if (!expanded && !dropBoundAndRetry(state)) return false;
  }
  return true;
};

/** git's `lookup_commit_reference_gently`: a name that resolves to nothing at
 *  all — pruned, or never written — returns NULL rather than aborting. */
const peelGently = async (ctx: Context, oid: ObjectId): Promise<PeeledRef | undefined> => {
  try {
    return await peelRefToCommit(ctx, oid);
  } catch (err) {
    if (isObjectNotFound(err)) return undefined;
    throw err;
  }
};

/** A null object id, one that never resolved, or one that does not peel to a
 *  commit is never unreachable — it is kept, exactly as git's own gentle
 *  lookup treats it. Marks are consulted first: a marked id is already a
 *  confirmed-reachable commit by construction (marks come from
 *  `readCommitMeta` parents), so only a miss pays for the peel. */
const isUnreachable = async (
  ctx: Context,
  state: ReachabilityState,
  expireCut: number,
  oid: ObjectId,
): Promise<boolean> => {
  if (oid === zeroOid(ctx.hashConfig)) return false;
  if (state.marked.has(oid)) return false;
  const peeled = await peelGently(ctx, oid);
  if (peeled === undefined) return false;
  return !(await isMarked(ctx, state, expireCut, peeled.commit.id));
};

/**
 * git's `should_expire_reflog_ent`: below the total cutoff, expire
 * unconditionally; at or above the unreachable cutoff, always keep;
 * otherwise expire when the ref's log expires by clock alone, or when
 * either the old or the new object id is unreachable — checked in that
 * order, so an unreachable old id alone is enough.
 */
const shouldExpire = async (
  ctx: Context,
  entry: ReflogEntry,
  kind: ExpireKind,
  state: ReachabilityState | undefined,
  expireCut: number,
  unreachableCut: number,
): Promise<boolean> => {
  if (entry.identity.timestamp < expireCut) return true;
  if (entry.identity.timestamp >= unreachableCut) return false;
  if (kind.kind === 'always' || state === undefined) return true;
  if (await isUnreachable(ctx, state, expireCut, entry.oldId)) return true;
  return isUnreachable(ctx, state, expireCut, entry.newId);
};

const resolveTips = async (ctx: Context): Promise<ReadonlyArray<ObjectId>> => {
  // Pooled through the `ioBound` bucket — each ref's resolution is an
  // independent read; the dedup moves to a `Set` built over the results
  // instead of accumulating into one while iterating serially. Survives only
  // for `HEAD`'s every-tip mark list — a single named ref peels its own tip
  // directly (`expireKindFor`). git seeds this list via `refs_for_each_ref`
  // — refs under `refs/` only — so the `HEAD` pseudo-ref `enumerateRefs`
  // also reports is never a tip in its own right, detached or not.
  const refs = await enumerateRefs(ctx);
  const tipRefs = refs.filter((ref) => ref !== 'HEAD');
  const resolved = await boundedMapFor(ctx, 'ioBound', tipRefs, (ref) => tryResolve(ctx, ref));
  const ids = resolved.filter((id): id is ObjectId => id !== undefined);
  return [...new Set(ids)];
};

const tryResolve = async (ctx: Context, ref: RefName): Promise<ObjectId | undefined> => {
  try {
    const id = await resolveRef(ctx, ref);
    const peeled = await peelRefToCommit(ctx, id);
    return peeled?.commit.id;
  } catch (err) {
    if (err instanceof TsgitError) return undefined;
    throw err;
  }
};
