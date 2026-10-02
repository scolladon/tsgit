import { isAsciiSpace } from '../pretty/ascii.js';

export interface MailmapRule {
  readonly newName?: string | undefined;
  readonly newEmail?: string | undefined;
  readonly oldName?: string | undefined;
  readonly oldEmail: string;
}

interface NameAndEmail {
  readonly name?: string | undefined;
  readonly email: string;
  readonly rest: string;
}

const COMMENT = '#';
const NUL = '\0';

const trimAsciiSpace = (text: string): string => {
  let start = 0;
  let end = text.length;
  while (start < end && isAsciiSpace(text.charCodeAt(start))) start++;
  while (end > start && isAsciiSpace(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
};

const nonEmpty = (text: string): string | undefined => (text === '' ? undefined : text);

const parseNameAndEmail = (text: string, allowEmptyEmail: boolean): NameAndEmail | undefined => {
  const left = text.indexOf('<');
  if (left < 0) return undefined;
  const right = text.indexOf('>', left + 1);
  if (right < 0) return undefined;
  if (!allowEmptyEmail && left + 1 === right) return undefined;
  return {
    name: nonEmpty(trimAsciiSpace(text.slice(0, left))),
    email: text.slice(left + 1, right),
    rest: text.slice(right + 1),
  };
};

const parseLine = (rawLine: string): MailmapRule | undefined => {
  if (rawLine.startsWith(COMMENT)) return undefined;
  const nul = rawLine.indexOf(NUL);
  const line = nul < 0 ? rawLine : rawLine.slice(0, nul);
  const first = parseNameAndEmail(line, false);
  if (first === undefined) return undefined;
  const second = first.rest === '' ? undefined : parseNameAndEmail(first.rest, true);
  if (second === undefined) return { newName: first.name, oldEmail: first.email };
  return {
    newName: first.name,
    newEmail: first.email,
    oldName: second.name,
    oldEmail: second.email,
  };
};

/** Grammar of git's `read_mailmap_line`: one rule per well-formed line, in file order. */
export const parseMailmap = (text: string): readonly MailmapRule[] =>
  text.split('\n').flatMap((line) => parseLine(line) ?? []);
