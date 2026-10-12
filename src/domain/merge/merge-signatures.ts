/**
 * git's `fmt_merge_msg_sigs`: each annotated tag merged has its message follow
 * the merge title, a signed tag's signature and verifier report commented
 * beneath it. Pure — the caller reads the tags and runs the verifier.
 */

const COMMENT_PREFIX = '#';
const SPACE_AFTER_PREFIX = ' ';
const NEWLINE = '\n';
const TAB = '\t';

/** One annotated tag merged, as `fmt_merge_msg_sigs` lays it out. */
export interface TagMessage {
  /** `handle_line`'s origin — heads the block once two or more tags merge. */
  readonly origin: string;
  /** The tag's message, its signature excluded. */
  readonly body: string;
  /** The signature followed by the verifier's report; absent for an unsigned tag. */
  readonly signature?: string;
}

/** git's `strbuf_complete_line`: a non-empty text ends with a newline. */
const completeLine = (text: string): string =>
  text === '' || text.endsWith(NEWLINE) ? text : `${text}${NEWLINE}`;

const commentLine = (line: string): string => {
  const bare = line.startsWith(NEWLINE) || line.startsWith(TAB);
  return `${COMMENT_PREFIX}${bare ? '' : SPACE_AFTER_PREFIX}${line}`;
};

/**
 * git's `strbuf_add_commented_lines`: every line behind the comment prefix — a
 * space after it unless the line is empty or tab-led — the last line completed.
 */
export const commentLines = (text: string): string =>
  completeLine(
    text
      .split(/(?<=\n)/)
      .filter((line) => line !== '')
      .map(commentLine)
      .join(''),
  );

/** git's `fmt_tag_signature`: the completed body, then the commented signature. */
const tagBlock = (tag: TagMessage): string => {
  const body = completeLine(tag.body);
  if (tag.signature === undefined || tag.signature === '') return body;
  return `${body}${NEWLINE}${commentLines(tag.signature)}`;
};

const originBlock = (tag: TagMessage): string =>
  `${NEWLINE}${commentLines(tag.origin)}${tagBlock(tag)}`;

/**
 * git's `fmt_merge_msg_sigs`: a blank line, then the lone tag's block — or,
 * with two or more, each block headed by its commented origin.
 */
export const formatTagMessages = (tags: ReadonlyArray<TagMessage>): string => {
  const [only] = tags;
  if (only === undefined) return '';
  if (tags.length === 1) return `${NEWLINE}${tagBlock(only)}`;
  return `${NEWLINE}${tags.map(originBlock).join('')}`;
};
