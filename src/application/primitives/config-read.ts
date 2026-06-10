import { configParseError } from '../../domain/commands/error.js';
import { TsgitError } from '../../domain/error.js';
import type { Context } from '../../ports/context.js';
import { commonGitDir } from './path-layout.js';

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
    readonly sparseCheckout?: boolean;
    readonly sparseCheckoutCone?: boolean;
  };
  readonly user?: { readonly name: string; readonly email: string };
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
  readonly branch?: ReadonlyMap<string, { readonly remote?: string; readonly merge?: string }>;
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
  /** `[extensions]` — `partialClone` names the promisor remote of a partial clone. */
  readonly extensions?: { readonly partialClone?: string };
}

// Cache reference is mutable so test code can swap in a fresh WeakMap and
// guarantee isolation between cases that re-use the same Context identity
// (the WeakMap itself can't be iterated, so a true reset requires replacement).
let cache: WeakMap<Context, Promise<ParsedConfig>> = new WeakMap();

/**
 * Read and cache `${gitDir}/config`. Missing → empty config (not an error).
 *
 * The cache is keyed on `Context` identity; a new context (e.g., after a write
 * that re-creates the repo) gets a fresh read. Concurrent calls share the same
 * in-flight promise (per-context single-flight).
 */
export const readConfig = (ctx: Context): Promise<ParsedConfig> => {
  const existing = cache.get(ctx);
  if (existing !== undefined) return existing;
  const pending = loadConfig(ctx);
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

const loadConfig = async (ctx: Context): Promise<ParsedConfig> => {
  const path = `${commonGitDir(ctx)}/config`;
  const raw = await readRawConfig(ctx, path);
  if (raw === undefined) return {};
  return parseConfigText(raw, path);
};

const readRawConfig = async (ctx: Context, path: string): Promise<string | undefined> => {
  try {
    return await ctx.fs.readUtf8(path);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return undefined;
    throw err;
  }
};

/**
 * One `[section "subsection"]` block of a git-config-format INI file: the
 * section name, an optional quoted subsection, and its key/value entries.
 * Exported so `.gitmodules` parsing — byte-identical grammar — reuses one
 * tokenizer (ADR-086).
 */
export interface IniSection {
  readonly section: string;
  readonly subsection: string | undefined;
  readonly entries: ReadonlyArray<{ readonly key: string; readonly value: string }>;
}

/** Internal builder shape — `entries` stays mutable while a section is collected. */
interface SectionBuilder {
  readonly section: string;
  readonly subsection: string | undefined;
  readonly entries: Array<{ readonly key: string; readonly value: string }>;
}

const parseConfigText = (text: string, source: string): ParsedConfig => {
  const sections = parseIniSections(text, source);
  return assembleParsed(sections);
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
 */
export const parseIniSections = (text: string, source?: string): ReadonlyArray<IniSection> => {
  const sections: SectionBuilder[] = [];
  const lines = text.split('\n');
  let current: SectionBuilder | undefined;
  let lineIdx = 0;
  while (lineIdx < lines.length) {
    const line = lines[lineIdx] as string;
    const trimmed = stripInlineComment(line).trim();
    // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent — an empty `trimmed` matches neither a section header nor a key/value (no `=`), so skipping it explicitly or falling through produces the same sections.
    if (trimmed === '') {
      lineIdx += 1;
      continue;
    }
    const header = parseSectionHeader(trimmed);
    if (header.kind === 'header') {
      current = { section: header.section, subsection: header.subsection, entries: [] };
      sections.push(current);
      lineIdx += 1;
      continue;
    }
    if (header.kind === 'malformed') {
      throw configParseError(lineIdx + 1, source, header.partialName);
    }
    const eqAt = effectiveEqualsIndex(line);
    if (eqAt === -1) {
      lineIdx += 1;
      continue;
    }
    const key = line.slice(0, eqAt).trim();
    const parsed = parseConfigValue(lines, lineIdx, eqAt + 1, source);
    if (current !== undefined && key !== '') {
      current.entries.push({ key, value: parsed.value });
    }
    lineIdx = parsed.nextLineIdx;
  }
  return sections;
};

/**
 * Index of the `=` that introduces a value, or `-1` when the line carries no
 * key/value: no `=` at all, or an unquoted comment starts before the `=`
 * (the comment swallows it, e.g. `ab#cd = x`).
 */
const effectiveEqualsIndex = (line: string): number => {
  const eqAt = line.indexOf('=');
  if (eqAt === -1) return -1;
  const hashAt = indexOfUnquoted(line, '#');
  const semiAt = indexOfUnquoted(line, ';');
  const cuts = [hashAt, semiAt].filter((n) => n >= 0);
  // equivalent-mutant: `<=` is observably equivalent — a cut index holds `#`
  // or `;` while `eqAt` holds `=`, so the two indices can never be equal.
  if (cuts.length > 0 && Math.min(...cuts) < eqAt) return -1;
  return eqAt;
};

/** Escape sequences git's value grammar accepts; anything else is a parse error. */
const VALUE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['n', '\n'],
  ['t', '\t'],
  ['b', '\b'],
  ['\\', '\\'],
  ['"', '"'],
]);

/** git sane-ctype `GIT_SPACE` minus LF (the line terminator): VT/FF are NOT whitespace. */
const VALUE_SPACE: ReadonlySet<string> = new Set([' ', '\t', '\r']);

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
  if (!state.inQuotes && VALUE_SPACE.has(c)) {
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

/** GIT_SPACE chars that may precede an opening subsection quote. */
const GIT_SPACE: ReadonlySet<string> = new Set([' ', '\t', '\r']);

/**
 * Parse a trimmed `[section]` / `[section "subsection"]` header line.
 * Returns a three-state discriminated union: `header` on success, `malformed`
 * when the `[…]` shape is present but the quoted-subsection grammar is
 * violated (git refuses the file), or `not-header` when the line is not
 * `[…]`-shaped at all (lenient skip, like git for unquoted malformations).
 *
 * For quoted subsections the scan is performed over `line.slice(1)` (everything
 * after the opening `[`) so that unclosed spans accumulate raw trailing chars
 * including any `]` that would otherwise be treated as the header terminator —
 * matching git's partial-name diagnostic.
 */
export const parseSectionHeader = (line: string): SectionHeaderParse => {
  if (!line.startsWith('[')) return { kind: 'not-header' };
  const afterOpen = line.slice(1);
  const quoteAt = afterOpen.indexOf('"');
  if (quoteAt === -1) {
    if (!line.endsWith(']')) return { kind: 'not-header' };
    const inner = afterOpen.slice(0, -1).trim();
    // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent — an empty `inner` yields a section named '' which assembleParsed never matches, so rejecting it or returning a '' section produces the same parsed config.
    if (inner === '') return { kind: 'not-header' };
    return { kind: 'header', section: inner, subsection: undefined };
  }
  return parseQuotedSubsectionHeader(afterOpen, quoteAt);
};

/** Handle the quoted-subsection branch of `parseSectionHeader`. */
const parseQuotedSubsectionHeader = (afterOpen: string, quoteAt: number): SectionHeaderParse => {
  const sectionPart = afterOpen.slice(0, quoteAt).trim().toLowerCase();
  const charBeforeQuote = quoteAt > 0 ? afterOpen[quoteAt - 1] : undefined;
  if (charBeforeQuote === undefined || !GIT_SPACE.has(charBeforeQuote)) {
    return { kind: 'malformed', partialName: sectionPart };
  }
  const section = afterOpen.slice(0, quoteAt).trim();
  return scanQuotedSpan(afterOpen, quoteAt, section, sectionPart);
};

/**
 * Scan the quoted subsection span starting at `openAt` (the index of `"`).
 * On success, the closing `"` must be immediately followed by `]` (end of
 * `afterOpen`). Otherwise produces a `malformed` result with the partial name.
 */
const scanQuotedSpan = (
  afterOpen: string,
  openAt: number,
  section: string,
  sectionPart: string,
): SectionHeaderParse => {
  let subsection = '';
  let i = openAt + 1;
  while (i < afterOpen.length) {
    const c = afterOpen[i] as string;
    if (c === '\\') {
      if (i + 1 >= afterOpen.length) {
        return { kind: 'malformed', partialName: `${sectionPart}.${subsection}` };
      }
      subsection += afterOpen[i + 1] as string;
      i += 2;
      continue;
    }
    if (c === '"') {
      const rest = afterOpen.slice(i + 1);
      if (rest === ']') return { kind: 'header', section, subsection };
      return { kind: 'malformed', partialName: `${sectionPart}.${subsection}` };
    }
    subsection += c;
    i += 1;
  }
  return { kind: 'malformed', partialName: `${sectionPart}.${subsection}` };
};

interface MutableParsedConfig {
  core?: {
    bare?: boolean;
    excludesFile?: string;
    attributesFile?: string;
    logAllRefUpdates?: boolean | 'always';
    hooksPath?: string;
    sparseCheckout?: boolean;
    sparseCheckoutCone?: boolean;
  };
  user?: { name?: string; email?: string };
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
  branch?: Map<string, { remote?: string; merge?: string }>;
  submodule?: Map<string, { url?: string; active?: boolean; update?: string }>;
  merge?: Map<string, { name?: string; driver?: string; recursive?: string }>;
  extensions?: { partialClone?: string };
}

const dispatchSection = (acc: MutableParsedConfig, sec: IniSection): void => {
  if (sec.section === 'core' && sec.subsection === undefined) {
    mergeCore(acc, sec);
  } else if (sec.section === 'user' && sec.subsection === undefined) {
    mergeUser(acc, sec);
  } else if (sec.section === 'remote' && sec.subsection !== undefined) {
    mergeRemote(acc, sec.subsection, sec);
  } else if (sec.section === 'branch' && sec.subsection !== undefined) {
    mergeBranch(acc, sec.subsection, sec);
  } else if (sec.section === 'submodule' && sec.subsection !== undefined) {
    mergeSubmodule(acc, sec.subsection, sec);
  } else if (sec.section === 'merge' && sec.subsection !== undefined) {
    mergeMergeDriver(acc, sec.subsection, sec);
  } else if (sec.section === 'extensions' && sec.subsection === undefined) {
    mergeExtensions(acc, sec);
  }
};

const assembleParsed = (sections: ReadonlyArray<IniSection>): ParsedConfig => {
  const acc: MutableParsedConfig = {};
  for (const sec of sections) {
    dispatchSection(acc, sec);
  }
  return finalize(acc);
};

const mergeCore = (
  acc: {
    core?: {
      bare?: boolean;
      excludesFile?: string;
      attributesFile?: string;
      logAllRefUpdates?: boolean | 'always';
      hooksPath?: string;
      sparseCheckout?: boolean;
      sparseCheckoutCone?: boolean;
    };
  },
  sec: IniSection,
): void => {
  for (const { key, value } of sec.entries) {
    // Git config keys are case-insensitive; the parser preserves casing,
    // so we lowercase here for comparison.
    const lowered = key.toLowerCase();
    if (lowered === 'bare') {
      // `{ ...undefined }` is `{}`, so the spread alone handles the first write.
      acc.core = { ...acc.core, bare: parseGitBoolean(value) };
    } else if (lowered === 'excludesfile') {
      acc.core = { ...acc.core, excludesFile: value };
    } else if (lowered === 'attributesfile') {
      acc.core = { ...acc.core, attributesFile: value };
    } else if (lowered === 'logallrefupdates') {
      acc.core = { ...acc.core, logAllRefUpdates: parseLogAllRefUpdates(value) };
    } else if (lowered === 'hookspath') {
      acc.core = { ...acc.core, hooksPath: value };
    } else if (lowered === 'sparsecheckout') {
      acc.core = { ...acc.core, sparseCheckout: parseGitBoolean(value) };
    } else if (lowered === 'sparsecheckoutcone') {
      acc.core = { ...acc.core, sparseCheckoutCone: parseGitBoolean(value) };
    }
  }
};

// The literal `always` is a third state beyond git's boolean values; anything
// else falls through to the standard boolean parse.
const parseLogAllRefUpdates = (value: string): boolean | 'always' =>
  value.toLowerCase() === 'always' ? 'always' : parseGitBoolean(value);

const mergeUser = (acc: { user?: { name?: string; email?: string } }, sec: IniSection): void => {
  for (const { key, value } of sec.entries) {
    if (key === 'name') {
      // `{ ...undefined }` is `{}`, so the spread alone handles the first write.
      acc.user = { ...acc.user, name: value };
    } else if (key === 'email') {
      acc.user = { ...acc.user, email: value };
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

const applyRemoteEntry = (acc: MutableRemote, key: string, value: string): void => {
  // Git config keys are case-insensitive — compare on the lower-cased key.
  const lowered = key.toLowerCase();
  if (lowered === 'url') acc.url = value;
  else if (lowered === 'pushurl') acc.pushUrl = value;
  else if (lowered === 'fetch') {
    acc.fetch ??= [];
    acc.fetch.push(value);
  } else if (lowered === 'promisor') acc.promisor = parseGitBoolean(value);
  else if (lowered === 'partialclonefilter') acc.partialCloneFilter = value;
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

const mergeBranch = (
  acc: { branch?: Map<string, { remote?: string; merge?: string }> },
  name: string,
  sec: IniSection,
): void => {
  acc.branch ??= new Map();
  const current = acc.branch.get(name) ?? {};
  const next: { remote?: string; merge?: string } = { ...current };
  for (const { key, value } of sec.entries) {
    if (key === 'remote') next.remote = value;
    else if (key === 'merge') next.merge = value;
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
    if (lowered === 'url') next.url = value;
    else if (lowered === 'active') next.active = parseGitBoolean(value);
    else if (lowered === 'update') next.update = value;
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
    const lowered = key.toLowerCase();
    if (lowered === 'name') next.name = value;
    else if (lowered === 'driver') next.driver = value;
    else if (lowered === 'recursive') next.recursive = value;
  }
  acc.merge.set(name, next);
};

const mergeExtensions = (
  acc: { extensions?: { partialClone?: string } },
  sec: IniSection,
): void => {
  for (const { key, value } of sec.entries) {
    // `partialClone` names the promisor remote of a partial clone.
    if (key.toLowerCase() === 'partialclone') {
      acc.extensions = { ...acc.extensions, partialClone: value };
    }
  }
};

/**
 * Finalize the `[core]` section: emit only the keys that were set, or
 * `undefined` when the section was never populated. `mergeCore` is the sole
 * writer of `acc.core` and always writes a defined value, so a defined `core`
 * always yields a non-empty object.
 */
const finalizeCore = (
  core:
    | {
        bare?: boolean;
        excludesFile?: string;
        attributesFile?: string;
        logAllRefUpdates?: boolean | 'always';
        hooksPath?: string;
        sparseCheckout?: boolean;
        sparseCheckoutCone?: boolean;
      }
    | undefined,
): ParsedConfig['core'] => {
  if (core === undefined) return undefined;
  return {
    ...(core.bare !== undefined ? { bare: core.bare } : {}),
    ...(core.excludesFile !== undefined ? { excludesFile: core.excludesFile } : {}),
    ...(core.attributesFile !== undefined ? { attributesFile: core.attributesFile } : {}),
    ...(core.logAllRefUpdates !== undefined ? { logAllRefUpdates: core.logAllRefUpdates } : {}),
    ...(core.hooksPath !== undefined ? { hooksPath: core.hooksPath } : {}),
    ...(core.sparseCheckout !== undefined ? { sparseCheckout: core.sparseCheckout } : {}),
    ...(core.sparseCheckoutCone !== undefined
      ? { sparseCheckoutCone: core.sparseCheckoutCone }
      : {}),
  };
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
    };
    user?: { name: string; email: string };
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
    branch?: ReadonlyMap<string, { remote?: string; merge?: string }>;
    submodule?: ReadonlyMap<string, { url?: string; active?: boolean; update?: string }>;
    merge?: ReadonlyMap<string, { name?: string; driver?: string; recursive?: string }>;
    extensions?: { partialClone?: string };
  } = {};
  const core = finalizeCore(acc.core);
  if (core !== undefined) out.core = core;
  // Stryker disable next-line OptionalChaining: equivalent — `&&` short-circuits, so `acc.user?.email` is only read after `acc.user?.name !== undefined` proved `acc.user` is defined.
  if (acc.user?.name !== undefined && acc.user?.email !== undefined) {
    out.user = { name: acc.user.name, email: acc.user.email };
  }
  // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — `acc.remote` is only ever assigned after a `Map.set`, so when defined its size is always >= 1; `> 0`, `>= 0` and a constant `true` never differ.
  if (acc.remote !== undefined && acc.remote.size > 0) out.remote = acc.remote;
  // `mergeExtensions` only assigns `acc.extensions` after observing a
  // `partialclone` key, so a defined value is always non-empty.
  if (acc.extensions !== undefined) out.extensions = acc.extensions;
  // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — `acc.branch` is only ever assigned after a `Map.set`, so when defined its size is always >= 1; `> 0`, `>= 0` and a constant `true` never differ.
  if (acc.branch !== undefined && acc.branch.size > 0) out.branch = acc.branch;
  // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — `acc.submodule` is only ever assigned after a `Map.set`, so when defined its size is always >= 1; `> 0`, `>= 0` and a constant `true` never differ.
  if (acc.submodule !== undefined && acc.submodule.size > 0) out.submodule = acc.submodule;
  // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — `acc.merge` is only ever assigned after a `Map.set`, so when defined its size is always >= 1; `> 0`, `>= 0` and a constant `true` never differ.
  if (acc.merge !== undefined && acc.merge.size > 0) out.merge = acc.merge;
  return out;
};

const TRUE_VALUES = new Set(['true', 'yes', 'on', '1']);

// Anything not a recognized truthy value is false: explicit false aliases
// (false/no/off/0/'') and unparseable values both fall through to `false`
// (lenient, like git itself).
const parseGitBoolean = (value: string): boolean => TRUE_VALUES.has(value.toLowerCase());
