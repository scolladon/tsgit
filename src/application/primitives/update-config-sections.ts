/**
 * Section-level surgery for `.git/config`: rename-section and remove-section.
 * These operations match headers by their raw dotted name (byte-exact,
 * case-sensitive) and rewrite or drop them without touching any other byte.
 *
 * @writes
 *   surface: config
 *   kind:    readback-only
 *   format:  git-config-text
 */
import type { ConfigScope } from '../../domain/commands/config-key.js';
import { configSectionNotFound, invalidOption } from '../../domain/commands/error.js';
import { TsgitError } from '../../domain/error.js';
import type { Context } from '../../ports/context.js';
import { invalidateConfigCache, parseSectionHeader } from './config-read.js';
import { invalidateScopedConfigCache } from './config-scoped-read.js';
import { resolveScopePath } from './internal/config-scope.js';
import {
  rejectEmptyPlainSection,
  rejectSection,
  rejectSubsection,
  renderSectionHeader,
} from './internal/config-write-shared.js';

/**
 * The raw dotted name of a parsed section header: `[s]` → `'s'`,
 * `[s "x"]` → `'s.x'`, `[s ""]` → `'s.'`, `[ ""]` → `'.'`,
 * deprecated `[s.X]` → `'s.X'`. The subsection is taken post-unescaping
 * (exactly what `parseSectionHeader` returns), making this the canonical
 * reduction used by git's section-op matching.
 *
 * The `'a.b'` ambiguity is documented and faithful: both `[a.b]` and
 * `[a "b"]` reduce to the same raw name `'a.b'`, so an old-name lookup
 * against `'a.b'` matches both blocks — exactly what canonical git does.
 */
export const rawSectionName = (header: {
  readonly section: string;
  readonly subsection: string | undefined;
}): string =>
  header.subsection === undefined ? header.section : `${header.section}.${header.subsection}`;

/**
 * True when `line` is a section header whose raw dotted name equals `oldName`
 * byte-for-byte (case-sensitive). Malformed headers never match.
 * Pre-quote whitespace is not identity — `parseSectionHeader` already strips it.
 */
const matchesRawSectionName = (line: string, oldName: string): boolean => {
  const header = parseSectionHeader(line.trim());
  if (header.kind !== 'header') return false;
  return rawSectionName(header) === oldName;
};

/** Any `[section]` / `[section "sub"]` header line — marks the end of a section. */
const isSectionHeader = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed.startsWith('[') && trimmed.endsWith(']');
};

/**
 * When `originalLines` ended with `''` (trailing `\n`) and `out` does not,
 * push `''` to restore the trailing newline. Used by remove-section.
 */
const withTrailingNewlineRestored = (
  originalLines: ReadonlyArray<string>,
  out: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  if (
    originalLines[originalLines.length - 1] === '' &&
    out.length > 0 &&
    out[out.length - 1] !== ''
  ) {
    return [...out, ''];
  }
  return out;
};

/**
 * Index of the first header line whose raw dotted name equals `oldName`
 * byte-for-byte, or `-1` when absent.
 */
const findSectionHeader = (lines: ReadonlyArray<string>, oldName: string): number => {
  for (let i = 0; i < lines.length; i += 1) {
    if (matchesRawSectionName(lines[i] as string, oldName)) return i;
  }
  return -1;
};

/**
 * The destination for a section rename. The `section` part must survive
 * `renderSectionHeader` (no whitespace, NUL, brackets, quotes, or
 * backslashes); the optional `subsection` must be LF/NUL-free, and a missing
 * subsection requires a non-empty section (`[]` is unparseable).
 * `renameConfigSectionInText` validates all of this itself; porcelain
 * callers may additionally fast-fail before any I/O.
 */
export interface NewSectionName {
  readonly section: string;
  readonly subsection?: string;
}

/**
 * Drops every block (header + body) whose raw dotted name equals `oldName`
 * byte-for-byte (case-sensitive). No validation is applied to `oldName` —
 * an unrecognised or syntactically unusual name simply matches nothing.
 *
 * The `'a.b'` ambiguity is faithful: both the deprecated `[a.b]` header and
 * the canonical `[a "b"]` header reduce to the same raw name, so a lookup
 * against `'a.b'` removes both blocks — exactly what canonical git does.
 *
 * Trailing blank line cleanup: the final `\n` separator that introduced
 * the dropped section is also dropped so a removed section at the end
 * of the file does not leave a stray trailing newline.
 */
export const removeConfigSectionInText = (text: string, oldName: string): string => {
  const lines = text.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (isSectionHeader(line)) {
      skipping = matchesRawSectionName(line, oldName);
      if (skipping) continue;
      out.push(line);
      continue;
    }
    if (skipping) continue;
    out.push(line);
  }
  return withTrailingNewlineRestored(lines, out).join('\n');
};

/**
 * Rewrites every header whose raw dotted name equals `oldName` byte-for-byte
 * to `renderSectionHeader(to.section, to.subsection)`. Body lines are not
 * touched; non-matching headers are preserved verbatim. The write-side guards
 * (`rejectSection`, `rejectSubsection`) run inside this function, so every
 * caller — porcelain or batch — gets the same protection.
 *
 * Cross-family renames (`s.x → t.y`, `s → t.y`, `s. → t`) are supported:
 * the only constraint is that the old name matches and the new name is valid.
 */
export const renameConfigSectionInText = (
  text: string,
  oldName: string,
  to: NewSectionName,
): string => {
  rejectSection(to.section);
  rejectEmptyPlainSection(to.section, to.subsection);
  if (to.subsection !== undefined) rejectSubsection(to.subsection);
  const lines = text.split('\n');
  const renamed = lines.map((line) => {
    if (!matchesRawSectionName(line, oldName)) return line;
    return renderSectionHeader(to.section, to.subsection);
  });
  return renamed.join('\n');
};

/**
 * Parse a new-section name using git's grammar: the section part (before the
 * first dot, or the whole string if no dot) must consist only of `[a-zA-Z0-9-]`
 * characters — an empty section part is allowed only when a dot follows (e.g.
 * `'.'` → `{ section: '', subsection: '' }`, `'.x'` → `{ section: '', subsection: 'x' }`).
 * Everything after the first dot is the subsection verbatim (no further grammar
 * restriction; may be empty for a trailing-dot form, may contain further dots).
 * The empty string is always refused. Case is preserved.
 */
export const parseNewSectionName = (name: string): NewSectionName => {
  if (name === '') {
    throw invalidOption('config', `invalid section name: ${name}`);
  }
  const dot = name.indexOf('.');
  const sectionPart = dot === -1 ? name : name.slice(0, dot);
  if (sectionPart.length > 0 && !/^[a-zA-Z0-9-]+$/.test(sectionPart)) {
    throw invalidOption('config', `invalid section name: ${name}`);
  }
  if (dot === -1) {
    return { section: sectionPart };
  }
  return { section: sectionPart, subsection: name.slice(dot + 1) };
};

/**
 * Read the raw config text; a missing file yields `''` (not an error). Other
 * failures (permission denied, disk error) propagate — only `FILE_NOT_FOUND`
 * is swallowed.
 */
const readConfigText = async (ctx: Context, path: string): Promise<string> => {
  try {
    return await ctx.fs.readUtf8(path);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return '';
    throw err;
  }
};

/**
 * Rename headers matching `oldName` (raw byte-exact dotted name) to the new
 * section shape derived from `newName` (parsed via `parseNewSectionName`).
 * The old name is never validated — any string is a legal lookup key; a miss
 * throws `CONFIG_SECTION_NOT_FOUND` carrying the raw input verbatim. Throws
 * `INVALID_OPTION` when the new subsection contains a LF or NUL.
 */
export const renameConfigSection = async ({
  ctx,
  oldName,
  newName,
  scope,
}: {
  readonly ctx: Context;
  readonly oldName: string;
  readonly newName: string;
  readonly scope?: ConfigScope;
}): Promise<void> => {
  const to = parseNewSectionName(newName);
  if (to.subsection !== undefined) rejectSubsection(to.subsection);
  const targetScope: ConfigScope = scope ?? 'local';
  const path = await resolveScopePath(ctx, targetScope);
  const text = await readConfigText(ctx, path);
  // Line-based existence check — lenient on malformed headers/values, exactly
  // like git's copy_or_rename machinery. A malformed header never matches
  // matchesRawSectionName (kind !== 'header'), so it is never the rename source.
  if (findSectionHeader(text.split('\n'), oldName) === -1) {
    throw configSectionNotFound(oldName, targetScope);
  }
  const after = renameConfigSectionInText(text, oldName, to);
  await ctx.fs.writeUtf8(path, after);
  invalidateConfigCache(ctx);
  invalidateScopedConfigCache(ctx);
};

/**
 * Delete headers matching `sectionName` (raw byte-exact dotted name) and their
 * bodies. The name is never validated — any string is a legal lookup key (e.g.
 * `'remote'`, `'s.'`, `''`); a miss throws `CONFIG_SECTION_NOT_FOUND` carrying
 * the raw input verbatim. For the trailing-dot and empty-name forms see
 * `rawSectionName` and `removeConfigSectionInText` documentation.
 */
export const removeConfigSection = async ({
  ctx,
  sectionName,
  scope,
}: {
  readonly ctx: Context;
  readonly sectionName: string;
  readonly scope?: ConfigScope;
}): Promise<void> => {
  const targetScope: ConfigScope = scope ?? 'local';
  const path = await resolveScopePath(ctx, targetScope);
  const text = await readConfigText(ctx, path);
  // Line-based existence check — lenient on malformed headers/values, exactly
  // like git's remove-section machinery. Matching is raw/byte-exact on `sectionName`.
  if (findSectionHeader(text.split('\n'), sectionName) === -1) {
    throw configSectionNotFound(sectionName, targetScope);
  }
  const after = removeConfigSectionInText(text, sectionName);
  await ctx.fs.writeUtf8(path, after);
  invalidateConfigCache(ctx);
  invalidateScopedConfigCache(ctx);
};
