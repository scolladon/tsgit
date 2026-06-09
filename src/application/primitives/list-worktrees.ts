/**
 * Enumerate the repository's worktrees — the main worktree first, then each
 * linked worktree registered under `<commonDir>/worktrees/<id>/`, sorted by
 * path. A pure read over the admin pointer files; the shared branch refs resolve
 * through the common-dir ref store.
 */
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import { parseLooseRef } from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { worktreeScopedFs } from './internal/worktree-context.js';
import { commonGitDir } from './path-layout.js';
import { getRefStore } from './ref-store.js';

const GIT_SUFFIX = '/.git';
const PRUNABLE_REASON = 'gitdir file points to non-existent location';

export interface WorktreeEntry {
  /** Admin-directory id (`<commonDir>/worktrees/<id>`); absent for the main worktree. */
  readonly id?: string;
  /** Absolute worktree path. */
  readonly path: FilePath;
  /** HEAD commit oid; absent for an unborn branch or a bare main worktree. */
  readonly head?: ObjectId;
  /** Full branch refname HEAD points at; absent when detached or bare. */
  readonly branch?: RefName;
  readonly detached: boolean;
  readonly bare: boolean;
  /** Present ⇒ locked; `reason` is the recorded reason (`''` when none). */
  readonly locked?: { readonly reason: string };
  /** Present ⇒ the admin entry's worktree is gone (prunable). */
  readonly prunable?: { readonly reason: string };
  /** True for the primary worktree. */
  readonly main: boolean;
}

interface ResolvedHead {
  readonly head?: ObjectId;
  readonly branch?: RefName;
  readonly detached: boolean;
}

/** Resolve a `HEAD` file's content into oid + branch (peeling the symref). */
const resolveHead = async (ctx: Context, content: string): Promise<ResolvedHead> => {
  const parsed = parseLooseRef(content);
  if (parsed.type === 'direct') {
    return { head: parsed.target, detached: true };
  }
  const target = await getRefStore(ctx).resolveDirect(parsed.target);
  return {
    branch: parsed.target,
    detached: false,
    ...(target.kind === 'direct' ? { head: target.id } : {}),
  };
};

/** The primary worktree entry (the repository's own working tree). */
const mainEntry = async (ctx: Context): Promise<WorktreeEntry> => {
  const path = ctx.layout.workDir as FilePath;
  if (ctx.layout.bare) {
    return { path, detached: false, bare: true, main: true };
  }
  const content = await ctx.fs.readUtf8(`${commonGitDir(ctx)}/HEAD`);
  const resolved = await resolveHead(ctx, content);
  return { path, bare: false, main: true, ...resolved };
};

/** Read the optional `<admin>/locked` reason; `undefined` when not locked. */
const readLocked = async (
  ctx: Context,
  adminDir: string,
): Promise<{ readonly reason: string } | undefined> => {
  if (!(await ctx.fs.exists(`${adminDir}/locked`))) return undefined;
  return { reason: (await ctx.fs.readUtf8(`${adminDir}/locked`)).trim() };
};

/** Build the entry for one linked worktree from its admin dir. */
const linkedEntry = async (ctx: Context, id: string, adminDir: string): Promise<WorktreeEntry> => {
  const gitdirPointer = (await ctx.fs.readUtf8(`${adminDir}/gitdir`)).trim();
  const path = (
    gitdirPointer.endsWith(GIT_SUFFIX) ? gitdirPointer.slice(0, -GIT_SUFFIX.length) : gitdirPointer
  ) as FilePath;
  const resolved = await resolveHead(ctx, await ctx.fs.readUtf8(`${adminDir}/HEAD`));
  const locked = await readLocked(ctx, adminDir);
  // The worktree dir lives outside workDir, so probe it through the worktree fs
  // (confined to the worktree path + common dir; ADR-298).
  const worktreeFs = worktreeScopedFs(ctx, path);
  const prunable = (await worktreeFs.exists(gitdirPointer))
    ? undefined
    : { reason: PRUNABLE_REASON };
  return {
    id,
    path,
    bare: false,
    main: false,
    ...resolved,
    ...(locked !== undefined ? { locked } : {}),
    ...(prunable !== undefined ? { prunable } : {}),
  };
};

const byPath = (a: WorktreeEntry, b: WorktreeEntry): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

export const listWorktrees = async (ctx: Context): Promise<ReadonlyArray<WorktreeEntry>> => {
  const main = await mainEntry(ctx);
  const root = `${commonGitDir(ctx)}/worktrees`;
  if (!(await ctx.fs.exists(root))) return [main];
  const linked: WorktreeEntry[] = [];
  for (const dir of await ctx.fs.readdir(root)) {
    if (!dir.isDirectory) continue;
    linked.push(await linkedEntry(ctx, dir.name, `${root}/${dir.name}`));
  }
  linked.sort(byPath);
  return [main, ...linked];
};
