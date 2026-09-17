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
import { REMOTE_REMOVE_REFLOG } from '../../domain/reflog/reflog-messages.js';
import { invalidRef, refUpdateConflict } from '../../domain/refs/error.js';
import type { Context } from '../../ports/context.js';
import { type ParsedConfig, readConfig } from '../primitives/config-read.js';
import { enumerateRefs } from '../primitives/enumerate-refs.js';
import { transactionLogging } from '../primitives/internal/ref-transaction-logging.js';
import { resolveWriteChain } from '../primitives/internal/ref-write-chain.js';
import { assertAcceptedRepository } from '../primitives/internal/repo-state.js';
import { getRefStore, type RefUpdate } from '../primitives/ref-store.js';
import { type ConfigOperation, updateConfigOperations } from '../primitives/update-config.js';
import { deleteRefs } from '../primitives/update-ref.js';
import { parseRefspec } from './internal/refspec.js';
import {
  assertRemoteNameUnnested,
  type BranchReferrer,
  listBranchReferrers,
  mapsTrackingNamespace,
  rewriteTrackingFetchRefspecs,
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

/** The `[remote "<name>"]` block a new remote writes: its url, then its fetch refspec. */
const addedRemoteOperations = (input: RemoteAddInput, fetchSpec: string): ConfigOperation[] => [
  { kind: 'set', section: 'remote', subsection: input.name, key: 'url', value: input.url },
  { kind: 'set', section: 'remote', subsection: input.name, key: 'fetch', value: fetchSpec },
];

export const remoteAdd = async (ctx: Context, input: RemoteAddInput): Promise<RemoteAddResult> => {
  await assertAcceptedRepository(ctx);
  const config = await readConfig(ctx);
  // git's own order: an existing remote refuses before its name is checked,
  // and the name's syntax before its nesting against the other remotes.
  if (config.remote?.has(input.name) === true) throw remoteExists(input.name);
  validateRemoteName(input.name);
  assertRemoteNameUnnested(config, input.name);
  assertUrlSafe(input.url);
  const fetchSpec = input.fetch ?? `+refs/heads/*:refs/remotes/${input.name}/*`;
  // parseRefspec throws REFSPEC_INVALID on bad input — the same code
  // `fetch`/`push` consumers raise, so callers get one consistent shape.
  parseRefspec(fetchSpec);
  await updateConfigOperations(ctx, addedRemoteOperations(input, fetchSpec));
  const remote = { name: input.name, url: input.url, pushUrl: undefined };
  return { remote: { ...remote, fetchRefspecs: [fetchSpec] } };
};

const listTrackingRefs = async (ctx: Context, name: string): Promise<ReadonlyArray<RefName>> => {
  const prefix = `refs/remotes/${name}/`;
  const all = await enumerateRefs(ctx);
  return all.filter((ref): ref is RefName => ref.startsWith(prefix));
};

/** A removal's config rewrite: the `[remote "<name>"]` section dropped and
 *  every paired `branch.<X>.remote` / `branch.<X>.merge` key cleared. */
const removeConfigOperations = (
  name: string,
  referrers: ReadonlyArray<BranchReferrer>,
): ConfigOperation[] => [
  { kind: 'removeSection', section: 'remote', subsection: name },
  ...referrers.flatMap((referrer): ConfigOperation[] => [
    { kind: 'removeEntry', section: 'branch', subsection: referrer.branch, key: 'remote' },
    { kind: 'removeEntry', section: 'branch', subsection: referrer.branch, key: 'merge' },
  ]),
];

export const remoteRemove = async (
  ctx: Context,
  input: RemoteRemoveInput,
): Promise<RemoteRemoveResult> => {
  await assertAcceptedRepository(ctx);
  const config = await readConfig(ctx);
  if (config.remote?.has(input.name) !== true) throw remoteNotConfigured(input.name);
  const trackingRefs = await listTrackingRefs(ctx, input.name);
  const referrers = listBranchReferrers(config, input.name);
  // Tracking refs go first — recoverable if we crash before the config
  // rewrite — as ONE ref transaction, as git's `remote remove` does; each
  // delete cleans its reflog file too.
  await deleteRefs(ctx, trackingRefs, { noDeref: true, reflogMessage: REMOTE_REMOVE_REFLOG });
  await updateConfigOperations(ctx, removeConfigOperations(input.name, referrers));
  const clearedBranches = referrers.map((referrer) => referrer.ref);
  return { name: input.name, removedTrackingRefs: trackingRefs, clearedBranches };
};

/** One tracking ref's resolved value, tagged by kind — the split
 *  `renameTrackingRefs` needs to create symbolic refs after direct ones
 *  and to treat each shape differently. */
type TrackingRefEntry =
  | { readonly kind: 'direct'; readonly name: RefName; readonly id: ObjectId }
  | { readonly kind: 'symbolic'; readonly name: RefName; readonly target: RefName };
type DirectTrackingRef = Extract<TrackingRefEntry, { kind: 'direct' }>;
type SymbolicTrackingRef = Extract<TrackingRefEntry, { kind: 'symbolic' }>;

/** One `[remote "<name>"]` block as `readConfig` parses it. */
type RemoteConfigEntry = NonNullable<ReturnType<NonNullable<ParsedConfig['remote']>['get']>>;

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

const REMOTES_PREFIX_LENGTH = 'refs/remotes/'.length;

/**
 * git's rewrite of a name a rename touches: the bytes at `refs/remotes/`'s
 * length, for as many bytes as the old remote name is long, replaced by the
 * new name — whatever those bytes spell and wherever the name lives.
 */
const spliceRemoteName = (value: string, rename: TrackingRename): string =>
  value.slice(0, REMOTES_PREFIX_LENGTH) +
  rename.to +
  value.slice(REMOTES_PREFIX_LENGTH + rename.from.length);

const renamedName = (name: RefName, rename: TrackingRename): RefName =>
  spliceRemoteName(name, rename) as RefName;

/** git's own rename message names the full ref paths, not the remote names. */
const trackingRenameMessage = (oldRef: RefName, newRef: RefName): string =>
  `remote: renamed ${oldRef} to ${newRef}`;

/**
 * A symref's target takes the same splice as the ref's own name, with no
 * check that it points inside the remote being renamed — so a target under
 * another namespace is rewritten into a dangling name, and one too short to
 * hold the slice has no bytes to overwrite and refuses.
 */
const rewriteSymbolicTarget = (target: RefName, rename: TrackingRename): RefName => {
  if (target.length < REMOTES_PREFIX_LENGTH + rename.from.length) {
    throw invalidRef(`symbolic ref target '${target}' is shorter than the renamed slice`);
  }
  return spliceRemoteName(target, rename) as RefName;
};

/** A symbolic tracking ref beside the two names git splices for it — both
 *  computed while the rename is prepared, before anything is written. */
interface RenamedSymref {
  readonly entry: SymbolicTrackingRef;
  readonly name: RefName;
  readonly target: RefName;
}

const prepareSymrefs = (
  symbolic: readonly SymbolicTrackingRef[],
  rename: TrackingRename,
): readonly RenamedSymref[] =>
  symbolic.map((entry) => ({
    entry,
    name: renamedName(entry.name, rename),
    target: rewriteSymbolicTarget(entry.target, rename),
  }));

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
    const target = renamedName(entry.name, rename);
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
const carrySymbolicLog = async (ctx: Context, renamed: RenamedSymref): Promise<void> => {
  const store = getRefStore(ctx);
  await (movesSymrefLog(ctx)
    ? store.moveReflog(renamed.entry.name, renamed.name)
    : store.copyReflog(renamed.entry.name, renamed.name));
};

/** A symbolic tracking ref's create under its spliced name and target —
 *  with a null-id rename entry on the files backend only. */
const symbolicCreate = (ctx: Context, renamed: RenamedSymref): RefUpdate => {
  const { name, target } = renamed;
  if (!movesSymrefLog(ctx)) return { kind: 'setSymbolic', name, target };
  const zero = zeroOid(ctx.hashConfig);
  const message = trackingRenameMessage(renamed.entry.name, name);
  return { kind: 'setSymbolic', name, target, reflog: { oldId: zero, newId: zero, message } };
};

/**
 * Move every tracking ref from `refs/remotes/<from>/` to `refs/remotes/<to>/`:
 * every symref's two names spliced first (git splices them while it prepares
 * the rename, so an unspliceable target refuses ahead of any name conflict),
 * every renamed name proven free, the direct refs created, the symbolic refs'
 * logs carried, every old name deleted in ONE ref transaction, and the
 * symbolic `<to>/HEAD` created last, once its target already exists.
 */
const renameTrackingRefs = async (
  ctx: Context,
  rename: TrackingRename,
): Promise<readonly RefName[]> => {
  const resolved = await readTrackingValues(ctx, await listTrackingRefs(ctx, rename.from));
  const symbolic = prepareSymrefs(resolved.filter(isSymbolicEntry), rename);
  // Every renamed name, in the ref order git queues the rename in.
  const renamedNames = resolved.map((entry) => renamedName(entry.name, rename));
  await assertRenamedNamesFree(ctx, renamedNames);
  await createDirectTrackingRefs(ctx, resolved.filter(isDirectEntry), rename);
  for (const renamed of symbolic) await carrySymbolicLog(ctx, renamed);
  const oldNames = resolved.map((entry) => entry.name);
  await deleteRefs(ctx, oldNames, { noDeref: true });
  for (const renamed of symbolic) {
    await getRefStore(ctx).applyRefUpdates([symbolicCreate(ctx, renamed)]);
  }
  return renamedNames;
};

/** The fetch refspec rewrite a rename makes on the renamed section: the
 *  existing entries wiped and every rewritten spec re-emitted through
 *  `appendEntry`, so order is kept and each spec keeps its own line (`set`
 *  would collapse them) — canonical specs rewritten, custom ones verbatim. */
const fetchRewriteOperations = (
  rename: TrackingRename,
  fetch: ReadonlyArray<string>,
): ConfigOperation[] => {
  const specs = rewriteTrackingFetchRefspecs(fetch, rename.from, rename.to);
  const entry = { section: 'remote', subsection: rename.to, key: 'fetch' } as const;
  const appends = specs.map((value): ConfigOperation => ({ kind: 'appendEntry', ...entry, value }));
  // With no spec at all, removing the absent key rewrites nothing, so no guard is needed.
  return [{ kind: 'removeEntry', ...entry }, ...appends];
};

/** The half of a rename's config rewrite git commits before it touches a
 *  ref: the section header alone, its values left naming the old remote. */
const renameSectionOperations = (rename: TrackingRename): ConfigOperation[] => [
  { kind: 'renameSection', section: 'remote', from: rename.from, to: rename.to },
];

/** The half git commits only once every ref has moved: the fetch refspecs
 *  rewritten and every branch tracking the remote re-pointed. */
const renameValueOperations = (
  rename: TrackingRename,
  fetch: ReadonlyArray<string>,
  referrers: ReadonlyArray<BranchReferrer>,
): ConfigOperation[] => [
  ...fetchRewriteOperations(rename, fetch),
  ...referrers.map(
    (referrer): ConfigOperation => ({
      kind: 'set',
      section: 'branch',
      subsection: referrer.branch,
      key: 'remote',
      value: rename.to,
    }),
  ),
];

/**
 * The configured remote a rename moves, once git's own checks pass in git's
 * order: the source is looked up, the target checked for an existing remote,
 * and only then the target's syntax.
 */
const renameSource = (config: ParsedConfig, rename: TrackingRename): RemoteConfigEntry => {
  const fromEntry = config.remote?.get(rename.from);
  if (fromEntry === undefined) throw remoteNotConfigured(rename.from);
  if (config.remote?.has(rename.to) === true) throw remoteExists(rename.to);
  validateRemoteName(rename.to);
  return fromEntry;
};

export const remoteRename = async (
  ctx: Context,
  input: RemoteRenameInput,
): Promise<RemoteRenameResult> => {
  await assertAcceptedRepository(ctx);
  if (input.from === input.to) {
    throw invalidOption('remote.rename', 'from and to must differ');
  }
  const config = await readConfig(ctx);
  const fromEntry = renameSource(config, input);
  const referrers = listBranchReferrers(config, input.from);
  // git commits the section header before it prepares the ref move, so a
  // refused rename leaves the section renamed and its values untouched.
  await updateConfigOperations(ctx, renameSectionOperations(input));
  // git moves tracking refs only for a remote whose fetch refspecs actually
  // map into `refs/remotes/<from>/`; every other remote keeps its refs.
  const fetch = fromEntry.fetch ?? [];
  const moved = mapsTrackingNamespace(fetch, input.from)
    ? await renameTrackingRefs(ctx, input)
    : [];
  await updateConfigOperations(ctx, renameValueOperations(input, fetch, referrers));
  const rewrittenBranches = referrers.map((referrer) => referrer.ref);
  return { from: input.from, to: input.to, movedTrackingRefs: moved, rewrittenBranches };
};

export const remoteSetUrl = async (
  ctx: Context,
  input: RemoteSetUrlInput,
): Promise<RemoteSetUrlResult> => {
  await assertAcceptedRepository(ctx);
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

/** Each of `names` that resolves to a direct value, with that value. */
const directTrackingValues = async (
  ctx: Context,
  names: ReadonlyArray<RefName>,
): Promise<ReadonlyMap<RefName, ObjectId>> => {
  const store = getRefStore(ctx);
  const values = new Map<RefName, ObjectId>();
  for (const name of names) {
    const direct = await store.resolveDirect(name);
    if (direct.kind === 'direct') values.set(name, direct.id);
  }
  return values;
};

export const remoteShow = async (
  ctx: Context,
  input: RemoteShowInput,
): Promise<RemoteShowResult> => {
  await assertAcceptedRepository(ctx);
  const config = await readConfig(ctx);
  const entry = config.remote?.get(input.name);
  if (entry === undefined) throw remoteNotConfigured(input.name);
  const trackingRefs = await directTrackingValues(ctx, await listTrackingRefs(ctx, input.name));
  const referrers = listBranchReferrers(config, input.name);
  const trackedBy = referrers.map((referrer) => ({ branch: referrer.ref, merge: referrer.merge }));
  return { remote: { ...toRemoteInfo(input.name, entry), trackingRefs, trackedBy } };
};
