/**
 * Targeted `.git/config` writer: entry-level surgery that preserves comments,
 * blank lines, key order, casing of unrelated keys, and every other section
 * byte-for-byte. Writes one `key = value` per call under any
 * `[section]` / `[section "subsection"]`.
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
  configValueInvalid,
} from '../../domain/commands/error.js';
import { TsgitError } from '../../domain/error.js';
import type { Context } from '../../ports/context.js';
import {
  type ConfigToken,
  invalidateConfigCache,
  parseIniSections,
  tokenizeConfigLines,
} from './config-read.js';
import { invalidateScopedConfigCache } from './config-scoped-read.js';
import { collectValues } from './internal/config-key.js';
import { resolveScopePath } from './internal/config-scope.js';
import {
  rejectControlChars,
  rejectEmptyPlainSection,
  rejectSection,
  rejectSubsection,
  rejectValueControlChars,
  renderEntry,
  renderSectionHeader,
} from './internal/config-write-shared.js';

import {
  rawSectionName,
  readConfigText,
  removeConfigSectionInText,
  renameConfigSectionInText,
} from './update-config-sections.js';

export { renderSectionHeader } from './internal/config-write-shared.js';
export type { NewSectionName } from './update-config-sections.js';
export {
  parseNewSectionName,
  rawSectionName,
  removeConfigSection,
  removeConfigSectionInText,
  renameConfigSection,
  renameConfigSectionInText,
} from './update-config-sections.js';

/** Section/subsection identity for token-based section matching. */
interface SectionTarget {
  readonly sectionLc: string;
  readonly subsection: string | undefined;
}

/** Builds a target with the section needle lowered once, not per header token. */
const makeTarget = (section: string, subsection: string | undefined): SectionTarget => ({
  sectionLc: section.toLowerCase(),
  subsection,
});

type EntryToken = Extract<ConfigToken, { kind: 'entry' }>;
type HeaderToken = Extract<ConfigToken, { kind: 'header' }>;

/** Physical-line span `[startLine, endLine)` of one logical entry. */
interface LineSpan {
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * True when `header` token matches `target`: case-insensitive section
 * (entry writes only — section ops match raw names case-sensitively) and
 * strict subsection identity — `undefined` matches only plain `[s]` headers,
 * `''` only explicitly empty `[s ""]` ones, never each other.
 */
const matchesTarget = (header: HeaderToken, target: SectionTarget): boolean => {
  if (header.section.toLowerCase() !== target.sectionLc) return false;
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
 * The header token a same-line entry shares its physical line with: the one
 * whose `line` equals the entry's `startLine`. git's set/unset re-emit this
 * header onto its own line whenever they rewrite the shared line, so the
 * `[section]` is never lost when the entry that followed it is replaced or
 * removed.
 */
const sharedHeaderOf = (
  tokens: ReadonlyArray<ConfigToken>,
  entry: EntryToken,
): HeaderToken | undefined => {
  for (const token of tokens) {
    if (token.kind === 'header' && token.line === entry.startLine) return token;
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
 * Replace the physical-line span of `existing` with a canonical `key = value`
 * line. A same-line entry (`[a] key = v`) re-emits its header on its own line
 * above the rewritten entry so the `[section]` survives the split — git's set
 * splits the shared line here. The rewritten entry is always LF-terminated,
 * even when the span reached EOF of a file lacking a final newline.
 */
const replaceEntrySpan = (
  lines: ReadonlyArray<string>,
  tokens: ReadonlyArray<ConfigToken>,
  existing: EntryToken,
  entry: string,
): string => {
  const header = existing.sharesHeaderLine ? sharedHeaderOf(tokens, existing) : undefined;
  const replacement =
    header !== undefined
      ? [renderSectionHeader(header.section, header.subsection), entry]
      : [entry];
  const out = [
    ...lines.slice(0, existing.startLine),
    ...replacement,
    ...lines.slice(existing.endLine),
  ];
  const terminated = existing.endLine === lines.length ? [...out, ''] : out;
  return terminated.join('\n');
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
  rejectEmptyPlainSection(section, subsection);
  rejectControlChars('key', key);
  rejectValueControlChars(value);
  if (subsection !== undefined) rejectSubsection(subsection);
  const lines = text.split('\n');
  const tokens = tokenizeConfigLines(lines, text.endsWith('\n'));
  const target = makeTarget(section, subsection);
  const existing = findEntry(tokens, target, key);
  if (existing !== undefined) {
    return replaceEntrySpan(lines, tokens, existing, renderEntry(key, value));
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
const matchingEntrySpans = (block: TokenBlock, keyLc: string): ReadonlyArray<LineSpan> =>
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

/**
 * Mark every physical line of the block (header + all body) as excluded.
 * Only called when `blockHasProtectingContent` is false, so body tokens are
 * matched entries and blanks — comments cannot occur here.
 */
const blockExclusions = (block: TokenBlock): ReadonlyArray<number> => [
  block.header.line,
  ...block.bodyTokens.flatMap((token) =>
    token.kind === 'entry' ? spanExclusions([token]) : [token.line],
  ),
];

/**
 * Mark every physical line of each span as excluded. Span bounds come from
 * the tokenizer, whose `endLine` never exceeds the tokenized line count.
 */
const spanExclusions = (spans: ReadonlyArray<LineSpan>): ReadonlyArray<number> =>
  spans.flatMap((span) =>
    Array.from({ length: span.endLine - span.startLine }, (_, i) => span.startLine + i),
  );

/** A header-line rewrite kept while removing the same-line entry that followed it. */
interface HeaderRewrite {
  readonly line: number;
  readonly text: string;
}

/** Per-block removal edit: lines to drop, plus an optional shared-header rewrite. */
interface BlockEdit {
  readonly excluded: ReadonlyArray<number>;
  readonly headerRewrite?: HeaderRewrite;
}

/**
 * Compute the removal edit for one matching block. Three shapes, mirroring
 * git's event-driven unset:
 *  - nothing protects the block ⇒ prune the whole block (header included);
 *  - the removed entry shares the header's physical line and the block survives
 *    ⇒ re-emit `[section]` alone on that line and drop only the entry's trailing
 *    continuation lines (and any other matched spans);
 *  - the removed entry is a plain body entry ⇒ drop its span(s), header verbatim.
 */
const blockEdit = (block: TokenBlock, keyLc: string): BlockEdit => {
  const spans = matchingEntrySpans(block, keyLc);
  if (spans.length === 0) return { excluded: [] };
  if (!blockHasProtectingContent(block, keyLc)) return { excluded: blockExclusions(block) };
  const sharesHeaderLine = spans.some((span) => span.startLine === block.header.line);
  if (!sharesHeaderLine) return { excluded: spanExclusions(spans) };
  // The header line stays (rewritten); only the entry's tail lines are dropped.
  const excluded = spanExclusions(spans).filter((idx) => idx !== block.header.line);
  return {
    excluded,
    headerRewrite: {
      line: block.header.line,
      text: renderSectionHeader(block.header.section, block.header.subsection),
    },
  };
};

/**
 * Apply the per-block removal `edits` to `lines`, returning the new text — or
 * `undefined` when no line is dropped and no header is re-emitted (a no-op).
 * Shared header lines are re-emitted before the excluded lines are filtered
 * out; the EOF terminator is preserved when the removed region reached EOF.
 */
const applyRemovalEdits = (
  lines: ReadonlyArray<string>,
  edits: ReadonlyArray<BlockEdit>,
): string | undefined => {
  const excluded = new Set(edits.flatMap((edit) => edit.excluded));
  const rewrites = edits.flatMap((edit) => (edit.headerRewrite ? [edit.headerRewrite] : []));
  if (excluded.size === 0 && rewrites.length === 0) return undefined;
  const rewritten = rewrites.reduce<ReadonlyArray<string>>(
    (acc, { line, text: header }) => acc.map((value, idx) => (idx === line ? header : value)),
    lines,
  );
  const kept = rewritten.filter((_, idx) => !excluded.has(idx));
  // When the removed region reached EOF, every kept line was followed by LF
  // in the original, so the output keeps that terminator — like git, which
  // copies the bytes before the removed region verbatim.
  const out = excluded.has(lines.length - 1) ? [...kept, ''] : kept;
  return out.join('\n');
};

/**
 * Remove every entry span for `key` from the section
 * `[section]` / `[section "subsection"]`. No-op when the section or key
 * is absent. Mirrors `git config --unset-all`: when the key appears more
 * than once (e.g. multiple `fetch =` lines), every occurrence and its full
 * backslash-continuation span is removed.
 *
 * Empty-block pruning: after removing the matched spans, a block whose
 * remaining tokens contain no entries and no comments (including the header's
 * own inline comment) is removed entirely, blank lines included. A same-line
 * entry whose block survives instead re-emits `[section]` on its own line. The
 * rule is per block occurrence, not per logical section name.
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
  const target = makeTarget(section, subsection);
  const blocks = buildTokenBlocks(tokenizeConfigLines(lines, text.endsWith('\n')));
  const keyLc = key.toLowerCase();
  const edits = blocks
    .filter((block) => matchesTarget(block.header, target))
    .map((block) => blockEdit(block, keyLc));
  return applyRemovalEdits(lines, edits) ?? text;
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
    return removeConfigSectionInText(
      text,
      rawSectionName({ section: op.section, subsection: op.subsection }),
    );
  }
  return renameConfigSectionInText(
    text,
    rawSectionName({ section: op.section, subsection: op.from }),
    {
      section: op.section,
      subsection: op.to,
    },
  );
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
  rejectEmptyPlainSection(section, subsection);
  rejectControlChars('key', key);
  rejectValueControlChars(value);
  if (subsection !== undefined) rejectSubsection(subsection);
  const lines = text.split('\n');
  const tokens = tokenizeConfigLines(lines, text.endsWith('\n'));
  const target = makeTarget(section, subsection);
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
