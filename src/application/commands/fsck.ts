import type { ObjectContent, ObjectId } from '../../domain/objects/index.js';
import type { LruCache } from '../../domain/storage/index.js';
import type { Context } from '../../ports/context.js';
import { warnSlashLeadingPromisorRemotes } from '../primitives/config-read.js';
import { deriveContext } from '../primitives/derive-context.js';
import { enumerateObjects } from '../primitives/enumerate-objects.js';
import { assertValidPromisorRemoteConfig } from '../primitives/internal/boolean-config-guard.js';
import { assertBigFileThresholdValid } from '../primitives/internal/repo-settings-gate.js';
import { runBitmapHealthPass } from './internal/fsck/bitmap-health.js';
import {
  type CatalogueOptions,
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
  checkedRootsAndTags,
  classifyObjects,
  excusePackHeld,
  typedBeforeWalk,
  type WalkTypingInput,
} from './internal/fsck/reachability.js';
import { readFsckConfiguration } from './internal/fsck/read-configuration.js';
import { type RefTargetCheck, runRefsVerifyPass } from './internal/fsck/refs-verify.js';
import { runRevIndexHealthPass } from './internal/fsck/rev-index-health.js';
import { collectRoots, type RootsCollection } from './internal/fsck/roots.js';
import { createSpecialBlobLedger } from './internal/fsck/special-blobs.js';
import type { UnreadableMode } from './internal/fsck/types.js';
import {
  parseCheckOnce,
  unverifiedIds,
  verifiedCopiesOf,
  withVerifiedCopies,
} from './internal/fsck/verified-copies.js';
import { runVerifyPackPass } from './internal/fsck/verify-pack.js';
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
 *  nothing more for it. A hash mismatch never reaches the check at all, nor
 *  does an object whose parse failed (`unparsed`). */
function contentRefusedIds(
  findings: ReadonlyArray<FsckFinding>,
  unparsed: ReadonlySet<ObjectId>,
): ReadonlySet<ObjectId> {
  const refused = findings.flatMap((f) =>
    (f.type === 'bad-object' && f.severity === 'error') || f.type === 'hash-mismatch' ? [f.id] : [],
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

async function auditRepository(ctx: Context, opts: FsckOptions): Promise<FsckResult> {
  await assertOperationalRepository(ctx);

  // Read up front, before a single object is decoded: git parses `[fsck]`
  // while it reads its configuration, so an unknown msg-id, an out-of-grammar
  // severity or an unusable `fsck.skipList` refuses the whole audit rather
  // than the entry — whichever of them the FILE holds first.
  const { severities, skipped, bigFileThreshold } = await readFsckConfiguration(ctx);

  // An integrity audit observes the STORE, never the object-byte read cache: a
  // delta base cached by an earlier read (or by this walk itself) would
  // satisfy a lookup git answers through the multi-pack-index, hiding the
  // exact per-entry corruption class this command exists to surface.
  // `deriveContext` keeps the session for a `deltaCache`-only change, so the
  // audit view SHARES every other session-keyed cache with the opening
  // Context — the pack registry (a second registry would double the scan and
  // duplicate every persistent pack handle), config and commit graph. (Refs
  // are verified through `ctx` directly, never `auditCtx`, so the ref store
  // is untouched by this derivation either way.) Re-reading those is
  // redundant work, not safer work: fsck's integrity guarantee comes from
  // its own independent re-hash of every object, which this isolation
  // leaves untouched.
  const auditCtx: Context = deriveContext(ctx, { deltaCache: createNoDeltaCache() });

  const allIds = await enumerateObjects(ctx, {
    scope: 'all',
    includePacks: opts.full !== false,
    accessiblePacksOnly: packAccessibilityReported(opts),
  });
  const universe = new Set(allIds);
  // git reads `core.bigFileThreshold` with the first object content it reads.
  if (opts.connectivityOnly !== true && universe.size > 0) await assertBigFileThresholdValid(ctx);

  const unreadable: UnreadableMode = opts.connectivityOnly === true ? 'classify' : 'skip';

  // Build the shared object cache — every universe object is decoded exactly
  // once here; all subsequent passes consume this map instead of re-reading.
  const {
    cache: objectCache,
    unrecoverable,
    recovered,
  } = await buildObjectCache(auditCtx, universe, unreadable);
  const promised = await collectPromisorObjects(auditCtx, objectCache);

  // Content validation pass (skipped when connectivityOnly): every loose
  // object's own bytes, read and hashed once. Its special-blob ledger is the
  // one the verify-pack pass continues, so a `.gitmodules`/`.gitattributes`
  // blob is checked where git meets it after its tree — see `SpecialBlobLedger`.
  const catalogue: CatalogueOptions = {
    strict: opts.strict === true,
    specialBlobs: createSpecialBlobLedger(auditCtx.hashConfig),
    severities,
    skipped,
    bigFileThreshold,
  };
  const contentResult =
    opts.connectivityOnly === true
      ? {
          findings: [] as FsckFinding[],
          exitBit: 0,
          typeUnknownIds: new Set<ObjectId>() as ReadonlySet<ObjectId>,
        }
      : await runContentValidationPass(auditCtx, universe, catalogue);

  // git's `parse_object` on every ref tip: the copy served first must hash to it.
  const parses = parseCheckOnce(auditCtx);
  const refsResult = await runRefsVerifyPass(
    ctx,
    universe,
    opts.checkReferences !== false,
    refTargetCheck(opts),
    severities,
    promised,
    parses,
  );

  // Pack-health pass — reports packs the registry could not open or index.
  const packResult = await runPackHealthPass(ctx, opts);

  // git's `verify_pack` — every accessible pack's `.idx` trailer, pack
  // trailer, then every entry's CRC, unpack, hash and catalogue — every
  // copy, not only the one the store reads. Full mode only.
  const verifyPackResult = await runVerifyPackPass(auditCtx, opts, catalogue);
  // git's `fsck_finish`: the special blobs no copy met after its tree.
  const deferredResult =
    opts.connectivityOnly === true
      ? { findings: [], exitBit: 0 }
      : await runDeferredSpecialBlobChecks(auditCtx, catalogue, promised);

  // Reverse-index health pass — reports a pack's own `.rev` when it exists,
  // is readable and is wrong. Ungated, like the rest of bit 64: runs after
  // the pack-health pass, whose universe (`registry.all()`) it shares.
  const revIndexResult = await runRevIndexHealthPass(ctx, opts);

  // git parses every ref tip before it checks anything — and dies on one
  // whose only copy is a damaged pack entry.
  await assertRefTipsReadable(auditCtx, objectCache);

  // Multi-pack-index health pass — reports the midx's own accessibility and
  // integrity. Runs after enumerateObjects has already succeeded above,
  // which is what lets a load-time midx fault reject the whole run before
  // this pass is ever reached.
  const midxResult = await runMidxHealthPass(ctx, opts);

  // Bitmap health pass — reports a pack's or the in-use multi-pack-index's
  // bitmap by trailing checksum only. Runs after the midx pass, whose
  // result settles the in-use midx layer's identity this pass's second
  // step needs.
  const bitmapResult = await runBitmapHealthPass(ctx, opts);

  // Content-validation's own git-faithful read can refuse an object the
  // general resolver above still typed — every loose object
  // `read_loose_object` itself refuses, or whose hash disagrees with its
  // path, PROVIDED no pack copy backs it — git's fsck has no separate "read
  // for typing" pass, so a refusal there denies its reachability graph the
  // type too. Overriding those ids to unreadable HERE, after content
  // validation and before every reachability read below, is what keeps
  // `dangling`/`unreachable` classification git-faithful.
  // A pack entry hashing to another id leaves git holding no copy of the object
  // unless a loose copy verifies (`HAS_OBJ`); a held one is walked as served.
  const verified = await verifiedCopiesOf(auditCtx, misHashedIds(verifyPackResult.findings));
  const unchecked = new Set([...contentResult.typeUnknownIds, ...unverifiedIds(verified)]);
  // git's object table: an object a parse or walk typed first, read as
  // another type, never parses — and is never recorded as present.
  const table = await readObjectTable(
    auditCtx,
    opts,
    objectCache,
    new Set([...unchecked, ...misHashedLooseIds(contentResult.findings)]),
    verifyPackResult.copies,
  );
  const refused = new Set([...unchecked, ...table.unparsed]);
  // Roots + the missing-entry-point condition — a whole-repository check,
  // not a per-oid one: git sets bit 8 here exactly when the index carries a
  // cache-tree (`TREE` extension) and at least one of its entries' tree
  // oids fails to resolve. An ABSENT index, or one with no cache-tree
  // extension, never contributes (a bare or never-staged repository is
  // healthy) — regardless of ref, reflog, or index entry resolution.
  // Measured against git 2.55.0: this bit is entirely independent of ref
  // health — a broken ref beside a healthy cache-tree never sets it, and a
  // healthy ref beside a broken cache-tree still does. `collectRoots`
  // reads the index once for both reachability roots and this check (a
  // bounded existence probe per cache-tree entry, deliberately independent
  // of `universe`'s own mode-narrowing — see `existsInStore`'s doc comment)
  // rather than re-scanning the store.
  const { roots, invalidIndexPointers, sawAbsentRefTarget, parsedIndexIds, ...recorded } =
    await collectRoots(
      ctx,
      opts,
      universe,
      recordedBy(universe, withUnreadableOverrides(objectCache, refused), unreadable),
      parses,
    );
  const reachabilityCache = withUnreadableOverrides(objectCache, refused);
  // git's `fsck_index` parses every cache-tree oid, in every mode — and dies
  // on one whose only copy is a damaged pack entry.
  await assertObjectsReadable(auditCtx, parsedIndexIds, objectCache);
  // Promisor-remote load (see assertValidPromisorRemoteConfig) — only when the walk has
  // roots, or a reflog entry names an absent object git asks `is_promisor_object` about.
  const consultsPromisorRemotes =
    roots.size > 0 || sawAbsentRefTarget || recorded.invalidReflogEntries.length > 0;
  if (consultsPromisorRemotes) {
    await warnSlashLeadingPromisorRemotes(ctx);
    await assertValidPromisorRemoteConfig(ctx);
  }
  const missingEntryPointBit = invalidIndexPointers.length > 0 ? EXIT_REFS_CONTENT : 0;
  // git's `fsck_handle_reflog_oid` excuses a promisor object it never recorded.
  const invalidReflogEntries = recorded.invalidReflogEntries.filter(
    (entry) => !promised.has(entry.id),
  );

  // Which of the (rare) unreadable ids are ALSO claimed by a pack — git's
  // `has_object_pack`: `buildReachableSet` must never report one of these
  // `missing`, since git's own `check_object` trusts the pack copy and never
  // learns the entry is corrupt. Skipped outside default mode: connectivityOnly
  // never consults this set (`isContentUnreadable` is gated on `unreadable`).
  const packMemberIds =
    // Stryker disable next-line ConditionalExpression: equivalent — packMemberIds is only ever read by reachability.ts's isContentUnreadable, itself gated on the SAME `unreadable === 'skip'` check, so a 'classify'-mode populate is extra work with no observable effect.
    unreadable === 'skip'
      ? await collectUnreadablePackMemberIds(auditCtx, reachabilityCache)
      : (new Set<ObjectId>() as ReadonlySet<ObjectId>);

  const walk = buildReachableSet(
    universe,
    roots,
    reachabilityCache,
    unreadable,
    packMemberIds,
    promised,
    await walkTyping(auditCtx, unreadable, reachabilityCache, { ...recorded, parsedIndexIds }),
    table.unresolvedEntries,
  );
  // `--no-full` verifies no pack, yet git's walk forgets an object a pack
  // holds (`has_object_pack`) rather than calling it missing or broken.
  const { reached, missingIds, brokenEdges, unreadableEdges, typeFindings } =
    opts.full === false ? await excusePackHeld(walk, (id) => hasPackCopy(auditCtx, id)) : walk;

  if (unreadable === 'classify') {
    await assertWalkedObjectsReadable(auditCtx, reached, recovered, objectCache);
  }

  // git marks children used only from a copy that passed its hash.
  const inEdgePresent = buildInEdgeMap(
    universe,
    withVerifiedCopies(reachabilityCache, verified),
    unreadable === 'classify' ? reached : undefined,
    table.unresolvedEntries,
  );
  const { unreachable, dangling } = classifyObjects(universe, reached, inEdgePresent);
  assertTypesRecoverable(ctx, unreachable, unrecoverable);
  const { rootCommits, tagRefs } = checkedRootsAndTags(
    universe,
    reachabilityCache,
    contentRefusedIds(contentResult.findings, table.unparsed),
  );

  const findings: FsckFinding[] = [
    ...withoutUnparsedChecks(contentResult.findings, table),
    ...table.findings,
    ...refsResult.findings,
    ...packResult.findings,
    ...verifyPackResult.findings,
    ...deferredResult.findings,
    ...revIndexResult.findings,
    ...midxResult.findings,
    ...bitmapResult.findings,
    ...assembleConnectivityFindings(
      { missingIds, brokenEdges, unreadableEdges, unreachable, dangling, rootCommits, tagRefs },
      { objectCache: reachabilityCache, recovered, unreadable, indexBlobs: recorded.indexBlobIds },
    ),
    ...invalidReflogEntries.map((entry) => ({
      type: 'invalid-reflog-entry' as const,
      ...entry,
    })),
    ...invalidIndexPointers,
    ...typeFindings,
  ];

  const connectivityBit =
    missingIds.size > 0 ||
    brokenEdges.length > 0 ||
    invalidReflogEntries.length > 0 ||
    typeFindings.some((f) => f.type === 'unresolved-link')
      ? EXIT_MISSING
      : 0;
  const exitCode =
    contentResult.exitBit |
    table.exitBit |
    connectivityBit |
    refsResult.exitBit |
    packResult.exitBit |
    verifyPackResult.exitBit |
    deferredResult.exitBit |
    revIndexResult.exitBit |
    midxResult.exitBit |
    bitmapResult.exitBit |
    missingEntryPointBit;

  return { findings, exitCode };
}
