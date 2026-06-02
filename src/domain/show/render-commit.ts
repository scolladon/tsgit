/**
 * Render the block `git show <commit>` prints: a `commit <oid>` header, an
 * optional `Merge:` line (merge commits), the `Author:` / `Date:` lines, a
 * blank line, the 4-space-indented message, and — when a patch is supplied —
 * a blank line and the unified diff. Merge-patch suppression and root-commit
 * patch computation are the caller's concern; this renderer appends `patchText`
 * iff a non-empty one is given.
 */
import type { CommitData, ObjectId } from '../objects/index.js';
import { renderIdentityHeader } from './identity-header.js';
import { indentMessage } from './message-indent.js';

const ABBREV_LENGTH = 7;

export interface CommitBlockParts {
  readonly id: ObjectId;
  readonly commit: CommitData;
  readonly patchText?: string;
}

export function renderCommitBlock({ id, commit, patchText }: CommitBlockParts): string {
  const isMerge = commit.parents.length >= 2;
  const lines = [`commit ${id}`];
  if (isMerge) {
    lines.push(`Merge: ${commit.parents.map((p) => p.slice(0, ABBREV_LENGTH)).join(' ')}`);
  }
  lines.push(...renderIdentityHeader('Author', commit.author));
  const block = `${lines.join('\n')}\n\n${indentMessage(commit.message)}\n`;
  if (patchText) return `${block}\n${patchText}`;
  // A merge shows no patch but git terminates it with a trailing blank line
  // (the empty-diff-merges terminator); a non-merge no-diff commit does not.
  return isMerge ? `${block}\n` : block;
}
