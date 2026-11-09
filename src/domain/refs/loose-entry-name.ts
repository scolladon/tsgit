/**
 * git's loose-ref directory entry skip rules. Two walks judge a basename
 * differently: the refs-verify walk and the loose-ref iterator. Pure
 * predicates — no I/O.
 */
const DOT = '.';
const LOCK_SUFFIX = '.lock';

/** git's `files_fsck_refs_dir`: a `.lock` file is skipped unless dot-led. */
export const isSkippedByRefsVerify = (basename: string): boolean =>
  !basename.startsWith(DOT) && basename.endsWith(LOCK_SUFFIX);

/** git's `loose_fill_ref_dir`: a dot-led name or a `.lock` file is skipped. */
export const isSkippedByLooseIterator = (basename: string): boolean =>
  basename.startsWith(DOT) || basename.endsWith(LOCK_SUFFIX);
