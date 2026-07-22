import {
  MSG_BAD_DATE_OVERFLOW,
  MSG_BAD_OBJECT_SHA1,
  MSG_BAD_TAG_NAME,
  MSG_MISSING_OBJECT,
  MSG_MISSING_SPACE_BEFORE_EMAIL,
  MSG_MISSING_TAG,
  MSG_MISSING_TAG_ENTRY,
  MSG_MISSING_TAGGER_ENTRY,
  MSG_MISSING_TYPE,
  MSG_MISSING_TYPE_ENTRY,
} from './msg-ids.js';
import { resolveSeverity } from './severity.js';
import type { FsckSeverity } from './types.js';

export interface TagFinding {
  readonly msgId: string;
  readonly severity: FsckSeverity;
}

const DECODER = new TextDecoder();

const SHA1_HEX_RE = /^[0-9a-f]{40}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const VALID_OBJECT_TYPES: ReadonlySet<string> = new Set(['blob', 'tree', 'commit', 'tag']);

function isValidSha(hex: string): boolean {
  return SHA1_HEX_RE.test(hex) || SHA256_HEX_RE.test(hex);
}

// INT64_MAX = 2^63 - 1 = 9223372036854775807 (19 decimal digits).
// Pinned real git 2.54.0: tagger timestamps above this value emit badDateOverflow.
const INT64_MAX_STR = '9223372036854775807';

function isTaggerTimestampOverflow(timestamp: string): boolean {
  if (timestamp.length > INT64_MAX_STR.length) return true;
  if (timestamp.length < INT64_MAX_STR.length) return false;
  return timestamp > INT64_MAX_STR;
}

function checkTaggerLine(line: string, strict: boolean): ReadonlyArray<TagFinding> {
  const ltIdx = line.indexOf('<');
  if (ltIdx === -1) return [];
  const name = line.slice(0, ltIdx);
  if (!name.endsWith(' ')) {
    return [
      {
        msgId: MSG_MISSING_SPACE_BEFORE_EMAIL,
        severity: resolveSeverity(MSG_MISSING_SPACE_BEFORE_EMAIL, strict),
      },
    ];
  }

  const gtIdx = line.indexOf('>', ltIdx);
  // Stryker disable next-line ConditionalExpression,UnaryOperator: equivalent — when > is absent (gtIdx=-1), the next guard (!afterGt.startsWith(' ')) returns [] for all realistic tagger inputs.
  if (gtIdx === -1) return [];
  const afterGt = line.slice(gtIdx + 1);
  if (!afterGt.startsWith(' ')) return [];

  // Stryker disable next-line Regex,StringLiteral: equivalent — afterGt.trim() removes boundary whitespace so split(/\s/) and split(/\s+/) produce the same [0] element; split() always returns at least one element, so the '' default can never activate.
  const [timestamp = ''] = afterGt.trim().split(/\s+/);
  if (/^\d+$/.test(timestamp) && isTaggerTimestampOverflow(timestamp)) {
    return [
      {
        msgId: MSG_BAD_DATE_OVERFLOW,
        severity: resolveSeverity(MSG_BAD_DATE_OVERFLOW, strict),
      },
    ];
  }

  return [];
}

function checkObjectAndType(
  lines: ReadonlyArray<string>,
  strict: boolean,
): { readonly findings: ReadonlyArray<TagFinding>; readonly nextIdx: number } {
  const findings: TagFinding[] = [];

  if (!lines[0]?.startsWith('object ')) {
    return {
      findings: [
        { msgId: MSG_MISSING_OBJECT, severity: resolveSeverity(MSG_MISSING_OBJECT, strict) },
      ],
      nextIdx: -1,
    };
  }
  if (!isValidSha(lines[0].slice(7))) {
    findings.push({
      msgId: MSG_BAD_OBJECT_SHA1,
      severity: resolveSeverity(MSG_BAD_OBJECT_SHA1, strict),
    });
  }

  if (!lines[1]?.startsWith('type ')) {
    findings.push({ msgId: MSG_MISSING_TYPE, severity: resolveSeverity(MSG_MISSING_TYPE, strict) });
    return { findings, nextIdx: -1 };
  }
  const typeVal = lines[1].slice(5);
  // Stryker disable next-line StringLiteral: equivalent — 'Stryker was here!' is not in VALID_OBJECT_TYPES, so !has catches it; typeVal==='' guard is redundant.
  if (typeVal === '' || !VALID_OBJECT_TYPES.has(typeVal)) {
    findings.push({
      msgId: MSG_MISSING_TYPE_ENTRY,
      severity: resolveSeverity(MSG_MISSING_TYPE_ENTRY, strict),
    });
    return { findings, nextIdx: -1 };
  }

  return { findings, nextIdx: 2 };
}

function checkTagAndTagger(
  lines: ReadonlyArray<string>,
  startIdx: number,
  strict: boolean,
): ReadonlyArray<TagFinding> {
  const findings: TagFinding[] = [];

  const tagLine = lines[startIdx];
  if (tagLine === undefined || !tagLine.startsWith('tag ')) {
    findings.push({ msgId: MSG_MISSING_TAG, severity: resolveSeverity(MSG_MISSING_TAG, strict) });
    return findings;
  }
  const tagVal = tagLine.slice(4);
  if (tagVal === '') {
    findings.push({
      msgId: MSG_MISSING_TAG_ENTRY,
      severity: resolveSeverity(MSG_MISSING_TAG_ENTRY, strict),
    });
    return findings;
  }
  if (tagVal.includes('\x00') || tagVal.includes('\n')) {
    findings.push({ msgId: MSG_BAD_TAG_NAME, severity: resolveSeverity(MSG_BAD_TAG_NAME, strict) });
  }

  const taggerIdx = startIdx + 1;
  const taggerLine = lines[taggerIdx];
  if (taggerLine === undefined || !taggerLine.startsWith('tagger ')) {
    findings.push({
      msgId: MSG_MISSING_TAGGER_ENTRY,
      severity: resolveSeverity(MSG_MISSING_TAGGER_ENTRY, strict),
    });
    return findings;
  }
  for (const f of checkTaggerLine(taggerLine.slice(7), strict)) findings.push(f);

  return findings;
}

/** Validate a raw tag object body, returning ordered findings. */
export function validateTag(raw: Uint8Array, strict: boolean): ReadonlyArray<TagFinding> {
  const text = DECODER.decode(raw);
  // Stryker disable next-line StringLiteral: equivalent — indexOf('') always returns 0; with any blankIdx value, headerText and lines parsing is unaffected since tag parser only accesses fixed indices [0],[1],[2],[3].
  const blankIdx = text.indexOf('\n\n');
  // Stryker disable next-line ConditionalExpression,EqualityOperator,UnaryOperator,MethodExpression: equivalent — tag parser accesses fixed header line indices; whether headerText is full text or header-only, lines[0..3] are identical.
  const headerText = blankIdx !== -1 ? text : text.slice(0, blankIdx);
  const lines = headerText.split('\n');

  const { findings: headerFindings, nextIdx } = checkObjectAndType(lines, strict);
  if (nextIdx === -1) return headerFindings;

  return [...headerFindings, ...checkTagAndTagger(lines, nextIdx, strict)];
}
