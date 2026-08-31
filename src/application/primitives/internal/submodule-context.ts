import { NO_PARSER_OFFSET, validateIndexPath } from '../../../domain/git-index/path-validator.js';
import { FILE_MODE, type FilePath } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { deriveContext } from '../derive-context.js';
import { joinPath } from './join-working-tree-path.js';
import { inheritedAcceptanceVerdicts } from './layout-verdict.js';
import { requireWorkTree } from './repo-state.js';

/**
 * Build a child `Context` whose object store is a submodule's absorbed gitdir
 * (`${gitDir}/modules/<name>`, working tree at `${workDir}/<treeRelPath>`). The
 * frozen-layout core shared by the read-side derivation (which gates on HEAD
 * existence) and the clone-target derivation (which does not, the gitdir being
 * about to be created).
 *
 * `promisor` and `hooks` are dropped — both close over the parent `Context` and
 * would fire against the parent's gitdir if invoked while operating on the child.
 *
 * A submodule is a genuinely DIFFERENT repository — its common dir is its own
 * absorbed gitdir, not the parent's — so `deriveContext` mints a fresh
 * session and every identity-keyed cache starts cold, unlike the worktree
 * derivation above.
 */
const buildChildContext = (ctx: Context, name: string, treeRelPath: FilePath): Context => {
  const gitDir = `${ctx.layout.gitDir}/modules/${name}`;
  const workDir = joinPath(requireWorkTree(ctx, 'deriveSubmoduleContext'), treeRelPath);
  const { promisor: _promisor, hooks: _hooks, ...rest } = ctx;
  return deriveContext(rest, {
    layout: Object.freeze({
      workDir,
      gitDir,
      bare: false,
      // A submodule is its own repository and can declare its own
      // `extensions.refStorage`, independent of the parent's — this
      // derivation does not run the Stage-2 scan, so it defaults to
      // 'files' by explicit assignment rather than copying the parent's
      // value (unlike the worktree derivation, which shares one repository).
      refStorage: 'files',
      // Stryker disable next-line ConditionalExpression,BooleanLiteral,EqualityOperator,ObjectLiteral: equivalent — when `homeDir` is undefined the always-true mutant yields `{ homeDir: undefined }`, indistinguishable from the `{}` branch on `layout.homeDir`; the conditional only exists to satisfy `exactOptionalPropertyTypes`. The killable always-`{}` half is covered by the homeDir-propagation tests.
      ...(ctx.layout.homeDir !== undefined ? { homeDir: ctx.layout.homeDir } : {}),
      ...inheritedAcceptanceVerdicts(ctx.layout),
    }),
    cwd: workDir,
  });
};

/**
 * Derive a child `Context` for an **already-cloned** submodule, or `undefined`
 * when it is not locally available (no `name`, the gitdir's `HEAD` is absent —
 * uninitialised — or its gitdir is already `visited`, i.e. a recursion cycle).
 * Shared by the read-side recursive walk and the write-side `deinit`/`sync`
 * checks.
 *
 * `name` is the `.gitmodules` subsection name, already rejected by
 * `parseGitmodules` if unsafe. That covers `name`, which builds the child's
 * gitdir — it says nothing about `treeRelPath`, which builds the child's work
 * directory and arrives unvalidated from a tree walk; `buildChildContext`
 * checks that one itself.
 */
export const deriveSubmoduleContext = async (
  ctx: Context,
  name: string | undefined,
  treeRelPath: FilePath,
  visited: ReadonlySet<string> = new Set(),
): Promise<Context | undefined> => {
  // Stryker disable next-line ConditionalExpression: equivalent — letting an `undefined` name through builds `gitDir = '…/modules/undefined'`, which fails the next `fs.exists` probe and still returns `undefined`; identical observable behaviour.
  if (name === undefined) return undefined;
  // `treeRelPath` is a gitlink entry's own name, straight off a tree walk. The
  // object-parse layer no longer refuses a `..` or separator-bearing name — git
  // refuses those where a path is materialised, not where a tree is read — and
  // this path becomes the child repository's work directory. Checked here
  // rather than where the context is built, so a hostile name is refused
  // whether or not the submodule happens to be initialised locally.
  validateIndexPath(treeRelPath, NO_PARSER_OFFSET, FILE_MODE.GITLINK);
  const gitDir = `${ctx.layout.gitDir}/modules/${name}`;
  // Defense-in-depth: under the absorbed layout + safe-name rules, the child
  // gitDir strictly extends an ancestor (`/modules/<name>` is appended at every
  // step), so it can never equal a visited entry — the guard is intentionally
  // present to catch future contract changes (e.g. a relaxed name rule).
  // Stryker disable next-line ConditionalExpression,BooleanLiteral: equivalent — visited.has(gitDir) is always false under the current contract, so replacing it with `false` produces identical behaviour; the guard's value is defensive, not behavioral.
  if (visited.has(gitDir)) return undefined;
  // Verdict: discovery-tier — a presence probe (uninitialised-submodule
  // detection), not a content read; a reftable repository's HEAD file still
  // exists as the routing stub, so `exists()` remains a valid signal.
  // Stryker disable next-line ConditionalExpression: equivalent — when the HEAD probe is false (uninitialised), removing the early `return undefined` lets the child Context be returned; downstream reads then surface the resulting `OBJECT_NOT_FOUND` and yield the same "no children" outcome.
  if (!(await ctx.fs.exists(`${gitDir}/HEAD`))) return undefined;
  return buildChildContext(ctx, name, treeRelPath);
};

/**
 * Derive a child `Context` targeting the absorbed gitdir a submodule is **about
 * to be cloned into** — the clone/checkout substrate for `add`/`update`. Unlike
 * `deriveSubmoduleContext` it does not probe for an existing `HEAD` (the gitdir
 * does not exist yet) and always returns a Context. The SSRF-wrapped `transport`
 * and `config` are inherited so the child clone is guarded identically to a
 * top-level clone.
 */
export const deriveSubmoduleCloneContext = (
  ctx: Context,
  name: string,
  treeRelPath: FilePath,
): Context => buildChildContext(ctx, name, treeRelPath);
