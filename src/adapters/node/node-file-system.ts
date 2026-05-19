import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as nodePath from 'node:path';
import {
  fileExists,
  fileNotFound,
  notADirectory,
  permissionDenied,
  TsgitError,
  unsupportedOperation,
} from '../../domain/index.js';
import type { DirEntry, FileHandle, FileStat, FileSystem } from '../../ports/file-system.js';
import { isWindows, type PlatformPredicate } from './platform.js';

type ContainmentMode = 'read' | 'lstat' | 'creation';

/** @internal */
export function toAbsolute(path: string, rootDir: string): string {
  return nodePath.isAbsolute(path) ? path : nodePath.join(rootDir, path);
}

/** @internal */
export function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * True iff `child === parent` (after case-folding on Windows) or `child` is
 * strictly inside `parent`. Defends `NodeFileSystem.checkContainment` against
 * (a) drive-letter casing differences on Windows and (b) the prefix-only
 * false-positive (parent='/tmp/foo', child='/tmp/foobar'). Phase 14.4.
 *
 * @internal
 */
export function pathContains(
  parent: string,
  child: string,
  isWindowsFn: PlatformPredicate = isWindows,
): boolean {
  const normalize = (path: string): string => (isWindowsFn() ? path.toLowerCase() : path);
  const p = normalize(parent);
  const c = normalize(child);
  if (c === p) return true;
  return c.startsWith(p + nodePath.sep);
}

/** @internal */
export function mapErrno(err: NodeJS.ErrnoException, path: string): TsgitError {
  switch (err.code) {
    case 'ENOENT':
      return fileNotFound(path);
    case 'EEXIST':
      return fileExists(path);
    case 'ENOTDIR':
    case 'ENOTEMPTY':
      // ENOTEMPTY is "directory not empty" — surface as NOT_A_DIRECTORY for cross-adapter
      // parity with the memory adapter, which uses the same code for non-empty rm.
      return notADirectory(path);
    case 'EACCES':
    case 'EPERM':
      return permissionDenied(path);
    case 'ELOOP':
      // POSIX errno for symlink-loop / O_NOFOLLOW refusal; Windows surfaces other
      // errnos handled by the `openWithNoFollow` discriminator (ADR-043).
      return permissionDenied(path);
    default:
      return unsupportedOperation('filesystem', err.code ?? 'UNKNOWN');
  }
}

/**
 * Run a filesystem operation, translating Node's errno exceptions into TsgitError.
 * Any non-errno error is re-thrown untouched so the caller sees the underlying cause.
 * @internal
 */
export async function runFs<T>(op: () => Promise<T>, path: string): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (isErrnoException(err)) throw mapErrno(err, path);
    throw err;
  }
}

/**
 * Resolves `absolute` by walking up until a realpath call succeeds, then reattaches
 * any non-existent tail. The loop's final candidate is the filesystem root (`/`),
 * which always resolves, guaranteeing a return.
 * @internal
 */
export async function realpathNearestExisting(absolute: string): Promise<string> {
  // equivalent-mutant: dropping `.filter(Boolean)` (MethodExpression) keeps extra empty segments
  // which only widen candidates with leading/internal `//`. POSIX realpath normalizes these to a
  // single `/`, so every candidate resolves identically to the filtered form.
  const segments = absolute.split(nodePath.sep).filter(Boolean);
  // equivalent-mutant: relaxing `i > 0` to `i >= 0` adds one more iteration where candidate = '/'.
  // That iteration reproduces the fallback branch below (join(realpath('/'), segments.join(sep))),
  // so the returned value is identical when no prefix resolves.
  for (let i = segments.length; i > 0; i--) {
    const candidate = nodePath.sep + segments.slice(0, i).join(nodePath.sep);
    try {
      const real = await fsPromises.realpath(candidate);
      const tail = segments.slice(i).join(nodePath.sep);
      // equivalent-mutant: relaxing `tail.length > 0` to `tail.length >= 0` (or to `true`) keeps
      // the join branch, and `nodePath.join(real, '')` returns `real` — so both branches yield
      // the same path when the tail is empty.
      return tail.length > 0 ? nodePath.join(real, tail) : real;
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') continue;
      throw err;
    }
  }
  // All segments were non-existent; anchor at the (always-resolvable) filesystem root.
  const root = await fsPromises.realpath(nodePath.sep);
  // equivalent-mutant: relaxing `segments.length > 0` to `>=0` (or forcing the condition to
  // `true`) keeps the join branch — and `nodePath.join(root, '')` returns `root`, so the empty
  // segments case still returns the same value as the explicit `: root` arm.
  return segments.length > 0 ? nodePath.join(root, segments.join(nodePath.sep)) : root;
}

/**
 * Interpret the result of an lstat on the leaf of a creation target.
 *
 * - Success + symlink → reject with PERMISSION_DENIED (don't write through a pre-existing symlink)
 * - Success + non-symlink → no-op (overwrite is fine)
 * - ENOENT → no-op (the leaf doesn't exist yet, which is the expected creation case)
 * - Any other errno → surface via mapErrno (must NOT be silently swallowed)
 *
 * Non-Error, non-errno throwables re-bubble as-is.
 * @internal
 */
export function interpretCreationLstat(
  result:
    | { readonly ok: true; readonly isSymlink: boolean }
    | { readonly ok: false; readonly err: unknown },
  path: string,
): void {
  if (result.ok) {
    if (result.isSymlink) throw permissionDenied(path);
    return;
  }
  const { err } = result;
  if (isErrnoException(err)) {
    if (err.code === 'ENOENT') return;
    throw mapErrno(err, path);
  }
  throw err;
}

function wrapNodeHandle(handle: fsPromises.FileHandle): FileHandle {
  let closed = false;
  return {
    read: async (buffer, offset, length, position) => {
      const { bytesRead } = await handle.read(buffer, offset, length, position ?? null);
      return bytesRead;
    },
    write: async (buffer) => {
      await handle.write(buffer, 0, buffer.length);
    },
    stat: async () => mapStat(await handle.stat({ bigint: true })),
    close: async () => {
      if (closed) return;
      closed = true;
      await handle.close();
    },
  };
}

/** @internal */
export function mapStat(s: {
  readonly ctimeMs: bigint | number;
  readonly mtimeMs: bigint | number;
  readonly dev: bigint | number;
  readonly ino: bigint | number;
  readonly mode: bigint | number;
  readonly uid: bigint | number;
  readonly gid: bigint | number;
  readonly size: bigint | number;
  readonly ctimeNs?: bigint;
  readonly mtimeNs?: bigint;
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
}): FileStat {
  const base = {
    ctimeMs: Number(s.ctimeMs),
    mtimeMs: Number(s.mtimeMs),
    dev: Number(s.dev),
    ino: Number(s.ino),
    mode: Number(s.mode),
    uid: Number(s.uid),
    gid: Number(s.gid),
    size: Number(s.size),
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    isSymbolicLink: s.isSymbolicLink(),
  };
  if (s.ctimeNs !== undefined && s.mtimeNs !== undefined) {
    return { ...base, ctimeNs: s.ctimeNs, mtimeNs: s.mtimeNs };
  }
  return base;
}

export class NodeFileSystem implements FileSystem {
  private readonly rootDir: string;

  constructor(rootDir: string, isWindowsFn: PlatformPredicate = isWindows) {
    this.rootDir = rootDir;
    this.isWindowsFn = isWindowsFn;
  }

  /**
   * Lazy long-name canonicalisation of `rootDir` for containment checks.
   * Promise so concurrent first calls share one `realpath`; cleared on
   * rejection so a transient ENOENT can be retried. See ADR-042.
   */
  private canonicalRootPromise: Promise<string> | undefined = undefined;

  private readonly isWindowsFn: PlatformPredicate;

  private async getCanonicalRoot(): Promise<string> {
    if (this.canonicalRootPromise === undefined) {
      this.canonicalRootPromise = fsPromises.realpath(this.rootDir).catch((err: unknown) => {
        this.canonicalRootPromise = undefined;
        throw err;
      });
    }
    return this.canonicalRootPromise;
  }

  read = async (path: string): Promise<Uint8Array> => {
    const real = await this.checkContainment(path, 'read');
    return runFs(async () => new Uint8Array(await fsPromises.readFile(real)), path);
  };

  readSlice = async (path: string, offset: number, length: number): Promise<Uint8Array> => {
    if (offset < 0 || length < 0) throw permissionDenied(path);
    const real = await this.checkContainment(path, 'read');
    let handle: fsPromises.FileHandle | undefined;
    try {
      return await runFs(async () => {
        handle = await fsPromises.open(real, 'r');
        const buf = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buf, 0, length, offset);
        return Uint8Array.from(buf.subarray(0, bytesRead));
      }, path);
    } finally {
      // equivalent-mutant: emptying this finally body (BlockStatement → {}) leaks the FileHandle
      // silently. Node's ESM module namespace declares `fs/promises.open` as non-configurable,
      // so `vi.spyOn`/`defineProperty` cannot intercept the call at runtime (TypeError:
      // "Cannot redefine property"). Simulating FD exhaustion to surface the leak needs tens of
      // thousands of sequential opens, which is prohibitively slow in a unit suite. Kept here
      // because the finally is load-bearing for long-running processes that call readSlice on
      // a hot path (pack index lookups); static review confirms the close is required.
      await handle?.close();
    }
  };

  readUtf8 = async (path: string): Promise<string> => {
    const real = await this.checkContainment(path, 'read');
    return runFs(() => fsPromises.readFile(real, 'utf-8'), path);
  };

  write = async (path: string, data: Uint8Array): Promise<void> => {
    const real = await this.checkContainment(path, 'creation');
    await runFs(async () => {
      await fsPromises.mkdir(nodePath.dirname(real), { recursive: true });
      await fsPromises.writeFile(real, data);
    }, path);
  };

  writeExclusive = async (path: string, data: Uint8Array): Promise<void> => {
    const real = await this.checkContainment(path, 'creation');
    await runFs(async () => {
      await fsPromises.mkdir(nodePath.dirname(real), { recursive: true });
      await fsPromises.writeFile(real, data, { flag: 'wx' });
    }, path);
  };

  writeUtf8 = async (path: string, content: string): Promise<void> => {
    const real = await this.checkContainment(path, 'creation');
    await runFs(async () => {
      await fsPromises.mkdir(nodePath.dirname(real), { recursive: true });
      await fsPromises.writeFile(real, content, 'utf-8');
    }, path);
  };

  exists = async (path: string): Promise<boolean> => {
    const resolved = nodePath.resolve(toAbsolute(path, this.rootDir));
    // Pre-resolve check against the raw rootDir catches obvious traversal
    // (e.g., `../outside`) before touching the disk. Case-folded on
    // Windows via `pathContains`. The post-resolve check against the
    // canonical root is the security gate for symlink and short-name
    // escapes (Phase 14.4).
    if (!pathContains(this.rootDir, resolved, this.isWindowsFn)) {
      throw permissionDenied(path);
    }
    const canonicalRoot = await this.getCanonicalRoot();
    try {
      const real = await fsPromises.realpath(resolved);
      if (!pathContains(canonicalRoot, real, this.isWindowsFn)) {
        throw permissionDenied(path);
      }
      return true;
    } catch (err) {
      if (err instanceof TsgitError) throw err;
      if (isErrnoException(err) && err.code === 'ENOENT') return false;
      // fsPromises.realpath only throws errno exceptions, so any remaining error is mapped.
      throw mapErrno(err as NodeJS.ErrnoException, path);
    }
  };

  stat = async (path: string): Promise<FileStat> => {
    const real = await this.checkContainment(path, 'read');
    return runFs(async () => mapStat(await fsPromises.stat(real, { bigint: true })), path);
  };

  lstat = async (path: string): Promise<FileStat> => {
    const real = await this.checkContainment(path, 'lstat');
    return runFs(async () => mapStat(await fsPromises.lstat(real, { bigint: true })), path);
  };

  readdir = async (path: string): Promise<ReadonlyArray<DirEntry>> => {
    const real = await this.checkContainment(path, 'read');
    return runFs(async () => {
      const entries = await fsPromises.readdir(real, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory(),
        isSymbolicLink: entry.isSymbolicLink(),
      }));
    }, path);
  };

  mkdir = async (path: string): Promise<void> => {
    const real = await this.checkContainment(path, 'creation');
    await runFs(() => fsPromises.mkdir(real, { recursive: true }), path);
  };

  rm = async (path: string): Promise<void> => {
    const real = await this.checkContainment(path, 'read');
    await runFs(() => fsPromises.rm(real), path);
  };

  rename = async (src: string, dst: string): Promise<void> => {
    const realSrc = await this.checkContainment(src, 'read');
    const realDst = await this.checkContainment(dst, 'creation');
    await runFs(async () => {
      await fsPromises.mkdir(nodePath.dirname(realDst), { recursive: true });
      await fsPromises.rename(realSrc, realDst);
    }, src);
  };

  readlink = async (path: string): Promise<string> => {
    const real = await this.checkContainment(path, 'lstat');
    return runFs(() => fsPromises.readlink(real), path);
  };

  symlink = async (target: string, path: string): Promise<void> => {
    const real = await this.checkContainment(path, 'creation');
    await runFs(async () => {
      await fsPromises.mkdir(nodePath.dirname(real), { recursive: true });
      await fsPromises.symlink(target, real);
    }, path);
  };

  chmod = async (path: string, mode: number): Promise<void> => {
    const real = await this.checkContainment(path, 'read');
    await runFs(() => fsPromises.chmod(real, mode), path);
  };

  rmRecursive = async (path: string): Promise<void> => {
    let real: string;
    try {
      real = await this.checkContainment(path, 'lstat');
      // Verify the leaf exists; checkContainment(lstat) realpaths only the parent.
      // A missing leaf surfaces as FILE_NOT_FOUND, which we swallow for idempotency.
      await this.lstat(real);
    } catch (err) {
      if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return;
      throw err;
    }
    await this.removeTree(real, path);
  };

  openWithNoFollow = async (path: string, mode: 'read' | 'write'): Promise<FileHandle> => {
    const real = await this.checkContainment(path, 'lstat');
    const flag = mode === 'write' ? fs.constants.O_WRONLY : fs.constants.O_RDONLY;
    // ELOOP now flows through `mapErrno` (ADR-043) so the POSIX path needs no
    // call-site rewrap. The Windows discriminator is added in Phase 14.4 §3.3
    // — separate commit.
    const handle = await runFs(() => fsPromises.open(real, flag | fs.constants.O_NOFOLLOW), path);
    return wrapNodeHandle(handle);
  };

  private async removeTree(real: string, originalPath: string): Promise<void> {
    // Caller (rmRecursive) verified the leaf exists; on TOCTOU mid-walk a missing child
    // would surface as FILE_NOT_FOUND through runFs, which is acceptable behavior.
    const leafStat = await runFs(() => fsPromises.lstat(real), originalPath);
    if (!leafStat.isDirectory() || leafStat.isSymbolicLink()) {
      // Symlink leaf or regular file: remove the entry itself; do NOT follow it.
      await runFs(() => fsPromises.rm(real, { force: true }), originalPath);
      return;
    }
    const entries = await runFs(
      () => fsPromises.readdir(real, { withFileTypes: true }),
      originalPath,
    );
    for (const entry of entries) {
      const child = nodePath.join(real, entry.name);
      await this.removeTree(child, originalPath);
    }
    await runFs(() => fsPromises.rmdir(real), originalPath);
  }

  private async resolveForCreation(path: string, resolved: string): Promise<string> {
    // realpathNearestExisting already resolved the existing prefix and rethrew any non-ENOENT
    // error, so lstat on `real` here can only succeed (leaf exists) or throw ENOENT (leaf is
    // the to-be-created tail). A symlink leaf is rejected to prevent writes through it.
    const real = await realpathNearestExisting(resolved);
    let lstatResult: { ok: true; isSymlink: boolean } | { ok: false; err: unknown };
    try {
      const leafStat = await fsPromises.lstat(real);
      lstatResult = { ok: true, isSymlink: leafStat.isSymbolicLink() };
    } catch (err) {
      lstatResult = { ok: false, err };
    }
    interpretCreationLstat(lstatResult, path);
    return real;
  }

  private async resolveForMode(
    path: string,
    resolved: string,
    mode: ContainmentMode,
    check: (abs: string) => void,
  ): Promise<string> {
    if (mode === 'read') {
      check(resolved);
      return fsPromises.realpath(resolved);
    }
    if (mode === 'lstat') {
      const parent = await fsPromises.realpath(nodePath.dirname(resolved));
      return nodePath.join(parent, nodePath.basename(resolved));
    }
    return this.resolveForCreation(path, resolved);
  }

  private async checkContainment(path: string, mode: ContainmentMode): Promise<string> {
    const resolved = nodePath.resolve(toAbsolute(path, this.rootDir));
    const canonicalRoot = await this.getCanonicalRoot();
    const check = (abs: string): void => {
      if (!pathContains(canonicalRoot, abs, this.isWindowsFn)) {
        throw permissionDenied(path);
      }
    };
    try {
      const real = await this.resolveForMode(path, resolved, mode, check);
      check(real);
      return real;
    } catch (err) {
      if (err instanceof TsgitError) throw err;
      // All remaining errors come from fsPromises.realpath/lstat and are errno exceptions.
      const errno = err as NodeJS.ErrnoException;
      // equivalent-mutant: flipping `errno.code === 'ENOENT'` to `false`, or mutating the literal
      // to `""`, funnels the error through `mapErrno` below — which also maps ENOENT to
      // `fileNotFound(path)`. The early return is a micro-optimization with identical output.
      if (errno.code === 'ENOENT') throw fileNotFound(path);
      throw mapErrno(errno, path);
    }
  }
}
