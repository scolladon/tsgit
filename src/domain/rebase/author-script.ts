/**
 * Pure serializer/parser for `.git/rebase-merge/author-script` — the file the
 * merge backend writes to preserve a stopped commit's author across a
 * `--continue`. Byte-faithful to git:
 *
 *   GIT_AUTHOR_NAME='<name>'
 *   GIT_AUTHOR_EMAIL='<email>'
 *   GIT_AUTHOR_DATE='@<unix> <tz>'
 *
 * Each value is shell single-quoted git's `sq_quote` way (wrap in `'…'`, escape
 * an embedded `'` as `'\''`); the date uses git's `@<unix>`-prefixed internal
 * format. A corrupt script (mid-write crash) is rejected via `invalidIdentity`
 * rather than silently producing a malformed author on the resolving commit.
 */
import type { AuthorIdentity } from '../objects/author-identity.js';
import { invalidIdentity } from '../objects/error.js';

export type { AuthorIdentity };

const sqQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const unSqQuote = (quoted: string): string => quoted.slice(1, -1).replaceAll("'\\''", "'");

export const serializeAuthorScript = (identity: AuthorIdentity): string =>
  `GIT_AUTHOR_NAME=${sqQuote(identity.name)}\n` +
  `GIT_AUTHOR_EMAIL=${sqQuote(identity.email)}\n` +
  `GIT_AUTHOR_DATE=${sqQuote(`@${identity.timestamp} ${identity.timezoneOffset}`)}\n`;

/** Pull a `KEY='<sq-quoted>'` value off the line set, or refuse if absent/malformed. */
const readValue = (lines: ReadonlyArray<string>, key: string): string => {
  const prefix = `${key}=`;
  const line = lines.find((l) => l.startsWith(prefix));
  if (line === undefined) throw invalidIdentity(key, 'missing author-script key');
  const quoted = line.slice(prefix.length);
  if (quoted.length < 2 || !quoted.startsWith("'") || !quoted.endsWith("'")) {
    throw invalidIdentity(line, 'author-script value is not single-quoted');
  }
  return unSqQuote(quoted);
};

export const parseAuthorScript = (text: string): AuthorIdentity => {
  const lines = text.split('\n');
  const name = readValue(lines, 'GIT_AUTHOR_NAME');
  const email = readValue(lines, 'GIT_AUTHOR_EMAIL');
  const date = readValue(lines, 'GIT_AUTHOR_DATE');
  if (!date.startsWith('@')) {
    throw invalidIdentity(date, 'author-script date lacks the `@` prefix');
  }
  const [rawTimestamp, timezoneOffset] = date.slice(1).split(' ');
  const timestamp = Number(rawTimestamp);
  if (!Number.isSafeInteger(timestamp)) {
    throw invalidIdentity(date, 'invalid author-script timestamp');
  }
  if (timezoneOffset === undefined || !/^[+-]\d{4}$/.test(timezoneOffset)) {
    throw invalidIdentity(date, 'invalid author-script timezone offset');
  }
  return { name, email, timestamp, timezoneOffset };
};
