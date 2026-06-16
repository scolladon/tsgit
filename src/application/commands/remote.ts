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
import { unsupportedOperation } from '../../domain/error.js';
import { type ObjectId, type RefName, ZERO_OID } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from '../primitives/config-read.js';
import { enumerateRefs } from '../primitives/enumerate-refs.js';
import { getRefStore } from '../primitives/ref-store.js';
import { type ConfigOperation, updateConfigOperations } from '../primitives/update-config.js';
import { updateRef } from '../primitives/update-ref.js';
import { parseRefspec } from './internal/refspec.js';
import {
  listBranchReferrers,
  rewriteDefaultFetchRefspecs,
  validateRemoteName,
} from './internal/remote-config.js';
import { assertCommandPreamble } from './internal/repo-state.js';

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
  await assertCommandPreamble(ctx);
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
  await assertCommandPreamble(ctx);
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
  await assertCommandPreamble(ctx);
  validateRemoteName(input.name);
  const config = await readConfig(ctx);
  if (config.remote?.has(input.name) !== true) throw remoteNotConfigured(input.name);
  const trackingRefs = await listTrackingRefs(ctx, input.name);
  const referrers = listBranchReferrers(config, input.name);
  // Delete tracking refs first — recoverable if we crash before the
  // config rewrite. `updateRef` cleans the reflog file too.
  for (const ref of trackingRefs) {
    await updateRef(ctx, ref, ZERO_OID, { delete: true });
  }
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

/**
 * Move one loose tracking ref from `refs/remotes/<from>/...` to
 * `refs/remotes/<to>/...`, preserving the OID. Reuses `updateRef`'s
 * atomic write + delete so the move is two atomic steps with no third
 * actor able to observe an "in both places" state (per the per-Context
 * single-thread invariant).
 */
const moveTrackingRef = async (
  ctx: Context,
  source: RefName,
  target: RefName,
  reflogMessage: string,
): Promise<void> => {
  const store = getRefStore(ctx);
  const direct = await store.resolveDirect(source);
  if (direct.kind !== 'direct') return;
  // Packed-only refs must surface BEFORE the target write — otherwise the
  // subsequent delete throws and leaves a partial move (target written,
  // source still packed). Mirrors `remove`'s packed-only error path.
  if (!(await store.isLoose(source))) {
    throw unsupportedOperation(
      'rename-packed-tracking-ref',
      `cannot rename packed-only ref ${source} — run \`git pack-refs --unpack\` and retry`,
    );
  }
  await updateRef(ctx, target, direct.id, { expected: 'absent', reflogMessage });
  await updateRef(ctx, source, ZERO_OID, { delete: true });
};

export const remoteRename = async (
  ctx: Context,
  input: RemoteRenameInput,
): Promise<RemoteRenameResult> => {
  await assertCommandPreamble(ctx);
  validateRemoteName(input.from);
  validateRemoteName(input.to);
  if (input.from === input.to) {
    throw invalidOption('remote.rename', 'from and to must differ');
  }
  const config = await readConfig(ctx);
  const fromEntry = config.remote?.get(input.from);
  if (fromEntry === undefined) throw remoteNotConfigured(input.from);
  if (config.remote?.has(input.to) === true) throw remoteExists(input.to);
  const trackingRefs = await listTrackingRefs(ctx, input.from);
  const referrers = listBranchReferrers(config, input.from);
  // Move tracking refs first (recoverability).
  const reflogMessage = `remote: renamed ${input.from} to ${input.to}`;
  const moved: RefName[] = [];
  for (const source of trackingRefs) {
    const suffix = source.slice(`refs/remotes/${input.from}/`.length);
    const target = `refs/remotes/${input.to}/${suffix}` as RefName;
    await moveTrackingRef(ctx, source, target, reflogMessage);
    moved.push(target);
  }
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
  await assertCommandPreamble(ctx);
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
  await assertCommandPreamble(ctx);
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
