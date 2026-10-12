/**
 * git's `squash_message`: the `SQUASH_MSG` a `merge --squash` leaves for the
 * commit that concludes it — every commit squashed, newest first, in the
 * `medium` pretty format.
 */
import type { ObjectId } from '../objects/index.js';
import { splitIdentLine } from '../pretty/ident.js';
import { type DateClock, showIdentDate } from '../pretty/ident-date.js';

const HEADER = 'Squashed commit of the following:\n';
const INDENT = '    ';
/** git's `isspace`, which `is_blank_line` and the closing right-trim strip. */
const TRAILING_SPACE = /[ \t\n\r]+$/;
const NO_CLOCK: DateClock = { nowSeconds: 0, localOffsetMinutes: 0 };
/** `show_ident_date`'s fallback when the ident carries no date: the epoch, in UTC. */
const EPOCH = new TextEncoder().encode('0');
const UTC = new TextEncoder().encode('+0000');
const decoder = new TextDecoder();

/**
 * One commit squashed: `mergeParents` are a merge's abbreviated parents, empty otherwise;
 * `author` is the raw `author` header value, if any, read the way `split_ident_line` reads it.
 */
export interface SquashedCommit {
  readonly id: ObjectId;
  readonly mergeParents: ReadonlyArray<string>;
  readonly author: Uint8Array | undefined;
  readonly message: string;
}

/** `pp_remainder` with an indent: leading blank lines skipped, every line right-trimmed and indented. */
const indentedBody = (message: string): string => {
  const lines = message.split('\n').map((line) => line.replace(TRAILING_SPACE, ''));
  const first = lines.findIndex((line) => line !== '');
  // Stryker disable next-line ConditionalExpression: equivalent — an all-blank body would render one bare indent, which the entry's closing right-trim removes
  if (first === -1) return '';
  return lines
    .slice(first)
    .map((line) => `${INDENT}${line}\n`)
    .join('');
};

/** `pp_user_info` in `medium`: nothing for a missing ident or one `split_ident_line` rejects. */
const authorLines = (author: Uint8Array | undefined): string => {
  if (author === undefined) return '';
  const { name, mail, date = EPOCH, tz = UTC } = splitIdentLine(author);
  if (!mail) return '';
  const ident = `${decoder.decode(name)} <${decoder.decode(mail)}>`;
  return `Author: ${ident}\nDate:   ${showIdentDate(date, tz, 'normal', NO_CLOCK)}\n`;
};

/** `pretty_print_commit` in `medium`: the header lines, a blank line, then the body, right-trimmed. */
const mediumEntry = (commit: SquashedCommit): string => {
  const merge = commit.mergeParents.length === 0 ? '' : `Merge: ${commit.mergeParents.join(' ')}\n`;
  const header = `${merge}${authorLines(commit.author)}`;
  const entry = `\ncommit ${commit.id}\n${header}\n${indentedBody(commit.message)}`;
  return `${entry.replace(TRAILING_SPACE, '')}\n`;
};

/** git's `squash_message` over the commits squashed, in walk order. */
export const squashMessage = (commits: ReadonlyArray<SquashedCommit>): string =>
  `${HEADER}${commits.map(mediumEntry).join('')}`;
