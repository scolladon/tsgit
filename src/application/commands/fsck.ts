import type { FsckObjectType } from '../../domain/fsck/index.js';
import type { ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { enumerateObjects } from '../primitives/enumerate-objects.js';
import {
  buildBlobFilenameMap,
  runContentValidationPass,
} from './internal/fsck/content-validation.js';
import { EXIT_MISSING } from './internal/fsck/exit-codes.js';
import {
  buildInEdgeMap,
  buildReachableSet,
  classifyObjects,
  collectTypeFindings,
  resolveObjectType,
} from './internal/fsck/reachability.js';
import { runRefsVerifyPass } from './internal/fsck/refs-verify.js';
import { collectRoots } from './internal/fsck/roots.js';
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

  const allIds = await enumerateObjects(ctx, { includePacks: opts.full !== false });
  const universe = new Set(allIds);

  // Build blob→filename map for special-file content checks (.gitmodules, .gitattributes).
  // Skipped when connectivityOnly since content checks are also skipped in that mode.
  const blobFilenames =
    opts.connectivityOnly === true
      ? (new Map() as ReadonlyMap<ObjectId, string>)
      : await buildBlobFilenameMap(ctx, universe);

  // Content validation pass (skipped when connectivityOnly)
  const contentResult =
    opts.connectivityOnly === true
      ? { findings: [] as FsckFinding[], exitBit: 0 }
      : await runContentValidationPass(ctx, universe, opts.strict === true, blobFilenames);

  // Refs-verify pass
  const refsResult = await runRefsVerifyPass(ctx, universe, opts.checkReferences !== false);

  const [roots, inEdgePresent] = await Promise.all([
    collectRoots(ctx, opts, universe),
    buildInEdgeMap(ctx, universe),
  ]);

  const { reached, missingIds, brokenEdges, rootCommits, tagRefs } = await buildReachableSet(
    ctx,
    universe,
    roots,
  );

  const { unreachable, dangling } = classifyObjects(universe, reached, inEdgePresent);

  const findings: FsckFinding[] = [...contentResult.findings, ...refsResult.findings];

  // Build map of absent-object id → type using broken-edge records.
  // Every broken edge carries the target type derived from the referring object
  // (tree entry mode, commit tree field, tag object-type header). This avoids
  // reading an object known to be absent while matching git's
  // "missing <type> <sha>" output — git emits the type it expected from context.
  const missingTypeFromEdge = new Map<ObjectId, FsckObjectType | 'unknown'>();
  for (const edge of brokenEdges) {
    if (!missingTypeFromEdge.has(edge.toId)) {
      missingTypeFromEdge.set(edge.toId, edge.toType);
    }
  }

  for (const id of missingIds) {
    const objectType = missingTypeFromEdge.get(id) ?? (await resolveObjectType(ctx, id));
    findings.push({ type: 'missing', id, objectType });
  }
  for (const edge of brokenEdges) {
    findings.push({ type: 'broken-link', ...edge });
  }
  await collectTypeFindings(ctx, unreachable, 'unreachable', findings);
  await collectTypeFindings(ctx, dangling, 'dangling', findings);
  for (const id of rootCommits) findings.push({ type: 'root', id });
  for (const { tagId, tagName, targetId, targetType } of tagRefs) {
    findings.push({ type: 'tagged', id: targetId, objectType: targetType, tagName, tag: tagId });
  }

  const connectivityBit = missingIds.size > 0 || brokenEdges.length > 0 ? EXIT_MISSING : 0;
  const exitCode = contentResult.exitBit | connectivityBit | refsResult.exitBit;

  return { findings, exitCode };
}
