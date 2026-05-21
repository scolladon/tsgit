import { TsgitError } from '../../domain/error.js';
import type { Context } from '../../ports/context.js';

/**
 * Subset of `.git/config` that v1 commands consume. Only fields actually used by
 * commands are typed — the parser ignores everything else (lenient, like git itself).
 */
export interface ParsedConfig {
  readonly core?: {
    readonly bare?: boolean;
    readonly excludesFile?: string;
    readonly logAllRefUpdates?: boolean | 'always';
    readonly hooksPath?: string;
  };
  readonly user?: { readonly name: string; readonly email: string };
  readonly remote?: ReadonlyMap<
    string,
    { readonly url?: string; readonly fetch?: ReadonlyArray<string> }
  >;
  readonly branch?: ReadonlyMap<string, { readonly remote?: string; readonly merge?: string }>;
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

const loadConfig = async (ctx: Context): Promise<ParsedConfig> => {
  const raw = await readRawConfig(ctx);
  if (raw === undefined) return {};
  return parseConfigText(raw);
};

const readRawConfig = async (ctx: Context): Promise<string | undefined> => {
  try {
    return await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return undefined;
    throw err;
  }
};

interface MutableSection {
  readonly section: string;
  readonly subsection: string | undefined;
  readonly entries: Array<{ readonly key: string; readonly value: string }>;
}

const parseConfigText = (text: string): ParsedConfig => {
  const sections = collectSections(text);
  return assembleParsed(sections);
};

const collectSections = (text: string): ReadonlyArray<MutableSection> => {
  const sections: MutableSection[] = [];
  let current: MutableSection | undefined;
  for (const line of joinContinuations(text.split('\n'))) {
    const trimmed = stripInlineComment(line).trim();
    // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent — an empty `trimmed` matches neither a section header nor a key/value, so skipping it explicitly or falling through both `continue` produces the same sections.
    if (trimmed === '') continue;
    const header = parseSectionHeader(trimmed);
    if (header !== undefined) {
      current = { section: header.section, subsection: header.subsection, entries: [] };
      sections.push(current);
      continue;
    }
    if (current === undefined) continue; // orphan key/value before any section.
    const kv = parseKeyValue(trimmed);
    if (kv === undefined) continue;
    current.entries.push(kv);
  }
  return sections;
};

const joinContinuations = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  // Stryker disable next-line ArrayDeclaration: equivalent — a non-empty seed prepends one extra logical line; as it precedes every section header it is an orphan that collectSections discards, leaving the parsed config unchanged.
  const out: string[] = [];
  let pending = '';
  for (const line of lines) {
    // Continuation: leading whitespace on the continuation line is dropped,
    // matching git's behavior when joining multi-line values.
    // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent — leading whitespace of the first physical line of a logical line is always at the start of the joined value, so collectSections' trim() removes it regardless of which ternary branch runs.
    const piece = pending === '' ? line : line.replace(/^\s+/, '');
    if (line.endsWith('\\')) {
      // `line` is already known to end with `\\` (the enclosing `if`), so the
      // backslash is dropped unconditionally.
      pending += piece.slice(0, piece.length - 1);
      continue;
    }
    out.push(`${pending}${piece}`);
    pending = '';
  }
  // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent — pushing an empty `pending` only appends a blank line, which collectSections skips; observable output is identical.
  if (pending !== '') out.push(pending);
  return out;
};

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
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && c === ch) return i;
  }
  return -1;
};

const parseSectionHeader = (
  line: string,
): { readonly section: string; readonly subsection: string | undefined } | undefined => {
  if (!line.startsWith('[') || !line.endsWith(']')) return undefined;
  const inner = line.slice(1, -1).trim();
  // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent — an empty `inner` yields a section named '' which assembleParsed never matches (it only handles core/user/remote/branch), so rejecting it or returning a '' section produces the same parsed config.
  if (inner === '') return undefined;
  const quoteAt = inner.indexOf('"');
  if (quoteAt === -1) return { section: inner, subsection: undefined };
  const sectionPart = inner.slice(0, quoteAt).trim();
  const lastQuote = inner.lastIndexOf('"');
  if (lastQuote <= quoteAt) return undefined;
  const subsection = inner.slice(quoteAt + 1, lastQuote);
  return { section: sectionPart, subsection };
};

const parseKeyValue = (
  line: string,
): { readonly key: string; readonly value: string } | undefined => {
  const eqAt = line.indexOf('=');
  if (eqAt === -1) return undefined;
  const key = line.slice(0, eqAt).trim();
  // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent — an empty key produces an entry whose key matches none of the consumed keys (bare/excludesfile/name/email/url/fetch/remote/merge), so rejecting it or emitting it leaves the parsed config unchanged.
  if (key === '') return undefined;
  const value = line.slice(eqAt + 1).trim();
  return { key, value };
};

const assembleParsed = (sections: ReadonlyArray<MutableSection>): ParsedConfig => {
  const acc: {
    core?: {
      bare?: boolean;
      excludesFile?: string;
      logAllRefUpdates?: boolean | 'always';
      hooksPath?: string;
    };
    user?: { name?: string; email?: string };
    remote?: Map<string, { url?: string; fetch?: string[] }>;
    branch?: Map<string, { remote?: string; merge?: string }>;
  } = {};
  for (const sec of sections) {
    if (sec.section === 'core' && sec.subsection === undefined) {
      mergeCore(acc, sec);
    } else if (sec.section === 'user' && sec.subsection === undefined) {
      mergeUser(acc, sec);
    } else if (sec.section === 'remote' && sec.subsection !== undefined) {
      mergeRemote(acc, sec.subsection, sec);
    } else if (sec.section === 'branch' && sec.subsection !== undefined) {
      mergeBranch(acc, sec.subsection, sec);
    }
  }
  return finalize(acc);
};

const mergeCore = (
  acc: {
    core?: {
      bare?: boolean;
      excludesFile?: string;
      logAllRefUpdates?: boolean | 'always';
      hooksPath?: string;
    };
  },
  sec: MutableSection,
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
    } else if (lowered === 'logallrefupdates') {
      acc.core = { ...acc.core, logAllRefUpdates: parseLogAllRefUpdates(value) };
    } else if (lowered === 'hookspath') {
      acc.core = { ...acc.core, hooksPath: value };
    }
  }
};

// The literal `always` is a third state beyond git's boolean values; anything
// else falls through to the standard boolean parse.
const parseLogAllRefUpdates = (value: string): boolean | 'always' =>
  value.toLowerCase() === 'always' ? 'always' : parseGitBoolean(value);

const mergeUser = (
  acc: { user?: { name?: string; email?: string } },
  sec: MutableSection,
): void => {
  for (const { key, value } of sec.entries) {
    if (key === 'name') {
      // `{ ...undefined }` is `{}`, so the spread alone handles the first write.
      acc.user = { ...acc.user, name: value };
    } else if (key === 'email') {
      acc.user = { ...acc.user, email: value };
    }
  }
};

const mergeRemote = (
  acc: { remote?: Map<string, { url?: string; fetch?: string[] }> },
  name: string,
  sec: MutableSection,
): void => {
  acc.remote ??= new Map();
  const current = acc.remote.get(name) ?? {};
  const fetch = current.fetch ? [...current.fetch] : [];
  let url = current.url;
  for (const { key, value } of sec.entries) {
    if (key === 'url') url = value;
    else if (key === 'fetch') fetch.push(value);
  }
  const merged: { url?: string; fetch?: string[] } = {};
  if (url !== undefined) merged.url = url;
  if (fetch.length > 0) merged.fetch = fetch;
  acc.remote.set(name, merged);
};

const mergeBranch = (
  acc: { branch?: Map<string, { remote?: string; merge?: string }> },
  name: string,
  sec: MutableSection,
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
        logAllRefUpdates?: boolean | 'always';
        hooksPath?: string;
      }
    | undefined,
): ParsedConfig['core'] => {
  if (core === undefined) return undefined;
  return {
    ...(core.bare !== undefined ? { bare: core.bare } : {}),
    ...(core.excludesFile !== undefined ? { excludesFile: core.excludesFile } : {}),
    ...(core.logAllRefUpdates !== undefined ? { logAllRefUpdates: core.logAllRefUpdates } : {}),
    ...(core.hooksPath !== undefined ? { hooksPath: core.hooksPath } : {}),
  };
};

const finalize = (acc: {
  core?: {
    bare?: boolean;
    excludesFile?: string;
    logAllRefUpdates?: boolean | 'always';
    hooksPath?: string;
  };
  user?: { name?: string; email?: string };
  remote?: Map<string, { url?: string; fetch?: string[] }>;
  branch?: Map<string, { remote?: string; merge?: string }>;
}): ParsedConfig => {
  const out: {
    core?: {
      bare?: boolean;
      excludesFile?: string;
      logAllRefUpdates?: boolean | 'always';
      hooksPath?: string;
    };
    user?: { name: string; email: string };
    remote?: ReadonlyMap<string, { url?: string; fetch?: ReadonlyArray<string> }>;
    branch?: ReadonlyMap<string, { remote?: string; merge?: string }>;
  } = {};
  const core = finalizeCore(acc.core);
  if (core !== undefined) out.core = core;
  // Stryker disable next-line OptionalChaining: equivalent — `&&` short-circuits, so `acc.user?.email` is only read after `acc.user?.name !== undefined` proved `acc.user` is defined.
  if (acc.user?.name !== undefined && acc.user?.email !== undefined) {
    out.user = { name: acc.user.name, email: acc.user.email };
  }
  // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — `acc.remote` is only ever assigned after a `Map.set`, so when defined its size is always >= 1; `> 0`, `>= 0` and a constant `true` never differ.
  if (acc.remote !== undefined && acc.remote.size > 0) out.remote = acc.remote;
  // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — `acc.branch` is only ever assigned after a `Map.set`, so when defined its size is always >= 1; `> 0`, `>= 0` and a constant `true` never differ.
  if (acc.branch !== undefined && acc.branch.size > 0) out.branch = acc.branch;
  return out;
};

const TRUE_VALUES = new Set(['true', 'yes', 'on', '1']);

// Anything not a recognized truthy value is false: explicit false aliases
// (false/no/off/0/'') and unparseable values both fall through to `false`
// (lenient, like git itself).
const parseGitBoolean = (value: string): boolean => TRUE_VALUES.has(value.toLowerCase());
