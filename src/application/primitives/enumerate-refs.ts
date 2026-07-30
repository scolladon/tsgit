/**
 * Enumerate every current ref: `HEAD`, loose refs under both the worktree's
 * own `refs/` (per-worktree namespaces: `refs/bisect/…`, `refs/worktree/…`,
 * `refs/rewritten/…`) and the common dir's `refs/` (everything shared), and
 * packed-refs entries — deduplicated. Consumed by `describe`, `name-rev`,
 * `push`, `remote`, `bundle-create`, fsck and `reflog expire` — several of
 * which are bench-tracked, so the walk below stays single-pass per root.
 */
import type { RefName } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { commonGitDir } from './path-layout.js';
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

/**
 * Loose refs live under two roots for a linked worktree: the worktree's own
 * gitdir (per-worktree namespaces) and the common dir (everything shared).
 * For a normal repo / the main worktree the two roots are one and the same
 * string, so the walk runs once; `enumerateRefs`'s `Set<RefName>` collapses
 * the cross-root duplicates that remain in the split case.
 */
async function collectLooseRefs(ctx: Context): Promise<ReadonlyArray<RefName>> {
  const ownRefs = `${ctx.layout.gitDir}/refs`;
  const commonRefs = `${commonGitDir(ctx)}/refs`;
  const roots = ownRefs === commonRefs ? [ownRefs] : [ownRefs, commonRefs];
  const refs: RefName[] = [];
  for (const root of roots) {
    if (!(await ctx.fs.exists(root))) continue;
    for (const ref of await walkLooseRefs(ctx, root, 'refs')) {
      refs.push(ref);
    }
  }
  return refs;
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
      for (const ref of await walkLooseRefs(ctx, `${dir}/${entry.name}`, rel)) {
        refs.push(ref);
      }
    } else {
      refs.push(rel as RefName);
    }
  }
  return refs;
}
