/**
 * Thin I/O layer over `.git/logs/<ref>` reflog files. Append is the hot path;
 * whole-file rewrite and delete back the `reflog` command's expire / delete.
 */

import type { RefName } from '../../domain/objects/object-id.js';
import { invalidReflogEntry } from '../../domain/reflog/error.js';
import type { ReflogEntry } from '../../domain/reflog/reflog-entry.js';
import { parseReflog, serializeReflogLine } from '../../domain/reflog/reflog-format.js';
import type { Context } from '../../ports/context.js';
import { commonGitDir, logsDir, perWorktreeRefDir, reflogPath } from './path-layout.js';
import { MAX_REFLOG_BYTES } from './types.js';

/** Append one entry to `ref`'s reflog, creating the file and parents as needed. */
export async function appendReflog(ctx: Context, ref: RefName, entry: ReflogEntry): Promise<void> {
  await ctx.fs.appendUtf8(
    reflogPath(perWorktreeRefDir(ctx, ref), ref),
    serializeReflogLine(entry, ctx.hashConfig.hexLength),
  );
}

/** Read `ref`'s reflog, oldest-first. Returns `[]` when the file is absent. */
export async function readReflog(ctx: Context, ref: RefName): Promise<ReadonlyArray<ReflogEntry>> {
  const path = reflogPath(perWorktreeRefDir(ctx, ref), ref);
  if (!(await ctx.fs.exists(path))) return [];
  const stat = await ctx.fs.stat(path);
  if (stat.size > MAX_REFLOG_BYTES) {
    throw invalidReflogEntry(`reflog file exceeds ${MAX_REFLOG_BYTES} bytes`);
  }
  return parseReflog(await ctx.fs.readUtf8(path), ctx.hashConfig.hexLength);
}

/** Whether `ref` has a reflog file at all. */
export async function reflogExists(ctx: Context, ref: RefName): Promise<boolean> {
  return ctx.fs.exists(reflogPath(perWorktreeRefDir(ctx, ref), ref));
}

/** Replace `ref`'s reflog with exactly `entries`. Used by expire / delete. */
export async function writeReflog(
  ctx: Context,
  ref: RefName,
  entries: ReadonlyArray<ReflogEntry>,
): Promise<void> {
  const text = entries
    .map((entry) => serializeReflogLine(entry, ctx.hashConfig.hexLength))
    .join('');
  await ctx.fs.writeUtf8(reflogPath(perWorktreeRefDir(ctx, ref), ref), text);
}

/** Remove `ref`'s reflog file. A no-op when the file is already absent. */
export async function deleteReflog(ctx: Context, ref: RefName): Promise<void> {
  const path = reflogPath(perWorktreeRefDir(ctx, ref), ref);
  if (await ctx.fs.exists(path)) {
    await ctx.fs.rm(path);
  }
}

/**
 * Every reflog under `logs/`, each as the `RefName` it logs. Reflogs live
 * under two roots for a linked worktree: the worktree's own gitdir (HEAD's
 * per-worktree log) and the common dir (every shared ref's log). For a
 * normal repo / the main worktree the two roots are one and the same string,
 * so the walk runs once; the `Set<RefName>` below collapses the cross-root
 * duplicates that remain in the split case.
 */
export async function listReflogs(ctx: Context): Promise<ReadonlyArray<RefName>> {
  const own = logsDir(ctx.layout.gitDir);
  const common = logsDir(commonGitDir(ctx));
  const roots = own === common ? [own] : [own, common];
  const names = new Set<RefName>();
  for (const root of roots) {
    if (!(await ctx.fs.exists(root))) continue;
    for (const name of await collectReflogs(ctx, root, '')) {
      names.add(name);
    }
  }
  return [...names];
}

async function collectReflogs(
  ctx: Context,
  dir: string,
  prefix: string,
): Promise<ReadonlyArray<RefName>> {
  const entries = await ctx.fs.readdir(dir);
  const refs: RefName[] = [];
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory) {
      refs.push(...(await collectReflogs(ctx, `${dir}/${entry.name}`, rel)));
    } else {
      refs.push(rel as RefName);
    }
  }
  return refs;
}
