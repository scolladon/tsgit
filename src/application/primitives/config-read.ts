import { configParseError } from '../../domain/commands/error.js';
import { TsgitError } from '../../domain/error.js';
import type { Context } from '../../ports/context.js';
import { commonGitDir } from './path-layout.js';

/** `push.default` mode; `tracking` is a deprecated alias canonicalized to `upstream` at parse time. */
export type PushDefaultMode = 'nothing' | 'current' | 'upstream' | 'simple' | 'matching';

/**
 * Subset of `.git/config` that v1 commands consume. Only fields actually used by
 * commands are typed — the parser ignores everything else (lenient, like git itself).
 */
export interface ParsedConfig {
  readonly core?: {
    readonly bare?: boolean;
    readonly excludesFile?: string;
    readonly attributesFile?: string;
    readonly logAllRefUpdates?: boolean | 'always';
    readonly hooksPath?: string;
    /** `core.notesRef` — default notes ref when neither explicit arg nor `GIT_NOTES_REF` is set. */
    readonly notesRef?: string;
    readonly sparseCheckout?: boolean;
    readonly sparseCheckoutCone?: boolean;
    readonly looseCompression?: number;
    /** `core.sshCommand` — shell string resolved by `resolveSshCommand` ahead of `GIT_SSH`. */
    readonly sshCommand?: string;
  };
  readonly user?: { readonly name?: string; readonly email?: string; readonly signingKey?: string };
  readonly remote?: ReadonlyMap<
    string,
    {
      readonly url?: string;
      /** `remote.<name>.pushurl` — push-only URL; `push` reads `pushUrl ?? url`. */
      readonly pushUrl?: string;
      readonly fetch?: ReadonlyArray<string>;
      /** `remote.<name>.promisor` — true when this is a partial-clone promisor remote. */
      readonly promisor?: boolean;
      /** `remote.<name>.partialclonefilter` — the canonical filter spec applied at clone. */
      readonly partialCloneFilter?: string;
    }
  >;
  /** `remote.pushDefault` — subsectionless `[remote]` only; per-remote `[remote "x"] pushDefault` is not read. */
  readonly remotePushDefault?: string;
  readonly branch?: ReadonlyMap<
    string,
    {
      readonly remote?: string;
      readonly merge?: string;
      /** `branch.<name>.pushRemote` — overrides the push-remote for this branch. */
      readonly pushRemote?: string;
    }
  >;
  /** `[submodule "<name>"]` — the registered (initialised) submodules. */
  readonly submodule?: ReadonlyMap<
    string,
    { readonly url?: string; readonly active?: boolean; readonly update?: string }
  >;
  /** `[merge "<driver>"]` — configured custom merge drivers. */
  readonly merge?: ReadonlyMap<
    string,
    { readonly name?: string; readonly driver?: string; readonly recursive?: string }
  >;
  /** `[diff "<name>"]` configured diff/textconv drivers. */
  readonly diff?: ReadonlyMap<
    string,
    { readonly textconv?: string; readonly cachetextconv?: boolean }
  >;
  /** `[filter "<name>"]` configured clean/smudge filter drivers. */
  readonly filter?: ReadonlyMap<
    string,
    {
      readonly clean?: string;
      readonly smudge?: string;
      readonly process?: string;
      readonly required?: boolean;
    }
  >;
  /** `[extensions]` — `partialClone` names the promisor remote of a partial clone. */
  readonly extensions?: { readonly partialClone?: string };
  /** `commit.gpgSign` — sign commits by default when true. */
  readonly commit?: { readonly gpgSign?: boolean };
  /** `tag.gpgSign` — sign annotated tags by default when true. */
  readonly tag?: { readonly gpgSign?: boolean };
  readonly push?: {
    /** `push.gpgSign` — sign push certificates: `true`/`false`, or `if-asked` (server-requested). */
    readonly gpgSign?: 'true' | 'false' | 'if-asked';
    /** `push.default` — canonicalized push remote-selection mode (`tracking` maps to `upstream`). */
    readonly default?: PushDefaultMode;
  };
  /** `[gpg]` — signing backend selection and the external program(s) invoked to sign/verify. */
  readonly gpg?: {
    readonly format?: 'openpgp' | 'ssh' | 'x509';
    readonly program?: string;
    /** `gpg.ssh.program` — the `ssh-keygen`-compatible binary used for `gpg.format = ssh`. */
    readonly ssh?: { readonly program?: string };
  };
}

/**
 * One read of `${gitDir}/config` cached per `Context`: the assembled parse, the
 * token stream both products are built from, and the absolute path the tokens
 * were read from. Held as a unit so a single read+tokenize feeds `readConfig`
 * (`.parsed`) and the valueless finders (`.tokens`), and one invalidation drops
 * both — they can never drift out of sync. `tokens` is `[]` for an absent file.
 */
interface ConfigCacheEntry {
  readonly parsed: ParsedConfig;
  readonly tokens: ReadonlyArray<ConfigToken>;
  readonly source: string;
}

// Cache reference is mutable so test code can swap in a fresh WeakMap and
// guarantee isolation between cases that re-use the same Context identity
// (the WeakMap itself can't be iterated, so a true reset requires replacement).
let cache: WeakMap<Context, Promise<ConfigCacheEntry>> = new WeakMap();

/**
 * Read and cache `${gitDir}/config`. Missing → empty config (not an error).
 *
 * The cache is keyed on `Context` identity; a new context (e.g., after a write
 * that re-creates the repo) gets a fresh read. Concurrent calls share the same
 * in-flight promise (per-context single-flight).
 */
export const readConfig = (ctx: Context): Promise<ParsedConfig> =>
  readConfigEntry(ctx).then((entry) => entry.parsed);

/**
 * The cache accessor: returns the per-`Context` `ConfigCacheEntry` promise,
 * single-flight (concurrent calls share the same in-flight read). Both
 * `readConfig` (`.parsed`) and the valueless finders (`.tokens`) consume it, so
 * the file is read and tokenized at most once per context until invalidated.
 */
const readConfigEntry = (ctx: Context): Promise<ConfigCacheEntry> => {
  const existing = cache.get(ctx);
  if (existing !== undefined) return existing;
  const pending = loadConfigEntry(ctx);
  cache.set(ctx, pending);
  return pending;
};

/** @internal — test-only cache reset between cases. Replaces the entire WeakMap. */
export const __resetConfigCacheForTests = (): void => {
  cache = new WeakMap();
};

/**
 * Drop the cached `readConfig` entry for a single `Context`. The production
 * invalidator: a config write (`updateCoreConfig`) calls this so a subsequent
 * `readConfig` on the same context re-reads the file instead of serving the
 * stale parse.
 */
export const invalidateConfigCache = (ctx: Context): void => {
  cache.delete(ctx);
};

const loadConfigEntry = async (ctx: Context): Promise<ConfigCacheEntry> => {
  const path = `${commonGitDir(ctx)}/config`;
  const raw = await readRawConfig(ctx, path);
  if (raw === undefined) return { parsed: {}, tokens: [], source: path };
  const tokens = tokenizeConfig(raw, path);
  return { parsed: assembleParsed(parseIniSectionsFromTokens(tokens)), tokens, source: path };
};

const readRawConfig = async (ctx: Context, path: string): Promise<string | undefined> => {
  try {
    return await ctx.fs.readUtf8(path);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return undefined;
    throw err;
  }
};

export interface ValuelessEntry {
  readonly key: string;
  readonly source: string;
  readonly line: number;
}

const matchesSection = (
  tokenSection: string,
  tokenSubsection: string | undefined,
  section: string,
  subsection: string | undefined,
): boolean =>
  tokenSection.toLowerCase() === section.toLowerCase() && tokenSubsection === subsection;

/**
 * Cold-path detection: re-tokenize the repo-local config and return the FIRST
 * valueless (`value === null`) entry, by config-file line, whose key
 * (case-insensitive) is one of `keys` and which sits under `[<section> "<subsection>"]`
 * (subsection `undefined` ⇒ the section with no subsection). Returns the fully-qualified
 * key, the absolute config path, and the 1-based line, or `undefined` when no such
 * entry exists. Runs ONLY on a command's refusal path.
 */
export const findFirstValuelessEntry = async (
  ctx: Context,
  section: string,
  subsection: string | undefined,
  keys: ReadonlyArray<string>,
): Promise<ValuelessEntry | undefined> => {
  const { tokens, source: path } = await readConfigEntry(ctx);
  const keySet = new Set(keys.map((k) => k.toLowerCase()));
  let inSection = false;
  for (const token of tokens) {
    if (token.kind === 'header') {
      inSection = matchesSection(token.section, token.subsection, section, subsection);
      continue;
    }
    if (!inSection || token.kind !== 'entry' || token.value !== null) continue;
    const loweredKey = token.key.toLowerCase();
    if (!keySet.has(loweredKey)) continue;
    const loweredSection = section.toLowerCase();
    const qualifiedKey =
      subsection === undefined
        ? `${loweredSection}.${loweredKey}`
        : `${loweredSection}.${subsection}.${loweredKey}`;
    return { key: qualifiedKey, source: path, line: token.startLine + 1 };
  }
  return undefined;
};

/**
 * Subsection-wildcard sibling of `findFirstValuelessEntry`: scan EVERY subsection
 * of `section` (case-insensitive section match, any `subsection`) and return the
 * FIRST valueless (`value === null`) entry, by config-file line, whose key
 * (case-insensitive) is one of `keys`. The qualified key keeps the matched
 * header's subsection verbatim (`${section}.${subsection}.${key}`, section + key
 * lower-cased), or `${section}.${key}` for the subsectionless form. Consumes the
 * cached token stream — one walk, no extra read. Used by the content-merge
 * chokepoint to reproduce git's whole-`[merge *]`-table valueless death.
 */
export const findFirstValuelessInSection = async (
  ctx: Context,
  section: string,
  keys: ReadonlyArray<string>,
): Promise<ValuelessEntry | undefined> => {
  const { tokens, source: path } = await readConfigEntry(ctx);
  const keySet = new Set(keys.map((k) => k.toLowerCase()));
  const loweredSection = section.toLowerCase();
  let subsection: string | undefined;
  let inSection = false;
  for (const token of tokens) {
    if (token.kind === 'header') {
      inSection = token.section.toLowerCase() === loweredSection;
      subsection = token.subsection;
      continue;
    }
    if (!inSection || token.kind !== 'entry' || token.value !== null) continue;
    const loweredKey = token.key.toLowerCase();
    if (!keySet.has(loweredKey)) continue;
    const qualifiedKey =
      subsection === undefined
        ? `${loweredSection}.${loweredKey}`
        : `${loweredSection}.${subsection}.${loweredKey}`;
    return { key: qualifiedKey, source: path, line: token.startLine + 1 };
  }
  return undefined;
};

/** Minimum valid zlib compression level (synonym for the implementation default). */
export const ZLIB_MIN_LEVEL = -1;
/** Maximum valid zlib compression level. */
export const ZLIB_MAX_LEVEL = 9;

/** The discriminated failure from a compression-key validation scan. */
type CompressionFailure =
  | {
      readonly kind: 'numeric';
      readonly value: string;
      readonly reason: 'invalid unit' | 'out of range';
    }
  | { readonly kind: 'zlib'; readonly level: number };

/** One invalid compression entry returned by `findFirstInvalidCompression`. */
export interface InvalidCompressionEntry {
  readonly key: string;
  readonly source: string;
  readonly line: number;
  readonly failure: CompressionFailure;
}

const COMPRESSION_KEYS: ReadonlySet<string> = new Set(['loosecompression', 'compression']);

/**
 * Cold-path detection: walk the cached `[core]` (subsectionless) tokens in
 * file order and return the FIRST entry whose key is `loosecompression` or
 * `compression` that fails full compression validation (valueless, invalid
 * integer, or integer outside zlib's `-1..9`). Returns `undefined` when all
 * compression keys are absent or valid. Runs ONLY on a command's refusal path.
 */
export const findFirstInvalidCompression = async (
  ctx: Context,
): Promise<InvalidCompressionEntry | undefined> => {
  const { tokens, source: path } = await readConfigEntry(ctx);
  let inSection = false;
  for (const token of tokens) {
    if (token.kind === 'header') {
      inSection = matchesSection(token.section, token.subsection, 'core', undefined);
      continue;
    }
    if (!inSection || token.kind !== 'entry') continue;
    const loweredKey = token.key.toLowerCase();
    if (!COMPRESSION_KEYS.has(loweredKey)) continue;
    const qualifiedKey = `core.${loweredKey}`;
    const line = token.startLine + 1;
    if (token.value === null) {
      return {
        key: qualifiedKey,
        source: path,
        line,
        failure: { kind: 'numeric', value: '', reason: 'invalid unit' },
      };
    }
    const parsed = parseGitInt(token.value);
    if (!parsed.ok) {
      return {
        key: qualifiedKey,
        source: path,
        line,
        failure: { kind: 'numeric', value: token.value, reason: parsed.reason },
      };
    }
    if (parsed.value < ZLIB_MIN_LEVEL || parsed.value > ZLIB_MAX_LEVEL) {
      return {
        key: qualifiedKey,
        source: path,
        line,
        failure: { kind: 'zlib', level: parsed.value },
      };
    }
  }
  return undefined;
};

/**
 * One `[section "subsection"]` block of a git-config-format INI file: the
 * section name, an optional quoted subsection, and its key/value entries.
 * Exported so `.gitmodules` parsing — byte-identical grammar — reuses one
 * tokenizer (ADR-086).
 *
 * Entry `value`:
 *   - `string` — key present with `=` (possibly `''` for `key =`)
 *   - `null`   — key present with no `=` (git's internal NULL; boolean-true)
 *   - `undefined` is never used here; the absent-key state lives one layer up
 */
export interface IniSection {
  readonly section: string;
  readonly subsection: string | undefined;
  readonly entries: ReadonlyArray<{ readonly key: string; readonly value: string | null }>;
}

/** Internal builder shape — `entries` stays mutable while a section is collected. */
interface SectionBuilder {
  readonly section: string;
  readonly subsection: string | undefined;
  readonly entries: Array<{ readonly key: string; readonly value: string | null }>;
}

/** Physical-line classification of git-config text; the writer's surgery unit. */
export type ConfigToken =
  | {
      readonly kind: 'header';
      readonly section: string;
      readonly subsection: string | undefined;
      readonly line: number;
      /** Header line carries an unquoted inline `#`/`;` comment (blocks empty-section pruning). */
      readonly hasComment: boolean;
    }
  | {
      readonly kind: 'entry';
      readonly key: string;
      readonly value: string | null;
      readonly startLine: number;
      /** Exclusive — `parseConfigValue`'s `nextLineIdx`; `startLine + 1` for single-line entries. */
      readonly endLine: number;
      /**
       * Present when the entry shares the header's physical line (`[a] key = v`).
       * The header still owns the bytes before `startCol`; the writer re-emits the
       * header onto its own line before this entry when it rewrites the shared line.
       */
      readonly sharesHeaderLine?: true;
      /** Column where a shared-header-line entry begins (just past the header skip). */
      readonly startCol?: number;
    }
  | { readonly kind: 'comment'; readonly line: number }
  | { readonly kind: 'blank'; readonly line: number };

/** One scanned key: its name, its value (`null` when valueless), and the line after it. */
interface ScannedKey {
  readonly key: string;
  readonly value: string | null;
  readonly nextLineIdx: number;
}

/** A key character: the first must be a letter, the rest letters/digits/dash. */
const isKeyHead = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isKeyTail = (c: string): boolean => isKeyHead(c) || (c >= '0' && c <= '9') || c === '-';

/** Space and TAB only — the run git skips between a key and its `=` or EOL (no CR). */
const isKeyGap = (c: string): boolean => c === ' ' || c === '\t';

/**
 * git's one key scanner, shared by the `=` and no-`=` paths. From column `start`
 * on `lines[lineIdx]`: the first char must be a letter, then letters/digits/dash
 * run into the key, then space/TAB is skipped. End of line (or a trailing CR)
 * yields a valueless entry (`value: null`); an `=` hands the rest to the value
 * grammar; anything else — including a mid-key `#`/`;` — refuses the whole file
 * with `CONFIG_PARSE_ERROR`, mirroring git's `bad config line N`.
 */
const scanKey = (
  lines: ReadonlyArray<string>,
  lineIdx: number,
  start: number,
  source: string | undefined,
): ScannedKey => {
  const line = lines[lineIdx] as string;
  if (start >= line.length || !isKeyHead(line[start] as string)) {
    throw configParseError(lineIdx + 1, source);
  }
  let col = start + 1;
  while (col < line.length && isKeyTail(line[col] as string)) col += 1;
  const key = line.slice(start, col);
  while (col < line.length && isKeyGap(line[col] as string)) col += 1;
  const valueless: ScannedKey = { key, value: null, nextLineIdx: lineIdx + 1 };
  if (col >= line.length) return valueless;
  const c = line[col] as string;
  if (c === '\r' && col === line.length - 1) return valueless;
  if (c !== '=') throw configParseError(lineIdx + 1, source);
  const parsed = parseConfigValue(lines, lineIdx, col + 1, source);
  return { key, value: parsed.value, nextLineIdx: parsed.nextLineIdx };
};

/** Index of the first non-space/TAB character at or after `start`, or the line length. */
const firstNonGap = (line: string, start: number): number => {
  let col = start;
  while (col < line.length && isKeyGap(line[col] as string)) col += 1;
  return col;
};

/**
 * Produce a flat token stream of physical-line classifications for git-config text.
 * The scan is char-wise like git's: a header may be followed on the same line by
 * an entry, so one physical line can yield a `header` token plus a same-line
 * `entry` token (marked `sharesHeaderLine`). The stream is the writer's surgery
 * unit. Degenerate case: empty text (`''`) yields one `blank` token at line 0,
 * because `''.split('\n')` produces a single empty line; consumers that skip
 * blanks see `[]`.
 *
 * Terminator handling: when `text` ends with `\n`, the final empty element from
 * `split('\n')` is the file terminator and emits no token. Continuation values may
 * still consume it (their `endLine` may equal `lines.length`).
 *
 * Throws `CONFIG_PARSE_ERROR` for malformed headers, unknown value escapes, unclosed
 * quotes, and invalid key grammar — mirroring `parseIniSections` exactly.
 */
export const tokenizeConfig = (text: string, source?: string): ReadonlyArray<ConfigToken> =>
  tokenizeConfigLines(text.split('\n'), text.endsWith('\n'), source);

/**
 * Same as `tokenizeConfig` over pre-split lines, so writers that already hold
 * the line array do not split the text twice. `endsWithNewline` tells whether
 * the final array element is the file terminator rather than a content line.
 */
export const tokenizeConfigLines = (
  lines: ReadonlyArray<string>,
  endsWithNewline: boolean,
  source?: string,
): ReadonlyArray<ConfigToken> => {
  const tokens: ConfigToken[] = [];
  const limit = endsWithNewline ? lines.length - 1 : lines.length;
  let lineIdx = 0;
  while (lineIdx < limit) {
    lineIdx = tokenizeLine(tokens, lines, lineIdx, source);
  }
  return tokens;
};

/** Tokenize one physical line, pushing its token(s) and returning the next line index. */
const tokenizeLine = (
  tokens: ConfigToken[],
  lines: ReadonlyArray<string>,
  lineIdx: number,
  source: string | undefined,
): number => {
  const line = lines[lineIdx] as string;
  const trimmed = stripInlineComment(line).trim();
  if (trimmed === '') {
    tokens.push(
      line.trim() === '' ? { kind: 'blank', line: lineIdx } : { kind: 'comment', line: lineIdx },
    );
    return lineIdx + 1;
  }
  const header = scanHeaderPrefix(line);
  if (header.parse.kind === 'header') {
    return emitHeaderLine(tokens, lines, lineIdx, header, source);
  }
  if (header.parse.kind === 'malformed') {
    throw configParseError(lineIdx + 1, source, header.parse.partialName);
  }
  // Not a header and not a comment: scan it as a key line. A bracket-shaped line
  // that is not a valid header (`[ core ]`, `[a b]`, `[half`) has no key character
  // at its first column, so `scanKey` refuses it — exactly as git does.
  return emitBodyEntry(tokens, lines, lineIdx, source);
};

/** Scan a whole-line entry from its first non-space column. */
const emitBodyEntry = (
  tokens: ConfigToken[],
  lines: ReadonlyArray<string>,
  lineIdx: number,
  source: string | undefined,
): number => {
  const start = firstNonGap(lines[lineIdx] as string, 0);
  const scanned = scanKey(lines, lineIdx, start, source);
  tokens.push({
    kind: 'entry',
    key: scanned.key,
    value: scanned.value,
    startLine: lineIdx,
    endLine: scanned.nextLineIdx,
  });
  return scanned.nextLineIdx;
};

/**
 * Push the header token(s) on this physical line, then scan its remainder.
 * git lets headers chain on one line (`[a][b]`): each `]`-closed bracket span
 * after GIT_SPACE that opens with `[` is another header, and the content after
 * the chain — same-line entry, `#`/`;` comment, or nothing — lands under the
 * LAST header (it is the open section when the body is read). A same-line entry
 * keeps its `sharesHeaderLine`/`startCol` marker relative to that last header.
 * Cost stays linear: a single integer cursor advances over the line, scanning
 * each bracket span in place from its offset — no per-span substring copy and
 * no re-scan from the line start, so a chain of K headers is O(line length).
 */
const emitHeaderLine = (
  tokens: ConfigToken[],
  lines: ReadonlyArray<string>,
  lineIdx: number,
  header: HeaderPrefixScan,
  source: string | undefined,
): number => {
  const line = lines[lineIdx] as string;
  let current = header;
  let contentStart = skipGitSpace(line, current.endOffset);
  while (line[contentStart] === '[') {
    pushHeaderToken(tokens, current, lineIdx, false);
    current = scanHeaderPrefix(line, contentStart);
    if (current.parse.kind !== 'header') {
      throw configParseError(lineIdx + 1, source, malformedPartialName(current.parse));
    }
    contentStart = skipGitSpace(line, current.endOffset);
  }
  const next = line[contentStart];
  const hasComment = next === '#' || next === ';';
  pushHeaderToken(tokens, current, lineIdx, hasComment);
  if (contentStart >= line.length || hasComment) return lineIdx + 1;
  const scanned = scanKey(lines, lineIdx, contentStart, source);
  tokens.push({
    kind: 'entry',
    key: scanned.key,
    value: scanned.value,
    startLine: lineIdx,
    endLine: scanned.nextLineIdx,
    sharesHeaderLine: true,
    startCol: contentStart,
  });
  return scanned.nextLineIdx;
};

/** Push one header token from a recognised header scan onto the stream. */
const pushHeaderToken = (
  tokens: ConfigToken[],
  header: HeaderPrefixScan,
  lineIdx: number,
  hasComment: boolean,
): void => {
  const parse = header.parse as Extract<SectionHeaderParse, { kind: 'header' }>;
  tokens.push({
    kind: 'header',
    section: parse.section,
    subsection: parse.subsection,
    line: lineIdx,
    hasComment,
  });
};

/** Partial name carried by a malformed parse, for the refusal message. */
const malformedPartialName = (parse: SectionHeaderParse): string | undefined =>
  parse.kind === 'malformed' ? parse.partialName : undefined;

/** Index of the first non-GIT_SPACE character at or after `start` (space/TAB/CR skipped). */
export const skipGitSpace = (line: string, start: number): number => {
  let col = start;
  while (col < line.length && GIT_SPACE.has(line[col] as string)) col += 1;
  return col;
};

/**
 * Tokenize git-config-format INI text into its sections. Lenient on structure,
 * like git is with unknown keys: orphan key/values and malformed headers are
 * skipped. Values follow git's full quoted-value grammar — quotes stripped,
 * `\n`/`\t`/`\b`/`\"`/`\\` decoded, backslash-newline continuations, unquoted
 * `#`/`;` starting comments — and a malformed value (unknown escape, unclosed
 * quote) throws `CONFIG_PARSE_ERROR` with its 1-based physical line and the
 * optional `source` label, mirroring git's `bad config line N in file F`
 * refusal. A malformed quoted-subsection header (e.g. `[s"a"]`, `[s "a" x]`,
 * unclosed quote) also throws `CONFIG_PARSE_ERROR` with `partialSectionName`.
 *
 * Keys before the first header are recorded under an implicit orphan section
 * (`section: ''`, `subsection: undefined`), so they surface on the token stream
 * and porcelain `--list`, mirroring git, which dumps them with no section prefix
 * but refuses to address them. The orphan section is emitted only when it
 * gathered an entry — a header-only file yields no leading empty section.
 *
 * A line with no `=` records a valueless key (`value: null`); the key grammar
 * (alpha-first, `[a-zA-Z0-9-]`, then space/TAB and `=`-or-EOL) refuses anything
 * else — `bad!key`, `9key`, a mid-key `#`/`;` — with `CONFIG_PARSE_ERROR`.
 */
export const parseIniSections = (text: string, source?: string): ReadonlyArray<IniSection> =>
  parseIniSectionsFromTokens(tokenizeConfig(text, source));

/**
 * Assemble `IniSection`s from an already-tokenized config stream — the body of
 * `parseIniSections` minus its `tokenizeConfig` call, so a caller that already
 * holds the tokens (the per-context cache) does not tokenize the same bytes a
 * second time. `parseIniSections` is the thin wrapper for callers that hold text.
 */
const parseIniSectionsFromTokens = (
  tokens: ReadonlyArray<ConfigToken>,
): ReadonlyArray<IniSection> => {
  const sections: SectionBuilder[] = [];
  const orphan: SectionBuilder = { section: '', subsection: undefined, entries: [] };
  let current: SectionBuilder = orphan;
  for (const token of tokens) {
    if (token.kind === 'header') {
      current = { section: token.section, subsection: token.subsection, entries: [] };
      sections.push(current);
    } else if (token.kind === 'entry') {
      current.entries.push({ key: token.key, value: token.value });
    }
  }
  return orphan.entries.length > 0 ? [orphan, ...sections] : sections;
};

/** Escape sequences git's value grammar accepts; anything else is a parse error. */
const VALUE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['n', '\n'],
  ['t', '\t'],
  ['b', '\b'],
  ['\\', '\\'],
  ['"', '"'],
]);

/**
 * git sane-ctype `GIT_SPACE` minus LF (the line terminator): VT/FF are NOT
 * whitespace. Shared by the value parser and the quoted-subsection grammar
 * (the whitespace required before an opening subsection quote).
 */
const GIT_SPACE: ReadonlySet<string> = new Set([' ', '\t', '\r']);

/** Mutable accumulator for one value parse; local to `parseConfigValue`. */
interface ValueState {
  out: string;
  /** Length of `out` before the open trailing-whitespace run, or -1 when none. */
  trimLen: number;
  inQuotes: boolean;
  inComment: boolean;
}

/** Mutable read position; `lineIdx` advances on backslash-newline continuations. */
interface ValueCursor {
  lineIdx: number;
  col: number;
}

/** One parsed value plus the index of the first physical line after it. */
interface ParsedValue {
  readonly value: string;
  readonly nextLineIdx: number;
}

/**
 * Parse one value starting at `lines[startLine][startCol]` (just past the `=`),
 * mirroring git's `parse_value`: GIT_SPACE handling with trailing trim, quote
 * spans, escape decoding, unquoted `#`/`;` comments, and backslash-newline
 * continuations (which may consume following physical lines). Throws
 * `CONFIG_PARSE_ERROR` on an unknown escape or a quote span left open at end
 * of line; a continuation on the final line ends the value (git fakes an EOL
 * at EOF).
 */
const parseConfigValue = (
  lines: ReadonlyArray<string>,
  startLine: number,
  startCol: number,
  source: string | undefined,
): ParsedValue => {
  const cursor: ValueCursor = { lineIdx: startLine, col: startCol };
  const state: ValueState = { out: '', trimLen: -1, inQuotes: false, inComment: false };
  while (cursor.lineIdx < lines.length) {
    const line = lines[cursor.lineIdx] as string;
    if (cursor.col >= line.length) {
      if (state.inQuotes) throw configParseError(cursor.lineIdx + 1, source);
      return finishValue(state, cursor.lineIdx + 1);
    }
    stepValueChar(lines, cursor, state, source);
  }
  return finishValue(state, cursor.lineIdx);
};

/** Consume one char (or escape pair) at the cursor, updating state in place. */
const stepValueChar = (
  lines: ReadonlyArray<string>,
  cursor: ValueCursor,
  state: ValueState,
  source: string | undefined,
): void => {
  const line = lines[cursor.lineIdx] as string;
  const c = line[cursor.col] as string;
  cursor.col += 1;
  if (state.inComment) return;
  if (!state.inQuotes && GIT_SPACE.has(c)) {
    appendValueSpace(state, c);
    return;
  }
  if (!state.inQuotes && (c === '#' || c === ';')) {
    state.inComment = true;
    return;
  }
  if (c === '\\') {
    consumeEscape(lines, cursor, state, source);
    return;
  }
  if (c === '"') {
    state.inQuotes = !state.inQuotes;
    state.trimLen = -1;
    return;
  }
  state.out += c;
  state.trimLen = -1;
};

/**
 * Decode the char after a backslash. A backslash at end of line is a
 * continuation: the line break is consumed and parsing resumes at column 0 of
 * the next physical line (its leading whitespace is interior to the value).
 */
const consumeEscape = (
  lines: ReadonlyArray<string>,
  cursor: ValueCursor,
  state: ValueState,
  source: string | undefined,
): void => {
  const line = lines[cursor.lineIdx] as string;
  if (cursor.col >= line.length) {
    cursor.lineIdx += 1;
    cursor.col = 0;
    return;
  }
  const decoded = VALUE_ESCAPES.get(line[cursor.col] as string);
  if (decoded === undefined) throw configParseError(cursor.lineIdx + 1, source);
  cursor.col += 1;
  state.out += decoded;
  state.trimLen = -1;
};

/**
 * Unquoted whitespace is skipped while the value is still empty (leading),
 * otherwise appended with the start of the run latched for the trailing trim.
 */
const appendValueSpace = (state: ValueState, c: string): void => {
  if (state.out === '') return;
  if (state.trimLen === -1) state.trimLen = state.out.length;
  state.out += c;
};

/** Apply the trailing-whitespace trim and package the parse result. */
const finishValue = (state: ValueState, nextLineIdx: number): ParsedValue => ({
  value: state.trimLen === -1 ? state.out : state.out.slice(0, state.trimLen),
  nextLineIdx,
});

const stripInlineComment = (line: string): string => {
  const hashAt = indexOfUnquoted(line, '#');
  const semiAt = indexOfUnquoted(line, ';');
  // Stryker disable next-line EqualityOperator: equivalent — a cut at index 0 means the whole line is a comment; whether it is truncated to '' (skipped) or kept (a '#'/';'-prefixed key that matches no consumed config key) the parsed result is identical.
  const cuts = [hashAt, semiAt].filter((n): n is number => n >= 0);
  // Stryker disable next-line ConditionalExpression: equivalent — with no cuts `Math.min(...[])` is `Infinity`, so `line.slice(0, Infinity)` returns the whole line, identical to the early `return line`.
  if (cuts.length === 0) return line;
  return line.slice(0, Math.min(...cuts));
};

const indexOfUnquoted = (line: string, ch: string): number => {
  let inQuotes = false;
  // Stryker disable next-line EqualityOperator: equivalent — at `i === line.length` `line[i]` is `undefined`, matching neither `'"'` nor `ch`, so the extra iteration is a no-op and the return value is unchanged.
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    // Inside a quoted span, `\` escapes the next byte — skip it so a `\"`
    // is not treated as the closing quote (matches canonical git's parser
    // and lets a value like `"foo\"#bar"` survive `stripInlineComment`).
    if (inQuotes && c === '\\') {
      i += 1;
      continue;
    }
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && c === ch) return i;
  }
  return -1;
};

/**
 * Three-state result of parsing a trimmed `[…]`-shaped header line. Exported
 * so the sibling config writer (`update-config.ts`) shares one header parser.
 */
export type SectionHeaderParse =
  | { readonly kind: 'header'; readonly section: string; readonly subsection: string | undefined }
  | { readonly kind: 'malformed'; readonly partialName: string }
  | { readonly kind: 'not-header' };

/**
 * Scan the quoted-subsection branch of a `[section "subsection"]` header.
 * `contentStart` is the absolute index just past `[`; `quoteAt` the absolute
 * index of the opening `"`. The section name is the span between them.
 */
const parseQuotedSubsectionHeader = (
  line: string,
  contentStart: number,
  quoteAt: number,
): QuotedHeaderScan => {
  const section = line.slice(contentStart, quoteAt).trim();
  const sectionPart = section.toLowerCase();
  // A quote that opens the header content (no char between `[` and `"`) has no
  // separating whitespace, which the guard below treats as git's refusal.
  // equivalent-mutant: at quoteAt === contentStart, line[quoteAt-1] is the opening `[`, never GIT_SPACE, so `>`/`>=`/`true` all reach the same `!GIT_SPACE` refusal below.
  const charBeforeQuote = quoteAt > contentStart ? line[quoteAt - 1] : undefined;
  if (charBeforeQuote === undefined || !GIT_SPACE.has(charBeforeQuote)) {
    return { parse: { kind: 'malformed', partialName: sectionPart } };
  }
  return scanQuotedSpan(line, quoteAt, section, sectionPart);
};

/** A closed quoted subsection: its decoded text and the index of the closing `"`. */
interface ClosedSubsection {
  readonly subsection: string;
  readonly closeQuoteAt: number;
}

/**
 * Decode the quoted subsection starting at absolute `openAt` (the opening `"`)
 * in `line`, honouring `\`-escapes. Returns the decoded text and the absolute
 * closing `"` index, or the partial text on an unclosed/dangling span (so the
 * caller can build a `malformed` name).
 */
const decodeSubsection = (
  line: string,
  openAt: number,
): ClosedSubsection | { readonly partial: string } => {
  let subsection = '';
  let i = openAt + 1;
  while (i < line.length) {
    const c = line[i] as string;
    if (c === '\\') {
      if (i + 1 >= line.length) return { partial: subsection };
      subsection += line[i + 1] as string;
      i += 2;
      continue;
    }
    if (c === '"') return { subsection, closeQuoteAt: i };
    subsection += c;
    i += 1;
  }
  return { partial: subsection };
};

/**
 * A quoted-header scan: the three-state parse plus, on success, the index of the
 * closing `"` so the raw-line scanner can derive the bracket end-offset from the
 * single identity decode rather than decoding the span a second time.
 */
interface QuotedHeaderScan {
  readonly parse: SectionHeaderParse;
  readonly closeQuoteAt?: number;
}

/**
 * Scan the quoted subsection span starting at absolute `openAt` (the index of
 * `"` in `line`). On success, the closing `"` must be immediately followed by
 * `]` — the last char on a trimmed line, or the bracket terminator before
 * same-line entry content on a raw line. Otherwise produces a `malformed` result.
 */
const scanQuotedSpan = (
  line: string,
  openAt: number,
  section: string,
  sectionPart: string,
): QuotedHeaderScan => {
  const decoded = decodeSubsection(line, openAt);
  if ('partial' in decoded) {
    return { parse: { kind: 'malformed', partialName: `${sectionPart}.${decoded.partial}` } };
  }
  if (line.startsWith(']', decoded.closeQuoteAt + 1)) {
    return {
      parse: { kind: 'header', section, subsection: decoded.subsection },
      closeQuoteAt: decoded.closeQuoteAt,
    };
  }
  return { parse: { kind: 'malformed', partialName: `${sectionPart}.${decoded.subsection}` } };
};

/**
 * A recognised header over a raw line plus `endOffset`: the column just past the
 * `]` that closes the bracket span. Same-line entry content (`[a] key = v`)
 * begins after `endOffset`; the writer slices the raw header bytes by it.
 */
export interface HeaderPrefixScan {
  readonly parse: SectionHeaderParse;
  readonly endOffset: number;
}

/**
 * Scan a header at offset `start` of a raw (untrimmed) line. It stops at the `]`
 * that closes the bracket span, so a same-line entry — or another chained header
 * — may follow it. `endOffset` is the absolute column just past that `]`, in the
 * original line. A char at `start` that is not `[` (after a leading-space skip),
 * or a malformed unquoted bracket span, reports `not-header` (the tokenizer keeps
 * its lenient skip); a malformed quoted subsection reports `malformed`. Scanning
 * from an offset (rather than a fresh slice) keeps a chain of headers linear in
 * the line length: the cursor advances over the line, never re-copying the tail.
 */
export const scanHeaderPrefix = (line: string, start = 0): HeaderPrefixScan => {
  const open = firstNonGap(line, start);
  if (line[open] !== '[') return NOT_HEADER_SCAN;
  const contentStart = open + 1;
  // The first `]` bounds the span; the `"` lookup only matters before it, so a
  // chain of quote-free `[a][b]...` headers never re-scans to end-of-line.
  const closeAt = line.indexOf(']', contentStart);
  const quoteAt = quoteBefore(line, contentStart, closeAt);
  if (quoteAt === -1) {
    return scanPlainHeaderPrefix(line, contentStart, closeAt);
  }
  return scanQuotedHeaderPrefix(line, contentStart, quoteAt);
};

/**
 * Absolute index of the first `"` in `[from, closeAt)`, or -1 when none. A quote
 * at or after the span's closing `]` is content of a later span, not this header's
 * subsection opener, so the search is bounded to the span: a chain of quote-free
 * `[a][b]...` headers never re-scans to end-of-line. With no closing `]` (an
 * unclosed span) the search runs to end-of-line — that line terminates anyway.
 */
const quoteBefore = (line: string, from: number, closeAt: number): number => {
  const limit = closeAt === -1 ? line.length : closeAt;
  for (let col = from; col < limit; col += 1) {
    if (line[col] === '"') return col;
  }
  return -1;
};

const NOT_HEADER_SCAN: HeaderPrefixScan = { parse: { kind: 'not-header' }, endOffset: 0 };

/**
 * git's unquoted section-name grammar: one or more of letter/digit/dot/dash,
 * with no whitespace, underscore, or other punctuation. Digit-first is allowed
 * for sections (unlike keys). A name outside this set makes the line not a
 * header, so it falls to the key path and refuses exactly as git does.
 */
const PLAIN_SECTION_NAME = /^[A-Za-z0-9.-]+$/;

/**
 * Plain `[section]` prefix: the section name is the exact (untrimmed) span from
 * `contentStart` (just past `[`) up to the closing `]` at absolute `closeAt`,
 * accepted only when it matches git's unquoted grammar. Interior or edge
 * whitespace (`[a ]`, `[ a]`, `[a b]`) is therefore refused, not trimmed.
 */
const scanPlainHeaderPrefix = (
  line: string,
  contentStart: number,
  closeAt: number,
): HeaderPrefixScan => {
  if (closeAt === -1) return NOT_HEADER_SCAN;
  const inner = line.slice(contentStart, closeAt);
  if (!PLAIN_SECTION_NAME.test(inner)) return NOT_HEADER_SCAN;
  return {
    parse: { kind: 'header', section: inner, subsection: undefined },
    endOffset: closeAt + 1,
  };
};

/**
 * Quoted `[section "sub"]` prefix: the closing `]` follows the closing `"`, so
 * the offset is taken from the single identity scan's quote index, not the first
 * `]` (which may be content inside the quotes). `quoteAt` is the absolute index
 * of the opening `"` in `line`; the scan works in place from `contentStart`.
 */
const scanQuotedHeaderPrefix = (
  line: string,
  contentStart: number,
  quoteAt: number,
): HeaderPrefixScan => {
  const { parse, closeQuoteAt } = parseQuotedSubsectionHeader(line, contentStart, quoteAt);
  // equivalent-mutant: every reader gates `endOffset` behind `parse.kind === 'header'` (which always carries a defined closeQuoteAt), so dropping the early return — its NaN endOffset on a malformed parse — is never observed.
  if (parse.kind !== 'header' || closeQuoteAt === undefined) return { parse, endOffset: 0 };
  return { parse, endOffset: closeQuoteAt + 2 };
};

type MutableGpg = {
  format?: 'openpgp' | 'ssh' | 'x509';
  program?: string;
  ssh?: { program?: string };
};

interface MutableParsedConfig {
  core?: MutableCore;
  user?: { name?: string; email?: string; signingKey?: string };
  remote?: Map<
    string,
    {
      url?: string;
      pushUrl?: string;
      fetch?: string[];
      promisor?: boolean;
      partialCloneFilter?: string;
    }
  >;
  remotePushDefault?: string;
  branch?: Map<string, { remote?: string; merge?: string; pushRemote?: string }>;
  submodule?: Map<string, { url?: string; active?: boolean; update?: string }>;
  merge?: Map<string, { name?: string; driver?: string; recursive?: string }>;
  diff?: Map<string, { textconv?: string; cachetextconv?: boolean }>;
  filter?: Map<string, { clean?: string; smudge?: string; process?: string; required?: boolean }>;
  extensions?: { partialClone?: string };
  commit?: { gpgSign?: boolean };
  tag?: { gpgSign?: boolean };
  push?: { gpgSign?: 'true' | 'false' | 'if-asked'; default?: PushDefaultMode };
  gpg?: MutableGpg;
}

const dispatchSubsection = (acc: MutableParsedConfig, sec: IniSection, name: string): void => {
  if (sec.section === 'remote') mergeRemote(acc, name, sec);
  else if (sec.section === 'branch') mergeBranch(acc, name, sec);
  else if (sec.section === 'submodule') mergeSubmodule(acc, name, sec);
  else if (sec.section === 'merge') mergeMergeDriver(acc, name, sec);
  else if (sec.section === 'diff') mergeDiffDriver(acc, name, sec);
  else if (sec.section === 'filter') mergeFilterDriver(acc, name, sec);
  else if (sec.section === 'gpg') mergeGpgSsh(acc, name, sec);
};

const dispatchSection = (acc: MutableParsedConfig, sec: IniSection): void => {
  if (sec.subsection !== undefined) {
    dispatchSubsection(acc, sec, sec.subsection);
  } else if (sec.section === 'remote') {
    mergeRemoteTopLevel(acc, sec);
  } else if (sec.section === 'core') {
    mergeCore(acc, sec);
  } else if (sec.section === 'user') {
    mergeUser(acc, sec);
  } else if (sec.section === 'extensions') {
    mergeExtensions(acc, sec);
  } else if (sec.section === 'commit') {
    mergeCommit(acc, sec);
  } else if (sec.section === 'tag') {
    mergeTag(acc, sec);
  } else if (sec.section === 'push') {
    mergePush(acc, sec);
  } else if (sec.section === 'gpg') {
    mergeGpg(acc, sec);
  }
};

const assembleParsed = (sections: ReadonlyArray<IniSection>): ParsedConfig => {
  const acc: MutableParsedConfig = {};
  for (const sec of sections) {
    dispatchSection(acc, sec);
  }
  return finalize(acc);
};

type MutableCore = {
  bare?: boolean;
  excludesFile?: string;
  attributesFile?: string;
  logAllRefUpdates?: boolean | 'always';
  hooksPath?: string;
  notesRef?: string;
  sparseCheckout?: boolean;
  sparseCheckoutCone?: boolean;
  looseCompression?: number;
  sshCommand?: string;
  /** Transient: true when looseCompression was set via loosecompression key (not compression).
   *  Dropped by finalizeCore. Guards order-independent precedence: loosecompression > compression. */
  looseCompressionFromLoose?: boolean;
};

/**
 * Apply core.loosecompression / core.compression with order-independent precedence.
 * loosecompression always wins; compression sets only when loosecompression was never seen.
 * valued-but-invalid int merges as absent (lenient; eager gate handles the valueless case).
 */
const applyLooseCompressionEntry = (
  core: MutableCore,
  lowered: string,
  value: string,
): MutableCore | undefined => {
  const r = parseGitInt(value);
  if (!r.ok) return undefined;
  if (lowered === 'loosecompression') {
    // loosecompression always wins — overrides any prior compression-derived value
    return { ...core, looseCompression: r.value, looseCompressionFromLoose: true };
  }
  // compression: set only if loosecompression has not already claimed the field
  if (core.looseCompressionFromLoose === true) return undefined;
  return { ...core, looseCompression: r.value };
};

/**
 * Apply one [core] entry to a mutable core accumulator. Returns the updated
 * accumulator, or `undefined` when the key is not recognised (so the caller
 * can avoid promoting `acc.core` from `undefined` to `{}` on irrelevant keys).
 */
const applyCoreEntry = (
  core: MutableCore,
  lowered: string,
  value: string | null,
): MutableCore | undefined => {
  if (lowered === 'bare') return { ...core, bare: parseGitBoolean(value) };
  if (lowered === 'logallrefupdates')
    return { ...core, logAllRefUpdates: parseLogAllRefUpdates(value) };
  if (lowered === 'sparsecheckout') return { ...core, sparseCheckout: parseGitBoolean(value) };
  if (lowered === 'sparsecheckoutcone')
    return { ...core, sparseCheckoutCone: parseGitBoolean(value) };
  // String-typed and int-typed fields skip null (valueless key treated as absent).
  if (value === null) return undefined;
  if (lowered === 'excludesfile') return { ...core, excludesFile: value };
  if (lowered === 'attributesfile') return { ...core, attributesFile: value };
  if (lowered === 'hookspath') return { ...core, hooksPath: value };
  if (lowered === 'notesref') return { ...core, notesRef: value };
  if (lowered === 'sshcommand') return { ...core, sshCommand: value };
  if (lowered === 'loosecompression' || lowered === 'compression') {
    return applyLooseCompressionEntry(core, lowered, value);
  }
  return undefined;
};

const mergeCore = (acc: { core?: MutableCore }, sec: IniSection): void => {
  for (const { key, value } of sec.entries) {
    // Git config keys are case-insensitive; the parser preserves casing,
    // so we lowercase here for comparison.
    // `{ ...undefined }` is `{}`, so the spread alone handles the first write.
    const updated = applyCoreEntry(acc.core ?? {}, key.toLowerCase(), value);
    if (updated !== undefined) acc.core = updated;
  }
};

// The literal `always` is a third state beyond git's boolean values; a null
// value (valueless key) is boolean-true. Anything else falls through to the
// standard boolean parse.
const parseLogAllRefUpdates = (value: string | null): boolean | 'always' =>
  value !== null && value.toLowerCase() === 'always' ? 'always' : parseGitBoolean(value);

const mergeUser = (
  acc: { user?: { name?: string; email?: string; signingKey?: string } },
  sec: IniSection,
): void => {
  for (const { key, value } of sec.entries) {
    // String-typed fields skip null (valueless key treated as absent).
    if (value === null) continue;
    if (key === 'name') {
      // `{ ...undefined }` is `{}`, so the spread alone handles the first write.
      acc.user = { ...acc.user, name: value };
    } else if (key === 'email') {
      acc.user = { ...acc.user, email: value };
    } else if (key.toLowerCase() === 'signingkey') {
      acc.user = { ...acc.user, signingKey: value };
    }
  }
};

interface MutableRemote {
  url?: string;
  pushUrl?: string;
  fetch?: string[];
  promisor?: boolean;
  partialCloneFilter?: string;
}

const applyRemoteEntry = (acc: MutableRemote, key: string, value: string | null): void => {
  // Git config keys are case-insensitive — compare on the lower-cased key.
  const lowered = key.toLowerCase();
  if (lowered === 'url') {
    // String-typed fields skip null (valueless key treated as absent).
    if (value !== null) acc.url = value;
  } else if (lowered === 'pushurl') {
    if (value !== null) acc.pushUrl = value;
  } else if (lowered === 'fetch') {
    if (value !== null) {
      acc.fetch ??= [];
      acc.fetch.push(value);
    }
  } else if (lowered === 'promisor') {
    acc.promisor = parseGitBoolean(value);
  } else if (lowered === 'partialclonefilter') {
    if (value !== null) acc.partialCloneFilter = value;
  }
};

const compactRemote = (mutable: MutableRemote): MutableRemote => {
  const merged: MutableRemote = {};
  if (mutable.url !== undefined) merged.url = mutable.url;
  if (mutable.pushUrl !== undefined) merged.pushUrl = mutable.pushUrl;
  if (mutable.fetch !== undefined && mutable.fetch.length > 0) merged.fetch = mutable.fetch;
  if (mutable.promisor !== undefined) merged.promisor = mutable.promisor;
  if (mutable.partialCloneFilter !== undefined) {
    merged.partialCloneFilter = mutable.partialCloneFilter;
  }
  return merged;
};

const mergeRemote = (
  acc: { remote?: Map<string, MutableRemote> },
  name: string,
  sec: IniSection,
): void => {
  acc.remote ??= new Map();
  const current = acc.remote.get(name) ?? {};
  const mutable: MutableRemote = { ...current, fetch: current.fetch ? [...current.fetch] : [] };
  for (const { key, value } of sec.entries) applyRemoteEntry(mutable, key, value);
  acc.remote.set(name, compactRemote(mutable));
};

// `[remote]` (no subsection) — distinct from `[remote "<name>"]`. Only `pushDefault` lives here;
// per-remote `pushDefault` is not read (pinned: `[remote "x"] pushDefault` is ignored by git).
const mergeRemoteTopLevel = (acc: { remotePushDefault?: string }, sec: IniSection): void => {
  for (const { key, value } of sec.entries) {
    if (value !== null && key.toLowerCase() === 'pushdefault') acc.remotePushDefault = value;
  }
};

const mergeBranch = (
  acc: { branch?: Map<string, { remote?: string; merge?: string; pushRemote?: string }> },
  name: string,
  sec: IniSection,
): void => {
  acc.branch ??= new Map();
  const current = acc.branch.get(name) ?? {};
  const next: { remote?: string; merge?: string; pushRemote?: string } = { ...current };
  for (const { key, value } of sec.entries) {
    // String-typed fields skip null (valueless key treated as absent).
    if (value === null) continue;
    if (key === 'remote') next.remote = value;
    else if (key === 'merge') next.merge = value;
    // Git config keys are case-insensitive; compare pushRemote on the lower-cased key.
    else if (key.toLowerCase() === 'pushremote') next.pushRemote = value;
  }
  acc.branch.set(name, next);
};

const mergeSubmodule = (
  acc: { submodule?: Map<string, { url?: string; active?: boolean; update?: string }> },
  name: string,
  sec: IniSection,
): void => {
  acc.submodule ??= new Map();
  const next: { url?: string; active?: boolean; update?: string } = {
    ...(acc.submodule.get(name) ?? {}),
  };
  for (const { key, value } of sec.entries) {
    const lowered = key.toLowerCase();
    if (lowered === 'url') {
      // String-typed fields skip null (valueless key treated as absent).
      if (value !== null) next.url = value;
    } else if (lowered === 'active') {
      next.active = parseGitBoolean(value);
    } else if (lowered === 'update') {
      if (value !== null) next.update = value;
    }
  }
  acc.submodule.set(name, next);
};

const mergeMergeDriver = (
  acc: { merge?: Map<string, { name?: string; driver?: string; recursive?: string }> },
  name: string,
  sec: IniSection,
): void => {
  acc.merge ??= new Map();
  const next: { name?: string; driver?: string; recursive?: string } = {
    ...(acc.merge.get(name) ?? {}),
  };
  for (const { key, value } of sec.entries) {
    // String-typed fields skip null (valueless key treated as absent).
    if (value === null) continue;
    const lowered = key.toLowerCase();
    if (lowered === 'name') next.name = value;
    else if (lowered === 'driver') next.driver = value;
    else if (lowered === 'recursive') next.recursive = value;
  }
  acc.merge.set(name, next);
};

const mergeDiffDriver = (
  acc: { diff?: Map<string, { textconv?: string; cachetextconv?: boolean }> },
  name: string,
  sec: IniSection,
): void => {
  acc.diff ??= new Map();
  const next: { textconv?: string; cachetextconv?: boolean } = {
    ...(acc.diff.get(name) ?? {}),
  };
  for (const { key, value } of sec.entries) {
    const lowered = key.toLowerCase();
    if (lowered === 'textconv') {
      // String-typed field: skip null (valueless key treated as absent).
      if (value === null) continue;
      next.textconv = value;
    } else if (lowered === 'cachetextconv') {
      next.cachetextconv = parseGitBoolean(value);
    }
  }
  acc.diff.set(name, next);
};

type FilterEntry = { clean?: string; smudge?: string; process?: string; required?: boolean };

const applyFilterEntry = (next: FilterEntry, key: string, value: string | null): void => {
  const lowered = key.toLowerCase();
  if (lowered === 'required') {
    next.required = parseGitBoolean(value);
    return;
  }
  // String-typed fields skip null (valueless key treated as absent).
  if (value === null) return;
  if (lowered === 'clean') next.clean = value;
  else if (lowered === 'smudge') next.smudge = value;
  else if (lowered === 'process') next.process = value;
};

const mergeFilterDriver = (
  acc: { filter?: Map<string, FilterEntry> },
  name: string,
  sec: IniSection,
): void => {
  acc.filter ??= new Map();
  const next: FilterEntry = { ...(acc.filter.get(name) ?? {}) };
  for (const { key, value } of sec.entries) {
    applyFilterEntry(next, key, value);
  }
  acc.filter.set(name, next);
};

const mergeExtensions = (
  acc: { extensions?: { partialClone?: string } },
  sec: IniSection,
): void => {
  for (const { key, value } of sec.entries) {
    // `partialClone` names the promisor remote of a partial clone.
    // String-typed field: skip null (valueless key treated as absent).
    if (key.toLowerCase() === 'partialclone' && value !== null) {
      acc.extensions = { ...acc.extensions, partialClone: value };
    }
  }
};

const mergeCommit = (acc: { commit?: { gpgSign?: boolean } }, sec: IniSection): void => {
  for (const { key, value } of sec.entries) {
    if (key.toLowerCase() === 'gpgsign') {
      acc.commit = { ...acc.commit, gpgSign: parseGitBoolean(value) };
    }
  }
};

const mergeTag = (acc: { tag?: { gpgSign?: boolean } }, sec: IniSection): void => {
  for (const { key, value } of sec.entries) {
    if (key.toLowerCase() === 'gpgsign') {
      acc.tag = { ...acc.tag, gpgSign: parseGitBoolean(value) };
    }
  }
};

const parsePushGpgSign = (value: string | null): 'true' | 'false' | 'if-asked' =>
  value !== null && value.toLowerCase() === 'if-asked'
    ? 'if-asked'
    : parseGitBoolean(value)
      ? 'true'
      : 'false';

// Lenient here: an unrecognized value (including wrong case) parses to `undefined` rather than
// throwing — the hard refusal on an invalid `push.default` is a push-time concern, not the parser's.
const parsePushDefault = (value: string | null): PushDefaultMode | undefined => {
  if (value === 'tracking') return 'upstream'; // deprecated alias
  if (
    value === 'nothing' ||
    value === 'current' ||
    value === 'upstream' ||
    value === 'simple' ||
    value === 'matching'
  ) {
    return value;
  }
  return undefined;
};

const mergePush = (
  acc: { push?: { gpgSign?: 'true' | 'false' | 'if-asked'; default?: PushDefaultMode } },
  sec: IniSection,
): void => {
  for (const { key, value } of sec.entries) {
    if (key.toLowerCase() === 'gpgsign') {
      acc.push = { ...acc.push, gpgSign: parsePushGpgSign(value) };
    } else if (key.toLowerCase() === 'default') {
      const mode = parsePushDefault(value);
      if (mode !== undefined) acc.push = { ...acc.push, default: mode };
    }
  }
};

const isGpgFormat = (value: string): value is 'openpgp' | 'ssh' | 'x509' =>
  value === 'openpgp' || value === 'ssh' || value === 'x509';

const mergeGpg = (acc: { gpg?: MutableGpg }, sec: IniSection): void => {
  for (const { key, value } of sec.entries) {
    if (value === null) continue;
    const lowered = key.toLowerCase();
    if (lowered === 'format' && isGpgFormat(value)) {
      acc.gpg = { ...acc.gpg, format: value };
    } else if (lowered === 'program') {
      acc.gpg = { ...acc.gpg, program: value };
    }
  }
};

// `[gpg "ssh"]` is the only recognised `gpg.*` subsection; any other
// subsection name (not a real git config surface today) is a silent no-op.
const mergeGpgSsh = (acc: { gpg?: MutableGpg }, name: string, sec: IniSection): void => {
  if (name !== 'ssh') return;
  for (const { key, value } of sec.entries) {
    if (key.toLowerCase() === 'program' && value !== null) {
      acc.gpg = { ...acc.gpg, ssh: { ...acc.gpg?.ssh, program: value } };
    }
  }
};

/**
 * Finalize the `[core]` section: emit only the keys that were set, or
 * `undefined` when the section was never populated. `mergeCore` is the sole
 * writer of `acc.core` and always writes a defined value, so a defined `core`
 * always yields a non-empty object.
 */
const finalizeCore = (core: MutableCore | undefined): ParsedConfig['core'] => {
  if (core === undefined) return undefined;
  // looseCompressionFromLoose is transient (precedence flag) — not projected to ParsedConfig
  return {
    ...(core.bare !== undefined ? { bare: core.bare } : {}),
    ...(core.excludesFile !== undefined ? { excludesFile: core.excludesFile } : {}),
    ...(core.attributesFile !== undefined ? { attributesFile: core.attributesFile } : {}),
    ...(core.logAllRefUpdates !== undefined ? { logAllRefUpdates: core.logAllRefUpdates } : {}),
    ...(core.hooksPath !== undefined ? { hooksPath: core.hooksPath } : {}),
    ...(core.notesRef !== undefined ? { notesRef: core.notesRef } : {}),
    ...(core.sparseCheckout !== undefined ? { sparseCheckout: core.sparseCheckout } : {}),
    ...(core.sparseCheckoutCone !== undefined
      ? { sparseCheckoutCone: core.sparseCheckoutCone }
      : {}),
    ...(core.looseCompression !== undefined ? { looseCompression: core.looseCompression } : {}),
    ...(core.sshCommand !== undefined ? { sshCommand: core.sshCommand } : {}),
  };
};

type FinalizeOut = {
  diff?: ReadonlyMap<string, { textconv?: string; cachetextconv?: boolean }>;
  filter?: ReadonlyMap<string, FilterEntry>;
  commit?: { gpgSign?: boolean };
  tag?: { gpgSign?: boolean };
  push?: { gpgSign?: 'true' | 'false' | 'if-asked'; default?: PushDefaultMode };
  gpg?: MutableGpg;
};

// Extracted to keep `finalize` under the cognitive-complexity ceiling.
const finalizeDriverMaps = (acc: MutableParsedConfig, out: FinalizeOut): void => {
  // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — `acc.diff` is only ever assigned after a `Map.set`, so when defined its size is always >= 1; `> 0`, `>= 0` and a constant `true` never differ.
  if (acc.diff !== undefined && acc.diff.size > 0) out.diff = acc.diff;
  // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — `acc.filter` is only ever assigned after a `Map.set`, so when defined its size is always >= 1; `> 0`, `>= 0` and a constant `true` never differ.
  if (acc.filter !== undefined && acc.filter.size > 0) out.filter = acc.filter;
};

/**
 * Finalize `[user]`: emit only when an identity (both name+email) or a
 * signingKey was set. A signingKey-only user does NOT count as an identity —
 * author/committer resolution still requires both name and email.
 */
const finalizeUser = (
  user: { name?: string; email?: string; signingKey?: string } | undefined,
): ParsedConfig['user'] => {
  if (user === undefined) return undefined;
  const hasIdentity = user.name !== undefined && user.email !== undefined;
  if (!hasIdentity && user.signingKey === undefined) return undefined;
  return {
    ...(user.name !== undefined ? { name: user.name } : {}),
    ...(user.email !== undefined ? { email: user.email } : {}),
    ...(user.signingKey !== undefined ? { signingKey: user.signingKey } : {}),
  };
};

// `mergeCommit`/`mergeTag`/`mergePush`/`mergeGpg`/`mergeGpgSsh` only assign
// their bucket after observing a recognised key, so a defined value is
// always non-empty (same invariant as `extensions`). Extracted to keep
// `finalize` under the cognitive-complexity ceiling.
const finalizeSigningBuckets = (acc: MutableParsedConfig, out: FinalizeOut): void => {
  if (acc.commit !== undefined) out.commit = acc.commit;
  if (acc.tag !== undefined) out.tag = acc.tag;
  if (acc.push !== undefined) out.push = acc.push;
  if (acc.gpg !== undefined) out.gpg = acc.gpg;
};

const finalize = (acc: MutableParsedConfig): ParsedConfig => {
  const out: {
    core?: {
      bare?: boolean;
      excludesFile?: string;
      attributesFile?: string;
      logAllRefUpdates?: boolean | 'always';
      hooksPath?: string;
      sparseCheckout?: boolean;
      sparseCheckoutCone?: boolean;
      looseCompression?: number;
    };
    user?: { name?: string; email?: string; signingKey?: string };
    remote?: ReadonlyMap<
      string,
      {
        url?: string;
        pushUrl?: string;
        fetch?: ReadonlyArray<string>;
        promisor?: boolean;
        partialCloneFilter?: string;
      }
    >;
    remotePushDefault?: string;
    branch?: ReadonlyMap<string, { remote?: string; merge?: string; pushRemote?: string }>;
    submodule?: ReadonlyMap<string, { url?: string; active?: boolean; update?: string }>;
    merge?: ReadonlyMap<string, { name?: string; driver?: string; recursive?: string }>;
    diff?: ReadonlyMap<string, { textconv?: string; cachetextconv?: boolean }>;
    filter?: ReadonlyMap<
      string,
      { clean?: string; smudge?: string; process?: string; required?: boolean }
    >;
    extensions?: { partialClone?: string };
    commit?: { gpgSign?: boolean };
    tag?: { gpgSign?: boolean };
    push?: { gpgSign?: 'true' | 'false' | 'if-asked'; default?: PushDefaultMode };
    gpg?: MutableGpg;
  } = {};
  const core = finalizeCore(acc.core);
  if (core !== undefined) out.core = core;
  const user = finalizeUser(acc.user);
  if (user !== undefined) out.user = user;
  // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — `acc.remote` is only ever assigned after a `Map.set`, so when defined its size is always >= 1; `> 0`, `>= 0` and a constant `true` never differ.
  if (acc.remote !== undefined && acc.remote.size > 0) out.remote = acc.remote;
  if (acc.remotePushDefault !== undefined) out.remotePushDefault = acc.remotePushDefault;
  // `mergeExtensions` only assigns `acc.extensions` after observing a
  // `partialclone` key, so a defined value is always non-empty.
  if (acc.extensions !== undefined) out.extensions = acc.extensions;
  // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — `acc.branch` is only ever assigned after a `Map.set`, so when defined its size is always >= 1; `> 0`, `>= 0` and a constant `true` never differ.
  if (acc.branch !== undefined && acc.branch.size > 0) out.branch = acc.branch;
  // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — `acc.submodule` is only ever assigned after a `Map.set`, so when defined its size is always >= 1; `> 0`, `>= 0` and a constant `true` never differ.
  if (acc.submodule !== undefined && acc.submodule.size > 0) out.submodule = acc.submodule;
  // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — `acc.merge` is only ever assigned after a `Map.set`, so when defined its size is always >= 1; `> 0`, `>= 0` and a constant `true` never differ.
  if (acc.merge !== undefined && acc.merge.size > 0) out.merge = acc.merge;
  finalizeDriverMaps(acc, out);
  finalizeSigningBuckets(acc, out);
  return out;
};

const TRUE_VALUES = new Set(['true', 'yes', 'on', '1']);

// Anything not a recognized truthy value is false: explicit false aliases
// (false/no/off/0/'') and unparseable values both fall through to `false`
// (lenient, like git itself). A `null` value (valueless key, git's internal
// NULL) maps to `true` — `git_config_bool(NULL) == 1`.
const parseGitBoolean = (value: string | null): boolean =>
  value === null || TRUE_VALUES.has(value.toLowerCase());

type GitIntResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reason: 'invalid unit' | 'out of range' };

// git config --type=int uses strtoimax (int64_t on all modern platforms).
// Pinned against git 2.54.0: values outside this range yield "out of range".
const GIT_INT_MAX = BigInt('9223372036854775807');
const GIT_INT_MIN = BigInt('-9223372036854775808');

// Unit multipliers accepted by git_parse_signed (k/K/m/M/g/G = ×1024^n).
// t/T are NOT accepted by git 2.54.0 (pinned empirically).
const UNIT_SCALE: ReadonlyMap<string, bigint> = new Map([
  ['k', BigInt(1024)],
  ['K', BigInt(1024)],
  ['m', BigInt(1024) * BigInt(1024)],
  ['M', BigInt(1024) * BigInt(1024)],
  ['g', BigInt(1024) * BigInt(1024) * BigInt(1024)],
  ['G', BigInt(1024) * BigInt(1024) * BigInt(1024)],
]);

// No in-range git integer needs this many significant digits (octal int64 max is 22
// digits). A longer significant run is always out of range — and capping it before
// BigInt bounds the parse work, so a hostile config value cannot stall the parser.
const MAX_SIGNIFICANT_DIGITS = 32;

// Classify the digit run at the start of `body` (sign already stripped) the way
// strtoimax base-0 does: `0x`/`0X` → hex, a leading `0` → octal (greedy over 0-7,
// stopping at the first non-octal digit), otherwise decimal. Returns the consumed
// token and its radix, or null when no digit run starts here.
const matchDigits = (
  body: string,
): { readonly token: string; readonly radix: 8 | 10 | 16 } | null => {
  // equivalent-mutant: dropping the `^` anchor cannot change the verdict — a `0x`/digit run
  // found past position 0 leaves the preceding chars as the unit suffix, which is never a valid
  // unit, so the result is `invalid unit` either way (exhaustively checked over all len-≤4 inputs).
  const hex = /^0[xX][0-9a-fA-F]+/.exec(body);
  if (hex !== null) return { token: hex[0], radix: 16 };
  if (body[0] === '0') return { token: (/^0[0-7]*/.exec(body) as RegExpExecArray)[0], radix: 8 };
  const dec = /^[0-9]+/.exec(body);
  return dec === null ? null : { token: dec[0], radix: 10 };
};

// Convert a classified digit token to its magnitude, or null when it has more than
// MAX_SIGNIFICANT_DIGITS significant digits (always out of range). Leading zeros are
// stripped first, so a long all-zeros run is the value 0, not an out-of-range reject.
const magnitudeOf = (token: string, radix: 8 | 10 | 16): bigint | null => {
  // Strip the radix marker (`0x` = 2 chars, octal `0` = 1 char, decimal = none),
  // then the leading zeros, leaving the significant digits.
  // equivalent-mutant: for the octal branch, replacing `token.slice(1)` with `token` (or dropping
  // the `radix === 8` arm so it falls through to `token`) keeps the leading marker `0`, which the
  // next line's `replace(/^0+/, '')` strips anyway — `significant` is identical.
  const bare = radix === 16 ? token.slice(2) : radix === 8 ? token.slice(1) : token;
  const significant = bare.replace(/^0+/, '');
  // equivalent-mutant: a significant run of ≥32 digits (any radix ≤16) always exceeds int64, so the
  // final range check returns `out of range` regardless of this early cap — dropping the guard or
  // shifting `>` to `>=` leaves the verdict unchanged (the cap only bounds BigInt work, not output).
  if (significant.length > MAX_SIGNIFICANT_DIGITS) return null;
  if (significant === '') return BigInt(0);
  const prefix = radix === 16 ? '0x' : radix === 8 ? '0o' : '';
  return BigInt(`${prefix}${significant}`);
};

// Total pure function: mirrors git's strtoimax base-0 grammar (decimal, `0x` hex,
// leading-`0` octal, sign, single k/m/g unit ×1024^n). Returns ok+value on success,
// or not-ok+reason on failure — never throws.
export const parseGitInt = (value: string | null): GitIntResult => {
  // Trim leading ASCII whitespace (git's behaviour), then strip one optional sign.
  const trimmed = (value ?? '').replace(/^[ \t]+/, '');
  const signed = trimmed[0] === '+' || trimmed[0] === '-';
  const body = signed ? trimmed.slice(1) : trimmed;

  const digits = matchDigits(body);
  if (digits === null) return { ok: false, reason: 'invalid unit' };

  const unit = body.slice(digits.token.length);
  const multiplier = unit === '' ? BigInt(1) : UNIT_SCALE.get(unit);
  if (multiplier === undefined) return { ok: false, reason: 'invalid unit' };

  const magnitude = magnitudeOf(digits.token, digits.radix);
  if (magnitude === null) return { ok: false, reason: 'out of range' };

  const result = (trimmed[0] === '-' ? -magnitude : magnitude) * multiplier;
  if (result < GIT_INT_MIN || result > GIT_INT_MAX) return { ok: false, reason: 'out of range' };
  return { ok: true, value: Number(result) };
};
