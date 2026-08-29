/**
 * Thin I/O layer over `.git/logs/<ref>` reflog files. Append is the hot path;
 * whole-file rewrite and delete back the `reflog` command's expire / delete.
 * `readReflog`/`listReflogs` route through the ref backend (`ref-store.ts`)
 * so every caller stays backend-neutral — see `RefStore.readReflog` /
 * `RefStore.listReflogs`.
 */

import type { RefName } from '../../domain/objects/object-id.js';
import type { ReflogEntry } from '../../domain/reflog/reflog-entry.js';
import { serializeReflogLine } from '../../domain/reflog/reflog-format.js';
import type { Context } from '../../ports/context.js';
import { perWorktreeRefDir, reflogPath } from './path-layout.js';
import { getRefStore } from './ref-store.js';

/** Append one entry to `ref`'s reflog, creating the file and parents as needed. */
export async function appendReflog(ctx: Context, ref: RefName, entry: ReflogEntry): Promise<void> {
  await ctx.fs.appendUtf8(
    reflogPath(perWorktreeRefDir(ctx, ref), ref),
    serializeReflogLine(entry, ctx.hashConfig.hexLength),
  );
}

/** Read `ref`'s reflog, oldest-first. Returns `[]` when the file is absent. */
export async function readReflog(ctx: Context, ref: RefName): Promise<ReadonlyArray<ReflogEntry>> {
  return getRefStore(ctx).readReflog(ref);
}

/** `ref`'s reflog, oldest-first, skipping any line that does not parse. `[]` when absent. */
export async function readReflogLenient(
  ctx: Context,
  ref: RefName,
): Promise<ReadonlyArray<ReflogEntry>> {
  return getRefStore(ctx).readReflogLenient(ref);
}

/** Whether `ref` has a reflog file at all. */
export async function reflogExists(ctx: Context, ref: RefName): Promise<boolean> {
  return ctx.fs.exists(reflogPath(perWorktreeRefDir(ctx, ref), ref));
}

/**
 * Replace `ref`'s reflog with exactly `entries`, through the same store
 * update the `reflog` command's expire/delete rewrites use — atomic
 * (lock + rename on the files backend), backend-neutral, and emitting
 * git's REWRITE byte form (the message TAB always present).
 */
export async function writeReflog(
  ctx: Context,
  ref: RefName,
  entries: ReadonlyArray<ReflogEntry>,
): Promise<void> {
  await getRefStore(ctx).applyRefUpdates([{ kind: 'reflogReplace', name: ref, entries }]);
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
 * normal repo / the main worktree the two roots collapse into one walk.
 */
export async function listReflogs(ctx: Context): Promise<ReadonlyArray<RefName>> {
  return getRefStore(ctx).listReflogs();
}
