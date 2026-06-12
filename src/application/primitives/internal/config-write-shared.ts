/**
 * Low-level write helpers shared by the config entry-write and section-op
 * modules. Nothing here has outward I/O dependencies — all functions are pure.
 */
import { invalidOption } from '../../../domain/commands/error.js';

/**
 * True when `value` must be wrapped in double quotes: the value starts with a
 * space, ends with a space, or contains `;`, `#`, or CR. These characters
 * would be misread by the parser without quotes (comment characters, trimmed
 * whitespace, CRLF line-ending). TAB, `"`, `\`, and LF do NOT trigger quoting
 * — they are always escaped instead (git's `write_pair` grammar).
 */
const needsQuote = (value: string): boolean =>
  value.startsWith(' ') ||
  value.endsWith(' ') ||
  value.includes(';') ||
  value.includes('#') ||
  value.includes('\r');

/**
 * Render a value for emission inside a `key = value` line. Escaping is
 * unconditional (quoted or not): `\` → `\\` first, then `"` → `\"`,
 * LF → `\n`, TAB → `\t`. CR and all other control bytes pass through raw.
 * The value is then wrapped in `"…"` iff `needsQuote` is true.
 * Escape order matters — backslashes MUST be escaped first.
 */
const renderValue = (value: string): string => {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\t', '\\t');
  return needsQuote(value) ? `"${escaped}"` : escaped;
};

/** Render `key = value` indented with a tab — git's own section-body style. */
export const renderEntry = (key: string, value: string): string =>
  `\t${key} = ${renderValue(value)}`;

/**
 * Escape a subsection name for embedding inside `[section "…"]`. git's
 * `write_section` escapes `\` → `\\` first (order matters), then `"` → `\"`.
 * Every other byte — `]`, CR, `#`, `;`, spaces — is written raw.
 */
const escapeSubsection = (subsection: string): string =>
  subsection.replaceAll('\\', '\\\\').replaceAll('"', '\\"');

/** Render a `[section]` / `[section "subsection"]` header line. */
export const renderSectionHeader = (section: string, subsection: string | undefined): string =>
  subsection === undefined ? `[${section}]` : `[${section} "${escapeSubsection(subsection)}"]`;

/**
 * Reject a `key`/`subsection` carrying a `\n`, `\r`, or `\0` — those would let
 * line surgery splice a forged config section into `.git/config`. Values get a
 * more permissive variant (`rejectValueControlChars`) that accepts `\n`/`\t`
 * because the quoting writer escapes them to `\\n`/`\\t` on write.
 */
export const rejectControlChars = (field: 'key' | 'subsection', text: string): void => {
  if (/[\n\r\0]/.test(text)) {
    throw invalidOption('config', `${field} must not contain a newline or NUL`);
  }
};

/**
 * Reject NUL (`\0`) in a value. NUL has no canonical-git escape and cannot
 * survive a config write. CR and other control bytes are accepted — CR triggers
 * quoting and passes through raw; C0/DEL are written verbatim (git accepts them).
 */
export const rejectValueControlChars = (value: string): void => {
  if (value.includes('\0')) {
    throw invalidOption('config', 'value must not contain a NUL byte');
  }
};

/**
 * Reject a subsection name that cannot survive a config write. git rejects
 * LF ("invalid key (newline)"); NUL is argv-impossible. CR, `"`, `\`, and `]`
 * are accepted — the writer escapes `"` and `\`, and writes `]`/CR raw.
 */
export const rejectSubsection = (subsection: string): void => {
  if (/[\n\0]/.test(subsection)) {
    throw invalidOption('config', 'subsection must not contain a newline or NUL');
  }
};

/**
 * Reject a section name that would break the `[section]` line or render a
 * header canonical git refuses to re-read: whitespace, NUL, brackets, `"`,
 * `\`. Defence-in-depth for direct callers of the exported writers — every
 * key-derived path is already constrained by `parseConfigKey` /
 * `parseNewSectionName`.
 */
export const rejectSection = (section: string): void => {
  if (/[\s\0[\]"\\]/.test(section)) {
    throw invalidOption(
      'config',
      'section must not contain whitespace, NUL, brackets, quotes, or backslashes',
    );
  }
};

/**
 * Reject the subsection-less empty section in entry writes: `[]` is not a
 * parseable header (the empty name has no plain form — git refuses `.k`
 * too), so writing it would corrupt the file for every later reader.
 */
export const rejectEmptyPlainSection = (section: string, subsection: string | undefined): void => {
  if (section === '' && subsection === undefined) {
    throw invalidOption('config', 'section name must not be empty without a subsection');
  }
};
