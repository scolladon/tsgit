import * as fs from 'node:fs';
import type * as fsPromises from 'node:fs/promises';
import {
  directoryNotEmpty,
  fileExists,
  fileNotFound,
  notADirectory,
  permissionDenied,
  TsgitError,
  unsupportedOperation,
} from '../../domain/index.js';
import type { DirEntry, FileHandle, FileStat, FileSystem } from '../../ports/file-system.js';
import type { FsOperations } from './fs-operations.js';
import { realFsOps } from './fs-operations.js';
import type { PathPolicy } from './path-policy.js';
import { nativePolicy } from './path-policy.js';

type ContainmentMode = 'read' | 'lstat' | 'creation';

/** @internal */
export function toAbsolute(
  path: string,
  rootDir: string,
  policy: PathPolicy = nativePolicy,
): string {
  return policy.isAbsolute(path) ? path : policy.join(rootDir, path);
}

/** @internal */
export function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * On Windows, `O_NOFOLLOW` against a symlink leaf surfaces as `EACCES`,
 * `EPERM`, or `EISDIR` depending on the link target — `mapErrno` cannot
 * disambiguate without knowing whether the leaf is a symlink. This helper
 * accepts the pre-open `lstat` result and the post-open error, and
 * returns true iff the error should be rewrapped to `PERMISSION_DENIED`
 * for cross-platform symlink-refusal parity (ADR-043).
 *
 * @internal
 */
export function isWindowsSymlinkRefusal(err: unknown, policy: PathPolicy = nativePolicy): boolean {
  // Discriminator only fires on case-insensitive (Windows) platforms.
  // POSIX symlink refusal flows through `mapErrno` directly via `ELOOP`.
  if (!policy.caseInsensitive) return false;
  if (!(err instanceof TsgitError)) return false;
  return err.data.code === 'PERMISSION_DENIED' || err.data.code === 'UNSUPPORTED_OPERATION';
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
  policy: PathPolicy = nativePolicy,
): boolean {
  const p = policy.normalizeForCompare(parent);
  const c = policy.normalizeForCompare(child);
  if (c === p) return true;
  return c.startsWith(p + policy.sep);
}

/** @internal */
export function mapErrno(err: NodeJS.ErrnoException, path: string): TsgitError {
  switch (err.code) {
    case 'ENOENT':
      return fileNotFound(path);
    case 'EEXIST':
      return fileExists(path);
    case 'ENOTDIR':
      return notADirectory(path);
    case 'ENOTEMPTY':
      // "rmdir on a non-empty directory" is semantically distinct from
      // "the path is the wrong shape" — callers branching on the code
      // (e.g., to decide between abort vs. force-recursive) need both.
      return directoryNotEmpty(path);
    case 'EACCES':
    case 'EPERM':
      return permissionDenied(path);
    case 'ELOOP':
      // POSIX errno for symlink-loop / O_NOFOLLOW refusal; Windows surfaces other
      // errnos handled by the `openWithNoFollow` discriminator (ADR-043).
      return permissionDenied(path);
    case 'EISDIR':
      // POSIX errno for "is a directory" — surfaces from open(dir, write-flag).
      // Map to PERMISSION_DENIED so both POSIX and Windows symlink-to-directory
      // refusals share the same cross-platform code.
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

export async function realpathNearestExisting(
  absolute: string,
  policy: PathPolicy = nativePolicy,
  fsOps: FsOperations = realFsOps,
): Promise<string> {
  // `policy.rootOf` returns the platform-correct root prefix: `/` on POSIX,
  // `'C:\\'` (or `'\\\\server\\share\\'`) on Windows. The previous
  // `nodePath.sep + segments.join(sep)` construction produced invalid
  // `\C:\Users\…` paths on Windows.
  const root = policy.rootOf(absolute);
  const tail = absolute.slice(root.length);
  const segments = tail.split(policy.sep).filter(Boolean);
  for (let i = segments.length; i > 0; i--) {
    const candidate = root + segments.slice(0, i).join(policy.sep);
    try {
      const real = await fsOps.realpath(candidate);
      const remaining = segments.slice(i).join(policy.sep);
      // equivalent-mutant: relaxing `remaining.length > 0` to `>= 0` keeps the
      // join branch, and `policy.join(real, '')` returns `real` — so both
      // branches yield the same path when the remaining tail is empty.
      return remaining.length > 0 ? policy.join(real, remaining) : real;
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') continue;
      throw err;
    }
  }
  // All segments were non-existent; anchor at the (always-resolvable) root.
  const realRoot = await fsOps.realpath(root);
  // equivalent-mutant: relaxing `segments.length > 0` to `>= 0` keeps the join
  // branch — and `policy.join(realRoot, '')` returns `realRoot`, so the empty
  // segments case still returns the same value as the explicit `: realRoot` arm.
  return segments.length > 0 ? policy.join(realRoot, segments.join(policy.sep)) : realRoot;
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

  private readonly pathPolicy: PathPolicy;

  private readonly fsOps: FsOperations;

  /**
   * Lazy long-name canonicalisation of `rootDir` for containment checks.
   * Promise so concurrent first calls share one `realpath`; cleared on
   * rejection so a transient ENOENT can be retried. See ADR-042.
   */
  private canonicalRootPromise: Promise<string> | undefined = undefined;

  constructor(
    rootDir: string,
    pathPolicy: PathPolicy = nativePolicy,
    fsOps: FsOperations = realFsOps,
  ) {
    this.rootDir = rootDir;
    this.pathPolicy = pathPolicy;
    this.fsOps = fsOps;
  }

  private async getCanonicalRoot(): Promise<string> {
    if (this.canonicalRootPromise === undefined) {
      this.canonicalRootPromise = this.fsOps.realpath(this.rootDir).catch((err: unknown) => {
        this.canonicalRootPromise = undefined;
        throw err;
      });
    }
    return this.canonicalRootPromise;
  }

  read = async (path: string): Promise<Uint8Array> => {
    const real = await this.checkContainment(path, 'read');
    return runFs(async () => new Uint8Array(await this.fsOps.readFile(real)), path);
  };

  readSlice = async (path: string, offset: number, length: number): Promise<Uint8Array> => {
    if (offset < 0 || length < 0) throw permissionDenied(path);
    const real = await this.checkContainment(path, 'read');
    let handle: fsPromises.FileHandle | undefined;
    try {
      return await runFs(async () => {
        handle = await this.fsOps.open(real, 'r');
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
    return runFs(() => this.fsOps.readFile(real, 'utf-8'), path);
  };

  write = async (path: string, data: Uint8Array): Promise<void> => {
    const real = await this.checkContainment(path, 'creation');
    await runFs(async () => {
      await this.fsOps.mkdir(this.pathPolicy.dirname(real), { recursive: true });
      await this.fsOps.writeFile(real, data);
    }, path);
  };

  writeExclusive = async (path: string, data: Uint8Array): Promise<void> => {
    const real = await this.checkContainment(path, 'creation');
    await runFs(async () => {
      await this.fsOps.mkdir(this.pathPolicy.dirname(real), { recursive: true });
      await this.fsOps.writeFile(real, data, { flag: 'wx' });
    }, path);
  };

  writeUtf8 = async (path: string, content: string): Promise<void> => {
    const real = await this.checkContainment(path, 'creation');
    await runFs(async () => {
      await this.fsOps.mkdir(this.pathPolicy.dirname(real), { recursive: true });
      await this.fsOps.writeFile(real, content, 'utf-8');
    }, path);
  };

  exists = async (path: string): Promise<boolean> => {
    const resolved = this.pathPolicy.resolve(toAbsolute(path, this.rootDir, this.pathPolicy));
    const canonicalRoot = await this.getCanonicalRoot();
    try {
      // Post-realpath check is the security gate against symlink escapes
      // and 8.3 short-name aliasing. Phase 14.4.
      const real = await this.fsOps.realpath(resolved);
      if (!pathContains(canonicalRoot, real, this.pathPolicy)) {
        throw permissionDenied(path);
      }
      return true;
    } catch (err) {
      if (err instanceof TsgitError) throw err;
      if (isErrnoException(err) && err.code === 'ENOENT') {
        // ENOENT — the resolved path doesn't exist. But the caller might be
        // probing `../outside`: verify the path WOULD have been inside the
        // root if it existed. Check against BOTH raw and canonical roots so
        // callers can pass paths in either form when rootDir's parent is
        // 8.3-shortened on Windows.
        if (
          !pathContains(this.rootDir, resolved, this.pathPolicy) &&
          !pathContains(canonicalRoot, resolved, this.pathPolicy)
        ) {
          throw permissionDenied(path);
        }
        return false;
      }
      if (isErrnoException(err)) throw mapErrno(err, path);
      throw err;
    }
  };

  stat = async (path: string): Promise<FileStat> => {
    const real = await this.checkContainment(path, 'read');
    return runFs(async () => mapStat(await this.fsOps.stat(real, { bigint: true })), path);
  };

  lstat = async (path: string): Promise<FileStat> => {
    const real = await this.checkContainment(path, 'lstat');
    return runFs(async () => mapStat(await this.fsOps.lstat(real, { bigint: true })), path);
  };

  readdir = async (path: string): Promise<ReadonlyArray<DirEntry>> => {
    const real = await this.checkContainment(path, 'read');
    return runFs(async () => {
      const entries = await this.fsOps.readdir(real, { withFileTypes: true });
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
    await runFs(() => this.fsOps.mkdir(real, { recursive: true }), path);
  };

  rm = async (path: string): Promise<void> => {
    const real = await this.checkContainment(path, 'read');
    await runFs(() => this.fsOps.rm(real), path);
  };

  rename = async (src: string, dst: string): Promise<void> => {
    const realSrc = await this.checkContainment(src, 'read');
    const realDst = await this.checkContainment(dst, 'creation');
    await runFs(async () => {
      await this.fsOps.mkdir(this.pathPolicy.dirname(realDst), { recursive: true });
      await this.fsOps.rename(realSrc, realDst);
    }, src);
  };

  readlink = async (path: string): Promise<string> => {
    const real = await this.checkContainment(path, 'lstat');
    return runFs(() => this.fsOps.readlink(real), path);
  };

  symlink = async (target: string, path: string): Promise<void> => {
    const real = await this.checkContainment(path, 'creation');
    await runFs(async () => {
      await this.fsOps.mkdir(this.pathPolicy.dirname(real), { recursive: true });
      await this.fsOps.symlink(target, real);
    }, path);
  };

  chmod = async (path: string, mode: number): Promise<void> => {
    const real = await this.checkContainment(path, 'read');
    await runFs(() => this.fsOps.chmod(real, mode), path);
  };

  rmRecursive = async (path: string): Promise<void> => {
    let real: string;
    try {
      real = await this.checkContainment(path, 'lstat');
      // Verify the leaf exists. Call `fsOps.lstat` directly — `real` is
      // already a contained, canonical-prefix path; re-entering the
      // public `lstat` method would re-run checkContainment for no
      // benefit. ENOENT surfaces as FILE_NOT_FOUND via runFs, which we
      // swallow for idempotency.
      await runFs(() => this.fsOps.lstat(real), path);
    } catch (err) {
      if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return;
      throw err;
    }
    await this.removeTree(real, path);
  };

  openWithNoFollow = async (path: string, mode: 'read' | 'write'): Promise<FileHandle> => {
    const real = await this.checkContainment(path, 'lstat');
    // Windows: `O_NOFOLLOW` is silently ignored by the underlying Win32 API
    // (Node forwards the flag but CreateFile has no equivalent), so the
    // kernel follows the symlink and opens the target. We must refuse
    // upfront when the leaf IS a symlink. ELOOP flows through `mapErrno` to
    // PERMISSION_DENIED on POSIX (ADR-043); Windows needs the proactive
    // refusal + the discriminator (for errno-bearing failures like EACCES
    // on a symlink target inside an inaccessible parent).
    if (this.pathPolicy.caseInsensitive && (await this.isSymlinkLeaf(real))) {
      throw permissionDenied(path);
    }

    const flag = mode === 'write' ? fs.constants.O_WRONLY : fs.constants.O_RDONLY;
    const handle = await runFs(
      () => this.fsOps.open(real, flag | fs.constants.O_NOFOLLOW),
      path,
    ).catch((err: unknown) => {
      // Defensive: if a symlink slips past the upfront check (TOCTOU between
      // isSymlinkLeaf and open), the discriminator rewraps any EACCES /
      // UNSUPPORTED_OPERATION into PERMISSION_DENIED so callers get a
      // single cross-platform code for symlink refusal.
      if (isWindowsSymlinkRefusal(err, this.pathPolicy)) {
        throw permissionDenied(path);
      }
      throw err;
    });
    return wrapNodeHandle(handle);
  };

  private async isSymlinkLeaf(real: string): Promise<boolean> {
    // equivalent-mutant: this method is only called when
    // `pathPolicy.caseInsensitive` is true (Windows). On the Linux mutation
    // runner the body is unreachable, so mutating returns/catch produces
    // no observable effect. Windows-mocked tests in
    // `node-file-system-injected.test.ts` (via `windowsPolicy` injected
    // through the `PathPolicy` + `FsOperations` DI seam — ADR-046/047)
    // cover both arms.
    try {
      const stat = await this.fsOps.lstat(real);
      return stat.isSymbolicLink();
    } catch (err) {
      // TOCTOU: the leaf may have been removed between checkContainment's
      // resolveForMode and this lstat. ENOENT is safe to swallow — the
      // subsequent open call will surface its own errno. Other errors
      // (EACCES, EIO) indicate a genuine I/O fault that callers must see.
      if (isErrnoException(err) && err.code === 'ENOENT') return false;
      throw err;
    }
  }

  private async removeTree(real: string, originalPath: string): Promise<void> {
    // Caller (rmRecursive) verified the leaf exists; on TOCTOU mid-walk a missing child
    // would surface as FILE_NOT_FOUND through runFs, which is acceptable behavior.
    const leafStat = await runFs(() => this.fsOps.lstat(real), originalPath);
    if (!leafStat.isDirectory() || leafStat.isSymbolicLink()) {
      // Symlink leaf or regular file: remove the entry itself; do NOT follow it.
      await runFs(() => this.fsOps.rm(real, { force: true }), originalPath);
      return;
    }
    const entries = await runFs(
      () => this.fsOps.readdir(real, { withFileTypes: true }),
      originalPath,
    );
    for (const entry of entries) {
      const child = this.pathPolicy.join(real, entry.name);
      await this.removeTree(child, originalPath);
    }
    await runFs(() => this.fsOps.rmdir(real), originalPath);
  }

  private async resolveForCreation(path: string, resolved: string): Promise<string> {
    // realpathNearestExisting already resolved the existing prefix and rethrew any non-ENOENT
    // error, so lstat on `real` here can only succeed (leaf exists) or throw ENOENT (leaf is
    // the to-be-created tail). A symlink leaf is rejected to prevent writes through it.
    const real = await realpathNearestExisting(resolved, this.pathPolicy, this.fsOps);
    let lstatResult: { ok: true; isSymlink: boolean } | { ok: false; err: unknown };
    try {
      const leafStat = await this.fsOps.lstat(real);
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
      return this.fsOps.realpath(resolved);
    }
    if (mode === 'lstat') {
      // Mirror the `read` arm: fail-fast on obviously out-of-tree input
      // BEFORE issuing the realpath I/O. Without this gate, an absolute
      // escape path (`../../etc`) would still walk through
      // `realpath(dirname)` before the post-check catches it.
      check(resolved);
      const parent = await this.fsOps.realpath(this.pathPolicy.dirname(resolved));
      return this.pathPolicy.join(parent, this.pathPolicy.basename(resolved));
    }
    return this.resolveForCreation(path, resolved);
  }

  private async checkContainment(path: string, mode: ContainmentMode): Promise<string> {
    const resolved = this.pathPolicy.resolve(toAbsolute(path, this.rootDir, this.pathPolicy));
    const canonicalRoot = await this.getCanonicalRoot();
    // Containment passes if `abs` is inside EITHER the raw rootDir (which
    // matches user-supplied paths with the same short-name form as the
    // constructor argument) OR the canonical rootDir (which matches paths
    // produced by `realpath` after short-name expansion). Without the
    // OR, a Windows user passing a short-name input would hit the pre-resolve
    // check against the canonical long-name root and fail spuriously.
    const check = (abs: string): void => {
      if (
        !pathContains(this.rootDir, abs, this.pathPolicy) &&
        !pathContains(canonicalRoot, abs, this.pathPolicy)
      ) {
        throw permissionDenied(path);
      }
    };
    try {
      const real = await this.resolveForMode(path, resolved, mode, check);
      check(real);
      return real;
    } catch (err) {
      if (err instanceof TsgitError) throw err;
      // equivalent-mutant: flipping `errno.code === 'ENOENT'` to `false`, or mutating the literal
      // to `""`, funnels the error through `mapErrno` below — which also maps ENOENT to
      // `fileNotFound(path)`. The early return is a micro-optimization with identical output.
      if (isErrnoException(err) && err.code === 'ENOENT') throw fileNotFound(path);
      if (isErrnoException(err)) throw mapErrno(err, path);
      throw err;
    }
  }
}
