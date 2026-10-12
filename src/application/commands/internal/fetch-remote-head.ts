/**
 * git fetch's `set_head`: after a fetch by a remote's own refspecs, point
 * `refs/remotes/<remote>/HEAD` at the tracking ref of the branch the remote's
 * HEAD names, as `remote.<remote>.followRemoteHEAD` says — `create` (git's
 * default) only when it is absent, `always` every time, `warn` like `create`
 * but reporting a local HEAD that differs, `never` not at all.
 */
import { type ObjectId, RefName } from '../../../domain/objects/index.js';
import { zeroOid } from '../../../domain/objects/object-id.js';
import type { AdvertisedRef, Advertisement } from '../../../domain/protocol/index.js';
import type { Context } from '../../../ports/context.js';
import { findSubsectionEntries } from '../../primitives/config-read.js';
import { getRefStore, type ResolveDirectResult } from '../../primitives/ref-store.js';
import { resolveRefOrMissing } from '../../primitives/resolve-ref.js';

export interface RemoteHeadPolicy {
  readonly mode: 'never' | 'create' | 'warn' | 'always';
  /** `warn-if-not-<branch>`: no report while the remote HEAD names this branch. */
  readonly noWarnBranch?: string;
}

const DEFAULT_POLICY: RemoteHeadPolicy = { mode: 'create' };
const WARN_IF_NOT = 'warn-if-not-';
const FIXED_MODES: ReadonlySet<string> = new Set(['never', 'create', 'warn', 'always']);
const HEADS_PREFIX = 'refs/heads/';
const SYMREF_HEAD = 'symref=HEAD:';
const SET_HEAD_REFLOG = 'fetch';

/** git's `handle_config` for `followRemoteHEAD`: each entry overrides, an unrecognised one is ignored with a warning. */
export const readRemoteHeadPolicy = async (
  ctx: Context,
  remote: string,
): Promise<RemoteHeadPolicy> => {
  let policy = DEFAULT_POLICY;
  for (const { value } of await findSubsectionEntries(ctx, 'remote', remote, 'followRemoteHEAD')) {
    // Stryker disable next-line StringLiteral: equivalent — '' and any other non-mode, non-prefixed string both parse to undefined
    const parsed = parsePolicy(value ?? '');
    if (parsed === undefined) {
      ctx.logger?.warn?.('unrecognized followRemoteHEAD value ignored', { remote, value });
      continue;
    }
    policy = parsed;
  }
  return policy;
};

const parsePolicy = (value: string): RemoteHeadPolicy | undefined => {
  if (FIXED_MODES.has(value)) return { mode: value as RemoteHeadPolicy['mode'] };
  if (value.startsWith(WARN_IF_NOT)) {
    return { mode: 'warn', noWarnBranch: value.slice(WARN_IF_NOT.length) };
  }
  return undefined;
};

export const followRemoteHead = async (
  ctx: Context,
  remote: string,
  advertisement: Advertisement,
  policy: RemoteHeadPolicy,
): Promise<void> => {
  if (policy.mode === 'never') return;
  const headName = guessRemoteHead(advertisement);
  if (headName === undefined) return;
  const store = getRefStore(ctx);
  const tracking = RefName.from(`refs/remotes/${remote}/${headName}`);
  const trackingValue = await store.resolveDirect(tracking);
  if (trackingValue.kind !== 'direct') return;
  const remoteHead = RefName.from(`refs/remotes/${remote}/HEAD`);
  const local = await store.resolveDirect(remoteHead);
  if (policy.mode === 'always' || local.kind === 'missing') {
    await pointRemoteHead(ctx, remoteHead, tracking, trackingValue.id);
  }
  if (policy.mode === 'warn' && policy.noWarnBranch !== headName) {
    reportDifference(ctx, remote, headName, local);
  }
};

/** git's `guess_remote_head` over `refs/heads/*`, every match: the symref target, else the one branch at HEAD's oid. */
const guessRemoteHead = ({ capabilities, refs }: Advertisement): string | undefined => {
  const head = refs.find((ref) => ref.name === 'HEAD');
  if (head === undefined) return undefined;
  const branches = refs.filter((ref) => ref.name.startsWith(HEADS_PREFIX));
  const symref = capabilities.find((capability) => capability.startsWith(SYMREF_HEAD));
  const matches =
    symref === undefined
      ? branches.filter((ref) => ref.id === head.id)
      : branches.filter((ref) => ref.name === symref.slice(SYMREF_HEAD.length));
  return matches.length === 1 ? shortName(matches[0]!) : undefined;
};

const shortName = (ref: AdvertisedRef): string => ref.name.slice(HEADS_PREFIX.length);

/** The symref write git logs from what the remote HEAD resolved to before, to the target's oid. */
const pointRemoteHead = async (
  ctx: Context,
  name: RefName,
  target: RefName,
  id: ObjectId,
): Promise<void> => {
  const oldId = (await resolveRefOrMissing(ctx, name)) ?? zeroOid(ctx.hashConfig);
  await getRefStore(ctx).applyRefUpdates([
    { kind: 'setSymbolic', name, target, reflog: { oldId, newId: id, message: SET_HEAD_REFLOG } },
  ]);
};

/** git's `report_set_head`: a local HEAD naming another branch, or detached. */
const reportDifference = (
  ctx: Context,
  remote: string,
  headName: string,
  local: ResolveDirectResult,
): void => {
  const prefix = `refs/remotes/${remote}/`;
  if (local.kind === 'symbolic' && local.target.startsWith(prefix)) {
    const previous = local.target.slice(prefix.length);
    if (previous === headName) return;
    ctx.logger?.warn?.("'HEAD' at the remote differs from the one we have locally", {
      remote,
      headName,
      local: previous,
    });
    return;
  }
  if (local.kind !== 'direct') return;
  ctx.logger?.warn?.("'HEAD' at the remote differs from the detached HEAD we have locally", {
    remote,
    headName,
    id: local.id,
  });
};
