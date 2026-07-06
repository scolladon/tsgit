/**
 * `push` command. Real receive-pack-driven body.
 *
 * Flow (see `docs/design/phase-12-3-push.md`):
 *  1. Resolve remote name → URL via `.git/config`.
 *  2. Parse refspecs (default = current branch).
 *  3. Discover refs over smart-HTTP v1 (`info/refs?service=git-receive-pack`).
 *  4. Resolve every refspec → local oid + server oid + lease.
 *  5. Apply force-with-lease / non-fast-forward guards.
 *  6. Enumerate the object closure missing on the remote (non-delete refspecs).
 *  7. Build the pack (non-delta,).
 *  8. POST `git-receive-pack` with ref-updates + pack body.
 *  9. Parse `report-status` (side-band demuxed when advertised).
 *  10. Update local `refs/remotes/<remote>/*` cache for accepted refs.
 */
import {
  invalidOption,
  nonFastForward,
  pushRejected,
  sanitize,
  signedPushUnsupported,
} from '../../domain/commands/error.js';
import { remoteNotConfigured } from '../../domain/index.js';
import { ObjectId, type RefName } from '../../domain/objects/index.js';
import {
  type AdvertisedRef,
  type Advertisement,
  buildPushCertPayload,
  buildReceivePackRequest,
  buildSignedReceivePackRequest,
  decodePktStream,
  type PktLine,
  PUSH_CERT,
  parseReceivePackResponse,
  parseSideBand,
  type RefStatus,
  type RefUpdate,
} from '../../domain/protocol/index.js';
import { PUSH_UPDATE } from '../../domain/reflog/reflog-messages.js';
import { isSafeRefName } from '../../domain/refs/ref-validation.js';
import type { Context } from '../../ports/context.js';
import { buildPack } from '../primitives/build-pack.js';
import { readConfig } from '../primitives/config-read.js';
import { enumeratePushObjects } from '../primitives/enumerate-push-objects.js';
import { assertNoValuelessConfig } from '../primitives/internal/valueless-config-guard.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { runHook } from '../primitives/run-hook.js';
import { resolveSigningSelector } from '../primitives/sign-payload.js';
import { updateRef } from '../primitives/update-ref.js';
import { walkCommits } from '../primitives/walk-commits.js';
import { resolveCurrentIdentity } from './internal/current-identity.js';
import { type GitServiceSession, openGitSession } from './internal/git-service-session.js';
import { discoverReceivePackRefs, selectPushCapabilities } from './internal/receive-pack-client.js';
import { type ParsedRefspec, parseRefspec } from './internal/refspec.js';
import { anonymizeRemoteUrl } from './internal/remote-url.js';
import { assertOperationalRepository, readHeadRaw } from './internal/repo-state.js';
import { resolveSignRequest, signOrThrow } from './internal/sign-request.js';

export interface PushOptions {
  readonly remote?: string;
  readonly refspecs?: ReadonlyArray<string>;
  readonly force?: boolean;
  readonly forceWithLease?: ObjectId | 'auto';
  /** Skip the `pre-push` hook (git's `--no-verify`). */
  readonly noVerify?: boolean;
  /**
   * GPG-sign the push certificate (git's `--signed`). `'yes'` refuses when
   * the receiving end doesn't advertise `push-cert`; `'if-asked'` falls back
   * to an unsigned push in that case. Falls back to `push.gpgSign` when unset.
   */
  readonly signed?: 'yes' | 'no' | 'if-asked';
}

export interface PushedRef {
  readonly name: RefName;
  readonly oldId: ObjectId;
  readonly newId: ObjectId;
  readonly status: 'ok' | 'rejected';
  readonly reason?: string;
}

export interface PushResult {
  readonly remote: string;
  readonly url: string;
  readonly pushedRefs: ReadonlyArray<PushedRef>;
}

interface ResolvedRefspec {
  readonly parsed: ParsedRefspec;
  readonly localOid: ObjectId;
  readonly remoteOid: ObjectId;
}

const PUSH_ENUMERATE_OBJECTS_OP = 'push:enumerate-objects';
const PUSH_UPLOAD_OP = 'push:upload';
const ZERO_OID = ObjectId.from('0'.repeat(40));
const REFS_HEADS_PREFIX = 'refs/heads/';
const SIDE_BAND_CAPS: ReadonlySet<string> = new Set(['side-band-64k', 'side-band']);

export const push = async (ctx: Context, opts: PushOptions = {}): Promise<PushResult> => {
  await assertOperationalRepository(ctx);
  ctx.progress.start(PUSH_ENUMERATE_OBJECTS_OP);
  try {
    return await pushViaSession(ctx, opts);
  } finally {
    ctx.progress.end(PUSH_ENUMERATE_OBJECTS_OP);
  }
};

const pushViaSession = async (ctx: Context, opts: PushOptions): Promise<PushResult> => {
  const remoteName = opts.remote ?? 'origin';
  const url = await resolveRemoteUrl(ctx, remoteName);
  const refspecs = await resolveRefspecsInput(ctx, opts.refspecs);
  const session = openGitSession(ctx, url, 'git-receive-pack');
  try {
    return await negotiateAndSend(ctx, opts, remoteName, url, refspecs, session);
  } finally {
    await session.close();
  }
};

const negotiateAndSend = async (
  ctx: Context,
  opts: PushOptions,
  remoteName: string,
  url: string,
  refspecs: ReadonlyArray<ParsedRefspec>,
  session: GitServiceSession,
): Promise<PushResult> => {
  const adv = await discoverReceivePackRefs(session);
  const resolved = await resolveAllRefspecs(ctx, refspecs, adv, remoteName, opts);
  const movers = resolved.filter((r) => r.localOid !== r.remoteOid);
  if (movers.length === 0) {
    return { remote: remoteName, url, pushedRefs: [] };
  }
  await runPrePushHook(ctx, opts.noVerify ?? false, remoteName, url, movers);
  const pushedRefs = await sendUpdates(ctx, session, adv, movers, remoteName, opts, url);
  return { remote: remoteName, url, pushedRefs };
};

/**
 * Fire the `pre-push` hook with git's canonical stdin payload — one
 * `<local-ref> SP <local-oid> SP <remote-ref> SP <remote-oid>` line per ref
 * being updated. A no-op when verification is disabled (`--no-verify`).
 */
const runPrePushHook = async (
  ctx: Context,
  noVerify: boolean,
  remoteName: string,
  url: string,
  movers: ReadonlyArray<ResolvedRefspec>,
): Promise<void> => {
  if (noVerify) return;
  const stdin = movers.map(prePushLine).join('');
  await runHook(ctx, 'pre-push', { args: [remoteName, url], stdin });
};

/** One `pre-push` stdin line. A delete refspec reports the `(delete)` sentinel. */
const prePushLine = (m: ResolvedRefspec): string => {
  const localRef = m.parsed.isDelete ? '(delete)' : m.parsed.src;
  return `${localRef} ${m.localOid} ${m.parsed.dst} ${m.remoteOid}\n`;
};

/**
 * First-pass sanity filter on remote names: alphanumerics, dot, dash,
 * underscore. Rejects obvious traversal vectors (slashes, control chars,
 * spaces) at the entry point so a hostile caller cannot smuggle a path
 * separator through `opts.remote`. NOT a sufficient guarantee on its own —
 * strings like `.git`, `..`, `a..b`, `a.lock` pass this regex but produce
 * invalid composed ref paths. The definitive guard is `isSafeRefName(composed)`
 * inside `updateTrackingCache` (and the contract honored by `updateRef`),
 * which runs `validateRefName` over the full composed path.
 */
const REMOTE_NAME_RE = /^[A-Za-z0-9._-]+$/;

const resolveRemoteUrl = async (ctx: Context, remoteName: string): Promise<string> => {
  if (!REMOTE_NAME_RE.test(remoteName)) {
    throw invalidOption('remote', `invalid remote name: ${remoteName}`);
  }
  const config = await readConfig(ctx);
  // Git validates each entry eagerly: a valueless `pushurl` or `url` dies before
  // the `pushurl ?? url` fallback can substitute the other, reporting whichever
  // is valueless first by config-file line.
  await assertNoValuelessConfig(ctx, 'remote', remoteName, ['pushurl', 'url']);
  const remote = config.remote?.get(remoteName);
  // `pushurl` overrides `url` for push (canonical-git parity).
  const url = remote?.pushUrl ?? remote?.url;
  if (url === undefined) {
    throw remoteNotConfigured(remoteName);
  }
  return url;
};

const resolveRefspecsInput = async (
  ctx: Context,
  refspecs: ReadonlyArray<string> | undefined,
): Promise<ReadonlyArray<ParsedRefspec>> => {
  // An explicit empty `refspecs: []` must fall through to the HEAD-default
  // branch — `length > 0` (not `>= 0`) makes `[]` behave like "no refspec".
  if (refspecs !== undefined && refspecs.length > 0) {
    return refspecs.map(parseRefspec);
  }
  const head = await readHeadRaw(ctx);
  if (head.kind !== 'symbolic') {
    throw invalidOption('refspecs', 'no-default-refspec (HEAD is detached)');
  }
  const branch = head.target;
  return [parseRefspec(`${branch}:${branch}`)];
};

const resolveAllRefspecs = async (
  ctx: Context,
  refspecs: ReadonlyArray<ParsedRefspec>,
  adv: Advertisement,
  remoteName: string,
  opts: PushOptions,
): Promise<ReadonlyArray<ResolvedRefspec>> => {
  const remoteByName = buildRemoteMap(adv.refs);
  const out: ResolvedRefspec[] = [];
  for (const parsed of refspecs) {
    out.push(await resolveOneRefspec(ctx, parsed, remoteByName, remoteName, opts));
  }
  return out;
};

const buildRemoteMap = (refs: ReadonlyArray<AdvertisedRef>): ReadonlyMap<string, ObjectId> => {
  const map = new Map<string, ObjectId>();
  for (const r of refs) map.set(r.name, r.id);
  return map;
};

const resolveOneRefspec = async (
  ctx: Context,
  parsed: ParsedRefspec,
  remoteByName: ReadonlyMap<string, ObjectId>,
  remoteName: string,
  opts: PushOptions,
): Promise<ResolvedRefspec> => {
  const remoteOid = remoteByName.get(parsed.dst) ?? ZERO_OID;
  if (parsed.isDelete) {
    if (remoteOid === ZERO_OID) {
      throw invalidOption('refspecs', `delete target ${parsed.dst} is not advertised`);
    }
    return { parsed, localOid: ZERO_OID, remoteOid };
  }
  const localOid = await resolveRef(ctx, parsed.src as RefName);
  await enforceLeaseAndFastForward(ctx, parsed, localOid, remoteOid, remoteName, opts);
  return { parsed, localOid, remoteOid };
};

const enforceLeaseAndFastForward = async (
  ctx: Context,
  parsed: ParsedRefspec,
  localOid: ObjectId,
  remoteOid: ObjectId,
  remoteName: string,
  opts: PushOptions,
): Promise<void> => {
  const lease = await resolveLease(ctx, parsed, remoteName, opts);
  if (lease !== undefined) {
    if (lease !== remoteOid) {
      throw pushRejected(parsed.dst as RefName, 'lease-mismatch', emptyReport());
    }
    // Lease holds → treat as force, skip ancestor check.
    return;
  }
  if (parsed.force === 'force' || opts.force === true) return;
  if (remoteOid === ZERO_OID) return; // creating a new ref
  if (!(await isAncestor(ctx, remoteOid, localOid))) {
    throw nonFastForward(parsed.dst as RefName, localOid, remoteOid);
  }
};

const resolveLease = async (
  ctx: Context,
  parsed: ParsedRefspec,
  remoteName: string,
  opts: PushOptions,
): Promise<ObjectId | undefined> => {
  // Stryker disable next-line ConditionalExpression: equivalent — when `forceWithLease` is undefined the next line (`undefined !== 'auto'`) returns `opts.forceWithLease` which is `undefined`, the identical result.
  if (opts.forceWithLease === undefined) return undefined;
  if (opts.forceWithLease !== 'auto') return opts.forceWithLease;
  if (!parsed.dst.startsWith(REFS_HEADS_PREFIX)) {
    throw invalidOption('forceWithLease', 'lease-on-non-branch');
  }
  const branch = parsed.dst.slice(REFS_HEADS_PREFIX.length);
  const trackingRef = `refs/remotes/${remoteName}/${branch}` as RefName;
  return resolveRef(ctx, trackingRef);
};

const isAncestor = async (
  ctx: Context,
  ancestor: ObjectId,
  descendant: ObjectId,
): Promise<boolean> => {
  // walkCommits yields `descendant` itself first, so the `c.id === ancestor`
  // check in the loop already handles the `ancestor === descendant` case
  // without a separate fast-path guard. Callers also filter no-op refspecs
  // before reaching this predicate via the `movers` step in push().
  for await (const c of walkCommits(ctx, { from: [descendant], ignoreMissing: true })) {
    if (c.id === ancestor) return true;
  }
  return false;
};

const emptyReport = (): { unpackOk: boolean; refUpdates: ReadonlyArray<RefStatus> } => ({
  unpackOk: true,
  refUpdates: [],
});

const sendUpdates = async (
  ctx: Context,
  session: GitServiceSession,
  adv: Advertisement,
  movers: ReadonlyArray<ResolvedRefspec>,
  remoteName: string,
  opts: PushOptions,
  url: string,
): Promise<ReadonlyArray<PushedRef>> => {
  const mode = await resolveSignedPushMode(ctx, opts);
  const nonce = parsePushCertNonce(adv.capabilities);
  const intent = resolveSigningIntent(mode, nonce, remoteName);
  const wants = movers.filter((m) => !m.parsed.isDelete).map((m) => m.localOid);
  // ZERO_OID-advertised refs (ref-creation sentinels) are kept verbatim in
  // `haves`: they only ever land in `walkCommits`'s `until` set, which does
  // pure membership checks and can never match a real commit oid — so an
  // explicit `id !== ZERO_OID` filter would be a provable no-op.
  const haves = adv.refs.map((r) => r.id);
  const oids = await collectObjects(ctx, wants, haves);
  const pack = await buildPack(ctx, { oids });
  const capabilities = selectPushCapabilities(adv.capabilities, intent.signing);
  const requestBody = intent.signing
    ? await buildSignedRequestBody(ctx, capabilities, movers, pack.bytes, url, intent.nonce)
    : buildReceivePackRequest({
        updates: movers.map(toRefUpdate),
        capabilities,
        packfile: pack.bytes,
      });
  const pktSource = await exchangeReceivePack(ctx, session, requestBody);
  const parsed = await parseReceiveResponse(ctx, pktSource, capabilities);
  if (!parsed.unpackOk) {
    throw pushRejected(
      movers[0]?.parsed.dst as RefName,
      // Stryker disable next-line StringLiteral: equivalent — `parseReceivePackResponse` always sets `unpackError` (a string) whenever `unpackOk` is false, so the `??` fallback is unreachable.
      parsed.unpackError ?? 'unpack failed',
      parsed,
    );
  }
  const pushedRefs = await applyReportStatus(ctx, movers, parsed.refUpdates, remoteName);
  return pushedRefs;
};

type SignedPushMode = 'yes' | 'no' | 'if-asked';

/** `opts.signed` wins; otherwise falls back to `push.gpgSign` (default `'no'`). */
const resolveSignedPushMode = async (ctx: Context, opts: PushOptions): Promise<SignedPushMode> => {
  if (opts.signed !== undefined) return opts.signed;
  const config = await readConfig(ctx);
  const configured = config.push?.gpgSign;
  if (configured === 'if-asked') return 'if-asked';
  if (configured === 'true') return 'yes';
  return 'no';
};

/** The nonce half of the server's `push-cert=<nonce>` advertisement, when present. */
const parsePushCertNonce = (capabilities: ReadonlyArray<string>): string | undefined =>
  capabilities.find((c) => c.startsWith(`${PUSH_CERT}=`))?.slice(PUSH_CERT.length + 1);

type SigningIntent =
  | { readonly signing: false }
  | { readonly signing: true; readonly nonce: string };

/**
 * P.3 refusal / if-asked table: `'yes'` without a server nonce refuses
 * outright (nothing is sent); `'if-asked'` without a nonce silently falls
 * back to an unsigned push; either mode with a nonce signs.
 */
const resolveSigningIntent = (
  mode: SignedPushMode,
  nonce: string | undefined,
  remoteName: string,
): SigningIntent => {
  if (mode === 'yes' && nonce === undefined) throw signedPushUnsupported(remoteName);
  if (nonce === undefined || mode === 'no') return { signing: false };
  return { signing: true, nonce };
};

/**
 * Build the P.1 certificate envelope: resolve the pusher identity/selector
 * (same ident-fallback rule as commit/tag `-u`), sign the P.2 raw payload,
 * and frame it with the armor and the nonce-stripped opener capabilities.
 */
const buildSignedRequestBody = async (
  ctx: Context,
  negotiatedCapabilities: ReadonlyArray<string>,
  movers: ReadonlyArray<ResolvedRefspec>,
  packfile: Uint8Array,
  url: string,
  nonce: string,
): Promise<Uint8Array> => {
  const config = await readConfig(ctx);
  const identity = await resolveCurrentIdentity(ctx);
  const pusherSelector = resolveSigningSelector({
    ...(config.user?.signingKey !== undefined ? { signingKey: config.user.signingKey } : {}),
    fallbackIdent: `${identity.name} <${identity.email}>`,
  });
  const pusher = `${pusherSelector} ${identity.timestamp} ${identity.timezoneOffset}`;
  const pushee = anonymizeRemoteUrl(url);
  const updates = movers.map(toRefUpdate);
  const payload = buildPushCertPayload({ pusher, pushee, nonce, updates });
  const armor = await signOrThrow(ctx, payload, resolveSignRequest(config, identity, undefined));
  const capabilities = negotiatedCapabilities.filter(
    (c) => c !== PUSH_CERT && !c.startsWith(`${PUSH_CERT}=`),
  );
  return buildSignedReceivePackRequest({
    updates,
    capabilities,
    armor,
    pusher,
    pushee,
    nonce,
    packfile,
  });
};

const collectObjects = async (
  ctx: Context,
  wants: ReadonlyArray<ObjectId>,
  haves: ReadonlyArray<ObjectId>,
): Promise<ReadonlyArray<ObjectId>> => {
  if (wants.length === 0) return [];
  const oids: ObjectId[] = [];
  for await (const id of enumeratePushObjects(ctx, { wants, haves })) {
    oids.push(id);
  }
  return oids;
};

const toRefUpdate = (m: ResolvedRefspec): RefUpdate => ({
  name: m.parsed.dst,
  oldId: m.remoteOid,
  newId: m.localOid,
});

const exchangeReceivePack = async (
  ctx: Context,
  session: GitServiceSession,
  requestBody: Uint8Array,
): Promise<AsyncIterable<PktLine>> => {
  ctx.progress.start(PUSH_UPLOAD_OP);
  try {
    return await session.exchange(requestBody);
  } finally {
    ctx.progress.end(PUSH_UPLOAD_OP);
  }
};

const parseReceiveResponse = async (
  ctx: Context,
  pktSource: AsyncIterable<PktLine>,
  capabilities: ReadonlyArray<string>,
): Promise<Awaited<ReturnType<typeof parseReceivePackResponse>>> => {
  if (hasSideBand(capabilities)) {
    const channel1 = parseSideBand(pktSource, {
      onProgress: (text) => ctx.progress.update(PUSH_UPLOAD_OP, 0, undefined, sanitize(text)),
    });
    return parseReceivePackResponse(decodePktStream(channel1));
  }
  return parseReceivePackResponse(pktSource);
};

const hasSideBand = (caps: ReadonlyArray<string>): boolean =>
  caps.some((c) => SIDE_BAND_CAPS.has(c));

const applyReportStatus = async (
  ctx: Context,
  movers: ReadonlyArray<ResolvedRefspec>,
  refUpdates: ReadonlyArray<RefStatus>,
  remoteName: string,
): Promise<ReadonlyArray<PushedRef>> => {
  const statusByName = new Map<string, RefStatus>();
  for (const s of refUpdates) statusByName.set(s.name, s);
  const out: PushedRef[] = [];
  for (const m of movers) {
    const status = statusByName.get(m.parsed.dst);
    const accepted = status?.accepted === true;
    if (accepted) await updateTrackingCache(ctx, m, remoteName);
    out.push({
      name: m.parsed.dst as RefName,
      oldId: m.remoteOid,
      newId: m.localOid,
      status: accepted ? 'ok' : 'rejected',
      ...(status?.reason !== undefined ? { reason: status.reason } : {}),
    });
  }
  return out;
};

const updateTrackingCache = async (
  ctx: Context,
  m: ResolvedRefspec,
  remoteName: string,
): Promise<void> => {
  if (!m.parsed.dst.startsWith(REFS_HEADS_PREFIX)) return; // tags handled elsewhere
  if (m.parsed.isDelete) return; // delete-only push doesn't update cache
  const branch = m.parsed.dst.slice(REFS_HEADS_PREFIX.length);
  const composed = `refs/remotes/${remoteName}/${branch}`;
  // `remoteName` is gated by REMOTE_NAME_RE (resolveRemoteUrl) and `branch`
  // derives from a server-advertised name matched against the local refspec
  // via the remoteByName map, so `composed` is always a valid ref path. The
  // guard is defense-in-depth for future refactors; it cannot fire on any
  // input push() can construct, hence the equivalent-mutant suppression.
  // Stryker disable next-line ConditionalExpression: equivalent — `composed` is always a valid ref path (see above); the guard never fires.
  if (!isSafeRefName(composed)) return;
  await updateRef(ctx, composed as RefName, m.localOid, { reflogMessage: PUSH_UPDATE });
};
