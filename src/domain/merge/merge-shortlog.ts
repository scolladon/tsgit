/**
 * git's merge-message shortlog (`fmt_merge_msg`'s `--log`): under each head
 * merged, the subjects of the commits it brings in, newest first.
 */
import { type ParsedHead, parseHead } from './merge-title.js';

/** git's `DEFAULT_MERGE_LOG_LEN`: `--log` / `merge.log = true` without a count. */
export const DEFAULT_MERGE_LOG_LENGTH = 20;

const LOCAL_SOURCE = '.';
const QUOTE = "'";
const ELIDED = '  ...\n';
const DESCRIPTION_LINE_PREFIX = '  : ';

/** How a head's shortlog block is headed, and whether it is a local branch. */
export interface ShortlogOrigin {
  readonly name: string;
  readonly localBranch: boolean;
}

/** One head's walk: the non-merge commits counted, the first `limit + 1` subjects kept. */
export interface ShortlogWalk {
  readonly name: string;
  readonly count: number;
  readonly subjects: ReadonlyArray<string>;
  /** `branch.<name>.description`, under `merge.branchdesc` for a local branch. */
  readonly description?: string;
}

/** The name `handle_line` gives a head before it qualifies it with its source. */
const bareOrigin = (head: ParsedHead): string => {
  if (head.kind === 'tag') return `tag ${head.name}`;
  if (head.kind === 'branch' || head.kind === 'remoteBranch') return head.name;
  return head.source;
};

const unquoted = (name: string): string =>
  name.length > 1 && name.startsWith(QUOTE) && name.endsWith(QUOTE) ? name.slice(1, -1) : name;

/** git's `handle_line` origin: a local or self-named head unquoted, any other `<name> of <source>`. */
export const shortlogOrigin = (description: string): ShortlogOrigin => {
  const head = parseHead(description);
  const origin = bareOrigin(head);
  const local = head.source === LOCAL_SOURCE;
  const name = local || head.source === origin ? unquoted(origin) : `${origin} of ${head.source}`;
  return { name, localBranch: local && head.kind === 'branch' };
};

/** git's `add_branch_desc`: every line of the description behind `  : `, the last completed. */
const descriptionLines = (description: string): string =>
  description
    .split(/(?<=\n)/)
    .filter((line) => line !== '')
    .map((line) => `${DESCRIPTION_LINE_PREFIX}${line}${line.endsWith('\n') ? '' : '\n'}`)
    .join('');

/** git's `shortlog`: `* <name>:` (with the count past `limit`), then each subject, eliding past `limit`. */
export const formatShortlog = (walk: ShortlogWalk, limit: number): string => {
  const count = walk.count > limit ? ` (${walk.count} commits)` : '';
  const subjects = walk.subjects.map((subject, i) => (i >= limit ? ELIDED : `  ${subject}\n`));
  const description = walk.description === undefined ? '' : descriptionLines(walk.description);
  return `\n* ${walk.name}:${count}\n${description}${subjects.join('')}`;
};
