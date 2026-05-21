/**
 * Enumerate every current ref: `HEAD`, loose refs under `.git/refs/**`, and
 * packed-refs entries — deduplicated. Used by `reflog expire` to seed the
 * reachable-commit walk; not on any hot path.
 */
import type { RefName } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { getRefStore } from './ref-store.js';

const HEAD: RefName = 'HEAD' as RefName;

export async function enumerateRefs(ctx: Context): Promise<ReadonlyArray<RefName>> {
  const names = new Set<RefName>();
  if (await ctx.fs.exists(`${ctx.layout.gitDir}/HEAD`)) {
    names.add(HEAD);
  }
  for (const name of await collectLooseRefs(ctx)) {
    names.add(name);
  }
  for (const entry of (await getRefStore(ctx).getPackedRefs()).entries) {
    names.add(entry.name);
  }
  return [...names];
}

async function collectLooseRefs(ctx: Context): Promise<ReadonlyArray<RefName>> {
  const root = `${ctx.layout.gitDir}/refs`;
  if (!(await ctx.fs.exists(root))) return [];
  return walkLooseRefs(ctx, root, 'refs');
}

async function walkLooseRefs(
  ctx: Context,
  dir: string,
  prefix: string,
): Promise<ReadonlyArray<RefName>> {
  const entries = await ctx.fs.readdir(dir);
  const refs: RefName[] = [];
  for (const entry of entries) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory) {
      refs.push(...(await walkLooseRefs(ctx, `${dir}/${entry.name}`, rel)));
    } else {
      refs.push(rel as RefName);
    }
  }
  return refs;
}
