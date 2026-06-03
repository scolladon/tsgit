/**
 * Ref decoration rendering for `%d` / `%D` and the `reference` pretty format,
 * faithful to git's `format_decorations`. git loads refs in ascending full-name
 * order and prepends each, so the printed order within a commit is **descending
 * full refname**; `HEAD` (as `HEAD -> <branch>` when symbolic, else bare) is
 * pulled to the front. Tags render `tag: <name>`; heads and remotes render their
 * short name.
 */

export type RefKind = 'head' | 'tag' | 'remote';

export interface DecorationRef {
  readonly fullName: string;
  readonly kind: RefKind;
}

export interface DecorationInput {
  /** Every head/tag/remote ref pointing at the commit. */
  readonly refs: ReadonlyArray<DecorationRef>;
  /** Full refname of HEAD's branch, when HEAD symbolically targets a branch at this commit. */
  readonly headBranch?: string;
  /** HEAD is detached directly at this commit. */
  readonly detachedHead?: boolean;
}

const PREFIXES: Readonly<Record<RefKind, string>> = {
  head: 'refs/heads/',
  tag: 'refs/tags/',
  remote: 'refs/remotes/',
};

const shortName = (ref: DecorationRef): string => ref.fullName.slice(PREFIXES[ref.kind].length);

const labelFor = (ref: DecorationRef): string =>
  ref.kind === 'tag' ? `tag: ${shortName(ref)}` : shortName(ref);

export function decorationLabels(input: DecorationInput): ReadonlyArray<string> {
  const descending = [...input.refs].sort((a, b) => (a.fullName < b.fullName ? 1 : -1));
  const head: string[] = [];
  let rest = descending;
  if (input.headBranch !== undefined) {
    const branch = input.headBranch;
    head.push(`HEAD -> ${branch.slice(PREFIXES.head.length)}`);
    rest = descending.filter((ref) => ref.fullName !== branch);
  } else if (input.detachedHead === true) {
    head.push('HEAD');
  }
  return [...head, ...rest.map(labelFor)];
}

/** `%D`: the bare, comma-separated decoration (empty when there is none). */
export const decorationBare = (labels: ReadonlyArray<string>): string => labels.join(', ');

/** `%d`: the parenthesised decoration with a leading space, empty when none. */
export const decorationParen = (labels: ReadonlyArray<string>): string =>
  labels.length === 0 ? '' : ` (${decorationBare(labels)})`;
