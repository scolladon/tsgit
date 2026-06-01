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
 *   …
 *
 * The first member is introduced by `the 1st commit message:`, every later
 * member by `the commit message #<k>:`. Each message's trailing newlines are
 * normalised to the single separating newline git writes. The cleaned commit
 * message is obtained by the caller's existing `stripComments` + `stripspace`
 * (the editor "cleanup" git applies on commit), so this module only serialises.
 */

const normalise = (message: string): string => message.replace(/\n+$/, '');

const blockHeader = (index: number): string =>
  index === 0 ? '# This is the 1st commit message:' : `# This is the commit message #${index + 1}:`;

export const buildCombinedMessage = (messages: ReadonlyArray<string>): string => {
  const count = messages.length;
  const plural = count === 1 ? 'commit' : 'commits';
  let out = `# This is a combination of ${count} ${plural}.\n`;
  for (let i = 0; i < count; i += 1) {
    const lead = i === 0 ? '' : '\n';
    out += `${lead}${blockHeader(i)}\n\n${normalise(messages[i] as string)}\n`;
  }
  return out;
};
