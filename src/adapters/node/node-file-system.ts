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
 * The adapter's containment roots in the two forms the checks consume:
 * `canonical` (every root's realpath — the post-realpath escape gate) and
 * `all` (raw ∪ canonical — the lexical gate, which must accept a path
 * supplied in either form). Bundled in ONE record so a check can never read
 * a raw prefix that has drifted from the canonical set it was resolved with.
 */
interface RootSet {
  readonly canonical: ReadonlyArray<RootPrefix>;
  readonly all: ReadonlyArray<RootPrefix>;
}

/**
 * Union of two prefix lists, deduped by normalised form — raw and canonical
 * coincide for every root without a symlinked or 8.3-shortened component, and
 * carrying both copies would double the containment loop for no verdict
 * change. `withSep` is derived from `normalized`, so equal keys carry equal
 * values and the surviving entry is interchangeable. Keyed through a `Map` so
 * the dedupe is structural, not an optional filtering step.
 */
function unionRootPrefixes(
  raw: ReadonlyArray<RootPrefix>,
  canonical: ReadonlyArray<RootPrefix>,
): ReadonlyArray<RootPrefix> {
  const byNormalized = new Map<string, RootPrefix>();
  for (const prefix of [...raw, ...canonical]) byNormalized.set(prefix.normalized, prefix);
  return [...byNormalized.values()];
}

const REMOVE_TREE_CONCURRENCY = 8;

/**
 * Numeric `open`/`writeFile` flags for the write guard's W2 leaf no-follow:
 * `O_NOFOLLOW` refuses a symlink leaf atomically at the syscall, closing the
 * TOCTOU window between a pre-write `lstat` and the write and costing one
 * fewer syscall per write. Ignored by Windows (the pre-write `lstat` fallback
 * in `assertLeafSafeToWrite` covers that platform instead).
 */
const WRITE_CREATE_FLAGS =
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
const WRITE_EXCLUSIVE_FLAGS =
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
const APPEND_FLAGS =
  fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW;

/**
 * `@types/node` types `WriteStreamOptions.flags` as `string`, but Node's own
 * implementation (`stringToFlags`) returns a numeric `flags` argument
 * unchanged rather than string-parsing it — verified against Node's source,
 * not guessed. A numeric flag is the only way to compose `O_NOFOLLOW` into
 * `writeStream`'s open; no string flag alias expresses it.
 */
type WriteStreamNumericFlags = Omit<fs.WriteStreamOptions, 'flags'> & { readonly flags: number };

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
 * strictly inside `parent`. Defends `NodeFileSystem.resolveWrite` against
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
 * the caller holds constant.
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
 * the containment check (see `isContainedInAnyRoot`).
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
  /**
   * Every containment root this adapter admits. A path is contained when it
   * is inside ANY of them — the set is the repository layout's own roots
   * (`workDir`, `gitDir`, `commonDir`), never a common ancestor of them: for
   * a linked worktree that ancestor is an unrelated parent directory, and
   * for a cross-top-level layout it degrades to the filesystem root, turning
   * the realpath gate into a no-op.
   */
  private readonly rootDirs: ReadonlyArray<string>;

  /**
   * The PRIMARY root — the first entry of `rootDirs`. Base for resolving a
   * caller's relative path (`toAbsolute`); containment itself always
   * consults the whole set.
   */
  private readonly rootDir: string;

  private readonly pathPolicy: PathPolicy;

  private readonly fsOps: FsOperations;

  /**
   * Memoised realpath of an *existing* parent directory, keyed by the raw
   * (pre-realpath) parent path. Every write surface shares this one cache
   * via `realpathForCreation`: a clone/checkout writing N files into the
   * same tree, or an `rm`/`rmRecursive` walk removing N entries under it,
   * pays the realpath walk-up once per parent rather than once per
   * file/entry. Containment itself is never cached here — `resolveWrite`
   * re-checks the joined leaf against the root set on every call, so a
   * stale verdict can never be served.
   *
   * Invariants:
   * - The key is the parent path alone: the root set is resolved once and
   *   frozen for the adapter's lifetime (every root contributes a canonical
   *   prefix, missing ones via their nearest existing ancestor), so every
   *   cached realpath shares one root set.
   * - Only EXISTING parents are cached. ENOENT walks fall back to
   *   `realpathNearestExisting` and are never recorded.
   * - `rmRecursive` and `rename` clear the cache (the parent realpath may
   *   have changed), which is cheap relative to a re-walk. `rm` clears
   *   nothing — a leaf removal does not change the parent's realpath.
   * - Sized to exceed the 256 loose-object fanout directories so a
   *   full-history walk does not thrash the cache.
   */
  private readonly parentRealpathCache = createLruCache<string>(128 * 1024, 512);

  /**
   * Lazy canonicalisation of every containment root, resolving to the whole
   * `RootSet`. Promise so concurrent first calls share one round of
   * `realpath`s; cleared on rejection so a transient error can be retried.
   */
  private rootSetPromise: Promise<RootSet> | undefined = undefined;

  /**
   * Synchronous cache of the resolved `RootSet`, set on `loadRootSet()`'s
   * resolution arm and cleared on its rejection arm — always in lockstep
   * with `rootSetPromise`. Lets hot-path callers (`resolveWrite`,
   * `exists`, `symlink`) read the settled value directly, without an
   * `await` (and its microtask), once the roots have resolved at least once.
   */
  private resolvedRootSet: RootSet | undefined = undefined;

  constructor(
    rootDir: string | ReadonlyArray<string>,
    pathPolicy: PathPolicy = nativePolicy,
    fsOps: FsOperations = realFsOps,
  ) {
    const roots = typeof rootDir === 'string' ? [rootDir] : rootDir;
    const [primary] = roots;
    // Fail closed: an empty root set would make every containment check
    // vacuously false, so the adapter must never be constructible without
    // at least one root to confine to.
    if (primary === undefined) {
      throw unsupportedOperation('constructor', 'NodeFileSystem requires at least one root');
    }
    this.rootDirs = roots;
    this.rootDir = primary;
    this.pathPolicy = pathPolicy;
    this.fsOps = fsOps;
  }

  /**
   * Normalises each raw root and its `+sep` prefix. Runs once per successful
   * root-set resolution — `loadRootSet` memoises the whole `RootSet`, so no
   * per-call memo is needed here.
   */
  private getRootDirPrefixes(): ReadonlyArray<RootPrefix> {
    return this.rootDirs.map((root) => this.toRootPrefix(root));
  }

  private toRootPrefix(root: string): RootPrefix {
    return toRootPrefix(this.pathPolicy.normalizeForCompare(root), this.pathPolicy.sep);
  }

  /**
   * Realpaths every root. A root that does not exist yet is a legitimate
   * root (`worktree add` probes its own target before creating it); its
   * canonical prefix is derived from the realpath of its nearest EXISTING ancestor
   * and re-joining the missing tail — exactly the form `realpathForCreation`
   * later produces for leaves under it, so a target beneath a symlinked
   * ancestor (macOS `/tmp` → `/private/tmp`) is admitted rather than
   * spuriously denied. Any non-ENOENT errno rejects the whole resolution
   * rather than being swallowed.
   */
  private async canonicalizeRoots(): Promise<ReadonlyArray<RootPrefix>> {
    const resolved = await Promise.all(
      this.rootDirs.map(async (root) => {
        try {
          return await this.fsOps.realpath(root);
        } catch (err) {
          if (isErrnoException(err) && err.code === 'ENOENT') {
            // The nearest-existing walk itself can ENOENT at the volume root
            // (an unmounted Windows drive / offline UNC share — unreachable on
            // POSIX, where realpath('/') always succeeds). Fall back to the
            // lexical root: its raw prefix still gates, and every op under the
            // unreachable volume fails closed on its own realpath instead of
            // rejecting the whole adapter with an unmapped errno.
            return realpathNearestExisting(root, this.pathPolicy, this.fsOps).catch(
              (nestedErr: unknown) => {
                if (isErrnoException(nestedErr) && nestedErr.code === 'ENOENT') return root;
                throw nestedErr;
              },
            );
          }
          throw err;
        }
      }),
    );
    return resolved.map((root) => this.toRootPrefix(root));
  }

  /**
   * Resolves and memoises the `RootSet`. Returns it directly from the
   * promise chain — callers thread the returned value onward, so there is no
   * synchronous "trust it's been set" field read: the type system proves
   * the value is defined via the `await`'s return, not a nullable field.
   * Every root contributes a canonical prefix (nearest-existing fallback
   * above), so the set is always complete and memoises on first resolution.
   */
  private async loadRootSet(): Promise<RootSet> {
    if (this.rootSetPromise === undefined) {
      this.rootSetPromise = this.canonicalizeRoots()
        .then((canonical) => {
          const rootSet: RootSet = {
            canonical,
            all: unionRootPrefixes(this.getRootDirPrefixes(), canonical),
          };
          this.resolvedRootSet = rootSet;
          return rootSet;
        })
        .catch((err: unknown) => {
          this.rootSetPromise = undefined;
          this.resolvedRootSet = undefined;
          throw err;
        });
    }
    return this.rootSetPromise;
  }

  /**
   * Synchronous-first-path accessor for the roots: returns the
   * already-settled `resolvedRootSet` field when populated (no `await`, no
   * microtask), falling back to `loadRootSet()` only on the first call or
   * after a rejection cleared the field. Used by
   * every hot-path call site (`resolveWrite`, `exists`, `symlink`)
   * instead of an unconditional `await this.loadRootSet()`.
   */
  private async resolveRootSet(): Promise<RootSet> {
    let rootSet = this.resolvedRootSet;
    // Stryker disable next-line ConditionalExpression: equivalent — when `resolvedRootSet` is already set, `loadRootSet()` returns the memoised promise resolving to that same `RootSet` (set in lockstep in its resolve arm, cleared with the promise on rejection), so forcing this guard true reassigns the identical value with no extra `realpath`; only the await fast-path is dropped.
    if (rootSet === undefined) {
      rootSet = await this.loadRootSet();
    }
    return rootSet;
  }

  read = async (path: string): Promise<Uint8Array> => {
    const { all } = this.resolvedRootSet ?? (await this.loadRootSet());
    const real = this.resolveRead(path, all);
    return runFs(async () => new Uint8Array(await this.fsOps.readFile(real)), path);
  };

  readSlice = async (path: string, offset: number, length: number): Promise<Uint8Array> => {
    if (offset < 0 || length < 0) throw permissionDenied(path);
    const { all } = this.resolvedRootSet ?? (await this.loadRootSet());
    const real = this.resolveRead(path, all);
    let handle: fsPromises.FileHandle | undefined;
    try {
      return await runFs(async () => {
        handle = await this.fsOps.open(real, 'r');
        // Exact-size unsafe allocation (no zero-fill) + a `bytesRead`-length
        // view over the same backing buffer (no second copy) — this method
        // sits on the pack delta-chain hot path.
        const buf = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buf, 0, length, offset);
        return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
      }, path);
    } finally {
      // Load-bearing: release the descriptor on every exit path so a
      // hot-path caller (pack index lookups) cannot leak FDs.
      await handle?.close();
    }
  };

  readUtf8 = async (path: string): Promise<string> => {
    const { all } = this.resolvedRootSet ?? (await this.loadRootSet());
    const real = this.resolveRead(path, all);
    return runFs(() => this.fsOps.readFile(real, 'utf-8'), path);
  };

  write = async (path: string, data: Uint8Array): Promise<void> => {
    const real = await this.resolveWrite(path);
    await this.assertWritableLeaf(real, path);
    await runFs(async () => {
      await this.fsOps.mkdir(this.pathPolicy.dirname(real), { recursive: true });
      await this.fsOps.writeFile(real, data, { flag: WRITE_CREATE_FLAGS });
    }, path);
  };

  writeStream = async (path: string, source: AsyncIterable<Uint8Array>): Promise<void> => {
    const real = await this.resolveWrite(path);
    await this.assertWritableLeaf(real, path);
    await runFs(async () => {
      await this.fsOps.mkdir(this.pathPolicy.dirname(real), { recursive: true });
      const streamOptions: WriteStreamNumericFlags = { flags: WRITE_CREATE_FLAGS };
      await pipeline(
        source,
        fs.createWriteStream(real, streamOptions as unknown as fs.WriteStreamOptions),
      );
    }, path);
  };

  writeExclusive = async (path: string, data: Uint8Array): Promise<void> => {
    const real = await this.resolveWrite(path);
    await this.assertWritableLeaf(real, path);
    await runFs(async () => {
      await this.fsOps.mkdir(this.pathPolicy.dirname(real), { recursive: true });
      await this.fsOps.writeFile(real, data, { flag: WRITE_EXCLUSIVE_FLAGS });
    }, path);
  };

  writeUtf8 = async (path: string, content: string): Promise<void> => {
    const real = await this.resolveWrite(path);
    await this.assertWritableLeaf(real, path);
    await runFs(async () => {
      await this.fsOps.mkdir(this.pathPolicy.dirname(real), { recursive: true });
      await this.fsOps.writeFile(real, content, { encoding: 'utf-8', flag: WRITE_CREATE_FLAGS });
    }, path);
  };

  appendUtf8 = async (path: string, content: string): Promise<void> => {
    const real = await this.resolveWrite(path);
    await this.assertWritableLeaf(real, path);
    await runFs(async () => {
      await this.fsOps.mkdir(this.pathPolicy.dirname(real), { recursive: true });
      await this.fsOps.appendFile(real, content, { encoding: 'utf-8', flag: APPEND_FLAGS });
    }, path);
  };

  // `exists` follows symlinks (port contract, `src/ports/file-system.ts`):
  // a dangling symlink must report `false`, not `true`. `stat` already
  // follows, so probing existence via `fsOps.stat` (never `lstat`) keeps
  // that contract while dropping the realpath + double root consultation
  // the old implementation paid on every call.
  exists = async (path: string): Promise<boolean> => {
    const { all } = this.resolvedRootSet ?? (await this.loadRootSet());
    const real = this.resolveRead(path, all);
    try {
      await this.fsOps.stat(real);
      return true;
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') return false;
      if (isErrnoException(err)) throw mapErrno(err, path);
      throw err;
    }
  };

  stat = async (path: string): Promise<FileStat> => {
    const { all } = this.resolvedRootSet ?? (await this.loadRootSet());
    const real = this.resolveRead(path, all);
    return runFs(async () => mapStat(await this.fsOps.stat(real, { bigint: true })), path);
  };

  lstat = async (path: string): Promise<FileStat> => {
    const { all } = this.resolvedRootSet ?? (await this.loadRootSet());
    const real = this.resolveRead(path, all);
    return runFs(async () => mapStat(await this.fsOps.lstat(real, { bigint: true })), path);
  };

  readdir = async (path: string): Promise<ReadonlyArray<DirEntry>> => {
    const { all } = this.resolvedRootSet ?? (await this.loadRootSet());
    const real = this.resolveRead(path, all);
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
    const real = await this.resolveWrite(path);
    await runFs(() => this.fsOps.mkdir(real, { recursive: true }), path);
  };

  rm = async (path: string): Promise<void> => {
    // W1 resolves the parent via realpath and joins the basename without
    // following the leaf, so dangling symlinks — whose realpath would fail
    // — can still be removed. A regular file's containment is still
    // verified via its parent directory, which is the same guarantee.
    const real = await this.resolveWrite(path);
    await runFs(() => this.fsOps.rm(real), path);
    // Node's `fs.rm` without `recursive` only removes leaves — a regular
    // file or symlink. The parent directory and its realpath are
    // unchanged, so the parent-realpath cache entry for `dirname(real)`
    // remains valid. No invalidation needed.
  };

  rename = async (src: string, dst: string): Promise<void> => {
    // Neither arm follows its leaf: `rename(2)` itself acts on the link
    // entry, never its target (POSIX and git semantics) — renaming a
    // symlink moves the link and leaves whatever it points at untouched.
    const realSrc = await this.resolveWrite(src);
    const realDst = await this.resolveWrite(dst);
    await runFs(async () => {
      await this.fsOps.mkdir(this.pathPolicy.dirname(realDst), { recursive: true });
      await this.fsOps.rename(realSrc, realDst);
    }, src);
    this.parentRealpathCache.clear();
  };

  readlink = async (path: string): Promise<string> => {
    const { all } = this.resolvedRootSet ?? (await this.loadRootSet());
    const real = this.resolveRead(path, all);
    return runFs(() => this.fsOps.readlink(real), path);
  };

  symlink = async (target: string, path: string): Promise<void> => {
    // A symlink's target — absolute or relative — is opaque bytes, written
    // verbatim, exactly like git: it is never resolved or checked against
    // the root set. Only the link's OWN path is contained (W1); `symlink(2)`
    // itself refuses any existing leaf with EEXIST, so no leaf follow can
    // occur here either.
    const real = await this.resolveWrite(path);
    await runFs(async () => {
      await this.fsOps.mkdir(this.pathPolicy.dirname(real), { recursive: true });
      await this.fsOps.symlink(target, real);
    }, path);
  };

  chmod = async (path: string, mode: number): Promise<void> => {
    // chmod both writes AND follows its leaf, and no portable no-follow
    // chmod exists — so, unlike the other W2 surfaces, it cannot rely on
    // `O_NOFOLLOW` and keeps an explicit leaf check on every platform.
    const real = await this.resolveWrite(path);
    await this.assertLeafSafeToWrite(real, path);
    await runFs(() => this.fsOps.chmod(real, mode), path);
  };

  rmRecursive = async (path: string): Promise<void> => {
    let real: string;
    try {
      real = await this.resolveWrite(path);
      // Verify the leaf exists. Call `fsOps.lstat` directly — `real` is
      // already a contained, canonical-prefix path; re-entering the
      // public `lstat` method would re-run the write guard for no
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
    // 'read' never mutates state, so it takes the lexical, syscall-free
    // gate like every other read surface; 'write' takes the write guard
    // (W1) and, like every other W2 surface, leans on `O_NOFOLLOW` at the
    // `open` below rather than a pre-open leaf check.
    let real: string;
    if (mode === 'write') {
      real = await this.resolveWrite(path);
    } else {
      const { all } = this.resolvedRootSet ?? (await this.loadRootSet());
      real = this.resolveRead(path, all);
    }
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
      // TOCTOU: the leaf may have been removed between `resolveWrite` and
      // this lstat. ENOENT is safe to swallow — the subsequent open call
      // will surface its own errno. Other errors
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

  /**
   * Explicit leaf check for the two situations that cannot rely on
   * `O_NOFOLLOW`: `chmod` (no portable no-follow chmod exists, on any
   * platform) and the Windows arm of every other W2 write surface
   * (`O_NOFOLLOW` is silently ignored there). A symlink leaf throws
   * `PERMISSION_DENIED`; a leaf that doesn't exist yet (ENOENT) is a no-op
   * — the ordinary creation case — and callers whose leaf must already
   * exist (`chmod`) surface that via their own op's own ENOENT.
   */
  private async assertLeafSafeToWrite(real: string, path: string): Promise<void> {
    let lstatResult: { ok: true; isSymlink: boolean } | { ok: false; err: unknown };
    try {
      const leafStat = await this.fsOps.lstat(real);
      lstatResult = { ok: true, isSymlink: leafStat.isSymbolicLink() };
    } catch (err) {
      lstatResult = { ok: false, err };
    }
    interpretCreationLstat(lstatResult, path);
  }

  /**
   * Windows fallback for every W2 write surface: `O_NOFOLLOW` is silently
   * ignored by the Win32 API, so the explicit leaf lstat is the only
   * defence there. POSIX relies on `O_NOFOLLOW` at the `open` itself and
   * skips this entirely.
   */
  private async assertWritableLeaf(real: string, path: string): Promise<void> {
    if (this.pathPolicy.caseInsensitive) {
      await this.assertLeafSafeToWrite(real, path);
    }
  }

  // Shared by every write surface via `realpathForCreation`: a
  // clone/checkout writing N files into the same tree, or an `rm`/
  // `rmRecursive` walk removing N entries under it, pays the realpath
  // walk-up once per parent rather than once per file/entry. Throws on
  // ENOENT (the `.set` below only runs after a successful await, so a
  // failed realpath is never cached) — callers that need a fallback catch
  // it themselves.
  private async cachedParentRealpath(parent: string): Promise<string> {
    const cached = this.parentRealpathCache.get(parent);
    if (cached !== undefined) {
      return cached;
    }
    const realParent = await this.fsOps.realpath(parent);
    this.parentRealpathCache.set(parent, realParent, parent.length + realParent.length);
    return realParent;
  }

  private async realpathForCreation(resolved: string): Promise<string> {
    // Fast path: parent already cached. The leaf realpath is meaningless
    // here (the leaf often doesn't exist yet, and — for surfaces that act
    // on the leaf itself, like `rm` or `rename` — realpathing it would be
    // wrong even when it does), so we cache the parent only and join the
    // basename. `resolveWrite`'s own post-check verifies containment on the
    // joined leaf itself.
    const parent = this.pathPolicy.dirname(resolved);
    const basename = this.pathPolicy.basename(resolved);
    // Cache miss falls through to a direct parent realpath — when the
    // parent exists this is a single call instead of the full walk-up.
    try {
      const realParent = await this.cachedParentRealpath(parent);
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
   * `abs` is normalised ONCE (not once per root) and compared against every
   * root's precomputed `+sep` prefix. Both the `=== root` equality arm and
   * the `startsWith(root + sep)` prefix arm are retained per root — dropping
   * either changes the verdict (a bare `startsWith(root)` would admit the
   * prefix-only sibling `root-evil`). The roots are passed in as
   * already-resolved `RootPrefix` values — no field read-back.
   */
  private isContainedInAnyRoot(abs: string, roots: ReadonlyArray<RootPrefix>): boolean {
    const c = this.pathPolicy.normalizeForCompare(abs);
    return roots.some((root) => containedByPrefix(c, root.normalized, root.withSep));
  }

  /**
   * Lexical, syscall-free containment gate for every read surface (`read`,
   * `readSlice`, `readUtf8`, `stat`, `lstat`, `readdir`, `readlink`,
   * `exists`, `openWithNoFollow(_, 'read')`). Git allows reading through a
   * symlink that resolves outside every root — the realpath escape check
   * `resolveWrite` runs for write surfaces does not apply
   * here, so this never touches the filesystem.
   *
   * `roots` is the caller's already-resolved `RootSet.all` (never read from
   * `this.resolvedRootSet` directly) so this stays synchronous and total:
   * every caller guarantees the set is populated via the
   * `this.resolvedRootSet ?? await this.loadRootSet()` sync-fast-arm idiom
   * BEFORE calling in, so the one-time root canonicalisation still pays its
   * microtask exactly once per adapter lifetime, never once per call.
   */
  private resolveRead(path: string, roots: ReadonlyArray<RootPrefix>): string {
    const absolute = toAbsolute(path, this.rootDir, this.pathPolicy);
    // Non-allocating `..` prefilter: the facade already rejects `..`
    // segments, so a raw adapter call is the only way this arm fires. `.`
    // segments and duplicate separators are left uncollapsed — both are
    // OS-normalised at the syscall and neither can escape a prefix check.
    const candidate = absolute.indexOf('..') === -1 ? absolute : this.pathPolicy.resolve(absolute);
    const normalized = this.pathPolicy.normalizeForCompare(candidate);
    const contained = roots.some((root) =>
      containedByPrefix(normalized, root.normalized, root.withSep),
    );
    if (!contained) throw permissionDenied(path);
    return candidate;
  }

  /**
   * The single write guard (W1): leading-path containment via
   * `realpathForCreation` (never the leaf itself — a dangling symlink,
   * whose leaf realpath would ENOENT, must stay removable) followed by an
   * unconditional per-entry post-check on the joined result. Every write
   * surface resolves through here; surfaces that also dereference their
   * leaf (`write`/`writeStream`/`writeUtf8`/`writeExclusive`/`appendUtf8`/
   * `openWithNoFollow(_, 'write')`/`chmod`) layer their own leaf check on
   * top of the `real` path this returns.
   */
  private async resolveWrite(path: string): Promise<string> {
    // `policy.resolve` normalises embedded `..`/`.` segments AND foreign
    // separators (a `/` on Windows). The adapter is contractually allowed
    // to receive mixed-separator input; resolving here produces a
    // platform-native form so the containment prefix-check compares
    // like-for-like.
    const resolved = this.pathPolicy.resolve(toAbsolute(path, this.rootDir, this.pathPolicy));
    // Every root is constant for the adapter's lifetime; their normalised
    // raw and canonical prefixes are held as one `RootSet` instance field,
    // read via `resolveRootSet()` (which skips the `await` entirely once the
    // set has settled) — so the case-fold allocations AND the canonicalising
    // microtask on the hot path each run once per adapter lifetime rather
    // than once per containment check.
    const { all } = await this.resolveRootSet();
    try {
      const real = await this.realpathForCreation(resolved);
      // Containment passes if `real` is inside ANY root, in either its raw
      // form (which matches user-supplied paths with the same short-name
      // form as the constructor argument) OR its canonical form (which
      // matches paths produced by `realpath` after short-name expansion).
      // Without both forms, a Windows user passing a short-name input would
      // hit the pre-resolve check against the canonical long-name root and
      // fail spuriously. This post-check runs unconditionally, on every
      // call — no verdict is ever cached across calls.
      if (!this.isContainedInAnyRoot(real, all)) {
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
