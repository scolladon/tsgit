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
  configInvalidFile,
  configMultipleValues,
  configSectionNotFound,
  configValueInvalid,
  invalidOption,
} from '../../domain/commands/error.js';
import { TsgitError } from '../../domain/error.js';
import type { Context } from '../../ports/context.js';
import {
  type ConfigToken,
  invalidateConfigCache,
  parseIniSections,
  parseSectionHeader,
  tokenizeConfigLines,
} from './config-read.js';
import { invalidateScopedConfigCache } from './config-scoped-read.js';
import { collectValues } from './internal/config-key.js';
import { resolveScopePath } from './internal/config-scope.js';

/**
 * True when `line` is the header for `[section]` / `[section "subsection"]`.
 * Section names are matched case-insensitively (git semantics); subsection
 * names case-sensitively. A `subsection` of `undefined` matches a header with
 * no subsection or an explicitly empty one (`[section ""]`). Malformed headers
 * never match — only `kind: 'header'` results are considered.
 */
const matchesSection = (line: string, section: string, subsection: string | undefined): boolean => {
  const header = parseSectionHeader(line.trim());
  if (header.kind !== 'header') return false;
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
const renderEntry = (key: string, value: string): string => `\t${key} = ${renderValue(value)}`;

/**
 * Escape a subsection name for embedding inside `[section "…"]`. git's
 * `write_section` escapes `\` → `\\` first (order matters), then `"` → `\"`.
 * Every other byte — `]`, CR, `#`, `;`, spaces — is written raw.
 */
const escapeSubsection = (subsection: string): string =>
  subsection.replaceAll('\\', '\\\\').replaceAll('"', '\\"');

/** Render a `[section]` / `[section "subsection"]` header line. */
const renderSectionHeader = (section: string, subsection: string | undefined): string =>
  subsection === undefined ? `[${section}]` : `[${section} "${escapeSubsection(subsection)}"]`;

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

/** Section/subsection identity for token-based section matching. */
interface SectionTarget {
  readonly section: string;
  readonly subsection: string | undefined;
}

type EntryToken = Extract<ConfigToken, { kind: 'entry' }>;
type HeaderToken = Extract<ConfigToken, { kind: 'header' }>;

/**
 * True when `header` token matches `target`: case-insensitive section,
 * case-sensitive subsection, `undefined` matches `undefined` or `''`.
 * Mirrors the semantics of `matchesSection`.
 */
const matchesTarget = (header: HeaderToken, target: SectionTarget): boolean => {
  if (header.section.toLowerCase() !== target.section.toLowerCase()) return false;
  if (target.subsection === undefined) {
    return header.subsection === undefined || header.subsection === '';
  }
  return header.subsection === target.subsection;
};

/**
 * First entry token (in line order) whose key matches `key` case-insensitively,
 * inside any block that matches `target`. Returns `undefined` when absent.
 */
const findEntry = (
  tokens: ReadonlyArray<ConfigToken>,
  target: SectionTarget,
  key: string,
): EntryToken | undefined => {
  const keyLc = key.toLowerCase();
  let inTarget = false;
  for (const token of tokens) {
    if (token.kind === 'header') {
      inTarget = matchesTarget(token, target);
    } else if (inTarget && token.kind === 'entry' && token.key.toLowerCase() === keyLc) {
      return token;
    }
  }
  return undefined;
};

/**
 * Insertion line for a new key: the end of the LAST matching block — the
 * last entry token's `endLine`, or `headerLine + 1` when that block has no
 * entries. Returns `undefined` when no block matches `target`.
 */
const insertionLine = (
  tokens: ReadonlyArray<ConfigToken>,
  target: SectionTarget,
): number | undefined => {
  let result: number | undefined;
  let inTarget = false;
  let blockInsert: number | undefined;
  for (const token of tokens) {
    if (token.kind === 'header') {
      if (inTarget) {
        result = blockInsert;
      }
      inTarget = matchesTarget(token, target);
      blockInsert = inTarget ? token.line + 1 : undefined;
    } else if (inTarget && token.kind === 'entry') {
      blockInsert = token.endLine;
    }
  }
  if (inTarget) {
    result = blockInsert;
  }
  return result;
};

/**
 * When `originalLines` ended with `''` (trailing `\n`) and `out` does not,
 * push `''` to restore the trailing newline. Shared by set/append and
 * remove-section.
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
 * Insert `entry` at line index `idx` in `lines`, clamping to the file's
 * writable boundary. When `idx === lines.length` (file has no trailing LF
 * and insertion is at EOF), appends a trailing `''` so the written entry
 * is LF-terminated.
 */
const spliceEntryAt = (
  lines: ReadonlyArray<string>,
  at: number,
  entry: string,
  originalText: string,
): ReadonlyArray<string> => {
  const max = originalText.endsWith('\n') ? lines.length - 1 : lines.length;
  const idx = Math.min(at, max);
  const out = [...lines.slice(0, idx), entry, ...lines.slice(idx)];
  if (idx === lines.length) out.push('');
  return out;
};

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
 * Reject NUL (`\0`) in a value. NUL has no canonical-git escape and cannot
 * survive a config write. CR and other control bytes are accepted — CR triggers
 * quoting and passes through raw; C0/DEL are written verbatim (git accepts them).
 */
const rejectValueControlChars = (value: string): void => {
  if (value.includes('\0')) {
    throw invalidOption('config', 'value must not contain a NUL byte');
  }
};

/**
 * Reject a subsection name that cannot survive a config write. git rejects
 * LF ("invalid key (newline)"); NUL is argv-impossible. CR, `"`, `\`, and `]`
 * are accepted — the writer escapes `"` and `\`, and writes `]`/CR raw.
 */
const rejectSubsection = (subsection: string): void => {
  if (/[\n\0]/.test(subsection)) {
    throw invalidOption('config', 'subsection must not contain a newline or NUL');
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
 * - existing section with that key ⇒ full span of the first match is replaced
 *   by a single canonical `\t<key> = <value>` line;
 * - existing section without that key ⇒ a `\t<key> = <value>` line is
 *   inserted at the end of the last matching block;
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
  const tokens = tokenizeConfigLines(lines, text.endsWith('\n'));
  const target = { section, subsection };
  const existing = findEntry(tokens, target, key);
  if (existing !== undefined) {
    const end = Math.min(existing.endLine, lines.length);
    const out = [
      ...lines.slice(0, existing.startLine),
      renderEntry(key, value),
      ...lines.slice(end),
    ];
    // git's write_pair always terminates the rewritten entry with LF, even
    // when the replaced span reached EOF of a file lacking a final newline.
    const terminated = end === lines.length ? [...out, ''] : out;
    return terminated.join('\n');
  }
  const at = insertionLine(tokens, target);
  if (at === undefined) {
    const prefix = text === '' ? '' : text.endsWith('\n') ? text : `${text}\n`;
    return `${prefix}${renderSectionHeader(section, subsection)}\n${renderEntry(key, value)}\n`;
  }
  return spliceEntryAt(lines, at, renderEntry(key, value), text).join('\n');
};

/** `setConfigEntryInText` bound to the `[core]` section — kept for legacy callers. */
export const setCoreConfigEntryInText = (text: string, key: string, value: string): string =>
  setConfigEntryInText(text, 'core', undefined, key, value);

type TokenBlock = {
  readonly header: HeaderToken;
  readonly bodyTokens: ReadonlyArray<ConfigToken>;
};

/** Group tokens into blocks: one header + every following token until the next header. */
const buildTokenBlocks = (tokens: ReadonlyArray<ConfigToken>): ReadonlyArray<TokenBlock> => {
  const blocks: TokenBlock[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as ConfigToken;
    if (token.kind !== 'header') continue;
    const body: ConfigToken[] = [];
    let j = i + 1;
    while (j < tokens.length && (tokens[j] as ConfigToken).kind !== 'header') {
      body.push(tokens[j] as ConfigToken);
      j++;
    }
    blocks.push({ header: token, bodyTokens: body });
    i = j - 1;
  }
  return blocks;
};

/** Collect the entry spans in `block` whose key matches `key` (case-insensitive). */
const matchingEntrySpans = (
  block: TokenBlock,
  keyLc: string,
): ReadonlyArray<{ startLine: number; endLine: number }> =>
  block.bodyTokens.flatMap((t) =>
    t.kind === 'entry' && t.key.toLowerCase() === keyLc
      ? [{ startLine: t.startLine, endLine: t.endLine }]
      : [],
  );

/**
 * True when the block retains content that prevents empty-block pruning:
 * a comment body token, a non-matched entry, or an inline comment on the header.
 */
const blockHasProtectingContent = (block: TokenBlock, keyLc: string): boolean =>
  block.header.hasComment ||
  block.bodyTokens.some(
    (t) => t.kind === 'comment' || (t.kind === 'entry' && t.key.toLowerCase() !== keyLc),
  );

/** Mark every physical line of the block (header + all body) as excluded. */
const blockExclusions = (block: TokenBlock, totalLines: number): ReadonlyArray<number> => [
  block.header.line,
  ...block.bodyTokens.flatMap((token) => {
    if (token.kind === 'blank') return [token.line];
    if (token.kind === 'entry') return spanExclusions([token], totalLines);
    return [];
  }),
];

/** Mark every physical line of each span as excluded. */
const spanExclusions = (
  spans: ReadonlyArray<{ startLine: number; endLine: number }>,
  totalLines: number,
): ReadonlyArray<number> =>
  spans.flatMap((span) => {
    const end = Math.min(span.endLine, totalLines);
    return Array.from({ length: end - span.startLine }, (_, i) => span.startLine + i);
  });

/**
 * Remove every entry span for `key` from the section
 * `[section]` / `[section "subsection"]`. No-op when the section or key
 * is absent. Mirrors `git config --unset-all`: when the key appears more
 * than once (e.g. multiple `fetch =` lines), every occurrence and its full
 * backslash-continuation span is removed.
 *
 * Empty-block pruning: after removing the matched spans, a block whose
 * remaining tokens contain no entries and no comments (including the header's
 * own inline comment) is removed entirely, blank lines included. The rule is
 * per block occurrence, not per logical section name.
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
  const target: SectionTarget = { section, subsection };
  const blocks = buildTokenBlocks(tokenizeConfigLines(lines, text.endsWith('\n')));
  const keyLc = key.toLowerCase();
  const excluded = new Set(
    blocks.flatMap((block) => {
      if (!matchesTarget(block.header, target)) return [];
      const spans = matchingEntrySpans(block, keyLc);
      if (spans.length === 0) return [];
      return blockHasProtectingContent(block, keyLc)
        ? spanExclusions(spans, lines.length)
        : blockExclusions(block, lines.length);
    }),
  );

  if (excluded.size === 0) return text;
  const kept = lines.filter((_, idx) => !excluded.has(idx));
  // When the removed region reached EOF, every kept line was followed by LF
  // in the original, so the output keeps that terminator — like git, which
  // copies the bytes before the removed region verbatim.
  const out = excluded.has(lines.length - 1) ? [...kept, ''] : kept;
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
  return withTrailingNewlineRestored(lines, out).join('\n');
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
  parseIniSectionsForWrite(original, path);
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
       * Insert a fresh `key = value` line at the end of the last matching
       * section block WITHOUT replacing any existing entry with the same key.
       * Use for multi-value keys (`fetch`) where every call must yield an
       * additional line.
       */
      readonly kind: 'appendEntry';
      readonly section: string;
      readonly subsection?: string;
      readonly key: string;
      readonly value: string;
    }
  | {
      /**
       * Remove every entry span for `key` from the section, pruning the block
       * header if no entries or comments remain. Delegates to `removeConfigEntry`.
       */
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
 * Insert a fresh `\tkey = value` line at the end of the LAST matching block
 * (never replaces an existing entry). Preserves insertion order across
 * repeated `appendEntry` calls — `fetch = A` followed by `fetch = B`
 * produces `A` then `B`. Creates the section if absent.
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
  const tokens = tokenizeConfigLines(lines, text.endsWith('\n'));
  const target = { section, subsection };
  const at = insertionLine(tokens, target);
  if (at === undefined) {
    const prefix = text === '' ? '' : text.endsWith('\n') ? text : `${text}\n`;
    return `${prefix}${renderSectionHeader(section, subsection)}\n${renderEntry(key, value)}\n`;
  }
  return spliceEntryAt(lines, at, renderEntry(key, value), text).join('\n');
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
  parseIniSectionsForWrite(original, path);
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
 * Validate a value-side string before writing. Rejects only NUL (`\0`) — it
 * has no canonical-git escape and cannot be represented in a config value.
 * CR, C0 controls, and DEL are accepted: CR triggers quoting and passes through
 * raw; C0/DEL are written verbatim (git accepts any byte except NUL).
 */
const assertValueSafe = (key: string, value: string): void => {
  // equivalent-mutant: `i <= value.length` is observably equivalent — at
  // `i === value.length` `charCodeAt` returns NaN, which is never 0, so the
  // extra iteration cannot throw.
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) === 0) {
      throw configValueInvalid(key, i);
    }
  }
};

/**
 * `parseIniSections` for write paths: a `CONFIG_PARSE_ERROR` carrying
 * `partialSectionName` means the file has a malformed quoted-subsection
 * header — git refuses the write with `invalid section name`, so it is
 * translated to `CONFIG_INVALID_FILE { sectionName, source }`. Value
 * malformations (no `partialSectionName`) propagate unchanged so callers
 * see git's read-shape error; all other exceptions propagate as-is.
 * Callers that only need the validation discard the result.
 */
const parseIniSectionsForWrite = (
  text: string,
  path: string,
): ReturnType<typeof parseIniSections> => {
  try {
    return parseIniSections(text, path);
  } catch (err) {
    if (
      err instanceof TsgitError &&
      err.data.code === 'CONFIG_PARSE_ERROR' &&
      err.data.partialSectionName !== undefined
    ) {
      throw configInvalidFile(err.data.partialSectionName, path);
    }
    throw err;
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
  parseIniSectionsForWrite(before, path);
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
 * clear every occurrence). An emptied section block is pruned entirely
 * (header + blank lines removed) unless the block contains a comment.
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
  // parseIniSections throws on malformed headers/values; translate header
  // errors to CONFIG_INVALID_FILE so the shape matches git's write refusal.
  const sections = parseIniSectionsForWrite(text, path);
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
 * are explicitly supported: all matching spans are removed in a single
 * read-modify-write pass. An emptied section block is pruned entirely
 * (header + blank lines removed) unless the block contains a comment.
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
  // Translate header malformation to CONFIG_INVALID_FILE (same as unsetConfigEntry).
  const sections = parseIniSectionsForWrite(text, path);
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
  // Line-based existence check — lenient on malformed headers/values, exactly
  // like git's copy_or_rename machinery. A malformed header never matches
  // matchesSection (kind !== 'header'), so it is never the rename source.
  if (findSectionHeader(text.split('\n'), oldParts.section, oldParts.subsection) === -1) {
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
  // Line-based existence check — lenient on malformed headers/values, exactly
  // like git's remove-section machinery.
  if (findSectionHeader(text.split('\n'), parts.section, parts.subsection) === -1) {
    throw configSectionNotFound(sectionName, targetScope);
  }
  const after = removeConfigSectionInText(text, parts.section, parts.subsection);
  await ctx.fs.writeUtf8(path, after);
  invalidateConfigCache(ctx);
  invalidateScopedConfigCache(ctx);
};
