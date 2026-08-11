/**
 * Tier-1 `pack-objects` command — the packfile-writing counterpart to
 * `rev-list`: enumerates the objects reachable from `wants` and not
 * reachable from `not`, then writes them as a `.pack` + `.idx` pair.
 * Delegates the reachability question to the same closure engine
 * `rev-list` uses, but at the OPPOSITE default tier — git's own
 * `pack-objects --revs` prefers a usable bitmap unless told not to, the
 * reverse of `rev-list`'s walk-by-default. `pack-objects` carries none of
 * the options that defeat a bitmap (`firstParent`, `noWalk`, `maxCount`
 * never apply here), so nothing narrows the default; the caller's only
 * lever is `useBitmapIndex: false`.
 *
 * With haves (a non-empty `not`), the bitmap tier's pack holds FEWER
 * objects than the walk's — every object the bitmap omits is reachable
 * from a `not` tip, so a peer that already supplied those haves already
 * has it. Sending the smaller pack is correct, not a divergence: it is
 * git's own default behaviour.
 *
 * No progress line, no summary line — structured counts only.
 */
import type { ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { buildPack } from '../primitives/build-pack.js';
import { type ClosureTier, computeClosure } from '../primitives/internal/closure-engine.js';
import { buildIdx, writePackArtifacts } from '../primitives/internal/write-pack-artifacts.js';
import { commonGitDir, packsDir } from '../primitives/path-layout.js';
import { refreshPackRegistry } from '../primitives/read-object.js';
import { assertOperationalRepository } from './internal/repo-state.js';
import { revParse } from './rev-parse.js';

export interface PackObjectsOptions {
  readonly wants: ReadonlyArray<string>;
  readonly not?: ReadonlyArray<string>;
  /** Directory to write into; defaults to the repository's pack directory. */
  readonly outputDirectory?: string;
  /**
   * Use the bitmap tier. **Defaults to `true`** — git's `pack-objects --revs`
   * uses a usable bitmap unless told not to. Setting it `false` yields the
   * walk's larger, equally valid pack.
   */
  readonly useBitmapIndex?: boolean;
}

export interface PackObjectsResult {
  /**
   * The pack's own checksum, also the `.pack`/`.idx` filename stem. Stable
   * for a fixed tier only — object order inside the pack is the closure's
   * own order, which differs between tiers, so the SAME closure written by
   * a different tier yields a DIFFERENT name. Never compare this across
   * tiers; compare the object set read back from the `.idx` instead.
   */
  readonly packId: ObjectId;
  readonly objectCount: number;
  readonly packBytes: number;
  readonly indexBytes: number;
}

/**
 * `useBitmapIndex` defaults to the bitmap tier — the opposite of
 * `rev-list`'s walk default — because `pack-objects` carries none of the
 * options (`firstParent`, `noWalk`, `maxCount`) that would force the walk
 * regardless. Only an explicit `false` declines it.
 */
const closureTierFor = (opts: PackObjectsOptions): ClosureTier =>
  opts.useBitmapIndex === false ? 'walk' : 'bitmap';

export const packObjects = async (
  ctx: Context,
  opts: PackObjectsOptions,
): Promise<PackObjectsResult> => {
  await assertOperationalRepository(ctx);
  const wants = await Promise.all(opts.wants.map((rev) => revParse(ctx, rev)));
  const not = await Promise.all((opts.not ?? []).map((rev) => revParse(ctx, rev)));
  const closure = await computeClosure(ctx, {
    wants,
    not,
    objects: true,
    tier: closureTierFor(opts),
  });

  const oids = closure.objects.map((object) => object.id);
  const pack = await buildPack(ctx, { oids });
  // `buildPack` produces exactly one entry per oid, in the same order — the
  // non-null assertion documents that invariant rather than working around it.
  const indexEntries = oids.map((id, i) => ({
    id,
    crc32: pack.entries[i]!.crc32,
    offset: pack.entries[i]!.offset,
  }));
  const idxBytes = await buildIdx(ctx, indexEntries, pack.sha);

  const outputDirectory = opts.outputDirectory ?? packsDir(commonGitDir(ctx));
  const written = await writePackArtifacts(
    ctx,
    outputDirectory,
    pack.bytes,
    idxBytes,
    pack.sha,
    pack.objectCount,
    false,
  );
  if (opts.outputDirectory === undefined) {
    refreshPackRegistry(ctx);
  }

  return {
    packId: written.packSha as ObjectId,
    objectCount: written.objectCount,
    packBytes: pack.bytes.length,
    indexBytes: idxBytes.length,
  };
};
