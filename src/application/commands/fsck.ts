import type { ObjectContent, ObjectId } from '../../domain/objects/index.js';
import type { LruCache } from '../../domain/storage/index.js';
import type { Context } from '../../ports/context.js';
import { warnSlashLeadingPromisorRemotes } from '../primitives/config-read.js';
import { deriveContext } from '../primitives/derive-context.js';
import { enumerateObjects } from '../primitives/enumerate-objects.js';
import { assertValidPromisorRemoteConfig } from '../primitives/internal/boolean-config-guard.js';
import { assertBigFileThresholdValid } from '../primitives/internal/repo-settings-gate.js';
import { runBitmapHealthPass } from './internal/fsck/bitmap-health.js';
import { runCommitGraphVerifyPass } from './internal/fsck/commit-graph-verify.js';
import {
  type CatalogueOptions,
  type ContentValidationPassResult,
  type ContentValidationResult,
  runContentValidationPass,
  runDeferredSpecialBlobChecks,
} from './internal/fsck/content-validation.js';
import { EXIT_MISSING, EXIT_REFS_CONTENT } from './internal/fsck/exit-codes.js';
import { readGraphCommits } from './internal/fsck/graph-commits.js';
import { runMidxHealthPass } from './internal/fsck/midx-health.js';
import {
  assertTypesRecoverable,
  buildObjectCache,
  type CachedGitObject,
  collectUnreadablePackMemberIds,
  hasPackCopy,
  type ObjectCacheResult,
  withUnreadableOverrides,
} from './internal/fsck/object-cache.js';
import { type ObjectTable, readObjectTable } from './internal/fsck/object-table.js';
import { packAccessibilityReported, runPackHealthPass } from './internal/fsck/pack-health.js';
import {
  assertObjectsReadable,
  assertRefTipsReadable,
  assertWalkedObjectsReadable,
} from './internal/fsck/packed-ref-tips.js';
import { collectPromisorObjects, withoutLazyFetch } from './internal/fsck/promisor-objects.js';
import {
  assembleConnectivityFindings,
  buildInEdgeMap,
  buildReachableSet,
  type ConnectivityClassification,
  checkedRootsAndTags,
  classifyObjects,
  excusePackHeld,
  typedBeforeWalk,
  type WalkResult,
  type WalkTypingInput,
} from './internal/fsck/reachability.js';
import {
  type FsckConfiguration,
  readFsckConfiguration,
} from './internal/fsck/read-configuration.js';
import { type RefTargetCheck, runRefsVerifyPass } from './internal/fsck/refs-verify.js';
import { runRevIndexHealthPass } from './internal/fsck/rev-index-health.js';
import {
  collectRoots,
  type InvalidReflogEntry,
  type RootsCollection,
} from './internal/fsck/roots.js';
import { createSpecialBlobLedger } from './internal/fsck/special-blobs.js';
import type { UnreadableMode } from './internal/fsck/types.js';
import {
  connectivityReadOrder,
  markUnreachableReferents,
  type ReferentMarks,
} from './internal/fsck/unreachable-referents.js';
import {
  type ParseCheck,
  parseCheckOnce,
  unverifiedIds,
  verifiedCopiesOf,
  withVerifiedCopies,
} from './internal/fsck/verified-copies.js';
import { runVerifyPackPass, type VerifyPackResult } from './internal/fsck/verify-pack.js';
import { assertOperationalRepository } from './internal/repo-state.js';

export type { FsckObjectType, FsckSeverity } from '../../domain/fsck/index.js';
export type { FsckFinding, FsckOptions, FsckResult } from './internal/fsck/types.js';

// Re-imported locally so the function body can use the types
import type { FsckFinding, FsckOptions, FsckResult } from './internal/fsck/types.js';

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

/** A cache that holds nothing — fsck's audit reads always reach the store.
 *  Built fresh per call, never a shared module-level singleton — the
 *  allocation is free enough that a fresh instance every call beats relying
 *  on a shared one staying inert. */
function createNoDeltaCache(): LruCache<ObjectContent> {
  return {
    get: () => undefined,
    // Stryker disable next-line ArrayDeclaration: equivalent — nothing in src/** ever calls .keys() on a Context's deltaCache (only .get()/.set(), via object-resolver.ts and blob-source.ts), so this arm's body never executes for the audit's no-op cache.
    keys: () => [].values(),
    // Stryker disable next-line BooleanLiteral: equivalent — every write to a Context's deltaCache goes through object-resolver.ts's `cacheEntry`, a void helper that discards what `.set()` returns, so this arm's return value is unobservable.
    set: () => false,
    // Stryker disable next-line BooleanLiteral: equivalent — nothing in src/** ever calls .has() on a Context's deltaCache (only .get()/.set(), via object-resolver.ts and blob-source.ts), so this arm's return value is unobservable.
    has: () => false,
    // Stryker disable next-line BooleanLiteral: equivalent — the sole caller of `.delete()` on a Context's deltaCache is gc-pipeline.ts, which discards the result and never runs against the audit Context this cache is built for, so this arm's return value is unobservable.
    delete: () => false,
    clear: () => undefined,
    currentSize: 0,
    maxSize: 0,
    entryCount: 0,
  };
}

/** How the refs-verify pass judges a ref target present — see `RefTargetCheck`. */
function refTargetCheck(opts: FsckOptions): RefTargetCheck {
  if (opts.full === false) return 'probe-packs';
  return packAccessibilityReported(opts) ? 'universe' : 'confirm-packs';
}

/**
 * Whether git's fsck recorded `id` as an object (`HAS_OBJ`): every enumerated
 * object under `--connectivity-only`, else only one it read — a loose object
 * or a pack entry that unpacked, and a pack only under `--full`.
 */
function recordedBy(
  universe: ReadonlySet<ObjectId>,
  cache: ReadonlyMap<ObjectId, CachedGitObject>,
  unreadable: UnreadableMode,
): (id: ObjectId) => boolean {
  if (unreadable === 'classify') return (id) => universe.has(id);
  return (id) => universe.has(id) && (cache.get(id) ?? null) !== null;
}

export async function fsck(ctx: Context, opts: FsckOptions = {}): Promise<FsckResult> {
  return auditRepository(withoutLazyFetch(ctx), opts);
}

/** Every id a pack holds under bytes that hash to another id. */
function misHashedIds(findings: ReadonlyArray<FsckFinding>): ReadonlySet<ObjectId> {
  return new Set(findings.flatMap((f) => (f.type === 'pack-entry-corrupt' ? [f.id] : [])));
}

/** Every id one of whose loose copies hashes to another id — which copy the
 *  object cache projected is then unknown, so the object table leaves it untyped. */
function misHashedLooseIds(findings: ReadonlyArray<FsckFinding>): ReadonlyArray<ObjectId> {
  return findings.flatMap((f) => (f.type === 'hash-mismatch' ? [f.id] : []));
}

/** Every id whose own content check raised an error — `fsck_obj` prints
 *  nothing more for it, nor for an object whose parse failed (`unparsed`). A
 *  loose copy hashing to another id is not here: a pack copy of the id is still
 *  checked, and the cache override already marks it unreadable when no pack backs it. */
function contentRefusedIds(
  findings: ReadonlyArray<FsckFinding>,
  unparsed: ReadonlySet<ObjectId>,
): ReadonlySet<ObjectId> {
  const refused = findings.flatMap((f) =>
    f.type === 'bad-object' && f.severity === 'error' ? [f.id] : [],
  );
  return new Set([...refused, ...unparsed]);
}

/** git never runs `fsck_obj` on an object whose parse failed: no content finding. */
function withoutUnparsedChecks(
  findings: ReadonlyArray<FsckFinding>,
  table: ObjectTable,
): ReadonlyArray<FsckFinding> {
  return findings.filter((f) => f.type !== 'bad-object' || !table.unparsed.has(f.id));
}

/** What git's connectivity-only walk types objects from; `undefined` in the
 *  other modes, where loading every object typed it already. */
async function walkTyping(
  ctx: Context,
  unreadable: UnreadableMode,
  cache: ReadonlyMap<ObjectId, CachedGitObject>,
  roots: Pick<
    RootsCollection,
    'refTips' | 'indexBlobIds' | 'parsedIndexIds' | 'unparseableReflogRoots'
  >,
): Promise<WalkTypingInput | undefined> {
  if (unreadable !== 'classify') return undefined;
  const parses = {
    refTips: roots.refTips,
    indexBlobs: roots.indexBlobIds,
    parsedIndexIds: roots.parsedIndexIds,
  };
  return {
    typedBeforeWalk: typedBeforeWalk(cache, parses),
    unparseable: roots.unparseableReflogRoots,
    graphCommits: await readGraphCommits(ctx),
  };
}

/** What every pass shares: the audit view, the enumerated universe and its decoded objects. */
interface AuditUniverse {
  readonly ctx: Context;
  readonly auditCtx: Context;
  readonly opts: FsckOptions;
  readonly universe: ReadonlySet<ObjectId>;
  readonly unreadable: UnreadableMode;
  readonly catalogue: CatalogueOptions;
  readonly objects: ObjectCacheResult;
  readonly promised: ReadonlySet<ObjectId>;
}

/** What the content, ref and pack passes read before the connectivity walk. */
interface StorePasses {
  readonly content: ContentValidationPassResult;
  readonly parses: ParseCheck;
  readonly refs: ContentValidationResult;
  readonly pack: ContentValidationResult;
  readonly verifyPack: VerifyPackResult;
  readonly deferred: ContentValidationResult;
}

/** What the reverse-index, multi-pack-index, bitmap and commit-graph passes reported. */
interface AccelerationPasses {
  readonly revIndex: ContentValidationResult;
  readonly midx: ContentValidationResult;
  readonly bitmap: ContentValidationResult;
  readonly commitGraph: ContentValidationResult;
}

/** git's object table, and the ids no copy of which it could parse. */
interface AuditObjectTable {
  readonly verified: ReadonlyMap<ObjectId, CachedGitObject>;
  readonly table: ObjectTable;
  readonly refused: ReadonlySet<ObjectId>;
}

/** The connectivity walk, settled against the referents git marks used. */
interface AuditConnectivity {
  readonly walk: WalkResult;
  readonly reachabilityCache: ReadonlyMap<ObjectId, CachedGitObject>;
  readonly referents: ReferentMarks;
  readonly classification: ConnectivityClassification;
}

async function auditRepository(ctx: Context, opts: FsckOptions): Promise<FsckResult> {
  const audit = await openAuditUniverse(ctx, opts);
  const store = { ...(await runContentPasses(audit)), ...(await runPackPasses(audit)) };
  const acceleration = await runAccelerationPasses(audit);
  const objectTable = await readAuditObjectTable(audit, store);
  const roots = await collectAuditRoots(audit, store.parses, objectTable.refused);
  const reachabilityCache = withUnreadableOverrides(audit.objects.cache, objectTable.refused);
  const walk = await walkConnectivity(audit, roots, reachabilityCache, objectTable.table);
  const connectivity = await classifyConnectivity(
    audit,
    walk,
    reachabilityCache,
    objectTable,
    store.content,
  );
  return reportAudit(audit, { store, acceleration, objectTable, roots, connectivity });
}

/**
 * Open the audit: refuse an unusable repository, read `[fsck]`, enumerate
 * the universe and decode every object in it exactly once — every later
 * pass consumes that map instead of re-reading.
 */
async function openAuditUniverse(ctx: Context, opts: FsckOptions): Promise<AuditUniverse> {
  await assertOperationalRepository(ctx);
  // Read up front, before a single object is decoded: git parses `[fsck]`
  // while it reads its configuration, so an unknown msg-id, an out-of-grammar
  // severity or an unusable `fsck.skipList` refuses the whole audit rather
  // than the entry — whichever of them the FILE holds first.
  const configuration = await readFsckConfiguration(ctx);
  const auditCtx = auditViewOf(ctx);
  const universe = await enumerateUniverse(ctx, opts);
  const unreadable: UnreadableMode = opts.connectivityOnly === true ? 'classify' : 'skip';
  const objects = await buildObjectCache(auditCtx, universe, unreadable);
  const promised = await collectPromisorObjects(auditCtx, objects.cache);
  const catalogue = catalogueOf(auditCtx, opts, configuration);
  return { ctx, auditCtx, opts, universe, unreadable, catalogue, objects, promised };
}

/**
 * The audit's Context. An integrity audit observes the STORE, never the
 * object-byte read cache: a delta base cached by an earlier read (or by this
 * walk itself) would satisfy a lookup git answers through the multi-pack-index,
 * hiding the exact per-entry corruption class this command exists to surface.
 * `deriveContext` keeps the session for a `deltaCache`-only change, so the
 * audit view SHARES every other session-keyed cache with the opening Context —
 * the pack registry (a second registry would double the scan and duplicate
 * every persistent pack handle), config and commit graph. (Refs are verified
 * through `ctx` directly, never the audit view, so the ref store is untouched
 * by this derivation either way.) Re-reading those is redundant work, not
 * safer work: fsck's integrity guarantee comes from its own independent
 * re-hash of every object, which this isolation leaves untouched.
 */
function auditViewOf(ctx: Context): Context {
  return deriveContext(ctx, { deltaCache: createNoDeltaCache() });
}

/** Every object the audit covers; git reads `core.bigFileThreshold` with the
 *  first object content it reads. */
async function enumerateUniverse(ctx: Context, opts: FsckOptions): Promise<ReadonlySet<ObjectId>> {
  const allIds = await enumerateObjects(ctx, {
    scope: 'all',
    includePacks: opts.full !== false,
    accessiblePacksOnly: packAccessibilityReported(opts),
  });
  const universe = new Set(allIds);
  if (opts.connectivityOnly !== true && universe.size > 0) await assertBigFileThresholdValid(ctx);
  return universe;
}

/** The catalogue the content and verify-pack passes share. Its special-blob
 *  ledger is the one the verify-pack pass continues, so a `.gitmodules` /
 *  `.gitattributes` blob is checked where git meets it after its tree — see
 *  `SpecialBlobLedger`. */
function catalogueOf(
  auditCtx: Context,
  opts: FsckOptions,
  configuration: FsckConfiguration,
): CatalogueOptions {
  return {
    strict: opts.strict === true,
    specialBlobs: createSpecialBlobLedger(auditCtx.hashConfig),
    severities: configuration.severities,
    skipped: configuration.skipped,
    bigFileThreshold: configuration.bigFileThreshold,
  };
}

/** Content validation (skipped when connectivityOnly: every loose object's own
 *  bytes, read and hashed once), then git's `parse_object` on every ref tip —
 *  the copy served first must hash to it. */
async function runContentPasses(
  audit: AuditUniverse,
): Promise<Pick<StorePasses, 'content' | 'parses' | 'refs'>> {
  const { ctx, auditCtx, opts, universe, catalogue } = audit;
  const content: ContentValidationPassResult =
    opts.connectivityOnly === true
      ? { findings: [], exitBit: 0, typeUnknownIds: new Set<ObjectId>() }
      : await runContentValidationPass(auditCtx, universe, catalogue);
  const parses = parseCheckOnce(auditCtx);
  const refs = await runRefsVerifyPass(
    ctx,
    universe,
    opts.checkReferences !== false,
    refTargetCheck(opts),
    catalogue.severities,
    audit.promised,
    parses,
  );
  return { content, parses, refs };
}

/**
 * The packs the registry could not open or index; then git's `verify_pack` —
 * every accessible pack's `.idx` trailer, pack trailer, then every entry's
 * CRC, unpack, hash and catalogue, every copy, not only the one the store
 * reads (full mode only); then git's `fsck_finish`: the special blobs no copy
 * met after its tree.
 */
async function runPackPasses(
  audit: AuditUniverse,
): Promise<Pick<StorePasses, 'pack' | 'verifyPack' | 'deferred'>> {
  const { ctx, auditCtx, opts, catalogue } = audit;
  const pack = await runPackHealthPass(ctx, opts);
  const verifyPack = await runVerifyPackPass(auditCtx, opts, catalogue);
  // Connectivity-only checks no tree's content, so no special blob is ever queued and this stays empty there.
  const deferred = await runDeferredSpecialBlobChecks(auditCtx, catalogue, audit.promised);
  return { pack, verifyPack, deferred };
}

/**
 * The acceleration files, in git's order. A pack's own `.rev` is reported
 * when it exists, is readable and is wrong — ungated, like the rest of bit 64,
 * sharing the pack-health universe (`registry.all()`). git then parses every
 * ref tip before it checks anything, dying on one whose only copy is a damaged
 * pack entry. The multi-pack-index pass runs after `enumerateObjects` already
 * succeeded, which is what lets a load-time midx fault reject the whole run
 * first; the bitmap pass (trailing checksum only) runs after it, whose result
 * settles the in-use midx layer's identity. Last, git's `commit-graph verify`,
 * one per object source, gated on core.commitGraph.
 */
async function runAccelerationPasses(audit: AuditUniverse): Promise<AccelerationPasses> {
  const { ctx, opts } = audit;
  const revIndex = await runRevIndexHealthPass(ctx, opts);
  await assertRefTipsReadable(audit.auditCtx, audit.objects.cache);
  const midx = await runMidxHealthPass(ctx, opts);
  const bitmap = await runBitmapHealthPass(ctx, opts);
  const commitGraph = await runCommitGraphVerifyPass(ctx);
  return { revIndex, midx, bitmap, commitGraph };
}

/**
 * git's object table. Content-validation's own git-faithful read can refuse an
 * object the general resolver still typed — every loose object
 * `read_loose_object` refuses, or whose hash disagrees with its path, PROVIDED
 * no pack copy backs it: git's fsck has no separate "read for typing" pass, so
 * a refusal there denies its reachability graph the type too. Overriding those
 * ids to unreadable HERE, after content validation and before every
 * reachability read, keeps `dangling`/`unreachable` git-faithful. A pack entry
 * hashing to another id leaves git holding no copy unless a loose copy
 * verifies (`HAS_OBJ`); a held one is walked as served. An object a parse or
 * walk typed first, read as another type, never parses — and is never
 * recorded as present.
 */
async function readAuditObjectTable(
  audit: AuditUniverse,
  store: Pick<StorePasses, 'content' | 'verifyPack'>,
): Promise<AuditObjectTable> {
  const { auditCtx, opts } = audit;
  const verified = await verifiedCopiesOf(auditCtx, misHashedIds(store.verifyPack.findings));
  const unchecked = new Set([...store.content.typeUnknownIds, ...unverifiedIds(verified)]);
  const table = await readObjectTable(
    auditCtx,
    opts,
    audit.objects.cache,
    new Set([...unchecked, ...misHashedLooseIds(store.content.findings)]),
    store.verifyPack.copies,
  );
  return { verified, table, refused: new Set([...unchecked, ...table.unparsed]) };
}

/**
 * Roots + the missing-entry-point condition — a whole-repository check, not a
 * per-oid one: git sets bit 8 exactly when the index carries a cache-tree
 * (`TREE` extension) and at least one of its entries' tree oids fails to
 * resolve. An ABSENT index, or one with no cache-tree extension, never
 * contributes — regardless of ref, reflog, or index entry resolution; a broken
 * ref beside a healthy cache-tree never sets it (measured against git 2.55.0).
 * `collectRoots` reads the index once for both (a bounded existence probe per
 * cache-tree entry, deliberately independent of `universe`'s own
 * mode-narrowing). git's `fsck_index` then parses every cache-tree oid, in
 * every mode — dying on one whose only copy is a damaged pack entry.
 */
async function collectAuditRoots(
  audit: AuditUniverse,
  parses: ParseCheck,
  refused: ReadonlySet<ObjectId>,
): Promise<RootsCollection> {
  const { ctx, auditCtx, universe, objects } = audit;
  const recorded = recordedBy(
    universe,
    withUnreadableOverrides(objects.cache, refused),
    audit.unreadable,
  );
  const collection = await collectRoots(ctx, audit.opts, universe, recorded, parses);
  await assertObjectsReadable(auditCtx, collection.parsedIndexIds, objects.cache);
  if (consultsPromisorRemotes(collection)) {
    await warnSlashLeadingPromisorRemotes(ctx);
    await assertValidPromisorRemoteConfig(ctx);
  }
  return collection;
}

/** Promisor-remote load (see assertValidPromisorRemoteConfig) — only when the walk has
 *  roots, or a reflog entry names an absent object git asks `is_promisor_object` about. */
function consultsPromisorRemotes(collection: RootsCollection): boolean {
  return (
    collection.roots.size > 0 ||
    collection.sawAbsentRefTarget ||
    collection.invalidReflogEntries.length > 0
  );
}

/** git's connectivity walk from the roots. */
async function walkConnectivity(
  audit: AuditUniverse,
  roots: RootsCollection,
  reachabilityCache: ReadonlyMap<ObjectId, CachedGitObject>,
  table: ObjectTable,
): Promise<WalkResult> {
  const { auditCtx, unreadable } = audit;
  const packMemberIds = await unreadablePackMemberIds(audit, reachabilityCache);
  const walk = buildReachableSet(
    audit.universe,
    roots.roots,
    reachabilityCache,
    unreadable,
    packMemberIds,
    audit.promised,
    await walkTyping(auditCtx, unreadable, reachabilityCache, roots),
    table.unresolvedEntries,
  );
  return settleWalk(audit, walk);
}

/**
 * The walk as git leaves it. `--no-full` verifies no pack, yet git's walk
 * forgets an object a pack holds (`has_object_pack`) rather than calling it
 * missing or broken; under connectivity-only, git dies on a walked object it
 * cannot read.
 */
async function settleWalk(audit: AuditUniverse, walk: WalkResult): Promise<WalkResult> {
  const { auditCtx, objects } = audit;
  const settled =
    audit.opts.full === false
      ? await excusePackHeld(walk, (id) => hasPackCopy(auditCtx, id))
      : walk;
  if (audit.unreadable === 'classify') {
    await assertWalkedObjectsReadable(auditCtx, settled.reached, objects.recovered, objects.cache);
  }
  return settled;
}

/**
 * Which of the (rare) unreadable ids are ALSO claimed by a pack — git's
 * `has_object_pack`: `buildReachableSet` must never report one of these
 * `missing`, since git's own `check_object` trusts the pack copy and never
 * learns the entry is corrupt. Skipped outside default mode: connectivityOnly
 * never consults this set (`isContentUnreadable` is gated on `unreadable`).
 */
async function unreadablePackMemberIds(
  audit: AuditUniverse,
  reachabilityCache: ReadonlyMap<ObjectId, CachedGitObject>,
): Promise<ReadonlySet<ObjectId>> {
  return (
    // Stryker disable next-line ConditionalExpression: equivalent — packMemberIds is only ever read by reachability.ts's isContentUnreadable, itself gated on the SAME `unreadable === 'skip'` check, so a 'classify'-mode populate is extra work with no observable effect.
    audit.unreadable === 'skip'
      ? await collectUnreadablePackMemberIds(audit.auditCtx, reachabilityCache)
      : new Set<ObjectId>()
  );
}

/** The walk classified: what is unreachable or dangling, the root commits and
 *  the tags git checks — every object whose content check raised refused. */
async function classifyConnectivity(
  audit: AuditUniverse,
  walk: WalkResult,
  reachabilityCache: ReadonlyMap<ObjectId, CachedGitObject>,
  objectTable: AuditObjectTable,
  content: ContentValidationPassResult,
): Promise<AuditConnectivity> {
  const { universe } = audit;
  const referents = await referentsOf(audit, walk, reachabilityCache, objectTable);
  const { unreachable, dangling } = classifyObjects(universe, walk.reached, referents.used);
  assertTypesRecoverable(audit.ctx, unreachable, audit.objects.unrecoverable);
  const { rootCommits, tagRefs } = checkedRootsAndTags(
    universe,
    reachabilityCache,
    contentRefusedIds(content.findings, objectTable.table.unparsed),
  );
  const { missingIds, brokenEdges, unreadableEdges } = walk;
  const classification = { missingIds, brokenEdges, unreadableEdges, unreachable, dangling };
  return {
    walk,
    reachabilityCache,
    referents,
    classification: { ...classification, rootCommits, tagRefs },
  };
}

/** git marks children used only from a copy that passed its hash; under
 *  connectivity-only, only from an unreachable object, in its listing order. */
async function referentsOf(
  audit: AuditUniverse,
  walk: WalkResult,
  reachabilityCache: ReadonlyMap<ObjectId, CachedGitObject>,
  objectTable: AuditObjectTable,
): Promise<ReferentMarks> {
  if (audit.unreadable === 'classify') {
    const order = await connectivityReadOrder(audit.auditCtx);
    return markUnreachableReferents(order, walk.reached, walk.typed, reachabilityCache);
  }
  const used = buildInEdgeMap(
    audit.universe,
    withVerifiedCopies(reachabilityCache, objectTable.verified),
    objectTable.table.unresolvedEntries,
  );
  return { used, findings: [] };
}

/** Everything the report is assembled from. */
interface AuditOutcome {
  readonly store: StorePasses;
  readonly acceleration: AccelerationPasses;
  readonly objectTable: AuditObjectTable;
  readonly roots: RootsCollection;
  readonly connectivity: AuditConnectivity;
}

/** The findings in git's report order, and every bit they set. */
function reportAudit(audit: AuditUniverse, outcome: AuditOutcome): FsckResult {
  const { store, objectTable, roots } = outcome;
  // git's `fsck_handle_reflog_oid` excuses a promisor object it never recorded.
  const invalidReflogEntries = roots.invalidReflogEntries.filter(
    (entry) => !audit.promised.has(entry.id),
  );
  const later = laterPasses(store, outcome.acceleration);
  const findings: FsckFinding[] = [
    ...withoutUnparsedChecks(store.content.findings, objectTable.table),
    ...objectTable.table.findings,
    ...later.flatMap((pass) => pass.findings),
    ...connectivityFindings(audit, outcome, invalidReflogEntries),
  ];
  const exitCode =
    store.content.exitBit |
    objectTable.table.exitBit |
    connectivityBit(outcome.connectivity.walk, invalidReflogEntries) |
    later.reduce((bits, pass) => bits | pass.exitBit, 0) |
    (roots.invalidIndexPointers.length > 0 ? EXIT_REFS_CONTENT : 0);
  return { findings, exitCode };
}

/** Every pass after content validation, in the order git reports them. */
function laterPasses(
  store: StorePasses,
  acceleration: AccelerationPasses,
): ReadonlyArray<ContentValidationResult> {
  const { refs, pack, verifyPack, deferred } = store;
  const { revIndex, midx, bitmap, commitGraph } = acceleration;
  return [refs, pack, verifyPack, deferred, revIndex, midx, bitmap, commitGraph];
}

/** The connectivity walk's findings, then the reflog and index pointers git
 *  could not resolve, the objects it could not walk as typed and the referents. */
function connectivityFindings(
  audit: AuditUniverse,
  outcome: AuditOutcome,
  invalidReflogEntries: ReadonlyArray<InvalidReflogEntry>,
): ReadonlyArray<FsckFinding> {
  const { walk, reachabilityCache, referents, classification } = outcome.connectivity;
  const resolution = {
    objectCache: reachabilityCache,
    recovered: audit.objects.recovered,
    unreadable: audit.unreadable,
    indexBlobs: outcome.roots.indexBlobIds,
  };
  return [
    ...assembleConnectivityFindings(classification, resolution),
    ...invalidReflogEntries.map((entry) => ({ type: 'invalid-reflog-entry' as const, ...entry })),
    ...outcome.roots.invalidIndexPointers,
    ...walk.typeFindings,
    ...referents.findings,
  ];
}

/** Bit 2: an object the walk missed, a broken link, an invalid reflog entry
 *  or a link git could not resolve to its stated type. */
function connectivityBit(
  walk: WalkResult,
  invalidReflogEntries: ReadonlyArray<InvalidReflogEntry>,
): number {
  const missing =
    walk.missingIds.size > 0 ||
    invalidReflogEntries.length > 0 ||
    walk.typeFindings.some((f) => f.type === 'unresolved-link');
  return missing ? EXIT_MISSING : 0;
}
