import { TsgitError } from '../../domain/error.js';
import type { Context } from '../../ports/context.js';
import { invalidateConfigCache } from './config-read.js';

/**
 * Targeted `.git/config` writer for the `[core]` section (design §6.2,
 * ADR-074). tsgit has no general INI writer; sparse checkout only needs to
 * flip `core.sparseCheckout` / `core.sparseCheckoutCone`, so this performs
 * line surgery that preserves comments, blank lines, key order, casing of
 * unrelated keys, and every other section byte-for-byte.
 */

/** A line whose trimmed form is a `[core]` / `[core ""]` section header. */
const isCoreHeader = (line: string): boolean => {
  const trimmed = line.trim();
  // `[core]` with no subsection, or an explicitly empty `[core ""]` one.
  return trimmed === '[core]' || trimmed === '[core ""]';
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

/** Render `key = value` indented with a tab — git's own `[core]` body style. */
const renderEntry = (key: string, value: string): string => `\t${key} = ${value}`;

/** Index of the `[core]` header line, or `-1` when the file has no `[core]`. */
const findCoreHeader = (lines: ReadonlyArray<string>): number => {
  for (let i = 0; i < lines.length; i += 1) {
    if (isCoreHeader(lines[i] as string)) return i;
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
 * Set `key` under `[core]` to `value`, preserving everything else verbatim.
 *
 * - existing `[core] key =` line ⇒ its value is replaced (key match is
 *   case-insensitive; the rest of the file is byte-preserved);
 * - existing `[core]` without that key ⇒ a `\t<key> = <value>` line is
 *   inserted right after the header;
 * - no `[core]` section ⇒ `[core]\n\t<key> = <value>\n` is appended.
 */
export const setCoreConfigEntry = (text: string, key: string, value: string): string => {
  const lines = text.split('\n');
  const headerIndex = findCoreHeader(lines);
  if (headerIndex === -1) {
    const prefix = text === '' ? '' : text.endsWith('\n') ? text : `${text}\n`;
    return `${prefix}[core]\n${renderEntry(key, value)}\n`;
  }
  const keyIndex = findKeyInSection(lines, headerIndex, key);
  if (keyIndex !== -1) {
    return replaceLine(lines, keyIndex, renderEntry(key, value)).join('\n');
  }
  return insertAfter(lines, headerIndex, renderEntry(key, value)).join('\n');
};

/**
 * Read `${gitDir}/config` (a missing file is treated as `''`), fold
 * `setCoreConfigEntry` over `entries`, write the result, and invalidate the
 * per-`Context` `readConfig` cache so a later read sees the new values.
 */
export const updateCoreConfig = async (
  ctx: Context,
  entries: Record<string, string>,
): Promise<void> => {
  const path = `${ctx.layout.gitDir}/config`;
  const original = await readConfigText(ctx, path);
  const updated = Object.entries(entries).reduce(
    (text, [key, value]) => setCoreConfigEntry(text, key, value),
    original,
  );
  await ctx.fs.writeUtf8(path, updated);
  invalidateConfigCache(ctx);
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
