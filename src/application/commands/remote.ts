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
import { invalidOption, remoteExists } from '../../domain/commands/error.js';
import type { ObjectId, RefName } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from '../primitives/config-read.js';
import { assertRepository } from '../primitives/internal/repo-state.js';
import { type ConfigOperation, updateConfigOperations } from '../primitives/update-config.js';
import { parseRefspec } from './internal/refspec.js';
import { validateRemoteName } from './internal/remote-config.js';

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

// --- Placeholder bodies for actions implemented in later slices. ---

const notYetImplemented = (action: string): never => {
  throw new Error(`remote action not yet implemented: ${action}`);
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

const removeRemote = async (
  _ctx: Context,
  action: { readonly name: string },
): Promise<RemoteResult> => {
  validateRemoteName(action.name);
  return notYetImplemented('remove');
};

const renameRemote = async (
  _ctx: Context,
  action: { readonly from: string; readonly to: string },
): Promise<RemoteResult> => {
  validateRemoteName(action.from);
  validateRemoteName(action.to);
  return notYetImplemented('rename');
};

const setRemoteUrl = async (
  _ctx: Context,
  action: { readonly name: string; readonly url: string; readonly push?: boolean },
): Promise<RemoteResult> => {
  validateRemoteName(action.name);
  return notYetImplemented('setUrl');
};

const showRemote = async (
  _ctx: Context,
  action: { readonly name: string },
): Promise<RemoteResult> => {
  validateRemoteName(action.name);
  return notYetImplemented('show');
};
