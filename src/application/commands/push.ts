/**
 * `push` command. Real receive-pack-driven body.
 *
 * Flow (see `docs/design/phase-12-3-push.md`):
 *  1. Resolve remote name → URL via `.git/config`.
 *  2. Parse refspecs (default = current branch).
 *  3. Discover refs over smart-HTTP v1 (`info/refs?service=git-receive-pack`).
 *  4. Resolve every refspec → local oid + server oid + lease.
 *  5. Judge each ref as git's `set_ref_status_for_push` does; a rejected ref
 *     is reported, not thrown, and the push carries on with the rest.
 *  6. Enumerate the object closure missing on the remote (non-delete refspecs).
 *  7. Build the pack (non-delta,).
 *  8. POST `git-receive-pack` with ref-updates + pack body.
 *  9. Parse `report-status` (side-band demuxed when advertised).
 *  10. Update local `refs/remotes/<remote>/*` cache for accepted refs.
 */
import {
  atomicPushUnsupported,
  configBadBooleanLiteral,
  invalidOption,
  invalidPushDefault,
  pushRejected,
  sanitize,
  signedPushUnsupported,
} from '../../domain/commands/error.js';
import { remoteNotConfigured } from '../../domain/index.js';
import { type ObjectId, type RefName, zeroOid } from '../../domain/objects/index.js';
import {
  type AdvertisedRef,
  type Advertisement,
  ATOMIC,
  buildPushCertPayload,
  buildReceivePackRequest,
  buildSignedReceivePackRequest,
  DELETE_REFS,
  decodePktStream,
  type PktLine,
  PUSH_CERT,
  parseReceivePackResponse,
  parseSideBand,
  type RefStatus,
  type RefUpdate,
  readObjectFormat,
} from '../../domain/protocol/index.js';
import { PUSH_UPDATE } from '../../domain/reflog/reflog-messages.js';
import { HEADS_PREFIX, TAGS_PREFIX } from '../../domain/refs/ref-prefixes.js';
import { isSafeRefName } from '../../domain/refs/ref-validation.js';
import { shortBranchName } from '../../domain/refs/short-branch-name.js';
import type { Context } from '../../ports/context.js';
import { buildPack } from '../primitives/build-pack.js';
import {
  findFirstInvalidPushGpgSign,
  findInvalidPushDefault,
  readConfig,
} from '../primitives/config-read.js';
import { enumerateRefs } from '../primitives/enumerate-refs.js';
import { hasObject } from '../primitives/has-object.js';
import { type ClosureTip, computeClosure } from '../primitives/internal/closure-engine.js';
import { boundedMapFor } from '../primitives/internal/concurrency.js';
import { lookupTypedCommitReferenceQuietly } from '../primitives/internal/lookup-commit-reference.js';
import {
  createObjectTypeTable,
  type ObjectTypeTable,
} from '../primitives/internal/object-type-table.js';
import { assertNoValuelessConfig } from '../primitives/internal/valueless-config-guard.js';
import { resolveRef, resolveRefOrMissing } from '../primitives/resolve-ref.js';
import { runHook } from '../primitives/run-hook.js';
import { resolveSigningSelector } from '../primitives/sign-payload.js';
import { updateRef } from '../primitives/update-ref.js';
import { resolveCurrentIdentity } from './internal/current-identity.js';
import { assertValidRemoteName, resolvePushRemote } from './internal/default-remote.js';
import { type GitServiceSession, openGitSession } from './internal/git-service-session.js';
import { isAncestor } from './internal/is-ancestor.js';
import { assertPeerAlgorithm } from './internal/object-format-guard.js';
import {
  finalizePushRefspecs,
  type PushRefspecPlan,
  planPushRefspecs,
} from './internal/push-refspecs.js';
import { discoverReceivePackRefs, selectPushCapabilities } from './internal/receive-pack-client.js';
import type { ParsedRefspec } from './internal/refspec.js';
import { readRemoteConfig } from './internal/remote-config.js';
import { anonymizeRemoteUrl } from './internal/remote-url.js';
import {
  assertOperationalRepository,
  branchRefFromHead,
  readHeadRaw,
} from './internal/repo-state.js';
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
  /**
   * All refs or none (git's `--atomic`): any ref rejected before sending fails
   * the others as `'atomic-push-failed'` and nothing is sent. Throws
   * `ATOMIC_PUSH_UNSUPPORTED` when the server does not advertise `atomic`.
   */
  readonly atomic?: boolean;
}

/**
 * Why a ref was not updated. All but `'remote'` are judged locally before
 * anything is sent: git's `REJECT_NONFASTFORWARD`, `REJECT_NEEDS_FORCE`,
 * `REJECT_FETCH_FIRST`, `REJECT_ALREADY_EXISTS`, `REJECT_STALE` (a
 * `forceWithLease` expectation the remote no longer holds),
 * `REJECT_NODELETE` (a delete the server cannot take, lacking `delete-refs`)
 * and `ATOMIC_PUSH_FAILED` (a ref held back because another failed an atomic
 * push). `'remote'` is the receiving end's `ng`, whose text is kept in
 * {@link PushedRef.reason}.
 */
export type PushRejection =
  | 'non-fast-forward'
  | 'needs-force'
  | 'fetch-first'
  | 'already-exists'
  | 'stale-info'
  | 'remote-ref-not-deletable'
  | 'atomic-push-failed'
  | 'remote';

type ClientRejection = Exclude<PushRejection, 'remote'>;
/** A rejection a ref earns on its own, before an atomic push fails the rest. */
type JudgedRejection = Exclude<ClientRejection, 'atomic-push-failed'>;

export interface PushedRef {
  readonly name: RefName;
  readonly oldId: ObjectId;
  readonly newId: ObjectId;
  readonly status: 'ok' | 'rejected';
  /** Set exactly when `status` is `'rejected'`. */
  readonly rejection?: PushRejection;
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
  readonly rejection?: JudgedRejection;
}

interface SettledRefspec extends Omit<ResolvedRefspec, 'rejection'> {
  readonly rejection?: ClientRejection;
}

/** git's `enum ref_status` value for each rejection, as its atomic error prints it. */
const GIT_REF_STATUS: Readonly<Record<JudgedRejection, number>> = {
  'non-fast-forward': 2,
  'already-exists': 3,
  'remote-ref-not-deletable': 4,
  'fetch-first': 5,
  'needs-force': 6,
  'stale-info': 7,
};

const PUSH_ENUMERATE_OBJECTS_OP = 'push:enumerate-objects';
const PUSH_UPLOAD_OP = 'push:upload';
const SIDE_BAND_CAPS: ReadonlySet<string> = new Set(['side-band-64k', 'side-band']);

// Real git validates `push.default` AND `push.gpgSign` in the same config
// callback pass on the cold path — before the remote resolves or any session
// opens, even when nothing will be pushed — so the first malformed LINE wins
// regardless of which key it belongs to (measured: swapping the two lines
// swaps which error git reports).
const assertValidPushConfig = async (ctx: Context): Promise<void> => {
  const [badDefault, badGpgSign] = await Promise.all([
    findInvalidPushDefault(ctx),
    findFirstInvalidPushGpgSign(ctx),
  ]);
  const defaultWins =
    // Stryker disable next-line EqualityOperator: equivalent — badDefault (push.default) and badGpgSign (push.gpgsign) are different keys, and the tokenizer yields at most one entry per physical config line, so badDefault.line === badGpgSign.line can never hold; `<` and `<=` decide identically here.
    badDefault !== undefined && (badGpgSign === undefined || badDefault.line < badGpgSign.line);
  if (defaultWins) {
    throw invalidPushDefault(badDefault.value, badDefault.source, badDefault.line);
  }
  if (badGpgSign !== undefined) {
    throw configBadBooleanLiteral(badGpgSign.key, badGpgSign.source, badGpgSign.value);
  }
};

export const push = async (ctx: Context, opts: PushOptions = {}): Promise<PushResult> => {
  await assertOperationalRepository(ctx);
  await assertValidPushConfig(ctx);
  ctx.progress.start(PUSH_ENUMERATE_OBJECTS_OP);
  try {
    return await pushViaSession(ctx, opts);
  } finally {
    ctx.progress.end(PUSH_ENUMERATE_OBJECTS_OP);
  }
};

const pushViaSession = async (ctx: Context, opts: PushOptions): Promise<PushResult> => {
  const head = await readHeadRaw(ctx);
  const branchRef = branchRefFromHead(head);
  const currentBranch = branchRef !== undefined ? shortBranchName(branchRef) : undefined;
  const config = await readRemoteConfig(ctx);
  const remoteName = resolvePushRemote(config, opts.remote, currentBranch);
  const url = await resolveRemoteUrl(ctx, remoteName);
  const plan = await planPushRefspecs(config, opts, head);
  const session = openGitSession(ctx, url, 'git-receive-pack');
  try {
    return await negotiateAndSend(ctx, opts, remoteName, url, plan, session);
  } finally {
    await session.close();
  }
};

const negotiateAndSend = async (
  ctx: Context,
  opts: PushOptions,
  remoteName: string,
  url: string,
  plan: PushRefspecPlan,
  session: GitServiceSession,
): Promise<PushResult> => {
  const adv = await discoverReceivePackRefs(session);
  const localHeads =
    // Stryker disable next-line ConditionalExpression: equivalent — forcing the guard true also computes localHeads for non-matching plans, but finalizePushRefspecs ignores localHeads unless the plan is 'matching', so the extra value is discarded and the result is unchanged.
    plan.kind === 'matching'
      ? // Stryker disable next-line MethodExpression: equivalent — finalizePushRefspecs intersects localHeads with the head-only advertised set, so dropping this refs/heads/ pre-filter cannot change the resolved refspecs.
        (await enumerateRefs(ctx)).filter((ref) => ref.startsWith(HEADS_PREFIX))
      : [];
  const refspecs = finalizePushRefspecs(plan, adv, localHeads);
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
  // git's pre-push feed skips a non-fast-forward or stale ref but lists the other rejections.
  const stdin = movers
    .filter((m) => m.rejection !== 'non-fast-forward' && m.rejection !== 'stale-info')
    .map(prePushLine)
    .join('');
  await runHook(ctx, 'pre-push', { args: [remoteName, url], stdin });
};

/** One `pre-push` stdin line. A delete refspec reports the `(delete)` sentinel. */
const prePushLine = (m: ResolvedRefspec): string => {
  const localRef = m.parsed.isDelete ? '(delete)' : m.parsed.src;
  return `${localRef} ${m.localOid} ${m.parsed.dst} ${m.remoteOid}\n`;
};

const resolveRemoteUrl = async (ctx: Context, remoteName: string): Promise<string> => {
  assertValidRemoteName(remoteName);
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

/** What every refspec of one push resolves against: the advertised refs, the
 *  remote and options, and the object table git's push process carries. */
interface RefspecScope {
  readonly remoteByName: ReadonlyMap<string, ObjectId>;
  readonly remoteName: string;
  readonly opts: PushOptions;
  readonly table: ObjectTypeTable;
}

const resolveAllRefspecs = async (
  ctx: Context,
  refspecs: ReadonlyArray<ParsedRefspec>,
  adv: Advertisement,
  remoteName: string,
  opts: PushOptions,
): Promise<ReadonlyArray<ResolvedRefspec>> => {
  const scope: RefspecScope = {
    remoteByName: buildRemoteMap(adv.refs),
    remoteName,
    opts,
    table: createObjectTypeTable(),
  };
  const located: ResolvedRefspec[] = [];
  for (const parsed of refspecs) {
    located.push(await locateRefspec(ctx, parsed, scope));
  }
  const out: ResolvedRefspec[] = [];
  for (const ref of inRemoteOrder(located, adv)) {
    out.push(await judgeRefspec(ctx, ref, scope));
  }
  return out;
};

/**
 * git's `remote_refs` list: the advertised refs in advertisement order, then
 * each ref the push creates, appended in refspec order as it is matched.
 */
const inRemoteOrder = (
  located: ReadonlyArray<ResolvedRefspec>,
  adv: Advertisement,
): ReadonlyArray<ResolvedRefspec> => {
  const position = new Map(adv.refs.map((ref, index) => [ref.name, index]));
  const rank = (ref: ResolvedRefspec): number =>
    position.get(ref.parsed.dst) ?? Number.POSITIVE_INFINITY;
  return [...located].sort((a, b) => rank(a) - rank(b));
};

const buildRemoteMap = (refs: ReadonlyArray<AdvertisedRef>): ReadonlyMap<string, ObjectId> => {
  const map = new Map<string, ObjectId>();
  for (const r of refs) map.set(r.name, r.id);
  return map;
};

const locateRefspec = async (
  ctx: Context,
  parsed: ParsedRefspec,
  scope: RefspecScope,
): Promise<ResolvedRefspec> => {
  const zero = zeroOid(ctx.hashConfig);
  const remoteOid = scope.remoteByName.get(parsed.dst) ?? zero;
  if (parsed.isDelete && remoteOid === zero) {
    throw invalidOption('refspecs', `delete target ${parsed.dst} is not advertised`);
  }
  const localOid = parsed.isDelete ? zero : await resolveRef(ctx, parsed.src as RefName);
  return { parsed, localOid, remoteOid };
};

const judgeRefspec = async (
  ctx: Context,
  ref: ResolvedRefspec,
  scope: RefspecScope,
): Promise<ResolvedRefspec> => {
  // git settles an up-to-date ref before the lease or any lookup.
  if (ref.localOid === ref.remoteOid) return ref;
  const rejection = await judgeUpdate(ctx, ref, scope);
  return rejection === undefined ? ref : { ...ref, rejection };
};

/**
 * git's `set_ref_status_for_push`: a stale lease is rejected as stale info;
 * otherwise a delete or a new ref is not judged and any other update is
 * measured — forced or not, as git measures it before force overrides it.
 * Force overrides every verdict; a lease that holds forces the update.
 */
const judgeUpdate = async (
  ctx: Context,
  ref: ResolvedRefspec,
  scope: RefspecScope,
): Promise<JudgedRejection | undefined> => {
  const lease = await resolveLease(ctx, ref.parsed, scope.remoteName, scope.opts);
  const stale = lease !== undefined && lease !== ref.remoteOid;
  const rejection = stale ? 'stale-info' : await measureUpdate(ctx, scope.table, ref);
  const forced = (lease !== undefined && !stale) || isForced(ref.parsed, scope.opts);
  return forced ? undefined : rejection;
};

const isForced = (parsed: ParsedRefspec, opts: PushOptions): boolean =>
  parsed.force === 'force' || opts.force === true;

const measureUpdate = async (
  ctx: Context,
  table: ObjectTypeTable,
  { parsed, localOid, remoteOid }: ResolvedRefspec,
): Promise<JudgedRejection | undefined> => {
  if (parsed.isDelete || remoteOid === zeroOid(ctx.hashConfig)) return undefined;
  return rejectionOf(ctx, table, parsed.dst, localOid, remoteOid);
};

/**
 * git's rules in order: a tag destination that exists, an advertised end not
 * held locally, either end not a commit (looked up quietly, advertised end
 * first, into the push's table), then `ref_newer`'s two-commit walk.
 */
const rejectionOf = async (
  ctx: Context,
  table: ObjectTypeTable,
  dst: string,
  localOid: ObjectId,
  remoteOid: ObjectId,
): Promise<JudgedRejection | undefined> => {
  if (dst.startsWith(TAGS_PREFIX)) return 'already-exists';
  if (!(await hasObject(ctx, remoteOid, { mode: 'recheck' }))) return 'fetch-first';
  const old = await lookupTypedCommitReferenceQuietly(ctx, table, remoteOid);
  if (old === undefined) return 'needs-force';
  const fresh = await lookupTypedCommitReferenceQuietly(ctx, table, localOid);
  if (fresh === undefined) return 'needs-force';
  return (await isAncestor(ctx, old, fresh, table)) ? undefined : 'non-fast-forward';
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
  return trackedValue(ctx, parsed.dst, remoteName);
};

/**
 * git's `remote_tracking` for an automatic lease: the branch's remote-tracking
 * ref, or — when the destination is no branch or nothing tracks it — the null
 * id, so the lease expects the remote ref absent.
 */
const trackedValue = async (ctx: Context, dst: string, remoteName: string): Promise<ObjectId> => {
  const absent = zeroOid(ctx.hashConfig);
  if (!dst.startsWith(HEADS_PREFIX)) return absent;
  const trackingRef = `refs/remotes/${remoteName}/${dst.slice(HEADS_PREFIX.length)}` as RefName;
  return (await resolveRefOrMissing(ctx, trackingRef)) ?? absent;
};

// git's `need_pack_data` is false when every command sent is a delete: no pack,
// so nothing is read from the object store.
const buildPackfileFor = async (
  ctx: Context,
  accepted: ReadonlyArray<SettledRefspec>,
  feed: ReadonlyArray<ClosureTip>,
): Promise<Uint8Array | undefined> => {
  if (accepted.every((m) => m.parsed.isDelete)) return undefined;
  const oids = await collectObjects(ctx, feed);
  const pack = await buildPack(ctx, { objects: oids.map((id) => ({ id })) });
  return pack.bytes;
};

const sendUpdates = async (
  ctx: Context,
  session: GitServiceSession,
  adv: Advertisement,
  movers: ReadonlyArray<ResolvedRefspec>,
  remoteName: string,
  opts: PushOptions,
  url: string,
): Promise<ReadonlyArray<PushedRef>> => {
  assertPeerAlgorithm(ctx.hashConfig.algorithm, readObjectFormat(adv.capabilities), 'push');
  const mode = await resolveSignedPushMode(ctx, opts);
  const nonce = parsePushCertNonce(adv.capabilities);
  const intent = resolveSigningIntent(mode, nonce, remoteName);
  const settled = settleBeforeSending(ctx, adv, movers, opts, remoteName);
  const accepted = settled.filter((m) => m.rejection === undefined);
  // git's send_pack sends no command, and so nothing at all, when every ref was rejected.
  if (accepted.length === 0) return applyReportStatus(ctx, settled, [], remoteName);
  // Zero-oid-advertised refs (ref-creation sentinels) are kept verbatim in
  // the feed: `hasObject(ctx, zeroOid)` is always false (no pack hit, no
  // loose file), so the sentinel drops out of `collectObjects`'s negatives on
  // its own — one absent negative among others, not a special case.
  const packfile = await buildPackfileFor(ctx, accepted, sendPackFeed(adv, movers));
  const capabilities = selectPushCapabilities(
    adv.capabilities,
    ctx.hashConfig.algorithm,
    capabilityOptIns(opts),
  );
  const requestBody = intent.signing
    ? await buildSignedRequestBody(ctx, capabilities, accepted, packfile, url, intent.nonce)
    : buildReceivePackRequest({
        updates: accepted.map(toRefUpdate),
        capabilities,
        packfile,
      });
  const pktSource = await exchangeReceivePack(ctx, session, requestBody);
  const parsed = await parseReceiveResponse(ctx, pktSource, capabilities);
  if (!parsed.unpackOk) {
    throw pushRejected(
      accepted[0]?.parsed.dst as RefName,
      // Stryker disable next-line StringLiteral: equivalent — `parseReceivePackResponse` always sets `unpackError` (a string) whenever `unpackOk` is false, so the `??` fallback is unreachable.
      parsed.unpackError ?? 'unpack failed',
      parsed,
    );
  }
  const pushedRefs = await applyReportStatus(ctx, settled, parsed.refUpdates, remoteName);
  return pushedRefs;
};

const capabilityOptIns = (opts: PushOptions): ReadonlyArray<string> =>
  opts.atomic === true ? [ATOMIC] : [];

/**
 * git's `send_pack` before it writes a command: an atomic push the server
 * cannot take dies, every delete is refused when the server lacks
 * `delete-refs`, and an atomic push with any rejected ref fails the rest.
 */
const settleBeforeSending = (
  ctx: Context,
  adv: Advertisement,
  movers: ReadonlyArray<ResolvedRefspec>,
  opts: PushOptions,
  remoteName: string,
): ReadonlyArray<SettledRefspec> => {
  const atomic = opts.atomic === true;
  if (atomic && !adv.capabilities.includes(ATOMIC)) throw atomicPushUnsupported(remoteName);
  const deletable = adv.capabilities.includes(DELETE_REFS);
  const judged = movers.map((m) =>
    m.parsed.isDelete && !deletable ? { ...m, rejection: 'remote-ref-not-deletable' as const } : m,
  );
  return atomic ? failAtomicPush(ctx, judged) : judged;
};

/** git's `reject_atomic_push`: the first rejected ref fails every accepted one. */
const failAtomicPush = (
  ctx: Context,
  judged: ReadonlyArray<ResolvedRefspec>,
): ReadonlyArray<SettledRefspec> => {
  const first = judged.find((m) => m.rejection !== undefined);
  if (first?.rejection === undefined) return judged;
  const status = GIT_REF_STATUS[first.rejection];
  ctx.logger?.error?.(`atomic push failed for ref ${first.parsed.dst}. status: ${status}`, {
    ref: first.parsed.dst,
    status,
  });
  return judged.map((m) =>
    m.rejection === undefined ? { ...m, rejection: 'atomic-push-failed' as const } : m,
  );
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
 * and frame it with the armor and the negotiated opener capabilities.
 */
const buildSignedRequestBody = async (
  ctx: Context,
  negotiatedCapabilities: ReadonlyArray<string>,
  movers: ReadonlyArray<SettledRefspec>,
  packfile: Uint8Array | undefined,
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
  return buildSignedReceivePackRequest({
    updates,
    capabilities: negotiatedCapabilities,
    armor,
    pusher,
    pushee,
    nonce,
    packfile,
  });
};

const HAVE_LINE = '.have';

/** One advertised ref's feed: its old value excluded, then any value pushed to it. */
const refFeed = (old: ObjectId, pushed: ObjectId | undefined): ReadonlyArray<ClosureTip> => {
  const excluded = { id: old, excluded: true };
  return pushed === undefined ? [excluded] : [excluded, { id: pushed, excluded: false }];
};

/**
 * git's send-pack `pack_objects` feed to `pack-objects --revs`: the remote's
 * `.have`s, then each advertised ref's old value and the value pushed to it,
 * then each ref the push creates — the order its walk types and pops in.
 */
const sendPackFeed = (
  adv: Advertisement,
  movers: ReadonlyArray<ResolvedRefspec>,
): ReadonlyArray<ClosureTip> => {
  const sent = movers.filter((m) => !m.parsed.isDelete);
  const pushed = new Map(sent.map((m) => [m.parsed.dst, m.localOid]));
  const refs = adv.refs.filter((ref) => ref.name !== HAVE_LINE);
  const advertised = new Set(refs.map((ref) => ref.name));
  return [
    ...adv.refs.filter((ref) => ref.name === HAVE_LINE).map(({ id }) => ({ id, excluded: true })),
    ...refs.flatMap((ref) => refFeed(ref.id, pushed.get(ref.name))),
    ...sent
      .filter((m) => !advertised.has(m.parsed.dst))
      .map((m) => ({ id: m.localOid, excluded: false })),
  ];
};

const collectObjects = async (
  ctx: Context,
  feed: ReadonlyArray<ClosureTip>,
): Promise<ReadonlyArray<ObjectId>> => {
  const negatives = [...new Set(feed.filter((tip) => tip.excluded).map((tip) => tip.id))];
  // git's send-pack feed_object: a negative we do not hold locally is never fed.
  const present = await boundedMapFor(ctx, 'ioBound', negatives, (id) => hasObject(ctx, id));
  const held = new Set(negatives.filter((_, index) => present[index] === true));
  const tips = feed.filter((tip) => !tip.excluded || held.has(tip.id));
  const closure = await computeClosure(ctx, {
    wants: tips.filter((tip) => !tip.excluded).map((tip) => tip.id),
    not: [...held],
    tips,
    objects: true,
    tier: 'bitmap',
    objectTypes: createObjectTypeTable(),
  });
  return closure.objects.map((object) => object.id);
};

const toRefUpdate = (m: SettledRefspec): RefUpdate => ({
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
  movers: ReadonlyArray<SettledRefspec>,
  refUpdates: ReadonlyArray<RefStatus>,
  remoteName: string,
): Promise<ReadonlyArray<PushedRef>> => {
  const statusByName = new Map<string, RefStatus>();
  for (const s of refUpdates) statusByName.set(s.name, s);
  const out: PushedRef[] = [];
  for (const m of movers) {
    out.push(await reportRef(ctx, m, statusByName.get(m.parsed.dst), remoteName));
  }
  return out;
};

/** One ref's outcome: its local verdict, else the remote's report for it. */
const reportRef = async (
  ctx: Context,
  m: SettledRefspec,
  status: RefStatus | undefined,
  remoteName: string,
): Promise<PushedRef> => {
  const ref = { name: m.parsed.dst as RefName, oldId: m.remoteOid, newId: m.localOid };
  if (m.rejection !== undefined) return { ...ref, status: 'rejected', rejection: m.rejection };
  if (status?.accepted === true) {
    await updateTrackingCache(ctx, m, remoteName);
    return { ...ref, status: 'ok' };
  }
  return {
    ...ref,
    status: 'rejected',
    rejection: 'remote',
    ...(status?.reason !== undefined ? { reason: status.reason } : {}),
  };
};

const updateTrackingCache = async (
  ctx: Context,
  m: SettledRefspec,
  remoteName: string,
): Promise<void> => {
  if (!m.parsed.dst.startsWith(HEADS_PREFIX)) return; // tags handled elsewhere
  if (m.parsed.isDelete) return; // delete-only push doesn't update cache
  const branch = m.parsed.dst.slice(HEADS_PREFIX.length);
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
