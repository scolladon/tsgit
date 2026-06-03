/**
 * Header bodies for the built-in pretty formats (no trailing newline — the
 * dispatcher frames the diff). Faithful to `git show --pretty=<name>`:
 *   - oneline   `<oid> <subject>`
 *   - short     commit / [Merge] / Author / blank / indented subject
 *   - medium    + Date / full message (the existing default)
 *   - full      + Commit line, no dates
 *   - fuller    Author/AuthorDate/Commit/CommitDate (aligned), full message
 *   - raw       verbatim tree/parent/author/committer header lines
 *   - reference `<abbrev> (<subject>, <short-date>)`
 *   - email/mboxrd  mbox envelope + `Subject: [PATCH] …` + body
 */
import { commitBody, subjectLine } from '../objects/commit-message.js';
import type { AuthorIdentity, CommitData, ObjectId } from '../objects/index.js';
import { formatDate } from './date-mode.js';
import { type DateFormatter, defaultDateFormatter } from './identity-header.js';
import { indentMessage } from './message-indent.js';

const ABBREV = 7;
const FULLER_LABEL_WIDTH = 12;
const MBOX_MAGIC = 'Mon Sep 17 00:00:00 2001';

export interface BuiltinParts {
  readonly id: ObjectId;
  readonly commit: CommitData;
  /** `Date:`/`AuthorDate:` formatter bound to `--date=`. */
  readonly formatDate: DateFormatter;
  readonly now: number;
}

const abbrev = (oid: ObjectId): string => oid.slice(0, ABBREV);

const identityText = (identity: AuthorIdentity): string => `${identity.name} <${identity.email}>`;

const mergeLine = (parents: ReadonlyArray<ObjectId>): string | undefined =>
  parents.length >= 2 ? `Merge: ${parents.map(abbrev).join(' ')}` : undefined;

const headerLines = (parts: BuiltinParts, extra: ReadonlyArray<string>): string[] => {
  const merge = mergeLine(parts.commit.parents);
  return [`commit ${parts.id}`, ...(merge !== undefined ? [merge] : []), ...extra];
};

const block = (lines: ReadonlyArray<string>, message: string): string =>
  `${lines.join('\n')}\n\n${indentMessage(message)}`;

const dateLine = (label: string, identity: AuthorIdentity, fmt: DateFormatter): string =>
  `${label}${fmt(identity)}`;

const renderOneline = (parts: BuiltinParts): string =>
  `${parts.id} ${subjectLine(parts.commit.message)}`;

const renderShort = (parts: BuiltinParts): string =>
  block(
    headerLines(parts, [`Author: ${identityText(parts.commit.author)}`]),
    subjectLine(parts.commit.message),
  );

const renderMedium = (parts: BuiltinParts): string =>
  block(
    headerLines(parts, [
      `Author: ${identityText(parts.commit.author)}`,
      dateLine('Date:   ', parts.commit.author, parts.formatDate),
    ]),
    parts.commit.message,
  );

const renderFull = (parts: BuiltinParts): string =>
  block(
    headerLines(parts, [
      `Author: ${identityText(parts.commit.author)}`,
      `Commit: ${identityText(parts.commit.committer)}`,
    ]),
    parts.commit.message,
  );

const fullerLabel = (label: string): string => `${label}:`.padEnd(FULLER_LABEL_WIDTH);

const renderFuller = (parts: BuiltinParts): string =>
  block(
    headerLines(parts, [
      `${fullerLabel('Author')}${identityText(parts.commit.author)}`,
      dateLine(fullerLabel('AuthorDate'), parts.commit.author, parts.formatDate),
      `${fullerLabel('Commit')}${identityText(parts.commit.committer)}`,
      dateLine(fullerLabel('CommitDate'), parts.commit.committer, parts.formatDate),
    ]),
    parts.commit.message,
  );

const rawIdentity = (identity: AuthorIdentity): string =>
  `${identity.name} <${identity.email}> ${identity.timestamp} ${identity.timezoneOffset}`;

const renderRaw = (parts: BuiltinParts): string => {
  const lines = [
    `commit ${parts.id}`,
    `tree ${parts.commit.tree}`,
    ...parts.commit.parents.map((parent) => `parent ${parent}`),
    `author ${rawIdentity(parts.commit.author)}`,
    `committer ${rawIdentity(parts.commit.committer)}`,
  ];
  return block(lines, parts.commit.message);
};

const renderReference = (parts: BuiltinParts): string => {
  const shortDate = formatDate(
    { kind: 'short' },
    parts.commit.author.timestamp,
    parts.commit.author.timezoneOffset,
    parts.now,
  );
  return `${abbrev(parts.id)} (${subjectLine(parts.commit.message)}, ${shortDate})`;
};

const mboxrdQuote = (body: string): string =>
  body
    .split('\n')
    .map((line) => (/^>*From /.test(line) ? `>${line}` : line))
    .join('\n');

const renderEmail = (parts: BuiltinParts, quote: boolean): string => {
  const date = formatDate(
    { kind: 'rfc' },
    parts.commit.author.timestamp,
    parts.commit.author.timezoneOffset,
    parts.now,
  );
  const subject = subjectLine(parts.commit.message);
  const rawBody = commitBody(parts.commit.message);
  const body = quote ? mboxrdQuote(rawBody) : rawBody;
  const head = `From ${parts.id} ${MBOX_MAGIC}\nFrom: ${identityText(parts.commit.author)}\nDate: ${date}\nSubject: [PATCH] ${subject}`;
  // The blank line + body (which carries its own trailing newline, or is empty)
  // are part of the header; framing adds no terminator for email/mboxrd.
  return `${head}\n\n${body}`;
};

export function renderBuiltinHeader(
  name:
    | 'oneline'
    | 'short'
    | 'medium'
    | 'full'
    | 'fuller'
    | 'raw'
    | 'reference'
    | 'email'
    | 'mboxrd',
  parts: BuiltinParts,
): string {
  switch (name) {
    case 'oneline':
      return renderOneline(parts);
    case 'short':
      return renderShort(parts);
    case 'medium':
      return renderMedium(parts);
    case 'full':
      return renderFull(parts);
    case 'fuller':
      return renderFuller(parts);
    case 'raw':
      return renderRaw(parts);
    case 'reference':
      return renderReference(parts);
    case 'email':
      return renderEmail(parts, false);
    case 'mboxrd':
      return renderEmail(parts, true);
  }
}

export { defaultDateFormatter };
