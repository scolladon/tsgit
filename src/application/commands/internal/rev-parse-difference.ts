/**
 * git rev-parse's `try_difference` split: an argument holding `..` is first
 * read as a range, the side before the first `..` and the side after it (past
 * a third `.` marking the range symmetric), an empty side standing for `HEAD`.
 * A bare `..` is the parent directory, never a range — unless the argument
 * cannot be a filename, where it reads `HEAD..HEAD`.
 */
const DOTDOT = '..';
const SYMMETRIC_MARK = '.';
const HEAD = 'HEAD';

export interface DifferenceSides {
  readonly start: string;
  readonly end: string;
  readonly symmetric: boolean;
}

const orHead = (side: string): string => (side === '' ? HEAD : side);

/** git's `handle_dotdot` split where the argument cannot be a filename: a bare `..` is `HEAD..HEAD`. */
export const rangeSides = (arg: string): DifferenceSides | undefined => {
  const dotdot = arg.indexOf(DOTDOT);
  if (dotdot === -1) return undefined;
  const after = arg.slice(dotdot + DOTDOT.length);
  const symmetric = after.startsWith(SYMMETRIC_MARK);
  const end = symmetric ? after.slice(SYMMETRIC_MARK.length) : after;
  return { start: orHead(arg.slice(0, dotdot)), end: orHead(end), symmetric };
};

/** The split where the argument may be a filename: a bare `..` is the parent directory. */
export const differenceSides = (arg: string): DifferenceSides | undefined =>
  arg === DOTDOT ? undefined : rangeSides(arg);
