import type { ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { enumerateObjects } from '../primitives/enumerate-objects.js';
import {
  buildBlobFilenameMap,
  runContentValidationPass,
} from './internal/fsck/content-validation.js';
import { EXIT_MISSING } from './internal/fsck/exit-codes.js';
import { assertTypesRecoverable, buildObjectCache } from './internal/fsck/object-cache.js';
import { packAccessibilityReported, runPackHealthPass } from './internal/fsck/pack-health.js';
import {
  assembleConnectivityFindings,
  buildInEdgeMap,
  buildReachableSet,
  classifyObjects,
} from './internal/fsck/reachability.js';
import { runRefsVerifyPass } from './internal/fsck/refs-verify.js';
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

export async function fsck(ctx: Context, opts: FsckOptions = {}): Promise<FsckResult> {
  await assertRepository(ctx);

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
  } = await buildObjectCache(ctx, universe, unreadable);

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
      : await runContentValidationPass(ctx, universe, opts.strict === true, blobFilenames);

  // Refs-verify pass
  const refsResult = await runRefsVerifyPass(ctx, universe, opts.checkReferences !== false);

  // Pack-health pass — reports packs the registry could not open or index.
  const packResult = await runPackHealthPass(ctx, opts);

  const roots = await collectRoots(ctx, opts, universe);
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
    ...assembleConnectivityFindings(
      { missingIds, brokenEdges, unreachable, dangling, rootCommits, tagRefs },
      { objectCache, recovered, unreadable },
    ),
  ];

  const connectivityBit = missingIds.size > 0 || brokenEdges.length > 0 ? EXIT_MISSING : 0;
  const exitCode =
    contentResult.exitBit | connectivityBit | refsResult.exitBit | packResult.exitBit;

  return { findings, exitCode };
}
