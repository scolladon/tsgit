/**
 * Tier-1 `reflog` command — inspect and manage `.git/logs/` reflog files.
 * One command, discriminated `action` (default `show`), mirroring `branch` /
 * `tag`. Writers are gated by `core.logAllRefUpdates`; this command is not —
 * it manages logs that already exist.
 */
import { revparseUnresolved } from '../../domain/commands/error.js';
import { TsgitError } from '../../domain/error.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { reflogNotFound } from '../../domain/reflog/error.js';
import type { ReflogEntry } from '../../domain/reflog/reflog-entry.js';
import { validateRefName } from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { enumerateRefs } from '../primitives/enumerate-refs.js';
import { resolveExpiryCutoff } from '../primitives/expiry-cutoff.js';
import { getRefStore, type RefUpdate } from '../primitives/ref-store.js';
import { listReflogs, readReflogLenient } from '../primitives/reflog-store.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { walkCommits } from '../primitives/walk-commits.js';
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
  const reachable = await collectReachable(ctx);
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
    const stored = await readReflogLenient(ctx, ref);
    const survivors = stored.filter((entry) =>
      keepEntry(entry, reachable, expireCut, unreachableCut),
    );
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

/** An entry survives on the reachable clock when its tip is reachable, else the shorter clock. */
const keepEntry = (
  entry: ReflogEntry,
  reachable: ReadonlySet<string>,
  expireCut: number,
  unreachableCut: number,
): boolean => {
  const cutoff = reachable.has(entry.newId) ? expireCut : unreachableCut;
  return entry.identity.timestamp >= cutoff;
};

/** Every commit reachable from any current ref tip. */
const collectReachable = async (ctx: Context): Promise<ReadonlySet<string>> => {
  const tips = await resolveTips(ctx);
  const reachable = new Set<string>();
  if (tips.length === 0) return reachable;
  for await (const commit of walkCommits(ctx, { from: tips, ignoreMissing: true })) {
    reachable.add(commit.id);
  }
  return reachable;
};

const resolveTips = async (ctx: Context): Promise<ReadonlyArray<ObjectId>> => {
  const tips = new Set<ObjectId>();
  for (const ref of await enumerateRefs(ctx)) {
    const id = await tryResolve(ctx, ref);
    if (id !== undefined) tips.add(id);
  }
  return [...tips];
};

const tryResolve = async (ctx: Context, ref: RefName): Promise<ObjectId | undefined> => {
  try {
    return await resolveRef(ctx, ref);
  } catch (err) {
    if (err instanceof TsgitError) return undefined;
    throw err;
  }
};
