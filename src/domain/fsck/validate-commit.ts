import {
  MSG_BAD_DATE,
  MSG_BAD_DATE_OVERFLOW,
  MSG_BAD_PARENT_SHA1,
  MSG_BAD_TIMEZONE,
  MSG_BAD_TREE_SHA1,
  MSG_MISSING_AUTHOR,
  MSG_MISSING_COMMITTER,
  MSG_MISSING_EMAIL,
  MSG_MISSING_NAME_BEFORE_EMAIL,
  MSG_MISSING_SPACE_BEFORE_DATE,
  MSG_MISSING_SPACE_BEFORE_EMAIL,
  MSG_MISSING_TREE,
  MSG_MULTIPLE_AUTHORS,
  MSG_NUL_IN_COMMIT,
  MSG_NUL_IN_HEADER,
  MSG_ZERO_PADDED_DATE,
} from './msg-ids.js';
import { resolveSeverity } from './severity.js';
import type { FsckSeverity } from './types.js';

export interface CommitFinding {
  readonly msgId: string;
  readonly severity: FsckSeverity;
}

const SHA1_HEX_RE = /^[0-9a-f]{40}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const TIMEZONE_RE = /^[+-]\d{4}$/;

function isValidSha(hex: string): boolean {
  return SHA1_HEX_RE.test(hex) || SHA256_HEX_RE.test(hex);
}

function isValidTimezone(tz: string): boolean {
  if (!TIMEZONE_RE.test(tz)) return false;
  const hours = Number.parseInt(tz.slice(1, 3), 10);
  const minutes = Number.parseInt(tz.slice(3, 5), 10);
  return hours < 24 && minutes < 60;
}

// INT64_MAX = 2^63 - 1 = 9223372036854775807 (19 decimal digits).
// Pinned real git 2.54.0: timestamps with this value are valid; values above
// this emit badDateOverflow (not badDate).  git parses timestamps with the
// C stdlib unsigned-max call and compares against TIME_T_MAX; the effective
// limit on 64-bit platforms is INT64_MAX.
const INT64_MAX_STR = '9223372036854775807';

function isTimestampOverflow(timestamp: string): boolean {
  if (timestamp.length > INT64_MAX_STR.length) return true;
  if (timestamp.length < INT64_MAX_STR.length) return false;
  return timestamp > INT64_MAX_STR;
}

function checkTimestamp(timestamp: string, strict: boolean): CommitFinding | undefined {
  if (timestamp.startsWith('0') && timestamp.length > 1) {
    return { msgId: MSG_ZERO_PADDED_DATE, severity: resolveSeverity(MSG_ZERO_PADDED_DATE, strict) };
  }
  if (!/^\d+$/.test(timestamp)) {
    return { msgId: MSG_BAD_DATE, severity: resolveSeverity(MSG_BAD_DATE, strict) };
  }
  if (isTimestampOverflow(timestamp)) {
    return {
      msgId: MSG_BAD_DATE_OVERFLOW,
      severity: resolveSeverity(MSG_BAD_DATE_OVERFLOW, strict),
    };
  }
  return undefined;
}

/**
 * Validate a single identity line (value after "author " or "committer ").
 * Returns msg-ids for detected faults.
 */
function checkIdentityLine(line: string, strict: boolean): ReadonlyArray<CommitFinding> {
  const findings: CommitFinding[] = [];
  const ltIdx = line.indexOf('<');
  if (ltIdx === -1) {
    findings.push({
      msgId: MSG_MISSING_EMAIL,
      severity: resolveSeverity(MSG_MISSING_EMAIL, strict),
    });
    return findings;
  }

  const name = line.slice(0, ltIdx);
  if (!name.endsWith(' ')) {
    findings.push({
      msgId: MSG_MISSING_SPACE_BEFORE_EMAIL,
      severity: resolveSeverity(MSG_MISSING_SPACE_BEFORE_EMAIL, strict),
    });
  }
  if (name.trimEnd() === '') {
    findings.push({
      msgId: MSG_MISSING_NAME_BEFORE_EMAIL,
      severity: resolveSeverity(MSG_MISSING_NAME_BEFORE_EMAIL, strict),
    });
  }

  const gtIdx = line.indexOf('>', ltIdx);
  if (gtIdx === -1) {
    findings.push({
      msgId: MSG_MISSING_EMAIL,
      severity: resolveSeverity(MSG_MISSING_EMAIL, strict),
    });
    return findings;
  }

  const afterGt = line.slice(gtIdx + 1);
  if (!afterGt.startsWith(' ')) {
    findings.push({
      msgId: MSG_MISSING_SPACE_BEFORE_DATE,
      severity: resolveSeverity(MSG_MISSING_SPACE_BEFORE_DATE, strict),
    });
    return findings;
  }

  const parts = afterGt.trim().split(/\s+/);
  const timestamp = parts[0]!;
  const timezone = parts[1] ?? '';

  const timestampFault = checkTimestamp(timestamp, strict);
  if (timestampFault !== undefined) {
    findings.push(timestampFault);
    return findings;
  }

  if (timezone !== '' && !isValidTimezone(timezone)) {
    findings.push({ msgId: MSG_BAD_TIMEZONE, severity: resolveSeverity(MSG_BAD_TIMEZONE, strict) });
  }

  return findings;
}

function parseHeaderLines(text: string): {
  readonly headerText: string;
  readonly messageBody: string;
  readonly lines: ReadonlyArray<string>;
} {
  const blankIdx = text.indexOf('\n\n');
  const headerText = blankIdx === -1 ? text : text.slice(0, blankIdx);
  const messageBody = blankIdx === -1 ? '' : text.slice(blankIdx + 2);
  return { headerText, messageBody, lines: headerText.split('\n') };
}

function checkTreeAndParents(
  lines: ReadonlyArray<string>,
  strict: boolean,
): { readonly findings: ReadonlyArray<CommitFinding>; readonly nextIdx: number } {
  const findings: CommitFinding[] = [];

  if (!lines[0]!.startsWith('tree ')) {
    findings.push({ msgId: MSG_MISSING_TREE, severity: resolveSeverity(MSG_MISSING_TREE, strict) });
    return { findings, nextIdx: -1 };
  }
  const treeVal = lines[0]!.slice(5);
  if (!isValidSha(treeVal)) {
    findings.push({
      msgId: MSG_BAD_TREE_SHA1,
      severity: resolveSeverity(MSG_BAD_TREE_SHA1, strict),
    });
  }

  let i = 1;
  while (i < lines.length && lines[i]!.startsWith('parent ')) {
    const parentVal = lines[i]!.slice(7);
    if (!isValidSha(parentVal)) {
      findings.push({
        msgId: MSG_BAD_PARENT_SHA1,
        severity: resolveSeverity(MSG_BAD_PARENT_SHA1, strict),
      });
    }
    i++;
  }

  return { findings, nextIdx: i };
}

function checkAuthorAndCommitter(
  lines: ReadonlyArray<string>,
  startIdx: number,
  strict: boolean,
): ReadonlyArray<CommitFinding> {
  const findings: CommitFinding[] = [];
  let i = startIdx;

  if (!lines[i]?.startsWith('author ')) {
    findings.push({
      msgId: MSG_MISSING_AUTHOR,
      severity: resolveSeverity(MSG_MISSING_AUTHOR, strict),
    });
    return findings;
  }
  for (const f of checkIdentityLine(lines[i]!.slice(7), strict)) findings.push(f);
  i++;

  // detect multiple author lines
  while (i < lines.length && lines[i]!.startsWith('author ')) {
    findings.push({
      msgId: MSG_MULTIPLE_AUTHORS,
      severity: resolveSeverity(MSG_MULTIPLE_AUTHORS, strict),
    });
    i++;
  }

  while (i < lines.length && !lines[i]!.startsWith('committer ')) i++;

  if (!lines[i]?.startsWith('committer ')) {
    findings.push({
      msgId: MSG_MISSING_COMMITTER,
      severity: resolveSeverity(MSG_MISSING_COMMITTER, strict),
    });
    return findings;
  }
  for (const f of checkIdentityLine(lines[i]!.slice(10), strict)) findings.push(f);

  return findings;
}

/** Validate a raw commit object body, returning ordered findings. */
export function validateCommit(raw: Uint8Array, strict: boolean): ReadonlyArray<CommitFinding> {
  const text = new TextDecoder().decode(raw);
  const { headerText, messageBody, lines } = parseHeaderLines(text);

  if (headerText.includes('\x00')) {
    return [{ msgId: MSG_NUL_IN_HEADER, severity: resolveSeverity(MSG_NUL_IN_HEADER, strict) }];
  }

  const { findings: headerFindings, nextIdx } = checkTreeAndParents(lines, strict);
  if (nextIdx === -1) return headerFindings;

  const findings: CommitFinding[] = [...headerFindings];
  for (const f of checkAuthorAndCommitter(lines, nextIdx, strict)) findings.push(f);

  if (messageBody.includes('\x00')) {
    findings.push({
      msgId: MSG_NUL_IN_COMMIT,
      severity: resolveSeverity(MSG_NUL_IN_COMMIT, strict),
    });
  }

  return findings;
}
