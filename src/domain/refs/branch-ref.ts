import type { RefName } from '../objects/index.js';
import { invalidRef } from './error.js';
import { HEADS_PREFIX } from './ref-prefixes.js';
import { validateRefName } from './ref-validation.js';

const HEAD_BRANCH_NAME = 'HEAD';

/**
 * The full ref a new branch `shortName` would occupy. On top of the ref-name
 * grammar, git refuses a branch named `HEAD` or starting with `-` — checks the
 * full `refs/heads/<name>` can no longer see.
 */
export const newBranchRef = (shortName: string): RefName => {
  if (shortName === HEAD_BRANCH_NAME) throw invalidRef('branch name must not be HEAD');
  if (shortName.startsWith('-')) throw invalidRef('branch name must not start with -');
  return validateRefName(`${HEADS_PREFIX}${shortName}`);
};
