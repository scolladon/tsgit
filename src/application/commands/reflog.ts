/**
 * Tier-1 `reflog` command — inspect and manage `.git/logs/` reflog files.
 * One command, discriminated `action` (default `show`), mirroring `branch` /
 * `tag`. Writers are gated by `core.logAllRefUpdates`; this command is not —
 * it manages logs that already exist.
 */
import { revparseUnresolved } from '../../domain/commands/error.js';
import { TsgitError } from '../../domain/error.js';
import { type ObjectId, type RefName, zeroOid } from '../../domain/objects/index.js';
import { reflogNotFound } from '../../domain/reflog/error.js';
import type { ReflogEntry } from '../../domain/reflog/reflog-entry.js';
import { validateRefName } from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { enumerateRefs } from '../primitives/enumerate-refs.js';
import { resolveExpiryCutoff } from '../primitives/expiry-cutoff.js';
import { boundedMapFor } from '../primitives/internal/concurrency.js';
import { type PeeledRef, peelRefToCommit } from '../primitives/internal/peel-ref-to-commit.js';
import { type CommitMeta, readCommitMeta } from '../primitives/internal/read-commit-meta.js';
import { assertRepoSettingsValid } from '../primitives/internal/repo-settings-gate.js';
import { getRefStore, type RefUpdate } from '../primitives/ref-store.js';
import { listReflogs, readReflogLenient } from '../primitives/reflog-store.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { assertOperationalRepository } from './internal/repo-state.js';

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

const DEFAULT_EXPIRE = '90.days.ago';
const DEFAULT_EXPIRE_UNREACHABLE = '30.days.ago';

/**
 * Validate a user-supplied ref before it indexes the filesystem. `validateRefName`
 * accepts the `HEAD` pseudo-ref verbatim, so no special-casing is needed — every
 * name, `HEAD` included, goes through the same containment-checking validator.
 */
const resolveUserRef = (ref: string): RefName => validateRefName(ref);

export const reflog = async (ctx: Context, opts: ReflogAction = {}): Promise<ReflogResult> => {
  await assertOperationalRepository(ctx);
  if (opts.action === 'exists') return runExists(ctx, opts.ref);
  // `reflog exists` runs on a malformed repo-settings class — git resolves it
  // by file presence alone, no store/graph touch — so the class is checked
  // only for the three verbs that actually parse a commit.
  await assertRepoSettingsValid(ctx);
  if (opts.action === 'delete') return runDelete(ctx, opts);
  if (opts.action === 'expire') return runExpire(ctx, opts);
  return runShow(ctx, opts.ref ?? 'HEAD');
};

const runShow = async (ctx: Context, refName: string): Promise<ReflogResult> => {
  const ref = resolveUserRef(refName);
  const stored = await readReflogLenient(ctx, ref);
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
  const ref = resolveUserRef(opts.ref);
  if (!(await hasReflog(ctx, ref))) throw reflogNotFound(ref);
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

const runExpire = async (
  ctx: Context,
  opts: {
    readonly ref?: string;
    readonly all?: boolean;
    readonly expire?: string;
    readonly expireUnreachable?: string;
  },
): Promise<ReflogResult> => {
  const now = Math.floor(Date.now() / 1000);
  const expireCut = resolveCutoff(opts.expire ?? DEFAULT_EXPIRE, now);
  const unreachableCut = resolveCutoff(opts.expireUnreachable ?? DEFAULT_EXPIRE_UNREACHABLE, now);
  const single = opts.all === true ? undefined : resolveUserRef(opts.ref ?? 'HEAD');
  if (single !== undefined && !(await hasReflog(ctx, single))) {
    // git refuses a single-ref expire when no reflog exists (exit 255) and
    // creates nothing; without this guard the unconditional rewrite below
    // would manufacture an empty log file and its parent directories.
    throw reflogNotFound(single);
  }
  const targets = single === undefined ? await listReflogs(ctx) : [single];
  let removed = 0;
  let kept = 0;
  const updates: RefUpdate[] = [];
  for (const ref of targets) {
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
    removed += stored.length - survivors.length;
    kept += survivors.length;
    // Unconditional: git rewrites the reflog on every `expire` run, even when
    // nothing is pruned — the only way a malformed line (which a lenient read
    // silently drops, leaving parsed counts equal) still gets purged from disk.
    updates.push({ kind: 'reflogReplace', name: ref, entries: survivors });
  }
  // One transaction for every target: on the reftable backend each
  // applyRefUpdates call is a full stack transaction plus a compaction
  // attempt, so a per-ref loop makes `expire --all` cost grow faster than linearly in ref count
  // (measured 3.6-5x at 200-800 refs) and leaves a partial rewrite behind if
  // one ref fails mid-loop. An empty list is a no-op on both backends, so
  // zero targets need no guard.
  await getRefStore(ctx).applyRefUpdates(updates);
  return { kind: 'expire', removed, kept };
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

const expireKindFor = async (
  ctx: Context,
  ref: RefName,
  expireCut: number,
  unreachableCut: number,
): Promise<ExpireKind> => {
  if (unreachableCut <= expireCut) return { kind: 'always' };
  if (ref === 'HEAD') return { kind: 'walk', tips: await resolveTips(ctx) };
  const direct = await getRefStore(ctx).resolveDirect(ref);
  if (direct.kind !== 'direct') return { kind: 'always' };
  const peeled = await peelRefToCommit(ctx, direct.id);
  return peeled === undefined ? { kind: 'always' } : { kind: 'walk', tips: [peeled.commit.id] };
};

/** Mark-and-sweep state for one ref's walk: `marked` commits are confirmed
 *  reachable; `frontier` holds ids reached but not yet popped; `leftover`
 *  holds marked commits whose expansion the total-cutoff bound skipped, kept
 *  so the bound can be dropped and retried on a miss — git's
 *  `mark_reachable`/`unreachable()` pair, where the date bound is laziness
 *  only, never a permanent verdict. Mutable by design — the walk is driven
 *  incrementally, one query at a time, and shared across every entry of the
 *  same ref. */
interface ReachabilityState {
  readonly marked: Set<ObjectId>;
  readonly frontier: ObjectId[];
  readonly leftover: ObjectId[];
  head: number;
  boundActive: boolean;
}

const createReachability = (tips: ReadonlyArray<ObjectId>): ReachabilityState => ({
  marked: new Set(),
  frontier: [...tips],
  leftover: [],
  head: 0,
  boundActive: true,
});

const isObjectNotFound = (err: unknown): boolean =>
  err instanceof TsgitError && err.data.code === 'OBJECT_NOT_FOUND';

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
  if (state.marked.has(id)) return true;
  const meta = await readAncestorMeta(ctx, id);
  if (meta === undefined) return true;
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
  if (!state.boundActive || state.leftover.length === 0) return false;
  state.boundActive = false;
  for (const id of state.leftover) state.marked.delete(id);
  state.frontier.push(...state.leftover);
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
