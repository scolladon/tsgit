/**
 * Targeted `.git/config` writer (ADR-082). tsgit has no general INI writer;
 * this performs line surgery that preserves comments, blank lines, key order,
 * casing of unrelated keys, and every other section byte-for-byte. It writes
 * one `key = value` per call under any `[section]` / `[section "subsection"]`.
 *
 * @writes
 *   surface: config
 *   kind:    readback-only
 *   format:  git-config-text
 */
import type { ConfigScope } from '../../domain/commands/config-key.js';
import { parseConfigKey } from '../../domain/commands/config-key.js';
import {
  configMultipleValues,
  configSectionNotFound,
  configValueInvalid,
  invalidOption,
} from '../../domain/commands/error.js';
import { TsgitError } from '../../domain/error.js';
import type { Context } from '../../ports/context.js';
import { invalidateConfigCache, parseIniSections, parseSectionHeader } from './config-read.js';
import { invalidateScopedConfigCache } from './config-scoped-read.js';
import { collectValues } from './internal/config-key.js';
import { resolveScopePath } from './internal/config-scope.js';

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

/**
 * True when `value` needs to be wrapped in double quotes to survive a parser
 * round-trip: `#`/`;` would start inline comments, leading/trailing whitespace
 * would be trimmed, embedded `"`/`\`/`\n` would either break the quoting
 * grammar (`"`/`\`) or splice a forged line (`\n`).
 */
const needsQuote = (value: string): boolean =>
  value.includes('#') ||
  value.includes(';') ||
  /^[ \t]/.test(value) ||
  /[ \t]$/.test(value) ||
  value.includes('"') ||
  value.includes('\\') ||
  value.includes('\n');

/**
 * Render a value for emission inside a `key = value` line. Plain values pass
 * through verbatim; values needing quoting are wrapped in `"..."` with `\\`,
 * `"`, and `\n` escaped. The escape order matters — backslashes MUST be
 * escaped first so a later replace does not double-escape them.
 */
const renderValue = (value: string): string => {
  if (!needsQuote(value)) return value;
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
  return `"${escaped}"`;
};

/** Render `key = value` indented with a tab — git's own section-body style. */
const renderEntry = (key: string, value: string): string => `\t${key} = ${renderValue(value)}`;

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
 * Reject a `key`/`subsection` carrying a `\n`, `\r`, or `\0` — those would let
 * line surgery splice a forged config section into `.git/config`. Values get a
 * more permissive variant (`rejectValueControlChars`) that accepts `\n`/`\t`
 * because the quoting writer escapes them to `\\n`/`\\t` on write.
 */
const rejectControlChars = (field: 'key' | 'subsection', text: string): void => {
  if (/[\n\r\0]/.test(text)) {
    throw invalidOption('config', `${field} must not contain a newline or NUL`);
  }
};

/**
 * Reject value-side control chars that the writer cannot escape: NUL (no
 * canonical-git escape) and `\r` (rejected to match `git_config_set_multivar_in_file`
 * which similarly bans CR). `\n` and `\t` are ACCEPTED — the quoting writer
 * escapes them to `\\n`/`\\t` so a round-trip through the parser is safe.
 */
const rejectValueControlChars = (value: string): void => {
  if (/[\r\0]/.test(value)) {
    throw invalidOption('config', 'value must not contain a carriage return or NUL');
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
export const setConfigEntryInText = (
  text: string,
  section: string,
  subsection: string | undefined,
  key: string,
  value: string,
): string => {
  rejectSection(section);
  rejectControlChars('key', key);
  rejectValueControlChars(value);
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

/** `setConfigEntryInText` bound to the `[core]` section — kept for legacy callers. */
export const setCoreConfigEntryInText = (text: string, key: string, value: string): string =>
  setConfigEntryInText(text, 'core', undefined, key, value);

/**
 * Remove every `key = value` line for `key` from the section
 * `[section]` / `[section "subsection"]`. No-op when the section or key
 * is absent. Mirrors `git config --unset-all`: when the key appears more
 * than once in the section (e.g. multiple `fetch =` lines), every
 * occurrence is removed.
 */
export const removeConfigEntry = (
  text: string,
  section: string,
  subsection: string | undefined,
  key: string,
): string => {
  rejectSection(section);
  if (subsection !== undefined) rejectSubsection(subsection);
  rejectControlChars('key', key);
  const lines = text.split('\n');
  const out: string[] = [];
  let inTarget = false;
  for (const line of lines) {
    if (isSectionHeader(line)) {
      inTarget = matchesSection(line, section, subsection);
      out.push(line);
      continue;
    }
    if (inTarget && isKeyLine(line, key)) continue;
    out.push(line);
  }
  return out.join('\n');
};

/**
 * Remove the header + body of every `[section]` / `[section "subsection"]`
 * block matching the target. Header and body are gone; following sections
 * are preserved byte-for-byte. No-op when no matching section exists.
 *
 * Trailing blank line cleanup: the final `\n` separator that introduced
 * the dropped section is also dropped so a removed section at the end
 * of the file does not leave a stray trailing newline.
 */
export const removeConfigSectionInText = (
  text: string,
  section: string,
  subsection: string | undefined,
): string => {
  rejectSection(section);
  if (subsection !== undefined) rejectSubsection(subsection);
  const lines = text.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (isSectionHeader(line)) {
      skipping = matchesSection(line, section, subsection);
      if (skipping) continue;
      out.push(line);
      continue;
    }
    if (skipping) continue;
    out.push(line);
  }
  // Preserve the file-level trailing newline: when the original ended in
  // `\n` (so split yielded a trailing '') AND that '' was consumed inside
  // a dropped section, the join loses one trailing `\n`. Restore it so a
  // non-empty result ends with `\n` exactly when the original did.
  const endedWithNewline = lines[lines.length - 1] === '';
  const outEndsWithNewline = out.length > 0 && out[out.length - 1] === '';
  if (endedWithNewline && !outEndsWithNewline && out.length > 0) out.push('');
  return out.join('\n');
};

/**
 * Rename every `[section "fromSubsection"]` header line to
 * `[section "toSubsection"]`. Body lines are not touched; other section
 * families (e.g. `[branch "fromSubsection"]` when family is `remote`)
 * are preserved. The new subsection name is validated with the same
 * line-surgery rules as `setConfigEntryInText`.
 */
export const renameConfigSectionInText = (
  text: string,
  section: string,
  fromSubsection: string,
  toSubsection: string,
): string => {
  rejectSection(section);
  rejectSubsection(fromSubsection);
  rejectSubsection(toSubsection);
  const lines = text.split('\n');
  const renamed = lines.map((line) => {
    if (!matchesSection(line, section, fromSubsection)) return line;
    return renderSectionHeader(section, toSubsection);
  });
  return renamed.join('\n');
};

/** One `key = value` write under `[section]` / `[section "subsection"]`. */
export interface ConfigEntry {
  readonly section: string;
  readonly subsection?: string;
  readonly key: string;
  readonly value: string;
}

/**
 * Read `${gitDir}/config` (a missing file is treated as `''`), fold
 * `setConfigEntryInText` over `entries`, write the result, and invalidate the
 * per-`Context` `readConfig` cache so a later read sees the new values.
 */
export const updateConfigEntries = async (
  ctx: Context,
  entries: ReadonlyArray<ConfigEntry>,
): Promise<void> => {
  const path = `${ctx.layout.gitDir}/config`;
  const original = await readConfigText(ctx, path);
  const updated = entries.reduce(
    (text, entry) =>
      setConfigEntryInText(text, entry.section, entry.subsection, entry.key, entry.value),
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
 * Mixed-operation batch entry. Folded over the on-disk text in order in
 * a single `writeUtf8`. Use this when `remote` CRUD needs a section-
 * remove paired with branch-referrer key removals in one atomic write.
 */
export type ConfigOperation =
  | {
      readonly kind: 'set';
      readonly section: string;
      readonly subsection?: string;
      readonly key: string;
      readonly value: string;
    }
  | {
      /**
       * Insert a fresh `key = value` line after the section header WITHOUT
       * replacing any existing entry with the same key. Use for multi-value
       * keys (`fetch`) where every call must yield an additional line.
       */
      readonly kind: 'appendEntry';
      readonly section: string;
      readonly subsection?: string;
      readonly key: string;
      readonly value: string;
    }
  | {
      readonly kind: 'removeEntry';
      readonly section: string;
      readonly subsection?: string;
      readonly key: string;
    }
  | { readonly kind: 'removeSection'; readonly section: string; readonly subsection?: string }
  | {
      readonly kind: 'renameSection';
      readonly section: string;
      readonly from: string;
      readonly to: string;
    };

export const applyConfigOpInText = (text: string, op: ConfigOperation): string => {
  if (op.kind === 'set') {
    return setConfigEntryInText(text, op.section, op.subsection, op.key, op.value);
  }
  if (op.kind === 'appendEntry') {
    return appendConfigEntry(text, op.section, op.subsection, op.key, op.value);
  }
  if (op.kind === 'removeEntry') {
    return removeConfigEntry(text, op.section, op.subsection, op.key);
  }
  if (op.kind === 'removeSection') {
    return removeConfigSectionInText(text, op.section, op.subsection);
  }
  return renameConfigSectionInText(text, op.section, op.from, op.to);
};

/**
 * Insert `\tkey = value` after the LAST existing matching key inside the
 * section (or after the section header when none exists). Preserves
 * insertion order across repeated `appendEntry` calls — `fetch = A`
 * followed by `fetch = B` produces `A` then `B`, not `B` then `A`.
 * Creates the section if absent.
 */
export const appendConfigEntry = (
  text: string,
  section: string,
  subsection: string | undefined,
  key: string,
  value: string,
): string => {
  rejectSection(section);
  rejectControlChars('key', key);
  rejectValueControlChars(value);
  if (subsection !== undefined) rejectSubsection(subsection);
  const lines = text.split('\n');
  const headerIndex = findSectionHeader(lines, section, subsection);
  if (headerIndex === -1) {
    const prefix = text === '' ? '' : text.endsWith('\n') ? text : `${text}\n`;
    return `${prefix}${renderSectionHeader(section, subsection)}\n${renderEntry(key, value)}\n`;
  }
  const insertAt = findLastKeyInSection(lines, headerIndex, key);
  return insertAfter(lines, insertAt, renderEntry(key, value)).join('\n');
};

/**
 * Within the section that starts at `headerIndex`, the index of the LAST
 * `key =` line, or `headerIndex` when no such line exists. The scan stops
 * at the next section header so a later section's `key` line is never
 * matched. `appendConfigEntry` uses this to preserve insertion order
 * across repeated appends.
 */
const findLastKeyInSection = (
  lines: ReadonlyArray<string>,
  headerIndex: number,
  key: string,
): number => {
  let last = headerIndex;
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (isSectionHeader(line)) return last;
    if (isKeyLine(line, key)) last = i;
  }
  return last;
};

/**
 * Apply a sequence of mixed ops to `${gitDir}/config` (missing → `''`),
 * write the result, and invalidate the `readConfig` cache. The whole
 * sequence lands in one `writeUtf8`.
 */
export const updateConfigOperations = async (
  ctx: Context,
  ops: ReadonlyArray<ConfigOperation>,
): Promise<void> => {
  const path = `${ctx.layout.gitDir}/config`;
  const original = await readConfigText(ctx, path);
  const updated = ops.reduce(applyConfigOpInText, original);
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

/**
 * Validate a value-side string before writing. Rejects control characters
 * the writer's quoting grammar cannot represent: NUL, CR, and the other
 * non-newline / non-tab C0/C1 controls. `\n` and `\t` are accepted because
 * `renderValue` escapes them to `\\n` / `\\t` on write.
 */
const assertValueSafe = (key: string, value: string): void => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x09 || code === 0x0a) continue;
    if (code < 0x20 || code === 0x7f) {
      throw configValueInvalid(key, i);
    }
  }
};

/**
 * Read-modify-write the config file for a given scope. The `transform` is a
 * pure text function (e.g. `setConfigEntryInText`) — this helper handles the
 * I/O, the missing-file → `''` fallback, the post-write cache invalidation,
 * and the scope-path resolution.
 */
const readModifyWriteScopedConfig = async (
  ctx: Context,
  scope: ConfigScope,
  transform: (text: string) => string,
): Promise<void> => {
  const path = await resolveScopePath(ctx, scope);
  const before = await readConfigText(ctx, path);
  const after = transform(before);
  await ctx.fs.writeUtf8(path, after);
  invalidateConfigCache(ctx);
  invalidateScopedConfigCache(ctx);
};

/**
 * Write a single `key = value` entry into the config file for the given scope
 * (default `'local'`). Re-runs of the same call with a different value
 * overwrite the existing entry in place (preserving comments and surrounding
 * content). The key is validated via `parseConfigKey` (throws
 * `CONFIG_KEY_INVALID` on a malformed input) and the value is validated by
 * `assertValueSafe` (throws `CONFIG_VALUE_INVALID` on a banned control char)
 * BEFORE any I/O — a rejected input never touches the file system.
 *
 * The branding on `ConfigKey` is enforced at the type level; this primitive
 * accepts a raw string and parses it internally so it can be used directly
 * from porcelain wrappers that hold un-branded callers' input.
 */
export const setConfigEntry = async ({
  ctx,
  key,
  value,
  scope,
}: {
  readonly ctx: Context;
  readonly key: string;
  readonly value: string;
  readonly scope?: ConfigScope;
}): Promise<void> => {
  const parsed = parseConfigKey(key);
  assertValueSafe(key, value);
  const targetScope: ConfigScope = scope ?? 'local';
  await readModifyWriteScopedConfig(ctx, targetScope, (text) =>
    setConfigEntryInText(text, parsed.section, parsed.subsection, parsed.name, value),
  );
};

/**
 * Remove a single `key = value` entry from the given scope. Idempotent — if
 * the key is absent the call is a no-op (no I/O). If the key appears more
 * than once in the targeted scope, throws `CONFIG_MULTIPLE_VALUES` with
 * `requested: 'remove'` (the caller should use `unsetAllConfigEntries` to
 * clear every occurrence).
 */
export const unsetConfigEntry = async ({
  ctx,
  key,
  scope,
}: {
  readonly ctx: Context;
  readonly key: string;
  readonly scope?: ConfigScope;
}): Promise<void> => {
  const parsed = parseConfigKey(key);
  const targetScope: ConfigScope = scope ?? 'local';
  const path = await resolveScopePath(ctx, targetScope);
  const text = await readConfigText(ctx, path);
  const sections = parseIniSections(text);
  const matches = collectValues(sections, parsed);
  if (matches.length === 0) return;
  if (matches.length > 1) {
    throw configMultipleValues(key, matches.length, 'remove', targetScope);
  }
  const after = removeConfigEntry(text, parsed.section, parsed.subsection, parsed.name);
  await ctx.fs.writeUtf8(path, after);
  invalidateConfigCache(ctx);
  invalidateScopedConfigCache(ctx);
};

/**
 * Remove every occurrence of `key` from the targeted scope. Idempotent — a
 * missing key produces no I/O. Unlike `unsetConfigEntry`, multi-valued keys
 * are explicitly supported: all matching lines are removed in a single
 * read-modify-write pass.
 */
export const unsetAllConfigEntries = async ({
  ctx,
  key,
  scope,
}: {
  readonly ctx: Context;
  readonly key: string;
  readonly scope?: ConfigScope;
}): Promise<void> => {
  const parsed = parseConfigKey(key);
  const targetScope: ConfigScope = scope ?? 'local';
  const path = await resolveScopePath(ctx, targetScope);
  const text = await readConfigText(ctx, path);
  const sections = parseIniSections(text);
  const matches = collectValues(sections, parsed);
  if (matches.length === 0) return;
  const after = removeConfigEntry(text, parsed.section, parsed.subsection, parsed.name);
  await ctx.fs.writeUtf8(path, after);
  invalidateConfigCache(ctx);
  invalidateScopedConfigCache(ctx);
};

/**
 * Split a dotted section name into `(section, subsection)`. v1 only supports
 * rename/remove on sections that carry an explicit subsection — top-level
 * sections (e.g. `[user]`) cannot be renamed by canonical git either.
 */
const parseSectionName = (
  name: string,
): { readonly section: string; readonly subsection: string } => {
  const dot = name.indexOf('.');
  if (dot === -1 || dot === 0 || dot === name.length - 1) {
    throw invalidOption(
      'config',
      `section name must be of the form "<section>.<subsection>": ${name}`,
    );
  }
  const section = name.slice(0, dot);
  const subsection = name.slice(dot + 1);
  if (subsection.length === 0) {
    throw invalidOption(
      'config',
      `section name must be of the form "<section>.<subsection>": ${name}`,
    );
  }
  return { section, subsection };
};

const sectionExists = (
  sections: ReadonlyArray<{
    readonly section: string;
    readonly subsection: string | undefined;
  }>,
  section: string,
  subsection: string,
): boolean => {
  const lowerSection = section.toLowerCase();
  for (const s of sections) {
    if (s.section.toLowerCase() !== lowerSection) continue;
    if (s.subsection === subsection) return true;
  }
  return false;
};

/**
 * Rename `[<section> "<oldSubsection>"]` to `[<section> "<newSubsection>"]`.
 * Both inputs are dotted (`'remote.origin'`). The two section families MUST
 * match — renaming across families (e.g. `remote.origin` → `branch.main`) is
 * rejected with `INVALID_OPTION`. Throws `CONFIG_SECTION_NOT_FOUND` if the
 * source section does not exist in the targeted scope.
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
  const oldParts = parseSectionName(oldName);
  const newParts = parseSectionName(newName);
  if (oldParts.section.toLowerCase() !== newParts.section.toLowerCase()) {
    throw invalidOption(
      'config',
      `cannot rename across section families: ${oldParts.section} → ${newParts.section}`,
    );
  }
  const targetScope: ConfigScope = scope ?? 'local';
  const path = await resolveScopePath(ctx, targetScope);
  const text = await readConfigText(ctx, path);
  const sections = parseIniSections(text);
  if (!sectionExists(sections, oldParts.section, oldParts.subsection)) {
    throw configSectionNotFound(oldName, targetScope);
  }
  const after = renameConfigSectionInText(
    text,
    oldParts.section,
    oldParts.subsection,
    newParts.subsection,
  );
  await ctx.fs.writeUtf8(path, after);
  invalidateConfigCache(ctx);
  invalidateScopedConfigCache(ctx);
};

/**
 * Delete `[<section> "<subsection>"]` and its body. `sectionName` is dotted
 * (`'remote.origin'`). Throws `CONFIG_SECTION_NOT_FOUND` when the section is
 * absent in the targeted scope.
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
  const parts = parseSectionName(sectionName);
  const targetScope: ConfigScope = scope ?? 'local';
  const path = await resolveScopePath(ctx, targetScope);
  const text = await readConfigText(ctx, path);
  const sections = parseIniSections(text);
  if (!sectionExists(sections, parts.section, parts.subsection)) {
    throw configSectionNotFound(sectionName, targetScope);
  }
  const after = removeConfigSectionInText(text, parts.section, parts.subsection);
  await ctx.fs.writeUtf8(path, after);
  invalidateConfigCache(ctx);
  invalidateScopedConfigCache(ctx);
};
