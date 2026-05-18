import { TsgitError } from '../../../domain/error.js';
import type { Context } from '../../../ports/context.js';

/**
 * Subset of `.git/config` that v1 commands consume. Only fields actually used by
 * commands are typed — the parser ignores everything else (lenient, like git itself).
 */
export interface ParsedConfig {
  readonly core?: { readonly bare?: boolean; readonly excludesFile?: string };
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
  const out: string[] = [];
  let pending = '';
  for (const line of lines) {
    // Continuation: leading whitespace on the continuation line is dropped,
    // matching git's behavior when joining multi-line values.
    const piece = pending === '' ? line : line.replace(/^\s+/, '');
    if (line.endsWith('\\')) {
      pending += piece.slice(0, piece.length - (line.endsWith('\\') ? 1 : 0));
      continue;
    }
    out.push(`${pending}${piece}`);
    pending = '';
  }
  if (pending !== '') out.push(pending);
  return out;
};

const stripInlineComment = (line: string): string => {
  const hashAt = indexOfUnquoted(line, '#');
  const semiAt = indexOfUnquoted(line, ';');
  const cuts = [hashAt, semiAt].filter((n): n is number => n >= 0);
  if (cuts.length === 0) return line;
  return line.slice(0, Math.min(...cuts));
};

const indexOfUnquoted = (line: string, ch: string): number => {
  let inQuotes = false;
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
  if (key === '') return undefined;
  const value = line.slice(eqAt + 1).trim();
  return { key, value };
};

const assembleParsed = (sections: ReadonlyArray<MutableSection>): ParsedConfig => {
  const acc: {
    core?: { bare?: boolean };
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
  acc: { core?: { bare?: boolean; excludesFile?: string } },
  sec: MutableSection,
): void => {
  for (const { key, value } of sec.entries) {
    // Git config keys are case-insensitive; the parser preserves casing,
    // so we lowercase here for comparison.
    const lowered = key.toLowerCase();
    if (lowered === 'bare') {
      acc.core ??= {};
      acc.core = { ...acc.core, bare: parseGitBoolean(value) };
    } else if (lowered === 'excludesfile') {
      acc.core ??= {};
      acc.core = { ...acc.core, excludesFile: value };
    }
  }
};

const mergeUser = (
  acc: { user?: { name?: string; email?: string } },
  sec: MutableSection,
): void => {
  for (const { key, value } of sec.entries) {
    if (key === 'name') {
      acc.user ??= {};
      acc.user = { ...acc.user, name: value };
    } else if (key === 'email') {
      acc.user ??= {};
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

const finalize = (acc: {
  core?: { bare?: boolean; excludesFile?: string };
  user?: { name?: string; email?: string };
  remote?: Map<string, { url?: string; fetch?: string[] }>;
  branch?: Map<string, { remote?: string; merge?: string }>;
}): ParsedConfig => {
  const out: {
    core?: { bare?: boolean; excludesFile?: string };
    user?: { name: string; email: string };
    remote?: ReadonlyMap<string, { url?: string; fetch?: ReadonlyArray<string> }>;
    branch?: ReadonlyMap<string, { remote?: string; merge?: string }>;
  } = {};
  if (acc.core?.bare !== undefined || acc.core?.excludesFile !== undefined) {
    out.core = {
      ...(acc.core?.bare !== undefined ? { bare: acc.core.bare } : {}),
      ...(acc.core?.excludesFile !== undefined ? { excludesFile: acc.core.excludesFile } : {}),
    };
  }
  if (acc.user?.name !== undefined && acc.user?.email !== undefined) {
    out.user = { name: acc.user.name, email: acc.user.email };
  }
  if (acc.remote !== undefined && acc.remote.size > 0) out.remote = acc.remote;
  if (acc.branch !== undefined && acc.branch.size > 0) out.branch = acc.branch;
  return out;
};

const TRUE_VALUES = new Set(['true', 'yes', 'on', '1']);
const FALSE_VALUES = new Set(['false', 'no', 'off', '0', '']);

const parseGitBoolean = (value: string): boolean => {
  const lowered = value.toLowerCase();
  if (TRUE_VALUES.has(lowered)) return true;
  if (FALSE_VALUES.has(lowered)) return false;
  return false; // Unparseable boolean defaults to false (lenient).
};
