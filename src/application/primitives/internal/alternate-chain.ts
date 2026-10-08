import { errorDataCode } from '../../../domain/error-data-code.js';
import { asciiLower } from '../../../domain/pretty/ascii.js';
import { parseAlternatesFile } from '../../../domain/storage/alternates.js';
import type { Context } from '../../../ports/context.js';
import type {
  AlternatePathProbe,
  ObjectSourceReader,
} from '../../../ports/object-source-access.js';
import { readConfig } from '../config-read.js';
import { commonGitDir } from '../path-layout.js';
import type { GitPathSyntax } from './git-path-syntax.js';

/** git's nested-symlink limit; its post-increment check lets one more link through than the limit. */
const MAX_SYMLINKS = 32;
const FILE_NOT_FOUND = 'FILE_NOT_FOUND';
const NOT_A_DIRECTORY = 'NOT_A_DIRECTORY';

type Lookup =
  | { readonly kind: 'found'; readonly isLink: boolean }
  | { readonly kind: 'absent' }
  | { readonly kind: 'blocked' };

const lookup = async (probe: AlternatePathProbe, path: string): Promise<Lookup> => {
  try {
    const stat = await probe.lstat(path);
    return { kind: 'found', isLink: stat.isSymbolicLink };
  } catch (error) {
    const code = errorDataCode(error);
    if (code === FILE_NOT_FOUND) return { kind: 'absent' };
    if (code === NOT_A_DIRECTORY) return { kind: 'blocked' };
    throw error;
  }
};

const CURRENT_DIRECTORY = '.';
/** The empty name a trailing separator leaves: nothing to append, but it is still "remaining". */
const TRAILING_SEPARATOR = '';

interface Walk {
  readonly syntax: GitPathSyntax;
  root: string;
  readonly names: string[];
  readonly pending: string[];
  hops: number;
}

/** git appends `/` after the resolved prefix unless it already ends in one (`C:` → `C:/x`). */
const joinedPath = (root: string, names: ReadonlyArray<string>): string => {
  if (names.length === 0) return root;
  const separator = root.endsWith('/') ? '' : '/';
  return `${root}${separator}${names.join('/')}`;
};

/** Restarts the walk at `path`'s root; false for a rootless one, which git resolves from its cwd. */
const restartAt = (walk: Walk, path: string): boolean => {
  const { root, rest } = walk.syntax.splitRoot(path);
  if (root === '') return false;
  walk.root = root;
  walk.names.length = 0;
  walk.pending.unshift(...walk.syntax.components(rest));
  return true;
};

const follow = async (probe: AlternatePathProbe, walk: Walk, link: string): Promise<boolean> => {
  if (walk.hops++ > MAX_SYMLINKS) return false;
  const target = await probe.readlink(link);
  if (walk.syntax.isAbsolute(target)) return restartAt(walk, target);
  walk.pending.unshift(...walk.syntax.components(target));
  return true;
};

const descend = async (
  probe: AlternatePathProbe,
  walk: Walk,
  segment: string,
): Promise<boolean> => {
  if (segment === CURRENT_DIRECTORY || segment === TRAILING_SEPARATOR) return true;
  if (segment === '..') {
    walk.names.pop();
    return true;
  }
  const candidate = joinedPath(walk.root, [...walk.names, segment]);
  const found = await lookup(probe, candidate);
  if (found.kind === 'blocked') return false;
  if (found.kind === 'absent') {
    walk.names.push(segment);
    return walk.pending.length === 0;
  }
  if (found.isLink) return follow(probe, walk, candidate);
  // git appends any non-link without a directory check: a later `..` walks back out of a file.
  walk.names.push(segment);
  return true;
};

/** git's realpath starts a rootless path (a share-less `\\server`) from its cwd. */
const startAt = (walk: Walk, path: string, cwd: string): boolean => {
  if (restartAt(walk, path)) return true;
  if (!restartAt(walk, cwd)) return false;
  walk.pending.push(...walk.syntax.components(path));
  return true;
};

/**
 * git's `strbuf_realpath(…, die_on_error=0)` over the port: every component is resolved and only
 * the last may be missing, with no separator after it. `undefined` when a middle component is
 * absent or under a file, links loop, or a link names a rootless target.
 */
export const realpathAllowingMissingLeaf = async (
  syntax: GitPathSyntax,
  probe: AlternatePathProbe,
  path: string,
  cwd: string,
): Promise<string | undefined> => {
  const walk: Walk = { syntax, root: '', names: [], pending: [], hops: 0 };
  if (!startAt(walk, path, cwd)) return undefined;
  while (walk.pending.length > 0) {
    if (!(await descend(probe, walk, walk.pending.shift() as string))) return undefined;
  }
  return joinedPath(walk.root, walk.names);
};

/** git's `odb.c` refuses to descend once a holder sits at this alternate depth. */
const MAX_ALTERNATE_DEPTH = 5;
const PRIMARY_DEPTH = -1;

export type AlternateDiagnosticReason =
  | 'unresolvable'
  | 'not-a-directory'
  | 'unreadable-list'
  | 'nesting-too-deep'
  | 'unreachable';

export interface AlternateDiagnostic {
  readonly reason: AlternateDiagnosticReason;
  readonly path: string;
  readonly listedIn: string;
  readonly code?: string;
}

export interface ObjectSourceSpec {
  readonly objectsDir: string;
  readonly local: boolean;
  readonly depth: number;
}

/** The two capabilities resolution needs: a metadata probe for any path and the reader of a source. */
export interface AlternateChainIo {
  readonly probe: (path: string) => AlternatePathProbe;
  readonly reader: (objectsDir: string) => ObjectSourceReader;
  /** How the filesystem's git build reads a path: separators, drives, UNC shares. */
  readonly pathSyntax: GitPathSyntax;
}

interface Resolution {
  readonly ctx: Context;
  readonly io: AlternateChainIo;
  readonly key: (path: string) => string;
  /** git's cwd while it reads alternates: the work tree's top, else where it was started. */
  readonly cwd: string;
  readonly seen: Set<string>;
  readonly sources: ObjectSourceSpec[];
  readonly diagnostics: AlternateDiagnostic[];
  readonly reports: Map<string, ReadonlyArray<AlternateDiagnostic>>;
  /** What each held source reported when it was linked, by `key`. */
  readonly heldReports: ReadonlyMap<string, ReadonlyArray<AlternateDiagnostic>>;
  readonly replayed: Set<AlternateDiagnostic>;
}

/** Per linked source, what its visit reported: its own list's entries and every source below. */
export type SourceReports = ReadonlyMap<string, ReadonlyArray<AlternateDiagnostic>>;

/** git trims an entry's trailing slashes, so the POSIX root becomes the empty path `stat` rejects. */
const TRAILING_SLASHES = /\/+$/;
const TRIMMED_ROOT = '';
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const lossyUtf8 = new TextDecoder();

const readIgnoreCase = async (ctx: Context): Promise<boolean> =>
  (await readConfig(ctx)).core?.ignoreCase === true;

/** Constant: an entry's path is repository-controlled text, so it travels in the context only. */
const UNUSABLE_ALTERNATE = 'objectStore: unusable alternate';

const report = (resolution: Resolution, diagnostic: AlternateDiagnostic): void => {
  resolution.diagnostics.push(diagnostic);
  resolution.ctx.logger?.warn?.(UNUSABLE_ALTERNATE, { ...diagnostic });
};

const readList = async (
  resolution: Resolution,
  holder: string,
): Promise<ReadonlyArray<Uint8Array>> => {
  const file = `${holder}/info/alternates`;
  try {
    return parseAlternatesFile(await resolution.io.reader(holder).read(file));
  } catch (error) {
    const code = errorDataCode(error);
    if (code === FILE_NOT_FOUND || code === NOT_A_DIRECTORY) return [];
    report(resolution, {
      reason: 'unreadable-list',
      path: file,
      listedIn: holder,
      ...(code === undefined ? {} : { code }),
    });
    return [];
  }
};

const decodeEntry = (entry: Uint8Array): string | undefined => {
  try {
    return strictUtf8.decode(entry);
  } catch {
    return undefined;
  }
};

const normalise = async (
  resolution: Resolution,
  entry: Uint8Array,
  holder: string,
): Promise<string | undefined> => {
  const text = decodeEntry(entry);
  const { pathSyntax } = resolution.io;
  const joined =
    text === undefined
      ? lossyUtf8.decode(entry)
      : pathSyntax.isAbsolute(text)
        ? text
        : `${holder}/${text}`;
  if (text === undefined) return void report(resolution, unresolvableAt(joined, holder));
  return realEntryPath(resolution, joined, holder);
};

const unresolvableAt = (path: string, listedIn: string) =>
  ({ reason: 'unresolvable', path, listedIn }) as const;

/** The entry's real path, trailing slashes dropped; reported and `undefined` when it has none. */
const realEntryPath = async (
  resolution: Resolution,
  joined: string,
  holder: string,
): Promise<string | undefined> => {
  const { probe, pathSyntax } = resolution.io;
  try {
    const real = await realpathAllowingMissingLeaf(
      pathSyntax,
      probe(joined),
      joined,
      resolution.cwd,
    );
    if (real === undefined) return void report(resolution, unresolvableAt(joined, holder));
    return real.replace(TRAILING_SLASHES, '');
  } catch (error) {
    const code = errorDataCode(error);
    report(resolution, {
      reason: 'unreachable',
      path: joined,
      listedIn: holder,
      ...(code === undefined ? {} : { code }),
    });
    return undefined;
  }
};

const isDirectory = async (
  resolution: Resolution,
  path: string,
  holder: string,
): Promise<boolean> => {
  if (path === TRIMMED_ROOT) {
    report(resolution, { reason: 'not-a-directory', path, listedIn: holder });
    return false;
  }
  try {
    const stat = await resolution.io.probe(path).stat(path);
    if (!stat.isDirectory)
      report(resolution, { reason: 'not-a-directory', path, listedIn: holder });
    return stat.isDirectory;
  } catch (error) {
    const code = errorDataCode(error);
    const absent = code === FILE_NOT_FOUND || code === NOT_A_DIRECTORY;
    report(resolution, {
      reason: absent ? 'not-a-directory' : 'unreachable',
      path,
      listedIn: holder,
      ...(code === undefined || absent ? {} : { code }),
    });
    return false;
  }
};

const normaliseAll = async (
  resolution: Resolution,
  entries: ReadonlyArray<Uint8Array>,
  holder: string,
): Promise<ReadonlyArray<string>> => {
  const paths: string[] = [];
  for (const entry of entries) {
    const path = await normalise(resolution, entry, holder);
    if (path !== undefined) paths.push(path);
  }
  return paths;
};

const visit = async (
  resolution: Resolution,
  holder: string,
  holderDepth: number,
  entries: ReadonlyArray<Uint8Array>,
): Promise<void> => {
  const paths = await normaliseAll(resolution, entries, holder);
  if (holderDepth + 1 > MAX_ALTERNATE_DEPTH && paths.length > 0) {
    report(resolution, { reason: 'nesting-too-deep', path: holder, listedIn: holder });
    return;
  }
  for (const path of paths) {
    if (!(await isDirectory(resolution, path, holder))) continue;
    if (resolution.seen.has(resolution.key(path))) {
      replayHeld(resolution, path);
      continue;
    }
    resolution.seen.add(resolution.key(path));
    resolution.sources.push({ objectsDir: path, local: false, depth: holderDepth + 1 });
    await visitLinked(resolution, path, holderDepth + 1);
  }
};

/** Visits a newly linked source, keeping what it reported for a later re-read to replay. */
const visitLinked = async (resolution: Resolution, path: string, depth: number): Promise<void> => {
  const start = resolution.diagnostics.length;
  await visit(resolution, path, depth, await readList(resolution, path));
  resolution.reports.set(path, resolution.diagnostics.slice(start));
};

/**
 * A held source is not visited again: what it reported when linked is replayed, once, where the
 * walk meets it, so a re-read keeps the first read's depth-first order.
 */
const replayHeld = (resolution: Resolution, path: string): void => {
  for (const diagnostic of resolution.heldReports.get(resolution.key(path)) ?? []) {
    if (resolution.replayed.has(diagnostic)) continue;
    resolution.replayed.add(diagnostic);
    resolution.diagnostics.push(diagnostic);
  }
};

/**
 * The primary's realpath, `undefined` when it cannot be resolved: an adapter confined below the
 * filesystem root refuses the primary's ancestors with a coded fault, and the primary itself is
 * still readable through it, so the walk's failure is not the store's.
 */
const primaryRealpath = async (
  io: AlternateChainIo,
  raw: string,
  cwd: string,
): Promise<string | undefined> => {
  try {
    return await realpathAllowingMissingLeaf(io.pathSyntax, io.probe(raw), raw, cwd);
  } catch (error) {
    if (errorDataCode(error) === undefined) throw error;
    return undefined;
  }
};

export interface ResolveOptions {
  /**
   * The sources an earlier preparation linked: git's `alt_odb_usable` refuses a path it already
   * holds, so neither it nor the list it holds is visited again — only new sources are.
   */
  readonly held?: ReadonlyArray<string>;
  /** What the held sources reported when they were linked: replayed where the walk meets them. */
  readonly heldReports?: SourceReports;
  /** The primary's alternates file, when the caller already read it; read through `io` otherwise. */
  readonly primaryList?: Uint8Array;
}

/** git's `odb_prepare_alternates`: the primary, then every reachable alternate in DFS pre-order. */
export const resolveObjectSources = async (
  ctx: Context,
  io: AlternateChainIo,
  options: ResolveOptions = {},
): Promise<{
  readonly sources: ReadonlyArray<ObjectSourceSpec>;
  readonly diagnostics: ReadonlyArray<AlternateDiagnostic>;
  readonly reports: SourceReports;
}> => {
  const raw = `${commonGitDir(ctx)}/objects`;
  const cwd = ctx.layout.workDir ?? ctx.cwd;
  const primary = (await primaryRealpath(io, raw, cwd)) ?? raw;
  const key = (await readIgnoreCase(ctx)) ? asciiLower : (path: string) => path;
  const resolution = startResolution({ ctx, io, key, cwd }, primary, options);
  const entries =
    options.primaryList === undefined
      ? await readList(resolution, primary)
      : parseAlternatesFile(options.primaryList);
  await visit(resolution, primary, PRIMARY_DEPTH, entries);
  const { sources, diagnostics, reports } = resolution;
  return { sources, diagnostics, reports };
};

type Walker = Pick<Resolution, 'ctx' | 'io' | 'key' | 'cwd'>;

const startResolution = (walker: Walker, primary: string, options: ResolveOptions): Resolution => {
  const { key } = walker;
  const held = [...(options.heldReports ?? [])];
  return {
    ...walker,
    seen: new Set([primary, ...(options.held ?? [])].map(key)),
    sources: [{ objectsDir: primary, local: true, depth: PRIMARY_DEPTH }],
    diagnostics: [],
    reports: new Map(),
    heldReports: new Map(held.map(([path, reported]) => [key(path), reported])),
    replayed: new Set(),
  };
};
