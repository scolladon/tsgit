/**
 * git's `interpret_branch_mark` scan: `<branch>@{upstream}` / `@{u}` /
 * `@{push}`, matched case-insensitively at the first `@` it applies to.
 */

export type BranchMarkKind = 'upstream' | 'push';

/** A mark found in a name: the branch before it (empty for the current one). */
export interface BranchMark {
  readonly branch: string;
  readonly kind: BranchMarkKind;
  /** Whether the mark ends the name — git substitutes only a name it consumes whole. */
  readonly whole: boolean;
}

const AT = '@';
const PATH_SEPARATOR = ':';
const MARKS: ReadonlyArray<readonly [suffix: string, kind: BranchMarkKind]> = [
  ['@{upstream}', 'upstream'],
  ['@{u}', 'upstream'],
  ['@{push}', 'push'],
];

/** git's `at_mark`: the first suffix the text at `at` starts with, case-insensitively. */
const markAt = (name: string, at: number): readonly [string, BranchMarkKind] | undefined => {
  const rest = name.slice(at).toLowerCase();
  return MARKS.find(([suffix]) => rest.startsWith(suffix));
};

/** The mark at `at`, unless a `:` before it makes the name a path. */
const branchMarkAt = (name: string, at: number): BranchMark | undefined => {
  const found = markAt(name, at);
  if (found === undefined || name.lastIndexOf(PATH_SEPARATOR, at) !== -1) return undefined;
  const [suffix, kind] = found;
  return { branch: name.slice(0, at), kind, whole: at + suffix.length === name.length };
};

/** The branch mark `name` carries at its first `@` that holds one, if any. */
export const findBranchMark = (name: string): BranchMark | undefined => {
  for (let at = name.indexOf(AT); at !== -1; at = name.indexOf(AT, at + 1)) {
    const mark = branchMarkAt(name, at);
    if (mark !== undefined) return mark;
  }
  return undefined;
};
