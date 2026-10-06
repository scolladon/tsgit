/**
 * git's `squash_message`: the `SQUASH_MSG` a `merge --squash` leaves for the
 * commit that concludes it — every commit squashed, newest first, in the
 * `medium` pretty format.
 */
import type { AuthorIdentity, ObjectId } from '../objects/index.js';
import { showDate } from '../pretty/date.js';

const HEADER = 'Squashed commit of the following:\n';
const INDENT = '    ';
/** git's `isspace`, which `is_blank_line` and the closing right-trim strip. */
const TRAILING_SPACE = /[ \t\n\r]+$/;
const NO_CLOCK = 0;

/** One commit squashed: `mergeParents` are a merge's abbreviated parents, empty otherwise. */
export interface SquashedCommit {
  readonly id: ObjectId;
  readonly mergeParents: ReadonlyArray<string>;
  readonly author: AuthorIdentity;
  readonly message: string;
}

/** `pp_remainder` with an indent: leading blank lines skipped, every line right-trimmed and indented. */
const indentedBody = (message: string): string => {
  const lines = message.split('\n').map((line) => line.replace(TRAILING_SPACE, ''));
  const first = lines.findIndex((line) => line !== '');
  if (first === -1) return '';
  return lines
    .slice(first)
    .map((line) => `${INDENT}${line}\n`)
    .join('');
};

/** git's `show_ident_date` in the default (`normal`) mode, in the author's own zone. */
const authorDate = (author: AuthorIdentity): string =>
  showDate(BigInt(author.timestamp), Number(author.timezoneOffset), 'normal', NO_CLOCK, NO_CLOCK);

/** `pretty_print_commit` in `medium`: the header lines, a blank line, then the body, right-trimmed. */
const mediumEntry = (commit: SquashedCommit): string => {
  const merge = commit.mergeParents.length === 0 ? '' : `Merge: ${commit.mergeParents.join(' ')}\n`;
  const { name, email } = commit.author;
  const header = `${merge}Author: ${name} <${email}>\nDate:   ${authorDate(commit.author)}\n`;
  const entry = `${header}\n${indentedBody(commit.message)}`;
  return `\ncommit ${commit.id}\n${entry.replace(TRAILING_SPACE, '')}\n`;
};

/** git's `squash_message` over the commits squashed, in walk order. */
export const squashMessage = (commits: ReadonlyArray<SquashedCommit>): string =>
  `${HEADER}${commits.map(mediumEntry).join('')}`;
