import type { PathPolicy } from '../adapters/node/path-policy.js';

/**
 * Longest common ancestor directory of a set of absolute paths. Used to root
 * a worktree filesystem wide enough to reach both the repository and a linked
 * worktree that lives outside it, before the multi-root validator narrows
 * access back down. Driven by an injected `PathPolicy` so the algebra stays
 * native-separator, drive-letter and UNC aware: inputs are resolved first
 * (canonicalising separators and casing) so every root and segment compared
 * afterwards is byte-shaped exactly like what the filesystem adapter's own
 * containment check expects — no spurious rejection of a real descendant.
 */

/** Non-root segments of an already-resolved absolute path. */
const segmentsOf = (resolved: string, policy: PathPolicy): ReadonlyArray<string> =>
  // Stryker disable next-line MethodExpression: equivalent — after policy.resolve an empty segment only arises for a bare volume root, and the loop treats [''] and [] identically (the lone '' matches another bare root and joins to '', or breaks — both yield firstRoot).
  resolved.slice(policy.rootOf(resolved).length).split(policy.sep).filter(Boolean);

/**
 * Whether segment `a` (possibly absent — a shorter path ran out of segments)
 * matches `b` under the policy's comparison rules. The `undefined` guard is
 * required: a rest path that is a strict ancestor of the first input yields
 * `undefined` here, and comparing it would call `normalizeForCompare` on a
 * non-string, throwing on case-insensitive policies.
 */
const segEq = (a: string | undefined, b: string, policy: PathPolicy): boolean =>
  a !== undefined && policy.normalizeForCompare(a) === policy.normalizeForCompare(b);

/**
 * The deepest directory that contains every path in `paths` (each absolute).
 * Returns `policy.sep` when `paths` is empty, or the shared segment prefix
 * under the common root when the paths share one. When the paths don't share
 * a volume/drive root at all, there is no meaningful shared directory — this
 * returns the resolved first input rather than a bare root, so a mismatched
 * caller sees its own path echoed back instead of a container it doesn't own.
 */
export const commonAncestor = (paths: ReadonlyArray<string>, policy: PathPolicy): string => {
  const resolved = paths.map((p) => policy.resolve(p));
  const [first, ...rest] = resolved;
  if (first === undefined) return policy.sep;

  const firstRoot = policy.rootOf(first);
  const rootsMatch = resolved.every(
    (r) => policy.normalizeForCompare(policy.rootOf(r)) === policy.normalizeForCompare(firstRoot),
  );
  if (!rootsMatch) return first;

  const restSegments = rest.map((r) => segmentsOf(r, policy));
  const shared: string[] = [];
  for (const segment of segmentsOf(first, policy)) {
    if (!restSegments.every((list) => segEq(list[shared.length], segment, policy))) break;
    shared.push(segment);
  }
  return firstRoot + shared.join(policy.sep);
};
