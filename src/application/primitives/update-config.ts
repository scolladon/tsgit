import { invalidOption } from '../../domain/commands/error.js';
import { TsgitError } from '../../domain/error.js';
import type { Context } from '../../ports/context.js';
import { invalidateConfigCache, parseSectionHeader } from './config-read.js';

/**
 * Targeted `.git/config` writer (ADR-082). tsgit has no general INI writer;
 * this performs line surgery that preserves comments, blank lines, key order,
 * casing of unrelated keys, and every other section byte-for-byte. It writes
 * one `key = value` per call under any `[section]` / `[section "subsection"]`.
 */

/**
 * True when `line` is the header for `[section]` / `[section "subsection"]`.
 * Section names are matched case-insensitively (git semantics); subsection
 * names case-sensitively. A `subsection` of `undefined` matches a header with
 * no subsection or an explicitly empty one (`[section ""]`).
 */
const matchesSection = (line: string, section: string, subsection: string | undefined): boolean => {
  const header = parseSectionHeader(line.trim());
  if (header === undefined) return false;
  if (header.section.toLowerCase() !== section.toLowerCase()) return false;
  if (subsection === undefined) {
    return header.subsection === undefined || header.subsection === '';
  }
  return header.subsection === subsection;
};

/** Any `[section]` / `[section "sub"]` header line — marks the end of a section. */
const isSectionHeader = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed.startsWith('[') && trimmed.endsWith(']');
};

/**
 * `key = value` line whose key (case-insensitively) equals `key`. The key is
 * the text before the first `=`, trimmed.
 */
const isKeyLine = (line: string, key: string): boolean => {
  const eqAt = line.indexOf('=');
  if (eqAt === -1) return false;
  return line.slice(0, eqAt).trim().toLowerCase() === key.toLowerCase();
};

/** Render `key = value` indented with a tab — git's own section-body style. */
const renderEntry = (key: string, value: string): string => `\t${key} = ${value}`;

/** Render a `[section]` / `[section "subsection"]` header line. */
const renderSectionHeader = (section: string, subsection: string | undefined): string =>
  subsection === undefined ? `[${section}]` : `[${section} "${subsection}"]`;

/** Index of the matching section header line, or `-1` when absent. */
const findSectionHeader = (
  lines: ReadonlyArray<string>,
  section: string,
  subsection: string | undefined,
): number => {
  for (let i = 0; i < lines.length; i += 1) {
    if (matchesSection(lines[i] as string, section, subsection)) return i;
  }
  return -1;
};

/**
 * Within the section that starts at `headerIndex`, the index of an existing
 * `key =` line, or `-1` when absent. The scan stops at the next section
 * header so a `key` line under a *later* section is never matched.
 */
const findKeyInSection = (
  lines: ReadonlyArray<string>,
  headerIndex: number,
  key: string,
): number => {
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (isSectionHeader(line)) return -1;
    if (isKeyLine(line, key)) return i;
  }
  return -1;
};

/** Replace element `at` in `lines` with `replacement`, returning a new array. */
const replaceLine = (
  lines: ReadonlyArray<string>,
  at: number,
  replacement: string,
): ReadonlyArray<string> => [...lines.slice(0, at), replacement, ...lines.slice(at + 1)];

/** Insert `entry` immediately after element `at`, returning a new array. */
const insertAfter = (
  lines: ReadonlyArray<string>,
  at: number,
  entry: string,
): ReadonlyArray<string> => [...lines.slice(0, at + 1), entry, ...lines.slice(at + 1)];

/**
 * Reject a `key`/`value`/`subsection` carrying a `\n`, `\r`, or `\0` — those
 * would let line surgery splice a forged config section into `.git/config`.
 */
const rejectControlChars = (field: 'key' | 'value' | 'subsection', text: string): void => {
  if (/[\n\r\0]/.test(text)) {
    throw invalidOption('config', `${field} must not contain a newline or NUL`);
  }
};

/**
 * Reject a subsection name that would break the `[section "subsection"]`
 * quoting: a control char (above) plus `"`, `\`, or `]`.
 */
const rejectSubsection = (subsection: string): void => {
  rejectControlChars('subsection', subsection);
  if (/["\\\]]/.test(subsection)) {
    throw invalidOption('config', 'subsection must not contain a quote, backslash, or bracket');
  }
};

/**
 * Reject a section name that would break the `[section]` line: control chars
 * plus `]`, `"`, `\`. Every current caller passes a hardcoded literal; the
 * guard is defence-in-depth for a future dynamic caller of this public helper.
 */
const rejectSection = (section: string): void => {
  if (/[\n\r\0\]"\\]/.test(section)) {
    throw invalidOption(
      'config',
      'section must not contain a newline, NUL, bracket, quote, or backslash',
    );
  }
};

/**
 * Set `key` under `[section]` / `[section "subsection"]`, preserving every
 * other byte verbatim.
 *
 * - existing section with that key ⇒ its value is replaced;
 * - existing section without that key ⇒ a `\t<key> = <value>` line is
 *   inserted right after the header;
 * - no such section ⇒ `[section]\n\t<key> = <value>\n` is appended.
 */
export const setConfigEntry = (
  text: string,
  section: string,
  subsection: string | undefined,
  key: string,
  value: string,
): string => {
  rejectSection(section);
  rejectControlChars('key', key);
  rejectControlChars('value', value);
  if (subsection !== undefined) rejectSubsection(subsection);
  const lines = text.split('\n');
  const headerIndex = findSectionHeader(lines, section, subsection);
  if (headerIndex === -1) {
    const prefix = text === '' ? '' : text.endsWith('\n') ? text : `${text}\n`;
    return `${prefix}${renderSectionHeader(section, subsection)}\n${renderEntry(key, value)}\n`;
  }
  const keyIndex = findKeyInSection(lines, headerIndex, key);
  if (keyIndex !== -1) {
    return replaceLine(lines, keyIndex, renderEntry(key, value)).join('\n');
  }
  return insertAfter(lines, headerIndex, renderEntry(key, value)).join('\n');
};

/** `setConfigEntry` bound to the `[core]` section — kept for legacy callers. */
export const setCoreConfigEntry = (text: string, key: string, value: string): string =>
  setConfigEntry(text, 'core', undefined, key, value);

/** One `key = value` write under `[section]` / `[section "subsection"]`. */
export interface ConfigEntry {
  readonly section: string;
  readonly subsection?: string;
  readonly key: string;
  readonly value: string;
}

/**
 * Read `${gitDir}/config` (a missing file is treated as `''`), fold
 * `setConfigEntry` over `entries`, write the result, and invalidate the
 * per-`Context` `readConfig` cache so a later read sees the new values.
 */
export const updateConfigEntries = async (
  ctx: Context,
  entries: ReadonlyArray<ConfigEntry>,
): Promise<void> => {
  const path = `${ctx.layout.gitDir}/config`;
  const original = await readConfigText(ctx, path);
  const updated = entries.reduce(
    (text, entry) => setConfigEntry(text, entry.section, entry.subsection, entry.key, entry.value),
    original,
  );
  await ctx.fs.writeUtf8(path, updated);
  invalidateConfigCache(ctx);
};

/** Fold a batch of `[core]` `key = value` writes via `updateConfigEntries`. */
export const updateCoreConfig = async (
  ctx: Context,
  entries: Record<string, string>,
): Promise<void> => {
  await updateConfigEntries(
    ctx,
    Object.entries(entries).map(([key, value]) => ({ section: 'core', key, value })),
  );
};

/**
 * Read the raw config text; a missing file yields `''` (not an error). Other
 * failures (permission denied, disk error) propagate — matching `config-read`,
 * only `FILE_NOT_FOUND` is swallowed.
 */
const readConfigText = async (ctx: Context, path: string): Promise<string> => {
  try {
    return await ctx.fs.readUtf8(path);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return '';
    throw err;
  }
};
