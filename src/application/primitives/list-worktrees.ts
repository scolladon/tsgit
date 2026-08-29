/**
 * Enumerate the repository's worktrees — the main worktree first, then each
 * linked worktree registered under `<commonDir>/worktrees/<id>/`, sorted by
 * path. A pure read over the admin pointer files; each worktree's own HEAD
 * and the shared branch refs both resolve through the ref backend (never a
 * raw HEAD-file read), scoped to that worktree's own admin dir.
 */
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import { refNotFound } from '../../domain/refs/error.js';
import { resolveWorktreePath } from '../../domain/worktree/resolve-path.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from './config-read.js';
import { deriveContext } from './derive-context.js';
import { deriveWorktreeContext, worktreeScopedFs } from './internal/worktree-context.js';
import { commonGitDir } from './path-layout.js';
import { getRefStore } from './ref-store.js';

const GIT_SUFFIX = '/.git';
const PRUNABLE_REASON = 'gitdir file points to non-existent location';
const HEAD_REF = 'HEAD' as RefName;

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

/**
 * Resolve `worktreeCtx`'s own HEAD into oid + branch (peeling one symbolic
 * hop). `worktreeCtx` must be rooted at the worktree being described — never
 * the calling Context — so this reads through the ref backend rather than a
 * raw file, the seam that keeps a reftable repository's HEAD stub file from
 * ever being mistaken for the real answer. The branch TARGET, by contrast,
 * is a shared ref — resolved through `commonCtx`, the ONE Context every
 * caller in this module reuses for the common dir, so `getRefStore` builds
 * that ref store once for the whole `listWorktrees` call instead of once per
 * worktree.
 */
const resolveHead = async (worktreeCtx: Context, commonCtx: Context): Promise<ResolvedHead> => {
  const head = await getRefStore(worktreeCtx).resolveDirect(HEAD_REF);
  if (head.kind === 'missing') throw refNotFound(HEAD_REF);
  if (head.kind === 'direct') {
    return { head: head.id, detached: true };
  }
  const target = await getRefStore(commonCtx).resolveDirect(head.target);
  return {
    branch: head.target,
    detached: false,
    ...(target.kind === 'direct' ? { head: target.id } : {}),
  };
};

/**
 * A Context rooted at the main checkout's own admin dir — the main
 * worktree's per-worktree state (HEAD, index, …) lives there, never under
 * the opened Context's own `gitDir` when that Context was opened from
 * inside a linked worktree. The common dir is unchanged by this derivation,
 * so `deriveContext` keeps the session.
 */
const deriveMainContext = (ctx: Context): Context =>
  deriveContext(ctx, { layout: { ...ctx.layout, gitDir: commonGitDir(ctx) } });

/**
 * Strip a trailing `/.git` from `dir`; absent means `dir` itself. Shared by
 * `mainEntry` (derives the main worktree's path from the common dir) and
 * `linkedEntry` (derives a linked worktree's path from its gitdir pointer) —
 * both are the same "gitdir to working-tree path" rule.
 */
const stripGitSuffix = (dir: string): string =>
  dir.endsWith(GIT_SUFFIX) ? dir.slice(0, -GIT_SUFFIX.length) : dir;

/**
 * Whether the MAIN checkout (the common dir, considered on its own) is bare.
 * NOT `ctx.layout.bare` when `ctx` was opened from inside a linked worktree:
 * a linked worktree always has its own work tree regardless of the shared
 * `core.bare` (`resolve-layout.ts`'s linked-worktree-admin override), but
 * `git worktree list`'s main entry still reports the shared config's verdict
 * for the checkout it actually names — so this re-derives it from `core.bare`
 * directly rather than reusing the current (possibly linked) Context's own
 * resolved bareness. git's main-entry flag is
 * `is_bare_repository_cfg == 1 || is_bare_repository()`: evaluated from a
 * linked Context the second disjunct is always false (a linked worktree has
 * a work tree by construction), and the cfg default of `-1` (key absent) is
 * NOT `== 1` — so only an explicit `core.bare = true` marks the main entry
 * bare. The layout formula's unset-is-truthy rule does not transfer here:
 * its "no work tree" conjunct cannot be known about the MAIN checkout from
 * a linked Context.
 */
const isMainCheckoutBare = async (ctx: Context): Promise<boolean> => {
  if (ctx.layout.commonDir === undefined) return ctx.layout.bare;
  const config = await readConfig(ctx);
  return config.core?.bare === true;
};

/**
 * The primary worktree entry (the repository's own working tree). The path
 * is always derived from the common dir, never from `ctx.layout.workDir` —
 * the latter is the caller's opened path, which is a linked worktree's own
 * path when opened from inside one, whereas `git worktree list` always
 * reports the main worktree's path first.
 */
const mainEntry = async (ctx: Context, mainCtx: Context): Promise<WorktreeEntry> => {
  const path = stripGitSuffix(commonGitDir(ctx)) as FilePath;
  if (await isMainCheckoutBare(ctx)) {
    return { path, detached: false, bare: true, main: true };
  }
  // Verdict: foreign-worktree — resolved against a Context rooted at the
  // main checkout's own admin dir, never the opened (possibly linked)
  // Context, and never a raw HEAD-file read.
  const resolved = await resolveHead(mainCtx, mainCtx);
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
const linkedEntry = async (
  ctx: Context,
  mainCtx: Context,
  id: string,
  adminDir: string,
): Promise<WorktreeEntry> => {
  // Resolved ONCE against adminDir (git-faithful for `--relative-paths`
  // pointers) and reused for BOTH consumers below: an absolute pointer
  // resolves to itself, so this is a no-op for today's default writer.
  // Resolving REMOVES the escape rather than tolerating it — the resolved
  // value is still subject to the same worktree-scoped fs containment.
  const gitdirPointer = resolveWorktreePath(
    adminDir,
    (await ctx.fs.readUtf8(`${adminDir}/gitdir`)).trim(),
  );
  const path = stripGitSuffix(gitdirPointer) as FilePath;
  // Verdict: foreign-worktree — each linked worktree owns its own HEAD;
  // resolved against a Context derived for THIS worktree's admin dir
  // (reusing the same derivation `worktree.ts` uses to operate on a linked
  // worktree), never the calling Context and never a raw HEAD-file read.
  // The shared branch TARGET resolves through `mainCtx` (see `resolveHead`).
  const resolved = await resolveHead(deriveWorktreeContext(ctx, id, path), mainCtx);
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

const byPath = (a: WorktreeEntry, b: WorktreeEntry): number => {
  // Stryker disable next-line EqualityOperator: equivalent — worktree paths are unique across a repository's worktree set, so `a.path <= b.path` returns -1 on exactly the same distinct pairs as `<`.
  if (a.path < b.path) return -1;
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — for any distinct-path pair V8's sort derives the order from the `<` rule above, so this `>` branch never changes the observable sort result.
  if (a.path > b.path) return 1;
  return 0;
};

export const listWorktrees = async (ctx: Context): Promise<ReadonlyArray<WorktreeEntry>> => {
  // Built once and reused by every entry below (main AND every linked
  // worktree) for the shared-ref lookup — the "immediate win" a session
  // token unlocks: N linked worktrees no longer cost N+1 fresh ref stores
  // and N+1 packed-refs parses.
  const mainCtx = deriveMainContext(ctx);
  const main = await mainEntry(ctx, mainCtx);
  const root = `${commonGitDir(ctx)}/worktrees`;
  if (!(await ctx.fs.exists(root))) return [main];
  const linked: WorktreeEntry[] = [];
  for (const dir of await ctx.fs.readdir(root)) {
    if (!dir.isDirectory) continue;
    linked.push(await linkedEntry(ctx, mainCtx, dir.name, `${root}/${dir.name}`));
  }
  linked.sort(byPath);
  return [main, ...linked];
};
