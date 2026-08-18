import type { PathPolicy } from '../adapters/node/path-policy.js';

/**
 * True when `ancestor` is a STRICT ancestor of `path` — equality is
 * explicitly excluded, which is what makes a ceiling equal to cwd (or equal
 * to cwd AND the repo root) a no-op rather than a refusal.
 */
const isStrictAncestor = (ancestor: string, path: string, pathPolicy: PathPolicy): boolean => {
  if (ancestor === path) return false;
  const prefix = ancestor.endsWith(pathPolicy.sep) ? ancestor : `${ancestor}${pathPolicy.sep}`;
  return path.startsWith(prefix);
};

/**
 * The longest ceiling entry that is a STRICT ancestor of `resolvedCwd` — the
 * argument-array equivalent of `GIT_CEILING_DIRECTORIES`. Computed once,
 * before the walk starts, never per level: the walk's loop head compares its
 * current directory against this single value on every iteration.
 *
 * Because ancestry is strict, the result can never equal `resolvedCwd`
 * itself, so the walk's very first iteration always examines cwd — a
 * ceiling equal to cwd, or equal to cwd AND the repo root, is a no-op
 * rather than a refusal.
 *
 * Entries are expected already resolved into the SAME coordinate system as
 * `resolvedCwd` — the Node shim realpaths both before calling in; sandboxed
 * adapters compare lexically, matching their own walk. Colon-splitting and
 * the leading-`:` symlink-resolution opt-out are `GIT_CEILING_DIRECTORIES`
 * env-string parsing artefacts with no representation in an array argument,
 * so neither is implemented here.
 */
export const longestStrictAncestor = (
  ceilings: ReadonlyArray<string> | undefined,
  resolvedCwd: string,
  pathPolicy: PathPolicy,
): string | undefined => {
  if (ceilings === undefined) return undefined;
  let longest: string | undefined;
  for (const raw of ceilings) {
    const ceiling = pathPolicy.resolve(raw);
    if (!isStrictAncestor(ceiling, resolvedCwd, pathPolicy)) continue;
    if (longest === undefined || ceiling.length > longest.length) longest = ceiling;
  }
  return longest;
};
