import type { ObjectId } from '../../domain/objects/index.js';
import type { LruCache } from '../../domain/storage/index.js';
import type { Context } from '../../ports/context.js';
import { enumerateObjects } from '../primitives/enumerate-objects.js';
import { assertValidPromisorRemoteConfig } from '../primitives/internal/boolean-config-guard.js';
import { adoptPackRegistry } from '../primitives/read-object.js';
import { runBitmapHealthPass } from './internal/fsck/bitmap-health.js';
import {
  buildBlobFilenameMap,
  runContentValidationPass,
} from './internal/fsck/content-validation.js';
import { EXIT_MISSING, EXIT_REFS_CONTENT } from './internal/fsck/exit-codes.js';
import { runMidxHealthPass } from './internal/fsck/midx-health.js';
import { assertTypesRecoverable, buildObjectCache } from './internal/fsck/object-cache.js';
import { packAccessibilityReported, runPackHealthPass } from './internal/fsck/pack-health.js';
import {
  assembleConnectivityFindings,
  buildInEdgeMap,
  buildReachableSet,
  classifyObjects,
} from './internal/fsck/reachability.js';
import { runRefsVerifyPass } from './internal/fsck/refs-verify.js';
import { runRevIndexHealthPass } from './internal/fsck/rev-index-health.js';
import { collectRoots } from './internal/fsck/roots.js';
import type { UnreadableMode } from './internal/fsck/types.js';
import { assertRepository } from './internal/repo-state.js';

export type { FsckObjectType, FsckSeverity } from '../../domain/fsck/index.js';
export type { FsckFinding, FsckOptions, FsckResult } from './internal/fsck/types.js';

// Re-imported locally so the function body can use the types
import type { FsckFinding, FsckOptions, FsckResult } from './internal/fsck/types.js';

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

/** A cache that holds nothing — fsck's audit reads always reach the store. */
const NO_DELTA_CACHE: LruCache<Uint8Array> = {
  get: () => undefined,
  set: () => undefined,
  // Stryker disable next-line BooleanLiteral: equivalent — nothing in src/** ever calls .has() on a Context's deltaCache (only .get()/.set(), via object-resolver.ts and blob-source.ts), so this arm's return value is unobservable.
  has: () => false,
  // Stryker disable next-line BooleanLiteral: equivalent — nothing in src/** ever calls .delete() on a Context's deltaCache, so this arm's return value is unobservable.
  delete: () => false,
  clear: () => undefined,
  currentSize: 0,
  maxSize: 0,
  entryCount: 0,
};

export async function fsck(ctx: Context, opts: FsckOptions = {}): Promise<FsckResult> {
  await assertRepository(ctx);

  // An integrity audit observes the STORE, never the session's read cache: a
  // delta base cached by an earlier read (or by this walk itself) would
  // satisfy a lookup git answers through the multi-pack-index, hiding the
  // exact per-entry corruption class this command exists to surface. The
  // audit view shares the ordinary registry — a second registry would double
  // the scan and duplicate every persistent pack handle. Every OTHER
  // per-Context read cache (loose fanout, commit graph, config) is left to
  // rebuild: bounded rework, no handles, no correctness stake. Frozen like
  // every Context the factories hand out.
  const auditCtx: Context = Object.freeze({ ...ctx, deltaCache: NO_DELTA_CACHE });
  adoptPackRegistry(ctx, auditCtx);

  const allIds = await enumerateObjects(ctx, {
    includePacks: opts.full !== false,
    accessiblePacksOnly: packAccessibilityReported(opts),
  });
  const universe = new Set(allIds);

  const unreadable: UnreadableMode = opts.connectivityOnly === true ? 'classify' : 'skip';

  // Build the shared object cache — every universe object is decoded exactly
  // once here; all subsequent passes consume this map instead of re-reading.
  const {
    cache: objectCache,
    unrecoverable,
    recovered,
  } = await buildObjectCache(auditCtx, universe, unreadable);

  // Build blob→filename map for special-file content checks (.gitmodules, .gitattributes).
  // Skipped when connectivityOnly since content checks are also skipped in that mode.
  const blobFilenames =
    // Stryker disable next-line ConditionalExpression,BooleanLiteral: equivalent — blobFilenames is only consumed by runContentValidationPass which is independently gated by connectivityOnly at the next conditional.
    opts.connectivityOnly === true
      ? (new Map() as ReadonlyMap<ObjectId, string>)
      : buildBlobFilenameMap(universe, objectCache);

  // Content validation pass (skipped when connectivityOnly).
  // Reads raw bytes separately (needed for malformed-object detection) and
  // verifies hash from those bytes — no additional readObject calls.
  const contentResult =
    opts.connectivityOnly === true
      ? { findings: [] as FsckFinding[], exitBit: 0 }
      : await runContentValidationPass(auditCtx, universe, opts.strict === true, blobFilenames);

  // Refs-verify pass — `confirmPackAccessibility` is true exactly when the
  // universe above was built WITHOUT accessiblePacksOnly narrowing but WITH
  // packs included (connectivityOnly): the only case `universe.has(oid)` can
  // hold for an oid whose housing pack later fails its own header gate.
  const confirmPackAccessibility = opts.full !== false && !packAccessibilityReported(opts);
  const refsResult = await runRefsVerifyPass(
    ctx,
    universe,
    opts.checkReferences !== false,
    confirmPackAccessibility,
  );

  // Pack-health pass — reports packs the registry could not open or index.
  const packResult = await runPackHealthPass(ctx, opts);

  // Reverse-index health pass — reports a pack's own `.rev` when it exists,
  // is readable and is wrong. Ungated, like the rest of bit 64: runs after
  // the pack-health pass, whose universe (`registry.all()`) it shares.
  const revIndexResult = await runRevIndexHealthPass(ctx, opts);

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

  // Roots + the missing-entry-point condition — a whole-repository check,
  // not a per-oid one: git sets bit 8 here exactly when the index carries a
  // cache-tree (`TREE` extension) and at least one of its entries' tree
  // oids fails to resolve. An ABSENT index, or one with no cache-tree
  // extension, never contributes (a bare or never-staged repository is
  // healthy) — regardless of ref, reflog, or stage-0 entry resolution.
  // Measured against git 2.55.0: this bit is entirely independent of ref
  // health — a broken ref beside a healthy cache-tree never sets it, and a
  // healthy ref beside a broken cache-tree still does. `collectRoots`
  // reads the index once for both reachability roots and this check (a
  // bounded existence probe per cache-tree entry, deliberately independent
  // of `universe`'s own mode-narrowing — see `existsInStore`'s doc comment)
  // rather than re-scanning the store.
  const { roots, missingEntryPoint, sawAbsentRefTarget } = await collectRoots(ctx, opts, universe);
  // Promisor-remote guard (see assertValidPromisorRemoteConfig) — only when the walk has roots.
  if (roots.size > 0 || sawAbsentRefTarget) {
    await assertValidPromisorRemoteConfig(ctx);
  }
  const missingEntryPointBit = missingEntryPoint ? EXIT_REFS_CONTENT : 0;
  const inEdgePresent = buildInEdgeMap(universe, objectCache);

  const { reached, missingIds, brokenEdges, rootCommits, tagRefs } = buildReachableSet(
    universe,
    roots,
    objectCache,
  );

  const { unreachable, dangling } = classifyObjects(universe, reached, inEdgePresent);
  assertTypesRecoverable(ctx, unreachable, unrecoverable);

  const findings: FsckFinding[] = [
    ...contentResult.findings,
    ...refsResult.findings,
    ...packResult.findings,
    ...revIndexResult.findings,
    ...midxResult.findings,
    ...bitmapResult.findings,
    ...assembleConnectivityFindings(
      { missingIds, brokenEdges, unreachable, dangling, rootCommits, tagRefs },
      { objectCache, recovered, unreadable },
    ),
  ];

  const connectivityBit = missingIds.size > 0 || brokenEdges.length > 0 ? EXIT_MISSING : 0;
  const exitCode =
    contentResult.exitBit |
    connectivityBit |
    refsResult.exitBit |
    packResult.exitBit |
    revIndexResult.exitBit |
    midxResult.exitBit |
    bitmapResult.exitBit |
    missingEntryPointBit;

  return { findings, exitCode };
}
