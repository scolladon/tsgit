/**
 * git rev-parse's `try_parent_shorthands` split: the first `^!` ends the
 * argument for `<rev>^!`, else the first `^@` for `<rev>^@`, else the first
 * `^-` opens `<rev>^-<n>`, `<n>` read as `strtoul` reads it — C whitespace and
 * a `+` before the digits — and `1` when absent. Anything after the mark, or
 * a parent number of zero, is no shorthand.
 */
const EXCLUDE_PARENTS_MARK = '^!';
const PARENTS_MARK = '^@';
const EXCLUDE_PARENT_MARK = '^-';
const DEFAULT_PARENT_NUMBER = 1;
const DECIMAL = 10;
/** `strtoul`'s accepted spelling: a `-` wraps past every parent count, so it never names one. */
const PARENT_NUMBER = /^[ \t\n\v\f\r]*\+?[0-9]+$/;

export type ParentShorthand =
  | { readonly kind: 'parents'; readonly base: string }
  | { readonly kind: 'exclude-parents'; readonly base: string }
  | { readonly kind: 'exclude-parent'; readonly base: string; readonly n: number };

/** The base before `mark` when `mark` ends `arg`; `undefined` when it stops short. */
const baseEndingWith = (arg: string, at: number, mark: string): string | undefined =>
  at + mark.length === arg.length ? arg.slice(0, at) : undefined;

const parentNumber = (spelt: string): number | undefined => {
  if (spelt === '') return DEFAULT_PARENT_NUMBER;
  if (!PARENT_NUMBER.test(spelt)) return undefined;
  const n = Number.parseInt(spelt, DECIMAL);
  return n === 0 ? undefined : n;
};

const excludeParent = (arg: string, at: number): ParentShorthand | undefined => {
  const n = parentNumber(arg.slice(at + EXCLUDE_PARENT_MARK.length));
  return n === undefined ? undefined : { kind: 'exclude-parent', base: arg.slice(0, at), n };
};

export const parentShorthand = (arg: string): ParentShorthand | undefined => {
  const bang = arg.indexOf(EXCLUDE_PARENTS_MARK);
  if (bang !== -1) {
    const base = baseEndingWith(arg, bang, EXCLUDE_PARENTS_MARK);
    return base === undefined ? undefined : { kind: 'exclude-parents', base };
  }
  const at = arg.indexOf(PARENTS_MARK);
  if (at !== -1) {
    const base = baseEndingWith(arg, at, PARENTS_MARK);
    return base === undefined ? undefined : { kind: 'parents', base };
  }
  const dash = arg.indexOf(EXCLUDE_PARENT_MARK);
  return dash === -1 ? undefined : excludeParent(arg, dash);
};
