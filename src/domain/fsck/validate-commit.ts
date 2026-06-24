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

const DECODER = new TextDecoder();

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
  // equivalent-mutant: trimEnd→trimStart — for any string, trimEnd()==='' iff
  // trimStart()==='' (both are '' iff the string is all-whitespace); the two
  // methods produce the same boolean outcome in this === '' comparison.
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

  const [timestamp = '', timezone = ''] = afterGt.trim().split(/\s+/);

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
  // equivalent-mutant: ConditionalExpression→false — when blankIdx===-1 the mutant
  // yields text.slice(1) instead of ''; but blankIdx===-1 means headerText===text,
  // so any '\x00' in text triggers nullInHeader before messageBody is consulted.
  // equivalent-mutant: MethodExpression→text — messageBody=text; any '\x00' already
  // in the header fires nullInHeader first; body-only '\x00' appears in both text
  // and text.slice(blankIdx+2), so the nullInCommit result is identical.
  // equivalent-mutant: ArithmeticOperator blankIdx-2 and UnaryOperator blankIdx+1 —
  // the slice start shifts by ≤2 bytes (both remain within the body region when
  // blankIdx≥2); '\x00' detection in messageBody is unaffected by a small offset.
  const messageBody = blankIdx === -1 ? '' : text.slice(blankIdx + 2);
  return { headerText, messageBody, lines: headerText.split('\n') };
}

function checkTreeAndParents(
  lines: ReadonlyArray<string>,
  strict: boolean,
): { readonly findings: ReadonlyArray<CommitFinding>; readonly nextIdx: number } {
  const findings: CommitFinding[] = [];

  const firstLine = lines[0];
  if (firstLine === undefined || !firstLine.startsWith('tree ')) {
    findings.push({ msgId: MSG_MISSING_TREE, severity: resolveSeverity(MSG_MISSING_TREE, strict) });
    return { findings, nextIdx: -1 };
  }
  const treeVal = firstLine.slice(5);
  if (!isValidSha(treeVal)) {
    findings.push({
      msgId: MSG_BAD_TREE_SHA1,
      severity: resolveSeverity(MSG_BAD_TREE_SHA1, strict),
    });
  }

  let i = 1;
  // equivalent-mutant: i<=lines.length — at i===lines.length, lines[i] is
  // undefined; the undefined===undefined guard inside the loop triggers break
  // immediately, so the extra iteration is a no-op.
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined || !line.startsWith('parent ')) break;
    const parentVal = line.slice(7);
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

  const authorLine = lines[i];
  if (authorLine === undefined || !authorLine.startsWith('author ')) {
    findings.push({
      msgId: MSG_MISSING_AUTHOR,
      severity: resolveSeverity(MSG_MISSING_AUTHOR, strict),
    });
    return findings;
  }
  for (const f of checkIdentityLine(authorLine.slice(7), strict)) findings.push(f);
  i++;

  // detect multiple author lines
  // equivalent-mutant: i<=lines.length — at i===lines.length, lines[i]?.startsWith
  // returns undefined (falsy); the condition is false so the loop exits identically.
  while (i < lines.length && lines[i]?.startsWith('author ')) {
    findings.push({
      msgId: MSG_MULTIPLE_AUTHORS,
      severity: resolveSeverity(MSG_MULTIPLE_AUTHORS, strict),
    });
    i++;
  }

  // equivalent-mutant: i<=lines.length exits same way as i< because lines[i===len] is undefined (falsy startsWith)
  while (i < lines.length && !lines[i]?.startsWith('committer ')) i++;

  const committerLine = lines[i];
  // equivalent-mutant: startsWith('') always true; while loop guarantees committerLine starts with 'committer ' when defined
  if (committerLine === undefined || !committerLine.startsWith('committer ')) {
    findings.push({
      msgId: MSG_MISSING_COMMITTER,
      severity: resolveSeverity(MSG_MISSING_COMMITTER, strict),
    });
    return findings;
  }
  for (const f of checkIdentityLine(committerLine.slice(10), strict)) findings.push(f);

  return findings;
}

/** Validate a raw commit object body, returning ordered findings. */
export function validateCommit(raw: Uint8Array, strict: boolean): ReadonlyArray<CommitFinding> {
  const text = DECODER.decode(raw);
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
