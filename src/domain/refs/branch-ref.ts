import type { RefName } from '../objects/index.js';
import { invalidRef } from './error.js';
import { HEADS_PREFIX } from './ref-prefixes.js';
import { validateRefName } from './ref-validation.js';

const HEAD_BRANCH_NAME = 'HEAD';

/**
 * The full ref a new branch would occupy. On top of the ref-name grammar, git
 * refuses a branch named `HEAD` or typed starting with `-` — checks the full
 * `refs/heads/<name>` can no longer see. The dash is tested on the name as
 * typed, before `@{-N}` expands; `HEAD` on the name it expands to.
 */
export const newBranchRef = (shortName: string, typed: string = shortName): RefName => {
  if (shortName === HEAD_BRANCH_NAME) throw invalidRef('branch name must not be HEAD');
  if (typed.startsWith('-')) throw invalidRef('branch name must not start with -');
  return validateRefName(`${HEADS_PREFIX}${shortName}`);
};
