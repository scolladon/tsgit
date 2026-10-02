import { errorDataCode } from '../../../domain/error-data-code.js';
import { parseAlternatesFile } from '../../../domain/storage/alternates.js';
import type { Context } from '../../../ports/context.js';
import type {
  AlternatePathProbe,
  ObjectSourceReader,
} from '../../../ports/object-source-access.js';
import { readConfig } from '../config-read.js';
import { commonGitDir } from '../path-layout.js';
import { isAbsolutePath } from './absolute-path.js';

/** Linux's symlink-follow limit: the hop budget after which git's realpath gives up on a link cycle. */
const MAX_SYMLINK_HOPS = 40;
const FILE_NOT_FOUND = 'FILE_NOT_FOUND';
const NOT_A_DIRECTORY = 'NOT_A_DIRECTORY';

type Lookup =
  | { readonly kind: 'found'; readonly isLink: boolean; readonly isDirectory: boolean }
  | { readonly kind: 'absent' }
  | { readonly kind: 'blocked' };

const segmentsOf = (path: string): string[] => path.split('/').filter((s) => s !== '');

const lookup = async (probe: AlternatePathProbe, path: string): Promise<Lookup> => {
  try {
    const stat = await probe.lstat(path);
    return { kind: 'found', isLink: stat.isSymbolicLink, isDirectory: stat.isDirectory };
  } catch (error) {
    const code = errorDataCode(error);
    if (code === FILE_NOT_FOUND) return { kind: 'absent' };
    if (code === NOT_A_DIRECTORY) return { kind: 'blocked' };
    throw error;
  }
};

interface Walk {
  resolved: string;
  readonly pending: string[];
  hops: number;
}

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/'));

const follow = async (probe: AlternatePathProbe, walk: Walk, link: string): Promise<boolean> => {
  walk.hops++;
  if (walk.hops > MAX_SYMLINK_HOPS) return false;
  const target = await probe.readlink(link);
  if (target.startsWith('/')) walk.resolved = '';
  walk.pending.unshift(...segmentsOf(target));
  return true;
};

const descend = async (
  probe: AlternatePathProbe,
  walk: Walk,
  segment: string,
): Promise<boolean> => {
  if (segment === '.') return true;
  if (segment === '..') {
    walk.resolved = parentOf(walk.resolved);
    return true;
  }
  const candidate = `${walk.resolved}/${segment}`;
  const found = await lookup(probe, candidate);
  const isLast = walk.pending.length === 0;
  if (found.kind === 'blocked') return false;
  if (found.kind === 'absent') {
    walk.resolved = candidate;
    return isLast;
  }
  if (found.isLink) return follow(probe, walk, candidate);
  walk.resolved = candidate;
  return found.isDirectory || isLast;
};

/**
 * git's `strbuf_realpath(…, die_on_error=0)` over the port: every component is resolved and only
 * the last may be missing. `undefined` when a middle component is absent or links loop.
 */
export const realpathAllowingMissingLeaf = async (
  probe: AlternatePathProbe,
  path: string,
): Promise<string | undefined> => {
  const walk: Walk = { resolved: '', pending: segmentsOf(path), hops: 0 };
  while (walk.pending.length > 0) {
    if (!(await descend(probe, walk, walk.pending.shift() as string))) return undefined;
  }
  return walk.resolved === '' ? '/' : walk.resolved;
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
}

interface Resolution {
  readonly ctx: Context;
  readonly io: AlternateChainIo;
  readonly key: (path: string) => string;
  readonly seen: Set<string>;
  readonly sources: ObjectSourceSpec[];
  readonly diagnostics: AlternateDiagnostic[];
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const lossyUtf8 = new TextDecoder();

const asciiLower = (path: string): string => path.replace(/[A-Z]/g, (c) => c.toLowerCase());

const readIgnoreCase = async (ctx: Context): Promise<boolean> =>
  (await readConfig(ctx)).core?.ignoreCase === true;

const report = (resolution: Resolution, diagnostic: AlternateDiagnostic): void => {
  resolution.diagnostics.push(diagnostic);
  resolution.ctx.logger?.warn?.(`alternate object store ${diagnostic.reason}: ${diagnostic.path}`, {
    ...diagnostic,
  });
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
  const joined =
    text === undefined
      ? lossyUtf8.decode(entry)
      : isAbsolutePath(text)
        ? text
        : `${holder}/${text}`;
  const unresolvable = { reason: 'unresolvable', path: joined, listedIn: holder } as const;
  if (text === undefined) return void report(resolution, unresolvable);
  try {
    const real = await realpathAllowingMissingLeaf(resolution.io.probe(joined), joined);
    if (real === undefined) report(resolution, unresolvable);
    return real;
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
): Promise<void> => {
  const entries = await readList(resolution, holder);
  const paths = await normaliseAll(resolution, entries, holder);
  if (holderDepth + 1 > MAX_ALTERNATE_DEPTH && paths.length > 0) {
    report(resolution, { reason: 'nesting-too-deep', path: holder, listedIn: holder });
    return;
  }
  for (const path of paths) {
    if (!(await isDirectory(resolution, path, holder))) continue;
    if (resolution.seen.has(resolution.key(path))) continue;
    resolution.seen.add(resolution.key(path));
    resolution.sources.push({ objectsDir: path, local: false, depth: holderDepth + 1 });
    await visit(resolution, path, holderDepth + 1);
  }
};

/** git's `odb_prepare_alternates`: the primary, then every reachable alternate in DFS pre-order. */
export const resolveObjectSources = async (
  ctx: Context,
  io: AlternateChainIo,
): Promise<{
  readonly sources: ReadonlyArray<ObjectSourceSpec>;
  readonly diagnostics: ReadonlyArray<AlternateDiagnostic>;
}> => {
  const raw = `${commonGitDir(ctx)}/objects`;
  const primary = (await realpathAllowingMissingLeaf(io.probe(raw), raw)) ?? raw;
  const key = (await readIgnoreCase(ctx)) ? asciiLower : (path: string) => path;
  const resolution: Resolution = {
    ctx,
    io,
    key,
    seen: new Set([key(primary)]),
    sources: [{ objectsDir: primary, local: true, depth: PRIMARY_DEPTH }],
    diagnostics: [],
  };
  await visit(resolution, primary, PRIMARY_DEPTH);
  return { sources: resolution.sources, diagnostics: resolution.diagnostics };
};
