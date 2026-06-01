/**
 * Pure builder for git's `squash`/`fixup` combined-message template — the body
 * the merge backend writes to `.git/rebase-merge/message` (and `message-squash`)
 * while melding a group. Byte-faithful to git 2.54:
 *
 *   # This is a combination of <N> commits.
 *   # This is the 1st commit message:
 *
 *   <message 1>
 *
 *   # This is the commit message #2:
 *
 *   <message 2>
 *
 *   # The commit message #3 will be skipped:
 *
 *   # <message 3, each line commented>
 *
 * The first member is introduced by `the 1st commit message:`; a kept (squash)
 * member by `the commit message #<k>:`; a skipped (fixup) member by `The commit
 * message #<k> will be skipped:` with its body commented out (so the editor
 * "cleanup" `stripComments` + `stripspace` drops it). Each message's trailing
 * newlines are normalised to the single separating newline git writes. The
 * cleaned commit message is obtained by the caller's `stripComments` +
 * `stripspace`, so this module only serialises.
 */

/** One group member's message and whether it is a `fixup` (commented/skipped). */
export interface CombinedMessageEntry {
  readonly message: string;
  /** `fixup` members are commented out so the cleaned message drops them. */
  readonly skip?: boolean;
}

const normalise = (message: string): string => message.replace(/\n+$/, '');

/** Comment every line git-style: `# <line>`, or a bare `#` for a blank line. */
const commentOut = (message: string): string =>
  normalise(message)
    .split('\n')
    .map((line) => (line === '' ? '#' : `# ${line}`))
    .join('\n');

const blockFor = (entry: CombinedMessageEntry, index: number): string => {
  if (index === 0) return `# This is the 1st commit message:\n\n${normalise(entry.message)}\n`;
  if (entry.skip === true) {
    return `\n# The commit message #${index + 1} will be skipped:\n\n${commentOut(entry.message)}\n`;
  }
  return `\n# This is the commit message #${index + 1}:\n\n${normalise(entry.message)}\n`;
};

export const buildCombinedMessage = (entries: ReadonlyArray<CombinedMessageEntry>): string => {
  const count = entries.length;
  const plural = count === 1 ? 'commit' : 'commits';
  let out = `# This is a combination of ${count} ${plural}.\n`;
  for (let i = 0; i < count; i += 1) {
    out += blockFor(entries[i] as CombinedMessageEntry, i);
  }
  return out;
};
