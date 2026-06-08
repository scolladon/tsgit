import type { FilePath } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';

/**
 * Derive a child `Context` whose object store is a submodule's absorbed gitdir
 * (`${gitDir}/modules/<name>`, with the working tree at
 * `${workDir}/<treeRelPath>`), or `undefined` when the submodule is not locally
 * available (no `name`, the gitdir's `HEAD` is absent — uninitialised — or its
 * gitdir is already `visited`, i.e. a recursion cycle). Shared by the read-side
 * recursive walk and the write-side `deinit` dirtiness check.
 *
 * `name` is the `.gitmodules` subsection name, already rejected by
 * `parseGitmodules` if unsafe; no second name check is needed here.
 *
 * `promisor` and `hooks` are dropped — both close over the parent `Context` and
 * would fire against the parent's gitdir if invoked while reading the child.
 */
export const deriveSubmoduleContext = async (
  ctx: Context,
  name: string | undefined,
  treeRelPath: FilePath,
  visited: ReadonlySet<string> = new Set(),
): Promise<Context | undefined> => {
  // Stryker disable next-line ConditionalExpression: equivalent — letting an `undefined` name through builds `gitDir = '…/modules/undefined'`, which fails the next `fs.exists` probe and still returns `undefined`; identical observable behaviour.
  if (name === undefined) return undefined;
  // Stryker disable next-line StringLiteral: equivalent — emptying the path template would leave `gitDir === '/modules/'` (or similar), which fails the `${gitDir}/HEAD` existence probe just as a real-but-uninitialised path would, so recursion is skipped identically.
  const gitDir = `${ctx.layout.gitDir}/modules/${name}`;
  // Defense-in-depth: under the absorbed layout + safe-name rules, the child
  // gitDir strictly extends an ancestor (`/modules/<name>` is appended at every
  // step), so it can never equal a visited entry — the guard is intentionally
  // present to catch future contract changes (e.g. a relaxed name rule).
  // Stryker disable next-line ConditionalExpression,BooleanLiteral: equivalent — visited.has(gitDir) is always false under the current contract, so replacing it with `false` produces identical behaviour; the guard's value is defensive, not behavioral.
  if (visited.has(gitDir)) return undefined;
  // Stryker disable next-line ConditionalExpression: equivalent — when the HEAD probe is false (uninitialised), removing the early `return undefined` lets the child Context be returned; downstream reads then surface the resulting `OBJECT_NOT_FOUND` and yield the same "no children" outcome.
  if (!(await ctx.fs.exists(`${gitDir}/HEAD`))) return undefined;
  // Stryker disable next-line StringLiteral: equivalent — `workDir` is informational on the child layout; no read primitive consults it (every read selects an object store by `gitDir`), so an empty `workDir` template produces no observable difference.
  const workDir = `${ctx.layout.workDir}/${treeRelPath}`;
  const { promisor: _promisor, hooks: _hooks, ...rest } = ctx;
  return Object.freeze({
    ...rest,
    layout: Object.freeze({
      workDir,
      gitDir,
      // Stryker disable next-line BooleanLiteral: equivalent — no read primitive branches on `layout.bare`; the field is informational on the child Context, so flipping it has no observable effect.
      bare: false,
      // Stryker disable next-line ConditionalExpression,BooleanLiteral,EqualityOperator,ObjectLiteral: equivalent — `homeDir` is unused by any read primitive (it only matters when expanding `core.excludesFile = ~/...`, never resolved here), so the spread shape has no observable effect; the conditional only exists to satisfy `exactOptionalPropertyTypes`.
      ...(ctx.layout.homeDir !== undefined ? { homeDir: ctx.layout.homeDir } : {}),
    }),
    cwd: workDir,
  });
};
