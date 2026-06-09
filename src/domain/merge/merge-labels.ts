import type { ObjectId } from '../objects/object-id.js';

/**
 * The three conflict labels for a content merge, shared by the built-in markers
 * (`ours` on `<<<<<<<`, `theirs` on `>>>>>>>`) and an external merge driver
 * (`%X` = ours, `%Y` = theirs, `%S` = base). The base label feeds the driver
 * only — v1 writes no diff3 base marker.
 */
export interface MergeLabels {
  readonly ours: string;
  readonly theirs: string;
  readonly base: string;
}

const HEAD = 'HEAD';
const ABBREV_LENGTH = 7;

/** git's fixed 7-char abbreviation (ADR-169 — no object-DB walk to auto-extend). */
export const abbreviateOid = (oid: ObjectId): string => oid.slice(0, ABBREV_LENGTH);

/** git's `<abbrev> (<subject>)` — `find_commit_subject` joined to the short oid. */
const commitLabel = (oid: ObjectId, subject: string): string =>
  `${abbreviateOid(oid)} (${subject})`;

const parentOf = (label: string): string => `parent of ${label}`;

/**
 * Labels for replaying a commit forward (cherry-pick, rebase): theirs is the
 * replayed commit, base is its parent.
 */
export const replayLabels = (oid: ObjectId, subject: string): MergeLabels => {
  const label = commitLabel(oid, subject);
  return { ours: HEAD, theirs: label, base: parentOf(label) };
};

/**
 * Labels for reverting a commit (the inverse of {@link replayLabels}): theirs is
 * the parent, base is the commit being undone.
 */
export const revertLabels = (oid: ObjectId, subject: string): MergeLabels => {
  const label = commitLabel(oid, subject);
  return { ours: HEAD, theirs: parentOf(label), base: label };
};

/**
 * Labels for a `merge`: theirs is the rev argument verbatim (git does not
 * normalise it), base is the abbreviated merge base (empty when there is none).
 */
export const mergeLabels = (revName: string, base: ObjectId | undefined): MergeLabels => ({
  ours: HEAD,
  theirs: revName,
  base: base !== undefined ? abbreviateOid(base) : '',
});

/** git's fixed labels for a `stash` apply/pop conflict. */
export const STASH_LABELS: MergeLabels = {
  ours: 'Updated upstream',
  theirs: 'Stashed changes',
  base: 'Stash base',
};
