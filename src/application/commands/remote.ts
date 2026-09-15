/**
 * `remote` porcelain — CRUD over `[remote "<name>"]` blocks in `.git/config`
 * plus the tracking refs they own, exposed as the `repo.remote.*`
 * nested namespace (`list` / `add` / `remove` / `rename` / `setUrl` / `show`).
 * Each verb is a Context-aware function; the namespace binder lives in
 * `internal/remote-namespace.ts`.
 *
 * Design: `docs/design/phase-20-8-crud-porcelain-nested-namespace.md`.
 */
import { invalidOption, remoteExists, remoteNotConfigured } from '../../domain/commands/error.js';
import type { TsgitError } from '../../domain/error.js';
import { type ObjectId, type RefName, zeroOid } from '../../domain/objects/object-id.js';
import { refUpdateConflict } from '../../domain/refs/error.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from '../primitives/config-read.js';
import { enumerateRefs } from '../primitives/enumerate-refs.js';
import { transactionLogging } from '../primitives/internal/ref-transaction-logging.js';
import { resolveWriteChain } from '../primitives/internal/ref-write-chain.js';
import { assertAcceptedRepository } from '../primitives/internal/repo-state.js';
import { getRefStore, type RefUpdate } from '../primitives/ref-store.js';
import { type ConfigOperation, updateConfigOperations } from '../primitives/update-config.js';
import { deleteRefs } from '../primitives/update-ref.js';
import { parseRefspec } from './internal/refspec.js';
import {
  listBranchReferrers,
  rewriteDefaultFetchRefspecs,
  validateRemoteName,
} from './internal/remote-config.js';

const FORBIDDEN_URL_CHARS = /[\n\r\0]/;

const assertUrlSafe = (url: string): void => {
  if (FORBIDDEN_URL_CHARS.test(url)) {
    throw invalidOption('remote.url', 'url must not contain a newline or NUL');
  }
};

/** Compact view of a remote pulled from `.git/config`. */
export interface RemoteInfo {
  readonly name: string;
  readonly url: string;
  readonly pushUrl: string | undefined;
  readonly fetchRefspecs: ReadonlyArray<string>;
}

/** Local-only `show` payload: config view + tracking refs + tracking branches. */
export interface RemoteShow extends RemoteInfo {
  readonly trackingRefs: ReadonlyMap<RefName, ObjectId>;
  readonly trackedBy: ReadonlyArray<{
    readonly branch: RefName;
    readonly merge: string | undefined;
  }>;
}

export interface RemoteListResult {
  readonly remotes: ReadonlyArray<RemoteInfo>;
}

export interface RemoteAddInput {
  readonly name: string;
  readonly url: string;
  readonly fetch?: string;
}
export interface RemoteAddResult {
  readonly remote: RemoteInfo;
}

export interface RemoteRemoveInput {
  readonly name: string;
}
export interface RemoteRemoveResult {
  readonly name: string;
  readonly removedTrackingRefs: ReadonlyArray<RefName>;
  readonly clearedBranches: ReadonlyArray<RefName>;
}

export interface RemoteRenameInput {
  readonly from: string;
  readonly to: string;
}
export interface RemoteRenameResult {
  readonly from: string;
  readonly to: string;
  readonly movedTrackingRefs: ReadonlyArray<RefName>;
  readonly rewrittenBranches: ReadonlyArray<RefName>;
}

export interface RemoteSetUrlInput {
  readonly name: string;
  readonly url: string;
  readonly push?: boolean;
}
export interface RemoteSetUrlResult {
  readonly remote: RemoteInfo;
}

export interface RemoteShowInput {
  readonly name: string;
}
export interface RemoteShowResult {
  readonly remote: RemoteShow;
}

const toRemoteInfo = (
  name: string,
  entry:
    | {
        readonly url?: string;
        readonly pushUrl?: string;
        readonly fetch?: ReadonlyArray<string>;
      }
    | undefined,
): RemoteInfo => ({
  name,
  url: entry?.url ?? '',
  pushUrl: entry?.pushUrl,
  fetchRefspecs: entry?.fetch ?? [],
});

export const remoteList = async (ctx: Context): Promise<RemoteListResult> => {
  await assertAcceptedRepository(ctx);
  const config = await readConfig(ctx);
  if (config.remote === undefined) return { remotes: [] };
  const remotes: RemoteInfo[] = [];
  for (const [name, entry] of config.remote) {
    remotes.push(toRemoteInfo(name, entry));
  }
  // config.remote keys are distinct, so the equal case is unreachable: a
  // binary -1/1 comparator suffices and `<` vs `<=` are indistinguishable.
  // Stryker disable next-line EqualityOperator: equivalent — names are distinct, so < and <= behave identically
  remotes.sort((left, right) => (left.name < right.name ? -1 : 1));
  return { remotes };
};

export const remoteAdd = async (ctx: Context, input: RemoteAddInput): Promise<RemoteAddResult> => {
  await assertAcceptedRepository(ctx);
  validateRemoteName(input.name);
  assertUrlSafe(input.url);
  const config = await readConfig(ctx);
  if (config.remote?.has(input.name) === true) throw remoteExists(input.name);
  const fetchSpec = input.fetch ?? `+refs/heads/*:refs/remotes/${input.name}/*`;
  // parseRefspec throws REFSPEC_INVALID on bad input — the same code
  // `fetch`/`push` consumers raise, so callers get one consistent shape.
  parseRefspec(fetchSpec);
  const ops: ReadonlyArray<ConfigOperation> = [
    { kind: 'set', section: 'remote', subsection: input.name, key: 'url', value: input.url },
    {
      kind: 'set',
      section: 'remote',
      subsection: input.name,
      key: 'fetch',
      value: fetchSpec,
    },
  ];
  await updateConfigOperations(ctx, ops);
  return {
    remote: {
      name: input.name,
      url: input.url,
      pushUrl: undefined,
      fetchRefspecs: [fetchSpec],
    },
  };
};

const listTrackingRefs = async (ctx: Context, name: string): Promise<ReadonlyArray<RefName>> => {
  const prefix = `refs/remotes/${name}/`;
  const all = await enumerateRefs(ctx);
  return all.filter((ref): ref is RefName => ref.startsWith(prefix));
};

export const remoteRemove = async (
  ctx: Context,
  input: RemoteRemoveInput,
): Promise<RemoteRemoveResult> => {
  await assertAcceptedRepository(ctx);
  validateRemoteName(input.name);
  const config = await readConfig(ctx);
  if (config.remote?.has(input.name) !== true) throw remoteNotConfigured(input.name);
  const trackingRefs = await listTrackingRefs(ctx, input.name);
  const referrers = listBranchReferrers(config, input.name);
  // Delete tracking refs first — recoverable if we crash before the
  // config rewrite — as ONE ref transaction, as git's `remote remove` does;
  // each delete cleans its reflog file too.
  await deleteRefs(ctx, trackingRefs, { noDeref: true });
  // Rewrite config: drop the [remote "<name>"] section AND clear every
  // paired branch.<X>.remote / branch.<X>.merge key.
  const ops: ConfigOperation[] = [
    { kind: 'removeSection', section: 'remote', subsection: input.name },
  ];
  for (const referrer of referrers) {
    ops.push(
      { kind: 'removeEntry', section: 'branch', subsection: referrer.branch, key: 'remote' },
      { kind: 'removeEntry', section: 'branch', subsection: referrer.branch, key: 'merge' },
    );
  }
  await updateConfigOperations(ctx, ops);
  return {
    name: input.name,
    removedTrackingRefs: trackingRefs,
    clearedBranches: referrers.map((r) => r.ref),
  };
};

/** One tracking ref's resolved value, tagged by kind — the split
 *  `renameTrackingRefs` needs to create symbolic refs after direct ones
 *  and to treat each shape differently. */
type TrackingRefEntry =
  | { readonly kind: 'direct'; readonly name: RefName; readonly id: ObjectId }
  | { readonly kind: 'symbolic'; readonly name: RefName; readonly target: RefName };
type DirectTrackingRef = Extract<TrackingRefEntry, { kind: 'direct' }>;
type SymbolicTrackingRef = Extract<TrackingRefEntry, { kind: 'symbolic' }>;

/** The remote names one rename moves tracking refs between. */
interface TrackingRename {
  readonly from: string;
  readonly to: string;
}

const readTrackingValues = async (
  ctx: Context,
  names: readonly RefName[],
): Promise<readonly TrackingRefEntry[]> => {
  const store = getRefStore(ctx);
  const entries: TrackingRefEntry[] = [];
  for (const name of names) {
    const resolved = await store.resolveDirect(name);
    if (resolved.kind === 'direct') entries.push({ kind: 'direct', name, id: resolved.id });
    else if (resolved.kind === 'symbolic') {
      entries.push({ kind: 'symbolic', name, target: resolved.target });
    }
  }
  return entries;
};

const isDirectEntry = (entry: TrackingRefEntry): entry is DirectTrackingRef =>
  entry.kind === 'direct';
const isSymbolicEntry = (entry: TrackingRefEntry): entry is SymbolicTrackingRef =>
  entry.kind === 'symbolic';

const renamedName = (name: RefName, from: string, to: string): RefName =>
  `refs/remotes/${to}/${name.slice(`refs/remotes/${from}/`.length)}` as RefName;

/** git's own rename message names the full ref paths, not the remote names. */
const trackingRenameMessage = (oldRef: RefName, newRef: RefName): string =>
  `remote: renamed ${oldRef} to ${newRef}`;

/** A symref's target is rewritten only when it points inside the remote
 *  being renamed (the pinned shape `<remote>/HEAD` takes) — any other
 *  target survives verbatim. */
const rewriteSymbolicTarget = (target: RefName, from: string, to: string): RefName => {
  const prefix = `refs/remotes/${from}/`;
  return target.startsWith(prefix) ? renamedName(target, from, to) : target;
};

/**
 * The refusal a rename's create meets at `target`, if any. git queues every
 * create with a null old id under `REF_NO_DEREF`, so a name that already
 * exists refuses — a symbolic ref reporting its referent's value, a
 * dangling one reporting absent (git's "dangling symref already exists").
 */
const existingNameConflict = async (
  ctx: Context,
  target: RefName,
): Promise<TsgitError | undefined> => {
  const options = { noDeref: true, expected: 'absent' } as const;
  const chain = await resolveWriteChain(getRefStore(ctx), target, options);
  if (chain.old !== 'absent') return refUpdateConflict(target, 'absent', chain.old);
  return chain.danglingSymref ? refUpdateConflict(target, 'absent', 'absent') : undefined;
};

/**
 * git's rename is one transaction prepared before anything moves: every
 * renamed name that already exists refuses the whole rename, reporting the
 * first in `targets`' byte order, before any ref or log is written.
 */
const assertRenamedNamesFree = async (ctx: Context, targets: readonly RefName[]): Promise<void> => {
  for (const target of targets) {
    const conflict = await existingNameConflict(ctx, target);
    if (conflict !== undefined) throw conflict;
  }
};

/** A direct tracking ref's create under its renamed name — no log is
 *  created for it here. */
const directCreate = (entry: DirectTrackingRef, target: RefName): RefUpdate => ({
  kind: 'set',
  name: target,
  id: entry.id,
  expected: 'absent',
});

/** The single trailing same-id entry a moved log gains under its new name. */
const directRenameLogEntry = (entry: DirectTrackingRef, target: RefName): RefUpdate => ({
  kind: 'reflogOnly',
  name: target,
  reflog: { oldId: entry.id, newId: entry.id, message: trackingRenameMessage(entry.name, target) },
});

/**
 * Create every direct tracking ref under its renamed name in one batch,
 * each logged source's history moved onto the new name first and followed
 * by one rename entry — no log is created for a name that never had one.
 */
const createDirectTrackingRefs = async (
  ctx: Context,
  direct: readonly DirectTrackingRef[],
  rename: TrackingRename,
): Promise<void> => {
  const store = getRefStore(ctx);
  const updates: RefUpdate[] = [];
  for (const entry of direct) {
    const target = renamedName(entry.name, rename.from, rename.to);
    updates.push(directCreate(entry, target));
    if (!(await store.hasReflog(entry.name))) continue;
    await store.moveReflog(entry.name, target);
    updates.push(directRenameLogEntry(entry, target));
  }
  await store.applyRefUpdates(updates);
};

/** Whether the backend moves a renamed symref's log wholesale (files) rather
 *  than copying it and keeping the old name's log (reftable). */
const movesSymrefLog = (ctx: Context): boolean =>
  transactionLogging(ctx).renamedSymrefLog === 'move-then-null-entry';

/**
 * Carry a symbolic tracking ref's log onto its renamed name before the old
 * name is deleted. The reftable backend copies it: the old name keeps its
 * log, and the `noDeref` delete appends the referent's value from before the
 * delete to it, as git's does.
 */
const carrySymbolicLog = async (
  ctx: Context,
  entry: SymbolicTrackingRef,
  rename: TrackingRename,
): Promise<void> => {
  const store = getRefStore(ctx);
  const target = renamedName(entry.name, rename.from, rename.to);
  await (movesSymrefLog(ctx)
    ? store.moveReflog(entry.name, target)
    : store.copyReflog(entry.name, target));
};

/** A symbolic tracking ref's create under its renamed name, its target
 *  rewritten into the new namespace — with a null-id rename entry on the
 *  files backend only. */
const symbolicCreate = (
  ctx: Context,
  entry: SymbolicTrackingRef,
  rename: TrackingRename,
): RefUpdate => {
  const name = renamedName(entry.name, rename.from, rename.to);
  const target = rewriteSymbolicTarget(entry.target, rename.from, rename.to);
  if (!movesSymrefLog(ctx)) return { kind: 'setSymbolic', name, target };
  const zero = zeroOid(ctx.hashConfig);
  const reflog = { oldId: zero, newId: zero, message: trackingRenameMessage(entry.name, name) };
  return { kind: 'setSymbolic', name, target, reflog };
};

/**
 * Move every tracking ref from `refs/remotes/<from>/` to `refs/remotes/<to>/`:
 * every renamed name proven free, the direct refs created, the symbolic
 * refs' logs carried, every old name deleted in ONE ref transaction, and the
 * symbolic `<to>/HEAD` created last, once its target already exists.
 */
const renameTrackingRefs = async (
  ctx: Context,
  rename: TrackingRename,
): Promise<readonly RefName[]> => {
  const resolved = await readTrackingValues(ctx, await listTrackingRefs(ctx, rename.from));
  const renamed = (entry: TrackingRefEntry): RefName =>
    renamedName(entry.name, rename.from, rename.to);
  await assertRenamedNamesFree(ctx, resolved.map(renamed));
  const direct = resolved.filter(isDirectEntry);
  const symbolic = resolved.filter(isSymbolicEntry);
  await createDirectTrackingRefs(ctx, direct, rename);
  for (const entry of symbolic) await carrySymbolicLog(ctx, entry, rename);
  const oldNames = resolved.map((entry) => entry.name);
  await deleteRefs(ctx, oldNames, { noDeref: true });
  for (const entry of symbolic) {
    await getRefStore(ctx).applyRefUpdates([symbolicCreate(ctx, entry, rename)]);
  }
  return [...direct, ...symbolic].map(renamed);
};

export const remoteRename = async (
  ctx: Context,
  input: RemoteRenameInput,
): Promise<RemoteRenameResult> => {
  await assertAcceptedRepository(ctx);
  validateRemoteName(input.from);
  validateRemoteName(input.to);
  if (input.from === input.to) {
    throw invalidOption('remote.rename', 'from and to must differ');
  }
  const config = await readConfig(ctx);
  const fromEntry = config.remote?.get(input.from);
  if (fromEntry === undefined) throw remoteNotConfigured(input.from);
  if (config.remote?.has(input.to) === true) throw remoteExists(input.to);
  const referrers = listBranchReferrers(config, input.from);
  // Move tracking refs first (recoverability): direct refs, then the
  // symbolic `<from>/HEAD` last.
  const moved = await renameTrackingRefs(ctx, { from: input.from, to: input.to });
  // Config rewrite: rename the section, replace the canonical refspec
  // (custom ones preserved), update branch referrers.
  const rewrittenSpecs = rewriteDefaultFetchRefspecs(fromEntry.fetch ?? [], input.from, input.to);
  const ops: ConfigOperation[] = [
    { kind: 'renameSection', section: 'remote', from: input.from, to: input.to },
  ];
  // Wipe the existing fetch entries on the (renamed) section and re-emit
  // every rewritten spec via `appendEntry` so order is preserved and each
  // spec produces its own line (`set` would collapse them).
  // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — when rewrittenSpecs is empty (no fetch refspec) the block is a no-op: removeEntry on an absent fetch key plus an empty append loop
  if (rewrittenSpecs.length > 0) {
    ops.push({
      kind: 'removeEntry',
      section: 'remote',
      subsection: input.to,
      key: 'fetch',
    });
    for (const spec of rewrittenSpecs) {
      ops.push({
        kind: 'appendEntry',
        section: 'remote',
        subsection: input.to,
        key: 'fetch',
        value: spec,
      });
    }
  }
  for (const referrer of referrers) {
    ops.push({
      kind: 'set',
      section: 'branch',
      subsection: referrer.branch,
      key: 'remote',
      value: input.to,
    });
  }
  await updateConfigOperations(ctx, ops);
  return {
    from: input.from,
    to: input.to,
    movedTrackingRefs: moved,
    rewrittenBranches: referrers.map((r) => r.ref),
  };
};

export const remoteSetUrl = async (
  ctx: Context,
  input: RemoteSetUrlInput,
): Promise<RemoteSetUrlResult> => {
  await assertAcceptedRepository(ctx);
  validateRemoteName(input.name);
  assertUrlSafe(input.url);
  const config = await readConfig(ctx);
  if (config.remote?.has(input.name) !== true) throw remoteNotConfigured(input.name);
  const key = input.push === true ? 'pushurl' : 'url';
  await updateConfigOperations(ctx, [
    {
      kind: 'set',
      section: 'remote',
      subsection: input.name,
      key,
      value: input.url,
    },
  ]);
  const refreshed = (await readConfig(ctx)).remote?.get(input.name);
  return { remote: toRemoteInfo(input.name, refreshed) };
};

export const remoteShow = async (
  ctx: Context,
  input: RemoteShowInput,
): Promise<RemoteShowResult> => {
  await assertAcceptedRepository(ctx);
  validateRemoteName(input.name);
  const config = await readConfig(ctx);
  const entry = config.remote?.get(input.name);
  if (entry === undefined) throw remoteNotConfigured(input.name);
  const trackingRefNames = await listTrackingRefs(ctx, input.name);
  const store = getRefStore(ctx);
  const trackingRefs = new Map<RefName, ObjectId>();
  for (const refName of trackingRefNames) {
    const direct = await store.resolveDirect(refName);
    if (direct.kind === 'direct') trackingRefs.set(refName, direct.id);
  }
  const referrers = listBranchReferrers(config, input.name);
  const base = toRemoteInfo(input.name, entry);
  return {
    remote: {
      ...base,
      trackingRefs,
      trackedBy: referrers.map((r) => ({ branch: r.ref, merge: r.merge })),
    },
  };
};
