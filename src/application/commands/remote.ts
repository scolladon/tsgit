/**
 * `remote` command — CRUD porcelain for `[remote "<name>"]` blocks in
 * `.git/config` plus the tracking refs they own. Action-discriminated
 * (`list` / `add` / `remove` / `rename` / `setUrl` / `show`).
 *
 * Design: `docs/design/phase-20-5-remote-crud-porcelain.md`.
 * ADRs: 175 (discriminator) · 176 (default refspec) · 177 (remove scope)
 *       · 178 (rename refspec rule) · 179 (set-url --push) · 180 (show
 *       local-only).
 */
import { invalidOption, remoteExists, remoteNotConfigured } from '../../domain/commands/error.js';
import { unsupportedOperation } from '../../domain/error.js';
import { type ObjectId, type RefName, ZERO_OID } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from '../primitives/config-read.js';
import { enumerateRefs } from '../primitives/enumerate-refs.js';
import { assertRepository } from '../primitives/internal/repo-state.js';
import { getRefStore } from '../primitives/ref-store.js';
import { type ConfigOperation, updateConfigOperations } from '../primitives/update-config.js';
import { updateRef } from '../primitives/update-ref.js';
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

export type RemoteAction =
  | { readonly kind: 'list' }
  | {
      readonly kind: 'add';
      readonly name: string;
      readonly url: string;
      readonly fetch?: string;
    }
  | { readonly kind: 'remove'; readonly name: string }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string }
  | {
      readonly kind: 'setUrl';
      readonly name: string;
      readonly url: string;
      readonly push?: boolean;
    }
  | { readonly kind: 'show'; readonly name: string };

export type RemoteResult =
  | { readonly kind: 'list'; readonly remotes: ReadonlyArray<RemoteInfo> }
  | { readonly kind: 'add'; readonly remote: RemoteInfo }
  | {
      readonly kind: 'remove';
      readonly name: string;
      readonly removedTrackingRefs: ReadonlyArray<RefName>;
      readonly clearedBranches: ReadonlyArray<RefName>;
    }
  | {
      readonly kind: 'rename';
      readonly from: string;
      readonly to: string;
      readonly movedTrackingRefs: ReadonlyArray<RefName>;
      readonly rewrittenBranches: ReadonlyArray<RefName>;
    }
  | { readonly kind: 'setUrl'; readonly remote: RemoteInfo }
  | { readonly kind: 'show'; readonly remote: RemoteShow };

export const remote = async (ctx: Context, action: RemoteAction): Promise<RemoteResult> => {
  await assertRepository(ctx);
  if (action.kind === 'list') return listRemotes(ctx);
  if (action.kind === 'add') return addRemote(ctx, action);
  if (action.kind === 'remove') return removeRemote(ctx, action);
  if (action.kind === 'rename') return renameRemote(ctx, action);
  if (action.kind === 'setUrl') return setRemoteUrl(ctx, action);
  return showRemote(ctx, action);
};

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

const listRemotes = async (ctx: Context): Promise<RemoteResult> => {
  const config = await readConfig(ctx);
  if (config.remote === undefined) return { kind: 'list', remotes: [] };
  const remotes: RemoteInfo[] = [];
  for (const [name, entry] of config.remote) {
    remotes.push(toRemoteInfo(name, entry));
  }
  remotes.sort((left, right) => compareByteWise(left.name, right.name));
  return { kind: 'list', remotes };
};

const compareByteWise = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const addRemote = async (
  ctx: Context,
  action: { readonly name: string; readonly url: string; readonly fetch?: string },
): Promise<RemoteResult> => {
  validateRemoteName(action.name);
  assertUrlSafe(action.url);
  const config = await readConfig(ctx);
  if (config.remote?.has(action.name) === true) throw remoteExists(action.name);
  const fetchSpec = action.fetch ?? `+refs/heads/*:refs/remotes/${action.name}/*`;
  // parseRefspec throws REFSPEC_INVALID on bad input — the same code
  // `fetch`/`push` consumers raise, so callers get one consistent shape.
  parseRefspec(fetchSpec);
  const ops: ReadonlyArray<ConfigOperation> = [
    { kind: 'set', section: 'remote', subsection: action.name, key: 'url', value: action.url },
    {
      kind: 'set',
      section: 'remote',
      subsection: action.name,
      key: 'fetch',
      value: fetchSpec,
    },
  ];
  await updateConfigOperations(ctx, ops);
  return {
    kind: 'add',
    remote: {
      name: action.name,
      url: action.url,
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

const removeRemote = async (
  ctx: Context,
  action: { readonly name: string },
): Promise<RemoteResult> => {
  validateRemoteName(action.name);
  const config = await readConfig(ctx);
  if (config.remote?.has(action.name) !== true) throw remoteNotConfigured(action.name);
  const trackingRefs = await listTrackingRefs(ctx, action.name);
  const referrers = listBranchReferrers(config, action.name);
  // Delete tracking refs first — recoverable if we crash before the
  // config rewrite (ADR-177). `updateRef` cleans the reflog file too.
  for (const ref of trackingRefs) {
    await updateRef(ctx, ref, ZERO_OID, { delete: true });
  }
  // Rewrite config: drop the [remote "<name>"] section AND clear every
  // paired branch.<X>.remote / branch.<X>.merge key.
  const ops: ConfigOperation[] = [
    { kind: 'removeSection', section: 'remote', subsection: action.name },
  ];
  for (const referrer of referrers) {
    ops.push(
      { kind: 'removeEntry', section: 'branch', subsection: referrer.branch, key: 'remote' },
      { kind: 'removeEntry', section: 'branch', subsection: referrer.branch, key: 'merge' },
    );
  }
  await updateConfigOperations(ctx, ops);
  return {
    kind: 'remove',
    name: action.name,
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

const renameRemote = async (
  ctx: Context,
  action: { readonly from: string; readonly to: string },
): Promise<RemoteResult> => {
  validateRemoteName(action.from);
  validateRemoteName(action.to);
  if (action.from === action.to) {
    throw invalidOption('remote.rename', 'from and to must differ');
  }
  const config = await readConfig(ctx);
  const fromEntry = config.remote?.get(action.from);
  if (fromEntry === undefined) throw remoteNotConfigured(action.from);
  if (config.remote?.has(action.to) === true) throw remoteExists(action.to);
  const trackingRefs = await listTrackingRefs(ctx, action.from);
  const referrers = listBranchReferrers(config, action.from);
  // Move tracking refs first (ADR-178 §recoverability).
  const reflogMessage = `remote: renamed ${action.from} to ${action.to}`;
  const moved: RefName[] = [];
  for (const source of trackingRefs) {
    const suffix = source.slice(`refs/remotes/${action.from}/`.length);
    const target = `refs/remotes/${action.to}/${suffix}` as RefName;
    await moveTrackingRef(ctx, source, target, reflogMessage);
    moved.push(target);
  }
  // Config rewrite: rename the section, replace the canonical refspec
  // (custom ones preserved), update branch referrers.
  const rewrittenSpecs = rewriteDefaultFetchRefspecs(fromEntry.fetch ?? [], action.from, action.to);
  const ops: ConfigOperation[] = [
    { kind: 'renameSection', section: 'remote', from: action.from, to: action.to },
  ];
  // Wipe the existing fetch entries on the (renamed) section and re-emit
  // every rewritten spec via `appendEntry` so order is preserved and each
  // spec produces its own line (`set` would collapse them).
  if (rewrittenSpecs.length > 0) {
    ops.push({
      kind: 'removeEntry',
      section: 'remote',
      subsection: action.to,
      key: 'fetch',
    });
    for (const spec of rewrittenSpecs) {
      ops.push({
        kind: 'appendEntry',
        section: 'remote',
        subsection: action.to,
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
      value: action.to,
    });
  }
  await updateConfigOperations(ctx, ops);
  return {
    kind: 'rename',
    from: action.from,
    to: action.to,
    movedTrackingRefs: moved,
    rewrittenBranches: referrers.map((r) => r.ref),
  };
};

const setRemoteUrl = async (
  ctx: Context,
  action: { readonly name: string; readonly url: string; readonly push?: boolean },
): Promise<RemoteResult> => {
  validateRemoteName(action.name);
  assertUrlSafe(action.url);
  const config = await readConfig(ctx);
  if (config.remote?.has(action.name) !== true) throw remoteNotConfigured(action.name);
  const key = action.push === true ? 'pushurl' : 'url';
  await updateConfigOperations(ctx, [
    {
      kind: 'set',
      section: 'remote',
      subsection: action.name,
      key,
      value: action.url,
    },
  ]);
  const refreshed = (await readConfig(ctx)).remote?.get(action.name);
  return { kind: 'setUrl', remote: toRemoteInfo(action.name, refreshed) };
};

const showRemote = async (
  ctx: Context,
  action: { readonly name: string },
): Promise<RemoteResult> => {
  validateRemoteName(action.name);
  const config = await readConfig(ctx);
  const entry = config.remote?.get(action.name);
  if (entry === undefined) throw remoteNotConfigured(action.name);
  const trackingRefNames = await listTrackingRefs(ctx, action.name);
  const store = getRefStore(ctx);
  const trackingRefs = new Map<RefName, ObjectId>();
  for (const refName of trackingRefNames) {
    const direct = await store.resolveDirect(refName);
    if (direct.kind === 'direct') trackingRefs.set(refName, direct.id);
  }
  const referrers = listBranchReferrers(config, action.name);
  const base = toRemoteInfo(action.name, entry);
  return {
    kind: 'show',
    remote: {
      ...base,
      trackingRefs,
      trackedBy: referrers.map((r) => ({ branch: r.ref, merge: r.merge })),
    },
  };
};
