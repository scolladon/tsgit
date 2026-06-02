/**
 * The `format:`/`tformat:` placeholder engine. `buildCommitFields` precomputes
 * every supported placeholder's value; `expandTemplate` walks the template,
 * substituting `%`-codes (two-letter `%a?`/`%c?` author/committer fields,
 * one-letter codes, `%xXX` hex bytes, `%n`, `%%`). An unknown `%?` is left
 * verbatim — git's behaviour.
 */
import { subjectLine } from '../objects/commit-message.js';
import type { AuthorIdentity, CommitData, ObjectId } from '../objects/index.js';
import { type DateMode, formatDate } from './date-mode.js';
import {
  type DecorationRef,
  decorationBare,
  decorationLabels,
  decorationParen,
} from './decoration.js';

const ABBREV = 7;

const HEX_PAIR = /^[0-9a-fA-F]{2}/;

/** `%f`: the path-safe subject — non-alphanumeric runs become `-`, leading/trailing `-` trimmed (case kept). */
const sanitizeSubject = (subject: string): string =>
  subject
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

const bodyOf = (message: string): string => {
  const blank = message.indexOf('\n\n');
  return blank === -1 ? '' : message.slice(blank + 2);
};

const encodingOf = (commit: CommitData): string =>
  commit.extraHeaders.find((h) => h.key === 'encoding')?.value ?? '';

export interface FieldContext {
  readonly id: ObjectId;
  readonly commit: CommitData;
  readonly dateMode: DateMode;
  readonly now: number;
  readonly refs: ReadonlyArray<DecorationRef>;
  readonly headBranch?: string;
  readonly detachedHead?: boolean;
}

const identityFields = (
  prefix: 'a' | 'c',
  identity: AuthorIdentity,
  dateMode: DateMode,
  now: number,
): Record<string, string> => {
  const at = (mode: DateMode): string =>
    formatDate(mode, identity.timestamp, identity.timezoneOffset, now);
  return {
    [`${prefix}n`]: identity.name,
    [`${prefix}e`]: identity.email,
    [`${prefix}d`]: at(dateMode),
    [`${prefix}D`]: at({ kind: 'rfc' }),
    [`${prefix}i`]: at({ kind: 'iso' }),
    [`${prefix}I`]: at({ kind: 'iso-strict' }),
    [`${prefix}s`]: at({ kind: 'short' }),
    [`${prefix}t`]: String(identity.timestamp),
    [`${prefix}r`]: at({ kind: 'relative' }),
    [`${prefix}h`]: at({ kind: 'human' }),
  };
};

export const buildCommitFields = (ctx: FieldContext): Readonly<Record<string, string>> => {
  const { commit } = ctx;
  const labels = decorationLabels({
    refs: ctx.refs,
    ...(ctx.headBranch !== undefined ? { headBranch: ctx.headBranch } : {}),
    ...(ctx.detachedHead === true ? { detachedHead: true } : {}),
  });
  const subject = subjectLine(commit.message);
  return {
    H: ctx.id,
    h: ctx.id.slice(0, ABBREV),
    T: commit.tree,
    t: commit.tree.slice(0, ABBREV),
    P: commit.parents.join(' '),
    p: commit.parents.map((parent) => parent.slice(0, ABBREV)).join(' '),
    s: subject,
    f: sanitizeSubject(subject),
    b: bodyOf(commit.message),
    B: commit.message,
    e: encodingOf(commit),
    d: decorationParen(labels),
    D: decorationBare(labels),
    n: '\n',
    '%': '%',
    ...identityFields('a', commit.author, ctx.dateMode, ctx.now),
    ...identityFields('c', commit.committer, ctx.dateMode, ctx.now),
  };
};

export const expandTemplate = (
  template: string,
  fields: Readonly<Record<string, string>>,
): string => {
  let out = '';
  let i = 0;
  while (i < template.length) {
    if (template[i] !== '%' || i + 1 >= template.length) {
      out += template[i];
      i += 1;
      continue;
    }
    const next = template[i + 1] as string;
    const hex = template.slice(i + 2, i + 4);
    if (next === 'x' && HEX_PAIR.test(hex)) {
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 4;
      continue;
    }
    const two = template.slice(i + 1, i + 3);
    if ((next === 'a' || next === 'c') && fields[two] !== undefined) {
      out += fields[two];
      i += 3;
      continue;
    }
    if (fields[next] !== undefined) {
      out += fields[next];
      i += 2;
      continue;
    }
    // Unknown placeholder: emit the `%` and reprocess the following char as a literal.
    out += '%';
    i += 1;
  }
  return out;
};
