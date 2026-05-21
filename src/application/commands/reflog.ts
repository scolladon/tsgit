/**
 * Tier-1 `reflog` command — inspect and manage `.git/logs/` reflog files.
 * One command, discriminated `action` (default `show`), mirroring `branch` /
 * `tag`. Writers are gated by `core.logAllRefUpdates`; this command is not —
 * it manages logs that already exist.
 */
import { revparseUnresolved } from '../../domain/commands/error.js';
import { TsgitError } from '../../domain/error.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { parseApproxidate } from '../../domain/reflog/approxidate.js';
import { reflogEntryOutOfRange, reflogNotFound } from '../../domain/reflog/error.js';
import type { ReflogEntry } from '../../domain/reflog/reflog-entry.js';
import { validateRefName } from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { enumerateRefs } from '../primitives/enumerate-refs.js';
import { listReflogs, readReflog, reflogExists, writeReflog } from '../primitives/reflog-store.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { walkCommits } from '../primitives/walk-commits.js';
import { assertRepository } from './internal/repo-state.js';

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
  | { readonly kind: 'delete'; readonly removed: ReflogEntry };

const DEFAULT_EXPIRE = '90.days.ago';
const DEFAULT_EXPIRE_UNREACHABLE = '30.days.ago';

/**
 * Validate a user-supplied ref before it indexes the filesystem. `validateRefName`
 * accepts the `HEAD` pseudo-ref verbatim, so no special-casing is needed — every
 * name, `HEAD` included, goes through the same containment-checking validator.
 */
const resolveUserRef = (ref: string): RefName => validateRefName(ref);

export const reflog = async (ctx: Context, opts: ReflogAction = {}): Promise<ReflogResult> => {
  await assertRepository(ctx);
  if (opts.action === 'exists') return runExists(ctx, opts.ref);
  if (opts.action === 'delete') return runDelete(ctx, opts);
  if (opts.action === 'expire') return runExpire(ctx, opts);
  return runShow(ctx, opts.ref ?? 'HEAD');
};

const runShow = async (ctx: Context, refName: string): Promise<ReflogResult> => {
  const ref = resolveUserRef(refName);
  const stored = await readReflog(ctx, ref);
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

const runExists = async (ctx: Context, refName: string): Promise<ReflogResult> => {
  return { kind: 'exists', exists: await reflogExists(ctx, resolveUserRef(refName)) };
};

const runDelete = async (
  ctx: Context,
  opts: { readonly ref: string; readonly index: number; readonly rewrite?: boolean },
): Promise<ReflogResult> => {
  const ref = resolveUserRef(opts.ref);
  if (!(await reflogExists(ctx, ref))) throw reflogNotFound(ref);
  const stored = await readReflog(ctx, ref);
  // A non-integer or negative index would bypass the range guard below
  // (`stored[NaN]` is `undefined`, silently returned as an entry).
  if (!Number.isInteger(opts.index) || opts.index < 0) {
    throw reflogEntryOutOfRange(ref, opts.index, stored.length);
  }
  // With `index` a non-negative integer, `target` cannot exceed `length - 1`;
  // only the lower bound (index past the oldest entry) remains reachable.
  const target = stored.length - 1 - opts.index;
  if (target < 0) {
    throw reflogEntryOutOfRange(ref, opts.index, stored.length);
  }
  const removed = stored[target] as ReflogEntry;
  const survivors = repairChain(stored, target, opts.rewrite === true);
  await writeReflog(ctx, ref, survivors);
  return { kind: 'delete', removed };
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
  const targets = opts.all === true ? await listReflogs(ctx) : [resolveUserRef(opts.ref ?? 'HEAD')];
  let removed = 0;
  let kept = 0;
  for (const ref of targets) {
    const stored = await readReflog(ctx, ref);
    const survivors = stored.filter((entry) =>
      keepEntry(entry, reachable, expireCut, unreachableCut),
    );
    removed += stored.length - survivors.length;
    kept += survivors.length;
    if (survivors.length !== stored.length) await writeReflog(ctx, ref, survivors);
  }
  return { kind: 'expire', removed, kept };
};

const resolveCutoff = (raw: string, now: number): number => {
  const cutoff = parseApproxidate(raw, now);
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
