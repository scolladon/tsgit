import type { ObjectId } from '../../domain/objects/index.js';
import { allObjectIds } from '../../domain/storage/pack-index.js';
import type { Context } from '../../ports/context.js';
import { commonGitDir, objectsDir } from './path-layout.js';
import { getPackRegistry } from './read-object.js';

export interface EnumerateObjectsOptions {
  /** Include objects from pack files (default: true). */
  readonly includePacks?: boolean;
  /**
   * Restrict the pack half of the universe to packs whose header gate passes
   * (default: `false`). When `true`, the pack half comes from
   * `registry.health().accessible`, so a pack refused at the header gate
   * contributes no ids. This is `fsck`'s universe knob and **not** a general
   * filter — every other enumeration surface (git's `cat-file
   * --batch-all-objects`, `count-objects`) lists a refused pack's ids and
   * must keep doing so.
   */
  readonly accessiblePacksOnly?: boolean;
}

export async function enumerateObjects(
  ctx: Context,
  opts?: EnumerateObjectsOptions,
): Promise<ReadonlyArray<ObjectId>> {
  const includePacks = opts?.includePacks !== false;
  const accessiblePacksOnly = opts?.accessiblePacksOnly === true;
  const ids = new Set<ObjectId>();

  await collectLooseObjectIds(ctx, ids);
  if (includePacks) {
    await collectPackedObjectIds(ctx, ids, accessiblePacksOnly);
  }

  return [...ids].sort();
}

async function collectLooseObjectIds(ctx: Context, ids: Set<ObjectId>): Promise<void> {
  const gitDir = commonGitDir(ctx);
  for (const prefix of HEX_PREFIXES) {
    const dir = objectsDir(gitDir, prefix);
    if (!(await ctx.fs.exists(dir))) continue;
    const entries = await ctx.fs.readdir(dir);
    for (const entry of entries) {
      if (entry.isFile) {
        ids.add(`${prefix}${entry.name}` as ObjectId);
      }
    }
  }
}

async function collectPackedObjectIds(
  ctx: Context,
  ids: Set<ObjectId>,
  accessiblePacksOnly: boolean,
): Promise<void> {
  const registry = getPackRegistry(ctx);
  const packs = accessiblePacksOnly ? (await registry.health()).accessible : await registry.all();
  for (const pack of packs) {
    for (const id of allObjectIds(pack.index)) {
      ids.add(id);
    }
  }
}

/** The 256 two-hex-digit prefixes that git uses as loose-object subdirectory names. */
const HEX_PREFIXES: ReadonlyArray<string> = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
);
