import * as fs from 'node:fs';
import type * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  directoryNotEmpty,
  fileExists,
  fileNotFound,
  notADirectory,
  permissionDenied,
  TsgitError,
  unsupportedOperation,
} from '../../domain/index.js';
import { createLruCache } from '../../domain/storage/lru-cache.js';
import type { DirEntry, FileHandle, FileStat, FileSystem } from '../../ports/file-system.js';
import type { FsOperations } from './fs-operations.js';
import { realFsOps } from './fs-operations.js';
import type { PathPolicy } from './path-policy.js';
import { nativePolicy } from './path-policy.js';

type ContainmentMode = 'read' | 'lstat' | 'creation';

/**
 * A normalised containment root paired with its precomputed `+sep` prefix.
 * Bundled together (never as two independent fields) so the prefix can
 * never be read stale relative to the root it was derived from.
 */
interface RootPrefix {
  readonly normalized: string;
  readonly withSep: string;
}

function toRootPrefix(normalized: string, sep: string): RootPrefix {
  return { normalized, withSep: normalized + sep };
}

/**
 * A parent directory's realpath, paired with the containment verdict for
 * that realpath — computed once, right after the realpath resolves, and
 * always read together so the two can never diverge. See
 * `NodeFileSystem.cachedParentRealpath`.
 */
interface ParentRealpathEntry {
  readonly realParent: string;
  readonly contained: boolean;
}

const REMOVE_TREE_CONCURRENCY = 8;

/**
 * Bounded-concurrency map. Issues up to `limit` `fn(item)` calls in
 * parallel; the next item runs as each in-flight call resolves.
 *
 * Error semantics: `Promise.all` short-circuits the returned promise on
 * the first rejection, but JavaScript can't cancel a running async
 * function — surviving workers continue running their current item AND
 * keep picking new items off the shared queue until it is exhausted.
 * So callers observing the rejected `mapConcurrent` should expect
 * additional `fn` invocations after the rejection lands. A second
 * concurrent rejection is silently swallowed by `Promise.all` (only the
 * first is surfaced). The current single caller (`removeTree`) is fine
 * with both properties; any future caller that needs strict
 * bail-on-error must thread an `AbortSignal` of its own.
 *
 * @internal
 */
export async function mapConcurrent<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  // Stryker disable next-line ConditionalExpression: equivalent — removing this fast-path guard (`if (false)`) is a no-op for an empty `items`: `workerCount` becomes `Math.min(limit, 0) === 0`, so zero workers spawn and `Promise.all([])` resolves immediately, exactly like the early return.
  if (items.length === 0) return;
  let next = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = next;
      next += 1;
      // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — when this bound is relaxed (false / `i > items.length`), the only reachable extra index is `i === items.length`, whose `items[i]` is `undefined`, caught by the `item === undefined` guard below; no `fn` call happens either way.
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

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
 * for cross-platform symlink-refusal parity.
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
 * false-positive (parent='/tmp/foo', child='/tmp/foobar').
 *
 * @internal
 */
export function pathContains(
  parent: string,
  child: string,
  policy: PathPolicy = nativePolicy,
): boolean {
  return pathContainsNormalized(policy.normalizeForCompare(parent), child, policy);
}

/**
 * Same predicate as `pathContains`, but the caller has already normalised
 * `parent` once and is willing to keep that result. Saves the per-call
 * `policy.normalizeForCompare(parent)` allocation when `parent` is a value
 * the caller holds constant — typically the adapter's `rootDir` /
 * `canonicalRoot` on the containment hot path.
 *
 * @internal
 */
export function pathContainsNormalized(
  normalizedParent: string,
  child: string,
  policy: PathPolicy = nativePolicy,
): boolean {
  const c = policy.normalizeForCompare(child);
  if (c === normalizedParent) return true;
  return c.startsWith(normalizedParent + policy.sep);
}

/**
 * Same two-arm test as `pathContainsNormalized`, but takes an
 * already-normalised child AND an already-precomputed `normalizedParent +
 * sep` prefix — used on `NodeFileSystem`'s hot path where both the child
 * normalisation and the parent `+sep` concatenation are amortised across
 * the containment check (see `isContainedInEitherRoot`).
 */
function containedByPrefix(
  normalizedChild: string,
  normalizedParent: string,
  parentWithSep: string,
): boolean {
  return normalizedChild === normalizedParent || normalizedChild.startsWith(parentWithSep);
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
    // Stryker disable next-line ConditionalExpression: equivalent — emptying this case's consequent makes EPERM fall through to the next `permissionDenied` arm, yielding the identical TsgitError.
    case 'EPERM':
      return permissionDenied(path);
    // Stryker disable next-line ConditionalExpression: equivalent — emptying this case's consequent makes ELOOP fall through to the EISDIR `permissionDenied` arm, yielding the identical TsgitError.
    case 'ELOOP':
      // POSIX errno for symlink-loop / O_NOFOLLOW refusal; Windows surfaces other
      // errnos handled by the `openWithNoFollow` discriminator.
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
      // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — forcing the join branch (true / `>= 0`) when `remaining` is empty evaluates `policy.join(real, '')`, which returns the already-normalised `real` — identical to the `: real` arm.
      return remaining.length > 0 ? policy.join(real, remaining) : real;
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') continue;
      throw err;
    }
  }
  // All segments were non-existent; anchor at the (always-resolvable) root.
  const realRoot = await fsOps.realpath(root);
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — forcing the join branch (true / `>= 0`) when `segments` is empty evaluates `policy.join(realRoot, '')`, which returns `realRoot` — identical to the `: realRoot` arm.
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
   * Memoised realpath of an *existing* parent directory, keyed by the raw
   * (pre-realpath) parent path, paired with that parent's containment
   * verdict (`isContainedInEitherRoot(realParent, …)`, computed once right
   * after the realpath resolves). The cached value is mode-independent, so
   * this single cache serves BOTH `resolveForCreation` (creation mode) and
   * `resolveForMode`'s lstat arm (lstat mode): a clone/checkout writing N
   * files into the same tree, or a status walk lstat-ing N entries under
   * the same directory, pays the realpath walk-up — and, for the lstat
   * arm, the containment POST-check — once per parent rather than once per
   * file/entry. The verdict is a per-clean-leaf equivalence
   * (`isContainedInEitherRoot(join(realParent, basename))` ≡
   * `isContainedInEitherRoot(realParent)`, see the design doc's proof) and
   * is consulted ONLY by the lstat arm; `read`/`creation` realpath the full
   * leaf and keep their own per-entry post-check.
   *
   * Invariants:
   * - Only EXISTING parents are cached. ENOENT walks fall back to
   *   `realpathNearestExisting` (creation) or propagate (lstat) and are
   *   never recorded.
   * - The realpath and the verdict are set together — never divergent.
   * - `rmRecursive` and `rename` clear the cache (invalidating BOTH the
   *   realpath and the verdict), which is correct (the parent realpath may
   *   have changed) and cheap relative to a re-walk. `rm` clears neither —
   *   a leaf removal does not change the parent's realpath or containment.
   * - Sized to exceed the 256 loose-object fanout directories so a
   *   full-history walk does not thrash the cache.
   */
  private readonly parentRealpathCache = createLruCache<ParentRealpathEntry>(128 * 1024, 512);

  /**
   * Lazy long-name canonicalisation of `rootDir` for containment checks,
   * resolving to the canonical root's `RootPrefix`. Promise so concurrent
   * first calls share one `realpath`; cleared on rejection so a transient
   * ENOENT can be retried.
   */
  private canonicalRootPromise: Promise<RootPrefix> | undefined = undefined;

  /**
   * Memoised `{ normalized, withSep }` pair for `pathPolicy.normalizeForCompare(rootDir)`.
   * The rootDir is `readonly` for the adapter's lifetime, so a single
   * normalisation (and its `+sep` prefix) is amortised across every
   * containment check. Bundled in one field — never two — so the prefix
   * can never diverge from the root it was derived from.
   */
  private normalizedRootDirPrefix: RootPrefix | undefined = undefined;

  constructor(
    rootDir: string,
    pathPolicy: PathPolicy = nativePolicy,
    fsOps: FsOperations = realFsOps,
  ) {
    this.rootDir = rootDir;
    this.pathPolicy = pathPolicy;
    this.fsOps = fsOps;
  }

  /**
   * Lazily normalises `rootDir` and its `+sep` prefix as one bundled
   * `RootPrefix`, memoised for the adapter's lifetime.
   */
  private getRootDirPrefix(): RootPrefix {
    if (this.normalizedRootDirPrefix === undefined) {
      this.normalizedRootDirPrefix = toRootPrefix(
        this.pathPolicy.normalizeForCompare(this.rootDir),
        this.pathPolicy.sep,
      );
    }
    return this.normalizedRootDirPrefix;
  }

  private getNormalizedRootDir(): string {
    return this.getRootDirPrefix().normalized;
  }

  /**
   * Resolves and memoises the canonical-root `RootPrefix`. Returns the
   * bundled `{ normalized, withSep }` value directly from the promise
   * chain — callers thread the returned value onward, so there is no
   * synchronous "trust it's been set" field read: the type system proves
   * the value is defined via the `await`'s return, not a nullable field.
   */
  private async getCanonicalRoot(): Promise<RootPrefix> {
    if (this.canonicalRootPromise === undefined) {
      this.canonicalRootPromise = this.fsOps
        .realpath(this.rootDir)
        .then((canonical) =>
          toRootPrefix(this.pathPolicy.normalizeForCompare(canonical), this.pathPolicy.sep),
        )
        .catch((err: unknown) => {
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
      // Load-bearing: release the descriptor on every exit path so a
      // hot-path caller (pack index lookups) cannot leak FDs.
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

  writeStream = async (path: string, source: AsyncIterable<Uint8Array>): Promise<void> => {
    const real = await this.checkContainment(path, 'creation');
    await runFs(async () => {
      await this.fsOps.mkdir(this.pathPolicy.dirname(real), { recursive: true });
      await pipeline(source, fs.createWriteStream(real));
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

  appendUtf8 = async (path: string, content: string): Promise<void> => {
    const real = await this.checkContainment(path, 'creation');
    await runFs(async () => {
      await this.fsOps.mkdir(this.pathPolicy.dirname(real), { recursive: true });
      await this.fsOps.appendFile(real, content, 'utf-8');
    }, path);
  };

  exists = async (path: string): Promise<boolean> => {
    const resolved = this.pathPolicy.resolve(toAbsolute(path, this.rootDir, this.pathPolicy));
    const normalizedRoot = this.getNormalizedRootDir();
    const normalizedCanonical = (await this.getCanonicalRoot()).normalized;
    try {
      // Post-realpath check is the security gate against symlink escapes
      // and 8.3 short-name aliasing.
      const real = await this.fsOps.realpath(resolved);
      if (!pathContainsNormalized(normalizedCanonical, real, this.pathPolicy)) {
        throw permissionDenied(path);
      }
      return true;
    } catch (err) {
      // Stryker disable next-line ConditionalExpression: equivalent — a TsgitError is never an ErrnoException (no own `code`), so skipping this early rethrow lands it at the final `throw err` with the identical instance.
      if (err instanceof TsgitError) throw err;
      if (isErrnoException(err) && err.code === 'ENOENT') {
        // ENOENT — the resolved path doesn't exist. But the caller might be
        // probing `../outside`: verify the path WOULD have been inside the
        // root if it existed. Check against BOTH raw and canonical roots so
        // callers can pass paths in either form when rootDir's parent is
        // 8.3-shortened on Windows.
        if (
          !pathContainsNormalized(normalizedRoot, resolved, this.pathPolicy) &&
          !pathContainsNormalized(normalizedCanonical, resolved, this.pathPolicy)
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
    // Use 'lstat' mode (resolves parent via realpath, joins basename without
    // following the leaf) so dangling symlinks — whose realpath would fail —
    // can be removed. A regular file's containment is still verified via its
    // parent directory, which is the same security guarantee.
    const real = await this.checkContainment(path, 'lstat');
    await runFs(() => this.fsOps.rm(real), path);
    // Node's `fs.rm` without `recursive` only removes leaves — a regular
    // file or symlink. The parent directory and its realpath are
    // unchanged, so the parent-realpath cache entry for `dirname(real)`
    // remains valid. No invalidation needed.
  };

  rename = async (src: string, dst: string): Promise<void> => {
    const realSrc = await this.checkContainment(src, 'read');
    const realDst = await this.checkContainment(dst, 'creation');
    await runFs(async () => {
      await this.fsOps.mkdir(this.pathPolicy.dirname(realDst), { recursive: true });
      await this.fsOps.rename(realSrc, realDst);
    }, src);
    this.parentRealpathCache.clear();
  };

  readlink = async (path: string): Promise<string> => {
    const real = await this.checkContainment(path, 'lstat');
    return runFs(() => this.fsOps.readlink(real), path);
  };

  symlink = async (target: string, path: string): Promise<void> => {
    // Absolute targets must point inside rootDir. Without this gate, a
    // malicious tree could plant a `/etc/passwd`-style symlink that
    // subsequent `readlink` exfiltrates. Relative targets are not
    // validated at create time — they are resolved against the link
    // entry's directory at OS-read time, and any follow-up `read`/`stat`
    // re-realpaths the leaf and re-checks containment.
    if (this.pathPolicy.isAbsolute(target)) {
      // Lexical normalisation alone is insufficient: a Windows directory
      // junction (`C:\repo\junction` → `C:\outside`) lexically passes the
      // prefix check but the OS-resolved path lands outside rootDir.
      // Resolve symlinks/junctions in the target's existing prefix and
      // compare the *real* path. The resolve only ever expands the target
      // — never the link entry, which doesn't exist yet.
      const lexical = this.pathPolicy.resolve(target);
      const resolvedTarget = await realpathNearestExisting(lexical, this.pathPolicy, this.fsOps);
      const normalizedRoot = this.getNormalizedRootDir();
      const normalizedCanonical = (await this.getCanonicalRoot()).normalized;
      if (
        !pathContainsNormalized(normalizedRoot, resolvedTarget, this.pathPolicy) &&
        !pathContainsNormalized(normalizedCanonical, resolvedTarget, this.pathPolicy)
      ) {
        throw permissionDenied(path);
      }
    }
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
    this.parentRealpathCache.clear();
  };

  openWithNoFollow = async (path: string, mode: 'read' | 'write'): Promise<FileHandle> => {
    const real = await this.checkContainment(path, 'lstat');
    // Windows: `O_NOFOLLOW` is silently ignored by the underlying Win32 API
    // (Node forwards the flag but CreateFile has no equivalent), so the
    // kernel follows the symlink and opens the target. We must refuse
    // upfront when the leaf IS a symlink. ELOOP flows through `mapErrno` to
    // PERMISSION_DENIED on POSIX; Windows needs the proactive
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
    // through the `PathPolicy` + `FsOperations` DI seam)
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
    await mapConcurrent(entries, REMOVE_TREE_CONCURRENCY, (entry) =>
      this.removeTree(this.pathPolicy.join(real, entry.name), originalPath),
    );
    await runFs(() => this.fsOps.rmdir(real), originalPath);
  }

  private async resolveForCreation(
    path: string,
    resolved: string,
    root: RootPrefix,
    canonicalRoot: RootPrefix,
  ): Promise<string> {
    // realpathNearestExisting already resolved the existing prefix and rethrew any non-ENOENT
    // error, so lstat on `real` here can only succeed (leaf exists) or throw ENOENT (leaf is
    // the to-be-created tail). A symlink leaf is rejected to prevent writes through it.
    const real = await this.realpathForCreation(resolved, root, canonicalRoot);
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

  // Shared by `realpathForCreation` and the `resolveForMode` lstat arm: a
  // status/walk touching many entries under the same directory pays the
  // parent realpath — and the lstat arm's containment verdict — once, not
  // once per entry. The leaf itself is never cached — only the parent
  // directory realpath and its verdict. Throws on ENOENT (the `.set` below
  // only runs after a successful await, so a failed realpath is never
  // cached) — callers that need a fallback catch it themselves.
  private async cachedParentRealpath(
    parent: string,
    root: RootPrefix,
    canonicalRoot: RootPrefix,
  ): Promise<ParentRealpathEntry> {
    const cached = this.parentRealpathCache.get(parent);
    if (cached !== undefined) {
      return cached;
    }
    const realParent = await this.fsOps.realpath(parent);
    const entry: ParentRealpathEntry = {
      realParent,
      contained: this.isContainedInEitherRoot(realParent, root, canonicalRoot),
    };
    this.parentRealpathCache.set(parent, entry, parent.length + realParent.length);
    return entry;
  }

  private async realpathForCreation(
    resolved: string,
    root: RootPrefix,
    canonicalRoot: RootPrefix,
  ): Promise<string> {
    // Fast path: parent already cached. The leaf realpath is meaningless
    // for creation (the leaf often doesn't exist yet), so we cache the
    // parent only and join the basename. Creation's own post-check (in
    // `checkContainment`) verifies containment on the joined leaf itself;
    // the cached `.contained` verdict is populated for a possible later
    // lstat under the same parent but is not consulted here.
    const parent = this.pathPolicy.dirname(resolved);
    const basename = this.pathPolicy.basename(resolved);
    // Cache miss falls through to a direct parent realpath — when the
    // parent exists this is a single call instead of the full walk-up.
    try {
      const { realParent } = await this.cachedParentRealpath(parent, root, canonicalRoot);
      return this.pathPolicy.join(realParent, basename);
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') {
        // Parent doesn't exist yet — fall back to the slow walk-up.
        // NOT cached: a half-built tree's "doesn't exist" decision must
        // not freeze.
        return realpathNearestExisting(resolved, this.pathPolicy, this.fsOps);
      }
      throw err;
    }
  }

  /**
   * Resolves `resolved` to its real, containment-checkable form. `contained`
   * is `undefined` for `read`/`creation` — those arms realpath a full leaf,
   * so `checkContainment` still runs its own per-entry POST-check on the
   * returned `real`. For `lstat`, `contained` carries the per-parent
   * verdict `cachedParentRealpath` already computed (once per parent,
   * proven verdict-identical to a per-entry check for a single clean leaf)
   * — `checkContainment` consults it directly instead of re-normalising.
   */
  private async resolveForMode(
    path: string,
    resolved: string,
    mode: ContainmentMode,
    root: RootPrefix,
    canonicalRoot: RootPrefix,
  ): Promise<{ real: string; contained: boolean | undefined }> {
    if (mode === 'read') {
      if (!this.isContainedInEitherRoot(resolved, root, canonicalRoot)) {
        throw permissionDenied(path);
      }
      const real = await this.fsOps.realpath(resolved);
      return { real, contained: undefined };
    }
    if (mode === 'lstat') {
      // Mirror the `read` arm: fail-fast on obviously out-of-tree input
      // BEFORE issuing the realpath I/O. Without this gate, an absolute
      // escape path (`../../etc`) would still walk through
      // `realpath(dirname)` before the post-check catches it.
      const verdict = this.containmentVerdict(resolved, root, canonicalRoot);
      if (!verdict.contained) {
        throw permissionDenied(path);
      }
      // The parent realpath — and its containment verdict — are cached
      // (shared with `realpathForCreation` via `cachedParentRealpath`).
      // ENOENT propagates to the caller here (no fallback), unlike the
      // creation path.
      const parent = this.pathPolicy.dirname(resolved);
      const basename = this.pathPolicy.basename(resolved);
      const { realParent, contained } = await this.cachedParentRealpath(
        parent,
        root,
        canonicalRoot,
      );
      // The per-parent verdict equivalence (`contained(join(realParent,
      // basename)) === contained(realParent)`) holds for every leaf
      // STRICTLY UNDER a root, but not when `resolved` IS a root itself:
      // `dirname(rootDir)` is the root's own parent, which is never
      // "contained in rootDir" even though `rootDir` trivially is (the
      // `===` arm) — so the cached per-parent verdict here would
      // false-deny an exact-root leaf. The exact-root leaf is therefore
      // the ONE exception to the per-parent equivalence: report
      // `contained: undefined` so `checkContainment`'s
      // `contained ?? isContainedInEitherRoot(real, …)` runs the FULL
      // per-entry post-check on the realpath'd `real` instead of trusting
      // the (inapplicable) per-parent verdict. This reproduces the
      // pre-per-parent-cache behaviour: a rootDir that is itself a symlink
      // pointing outside its own tree is DENIED, because `real` — built
      // from the SAME `realParent`/`basename` join as any other leaf — is
      // then checked against both roots on its own merits.
      return {
        real: this.pathPolicy.join(realParent, basename),
        contained: verdict.isExactRoot ? undefined : contained,
      };
    }
    const real = await this.resolveForCreation(path, resolved, root, canonicalRoot);
    return { real, contained: undefined };
  }

  /**
   * `abs` is normalised ONCE (not once per root) and compared against
   * both roots' precomputed `+sep` prefixes. Both the `=== root` equality
   * arm and the `startsWith(root + sep)` prefix arm are retained per
   * root — dropping either changes the verdict (a bare `startsWith(root)`
   * would admit the prefix-only sibling `root-evil`). Both roots are
   * passed in as already-resolved `RootPrefix` values — no field read-back.
   */
  private isContainedInEitherRoot(
    abs: string,
    root: RootPrefix,
    canonicalRoot: RootPrefix,
  ): boolean {
    return this.containmentVerdict(abs, root, canonicalRoot).contained;
  }

  /**
   * Single source of truth for the two-root, two-arm containment test —
   * `isContainedInEitherRoot` and the lstat arm's PRE-check both delegate
   * here so the "is `abs` exactly one of the roots" fact (needed by the
   * lstat arm's exact-root shortcut) is derived from the SAME normalise
   * call as the containment verdict, not a second one.
   */
  private containmentVerdict(
    abs: string,
    root: RootPrefix,
    canonicalRoot: RootPrefix,
  ): { contained: boolean; isExactRoot: boolean } {
    const c = this.pathPolicy.normalizeForCompare(abs);
    const isExactRoot = c === root.normalized || c === canonicalRoot.normalized;
    const contained =
      isExactRoot ||
      containedByPrefix(c, root.normalized, root.withSep) ||
      containedByPrefix(c, canonicalRoot.normalized, canonicalRoot.withSep);
    return { contained, isExactRoot };
  }

  private async checkContainment(path: string, mode: ContainmentMode): Promise<string> {
    // `policy.resolve` normalises embedded `..`/`.` segments AND foreign
    // separators (a `/` on Windows). The adapter is contractually allowed
    // to receive mixed-separator input; resolving here produces a
    // platform-native form so the containment prefix-check compares
    // like-for-like.
    const resolved = this.pathPolicy.resolve(toAbsolute(path, this.rootDir, this.pathPolicy));
    // Containment passes if `abs` is inside EITHER the raw rootDir (which
    // matches user-supplied paths with the same short-name form as the
    // constructor argument) OR the canonical rootDir (which matches paths
    // produced by `realpath` after short-name expansion). Without the
    // OR, a Windows user passing a short-name input would hit the pre-resolve
    // check against the canonical long-name root and fail spuriously.
    //
    // Both parents are constant for the call's lifetime; we hold their
    // normalised forms as instance fields so the case-fold allocation on
    // the hot path runs once per parent rather than once per containment
    // check. `getCanonicalRoot()` returns the resolved `RootPrefix`
    // directly — the awaited value is threaded onward, never read back
    // off the instance.
    const rootPrefix = this.getRootDirPrefix();
    const canonicalRootPrefix = await this.getCanonicalRoot();
    try {
      const { real, contained } = await this.resolveForMode(
        path,
        resolved,
        mode,
        rootPrefix,
        canonicalRootPrefix,
      );
      // `contained !== undefined` means `resolveForMode` already produced
      // the lstat arm's per-parent verdict (B3) — trust it and skip the
      // redundant per-entry recomputation. `read`/`creation` return
      // `undefined` and fall through to the per-entry POST-check, since
      // their `real` is a full-leaf realpath (the clean-single-leaf
      // equivalence B3 relies on does not hold for them).
      const isContained =
        contained ?? this.isContainedInEitherRoot(real, rootPrefix, canonicalRootPrefix);
      if (!isContained) {
        throw permissionDenied(path);
      }
      return real;
    } catch (err) {
      // Stryker disable next-line ConditionalExpression: equivalent — a TsgitError is never an ErrnoException (no own `code`), so skipping this early rethrow lands it at the final `throw err` with the identical instance.
      if (err instanceof TsgitError) throw err;
      // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent — bypassing this ENOENT short-circuit (false / `""`) funnels the error through `mapErrno` below, whose ENOENT arm also returns `fileNotFound(path)`; identical output.
      if (isErrnoException(err) && err.code === 'ENOENT') throw fileNotFound(path);
      if (isErrnoException(err)) throw mapErrno(err, path);
      throw err;
    }
  }

  homedir(): string {
    return os.homedir();
  }

  xdgConfigHome(): string {
    const explicit = process.env.XDG_CONFIG_HOME;
    if (explicit !== undefined && explicit.length > 0) return explicit;
    return path.join(os.homedir(), '.config');
  }

  systemConfigPath(): string {
    if (process.platform === 'win32') {
      const programData = process.env.ProgramData ?? 'C:\\ProgramData';
      return `${programData}\\Git\\config`;
    }
    return '/etc/gitconfig';
  }
}
