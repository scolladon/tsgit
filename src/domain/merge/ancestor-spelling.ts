/**
 * git's `merge_name` reading of `<name>^…` / `<name>~<n>`: a revision spelt as
 * an ancestor of a branch tip names that branch, as its "early part" unless
 * the spelling steps back zero commits (`~0`, `~00`).
 */
export interface AncestorSpelling {
  readonly branch: string;
  readonly early: boolean;
}

const TRAILING_CARETS = /\^+$/;
const DIGITS = /^\d*$/;
const NONZERO_DIGIT = /[1-9]/;

export const ancestorSpelling = (name: string): AncestorSpelling | undefined => {
  const carets = TRAILING_CARETS.exec(name);
  if (carets !== null) return { branch: name.slice(0, carets.index), early: true };
  const tilde = name.lastIndexOf('~');
  if (tilde === -1) return undefined;
  const steps = name.slice(tilde + 1);
  if (!DIGITS.test(steps)) return undefined;
  // `name~` is `name~1`.
  const early = steps.length === 0 || NONZERO_DIGIT.test(steps);
  return { branch: name.slice(0, tilde), early };
};
