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
import type { FsOperations, SyncFsOperations } from './fs-operations.js';
import { realFsOps } from './fs-operations.js';
import type { PathPolicy } from './path-policy.js';
import { nativePolicy } from './path-policy.js';
import type { SyncIoPolicy, TurnBudget } from './sync-io-budget.js';
import { runWithinBudget } from './sync-io-budget.js';

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
 * Numeric `open`/`writeFile` flags for the write guard's leaf no-follow:
 * `O_NOFOLLOW` refuses a symlink leaf atomically at the syscall, closing the
 * TOCTOU window between a pre-write `lstat` and the write and costing one
 * fewer syscall per write. Ignored by Windows, where the pre-write `lstat`
 * fallback covers that platform instead: `assertLeafSafeToWrite` for the
 * create and append flags (a symlink leaf refuses `PERMISSION_DENIED`) and
 * `assertExclusiveCreateLeaf` for the exclusive flags (`FILE_EXISTS`, the
 * verdict `O_EXCL` itself gives everywhere else).
 */
const WRITE_CREATE_FLAGS =
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
const WRITE_EXCLUSIVE_FLAGS =
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
const APPEND_FLAGS =
  fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW;

/**
 * `O_NONBLOCK` makes an `openSync` of a FIFO return immediately instead of
 * waiting for a writer. Windows has no such constant — `constants.O_NONBLOCK`
 * reads `undefined` there — and named pipes do not live in the namespace
 * these paths resolve to on that platform anyway, so `0` composes in as a
 * no-op flag. Takes the `constants` object as a parameter (rather than
 * reading the module-level `fs.constants` directly) so both arms of the `??`
 * are unit-testable without depending on which platform runs the suite.
 * @internal
 */
export function nonBlockFlag(constants: { readonly O_NONBLOCK?: number }): number {
  return constants.O_NONBLOCK ?? 0;
}

/** Numeric `openSync` flags for the sync fast path's small-read arms. */
const REGULAR_READ_FLAGS = fs.constants.O_RDONLY | nonBlockFlag(fs.constants);

/** Size of the extra read issued once a sync fill reaches the reported size, to detect growth. */
const EOF_PROBE_BYTES = 1;

/**
 * `@types/node` types `WriteStreamOptions.flags` as `string`, but Node's own
 * implementation (`stringToFlags`) returns a numeric `flags` argument
 * unchanged rather than string-parsing it — verified against Node's source,
 * not guessed. A numeric flag is the only way to compose `O_NOFOLLOW` into
 * `writeStream`'s open; no string flag alias expresses it.
 */
type WriteStreamNumericFlags = Omit<fs.WriteStreamOptions, 'flags'> & { readonly flags: number };

/** What `lstat` reports for `ino` on a volume that has no inodes (FAT, some network shares). */
const NO_INODE = 0n;

function reportsInode(stat: fs.BigIntStats): boolean {
  return stat.ino !== NO_INODE;
}

/**
 * Same directory entry, decided by device and inode rather than by name:
 * Win32 accepts several spellings of one entry (a trailing dot or space the
 * kernel strips, an 8.3 short name), and a case-fold can equate two DISTINCT
 * entries on a case-sensitive directory. Asked only when both sides report
 * an inode; compared as bigints because an NTFS file reference exceeds the
 * precision of a double.
 */
function sameEntry(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return a.ino === b.ino && a.dev === b.dev;
}

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

/** Absence is the only thing swallowed: `ENOENT`/`ENOTDIR` become `undefined`, anything else rethrows. */
async function orMissing<T>(probe: () => Promise<T>): Promise<T | undefined> {
  try {
    return await probe();
  } catch (err) {
    if (isErrnoException(err) && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return undefined;
    }
    throw err;
  }
}

/**
 * The classification shared by every `ENOENT`-folding probe, sync or async:
 * `ENOENT` is the caller's to fold into its own "absent" value (this
 * function returns normally); every other errno maps through `mapErrno`;
 * a non-errno error rethrows untouched.
 */
function throwUnlessEnoent(err: unknown, path: string): void {
  if (isErrnoException(err) && err.code === 'ENOENT') return;
  if (isErrnoException(err)) throw mapErrno(err, path);
  throw err;
}

/**
 * Runs `probe`, folding ONLY `ENOENT` into `undefined` — unlike `orMissing`,
 * which also folds `ENOTDIR`. Every other errno maps through `mapErrno`; a
 * non-errno error rethrows untouched. Shared by every async presence probe
 * (`isPresent`, and the optional `tryLstat`/`tryReadUtf8` port members).
 */
async function orAbsent<T>(probe: () => Promise<T>, path: string): Promise<T | undefined> {
  try {
    return await probe();
  } catch (err) {
    throwUnlessEnoent(err, path);
    return undefined;
  }
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
  // Discriminator only fires on a platform whose `open(2)` does NOT honour
  // `O_NOFOLLOW` (Windows today). A platform that does honour it gets the
  // real `ELOOP` and that flows through `mapErrno` directly — no rewrap
  // needed. Gated on `honoursNoFollow`, not `caseInsensitive`: the two
  // happen to coincide in every shipped policy, but they mean different
  // things (see `PathPolicy`'s JSDoc) and a hypothetical case-insensitive
  // POSIX filesystem must take the POSIX arm here.
  if (policy.honoursNoFollow) return false;
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
 * Wraps `fsOps.readFile`'s result as a view over its own `ArrayBuffer` when it
 * is the Buffer's own exact-fit allocation (`byteOffset === 0` and
 * `byteLength` spans the whole backing buffer); copies otherwise, since a
 * pooled slice's backing buffer holds unrelated bytes on either side.
 */
function toBufferView(buf: Buffer): Uint8Array {
  const ownsExactFitBuffer = buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength;
  return ownsExactFitBuffer
    ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    : new Uint8Array(buf);
}

/** Decodes a sync-arm view identically to `fsOps.readFile(path, 'utf-8')` — neither strips a BOM. */
function decodeUtf8(view: Uint8Array): string {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('utf8');
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
 * The synchronous twin of `runFs`: runs `op` under the turn budget
 * (`runWithinBudget` admits, times and charges it), translating Node's
 * errno exceptions into `TsgitError` exactly as `runFs` does. The method
 * itself stays `async`, so a synchronous throw always surfaces as a
 * rejection, never a synchronous exception.
 * @internal
 */
async function runSync<T>(budget: TurnBudget, op: () => T, path: string): Promise<T> {
  try {
    return await runWithinBudget(budget, op);
  } catch (err) {
    if (isErrnoException(err)) throw mapErrno(err, path);
    throw err;
  }
}

type PresenceProbeKind = 'stat' | 'lstat';

/** One non-throwing `stat`/`lstat` attempt: `undefined` on ANY miss, `ENOENT` or `ENOTDIR` alike. */
function probeOnce(
  ops: SyncFsOperations,
  kind: PresenceProbeKind,
  real: string,
): fs.BigIntStats | undefined {
  return kind === 'stat'
    ? ops.statSync(real, { bigint: true, throwIfNoEntry: false })
    : ops.lstatSync(real, { bigint: true, throwIfNoEntry: false });
}

/**
 * Distinguishes a sync miss's `ENOENT` from `ENOTDIR` without paying for a
 * thrown error on the common (plain-absence) case: `throwIfNoEntry: false`
 * answers a miss with `undefined` for EITHER cause, which would otherwise
 * silently report a genuine ancestor `NOT_A_DIRECTORY` as absence. One
 * more, still-throwing `statSync` on the immediate parent settles it — the
 * OS re-resolves that SAME ancestor chain, so an `ENOTDIR` anywhere above
 * the parent surfaces here exactly as it would have from the original
 * probe, and the parent itself being a plain file answers via
 * `isDirectory()` with no throw at all. The overwhelmingly common case (the
 * parent directory exists and IS a directory) never throws either way.
 */
function disambiguateMiss(ops: SyncFsOperations, parent: string, path: string): undefined {
  let parentStat: fs.BigIntStats;
  try {
    parentStat = ops.statSync(parent, { bigint: true });
  } catch (err) {
    throwUnlessEnoent(err, path);
    return undefined;
  }
  if (!parentStat.isDirectory()) throw notADirectory(path);
  return undefined;
}

/**
 * The synchronous twin of `orAbsent`: a non-throwing `stat`/`lstat` under
 * the turn budget, escalating to {@link disambiguateMiss} only on a miss.
 * Any OTHER errno the fast probe itself raises (`throwIfNoEntry: false`
 * only suppresses `ENOENT`/`ENOTDIR`) still maps directly. Shared by every
 * sync presence/miss probe (`isPresentSync`, and the optional `tryLstat`
 * port member).
 */
async function runSyncAbsent(
  budget: TurnBudget,
  ops: SyncFsOperations,
  kind: PresenceProbeKind,
  real: string,
  parent: string,
  path: string,
): Promise<fs.BigIntStats | undefined> {
  let result: fs.BigIntStats | undefined;
  try {
    result = await runWithinBudget(budget, () => probeOnce(ops, kind, real));
  } catch (err) {
    throwUnlessEnoent(err, path);
    return undefined;
  }
  if (result !== undefined) return result;
  return runWithinBudget(budget, () => disambiguateMiss(ops, parent, path));
}

/** The sync arm of `tryLstat`: a miss answers `undefined`, every other refusal throws. */
async function tryLstatSync(
  sync: SyncIoPolicy,
  real: string,
  parent: string,
  path: string,
): Promise<FileStat | undefined> {
  const stat = await runSyncAbsent(sync.budget, sync.ops, 'lstat', real, parent, path);
  return stat === undefined ? undefined : mapStat(stat);
}

/** The synchronous twin of `orAbsent` reduced to a boolean answer, for the plain presence probes. */
async function runSyncPresence(
  budget: TurnBudget,
  ops: SyncFsOperations,
  kind: PresenceProbeKind,
  real: string,
  parent: string,
  path: string,
): Promise<boolean> {
  return (await runSyncAbsent(budget, ops, kind, real, parent, path)) !== undefined;
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
 * Classify the result of an lstat on the leaf of a creation target.
 *
 * - Success + symlink → reports `true` (caller decides the refusal)
 * - Success + non-symlink → reports `false` (overwrite is fine)
 * - ENOENT → reports `false` (the leaf doesn't exist yet, the expected creation case)
 * - Any other errno → surface via mapErrno (must NOT be silently swallowed)
 *
 * Non-Error, non-errno throwables re-bubble as-is.
 * @internal
 */
export function isCreationLeafSymlink(
  result:
    | { readonly ok: true; readonly isSymlink: boolean }
    | { readonly ok: false; readonly err: unknown },
  path: string,
): boolean {
  if (result.ok) return result.isSymlink;
  const { err } = result;
  if (isErrnoException(err)) {
    if (err.code === 'ENOENT') return false;
    throw mapErrno(err, path);
  }
  throw err;
}

/** Fills `buf` from `fd` starting at file position 0, looping until `size` bytes land or EOF. */
function fillSync(ops: SyncFsOperations, fd: number, buf: Buffer, size: number): number {
  let filled = 0;
  while (filled < size) {
    const read = ops.readSync(fd, buf, filled, size - filled, filled);
    if (read === 0) break;
    filled += read;
  }
  return filled;
}

/** One extra byte past `size`: any byte read means the file grew since `fstat`. */
function grewPastGate(ops: SyncFsOperations, fd: number, size: number): boolean {
  const probe = Buffer.allocUnsafe(EOF_PROBE_BYTES);
  return ops.readSync(fd, probe, 0, EOF_PROBE_BYTES, size) > 0;
}

/** Fills a size-exact buffer of its own (never a pool slice) so the returned view owns its own memory. */
function readWholeFileSync(
  ops: SyncFsOperations,
  fd: number,
  size: number,
): Uint8Array | undefined {
  const buf = Buffer.allocUnsafeSlow(size);
  const filled = fillSync(ops, fd, buf, size);
  if (filled === size && grewPastGate(ops, fd, size)) return undefined;
  return new Uint8Array(buf.buffer, buf.byteOffset, filled);
}

/**
 * The sync fast path's whole-file read: `undefined` means "not eligible for
 * this path" (non-regular, over the gate, or grew mid-read) — the caller
 * falls back to the async arm. A thrown errno is NOT one of those cases; it
 * propagates raw for the caller's `runSync` to map.
 * @internal
 */
export function readRegularFileSync(
  ops: SyncFsOperations,
  real: string,
  maxBytes: number,
): Uint8Array | undefined {
  const attempt = openAndAttemptSyncRead(ops, real, maxBytes);
  if (attempt.kind === 'over-gate') {
    ops.closeSync(attempt.fd);
    return undefined;
  }
  return attempt.kind === 'read' ? attempt.bytes : undefined;
}

/**
 * `read`/`readUtf8`'s whole-file sync attempt, widened over
 * {@link readRegularFileSync} with one more outcome: `over-gate` hands back
 * the ALREADY-OPEN descriptor and its fstat'd size instead of closing it —
 * the caller finishes the read asynchronously on that SAME fd, so a file
 * over the sync gate (the index, a `.idx`, any read above 64 KiB) pays one
 * `open` instead of the sync probe's `open` plus a second one from the async
 * fallback. `ineligible` (non-regular, or grew mid-read under the gate) still
 * closes the fd itself — those cases must re-open from scratch regardless.
 */
type SyncWholeFileAttempt =
  | { readonly kind: 'read'; readonly bytes: Uint8Array }
  | { readonly kind: 'ineligible' }
  | { readonly kind: 'over-gate'; readonly fd: number; readonly size: number };

/** `fstatSync` that closes the descriptor it was given when the stat itself fails. */
function fstatOrClose(ops: SyncFsOperations, fd: number): fs.Stats {
  try {
    return ops.fstatSync(fd);
  } catch (err) {
    ops.closeSync(fd);
    throw err;
  }
}

function openAndAttemptSyncRead(
  ops: SyncFsOperations,
  real: string,
  maxBytes: number,
): SyncWholeFileAttempt {
  const fd = ops.openSync(real, REGULAR_READ_FLAGS);
  const stat = fstatOrClose(ops, fd);
  if (!stat.isFile()) {
    ops.closeSync(fd);
    return { kind: 'ineligible' };
  }
  if (stat.size > maxBytes) return { kind: 'over-gate', fd, size: stat.size };
  try {
    const bytes = readWholeFileSync(ops, fd, stat.size);
    return bytes === undefined ? { kind: 'ineligible' } : { kind: 'read', bytes };
  } finally {
    ops.closeSync(fd);
  }
}

/**
 * The largest file finished on the probe's own descriptor: `fs.readFile`'s
 * ceiling, past which `fs.read`'s length would wrap. Larger files go to
 * `readFile`, which refuses them exactly as the pooled arm does.
 */
const MAX_REUSED_FD_READ_BYTES = 2 ** 31 - 1;

/** The async twin of {@link fillSync}, reading off an already-open descriptor. */
async function fillAsync(
  ops: SyncFsOperations,
  fd: number,
  buf: Buffer,
  size: number,
): Promise<number> {
  let filled = 0;
  while (filled < size) {
    const read = await ops.readAsync(fd, buf, filled, size - filled, filled);
    if (read === 0) break;
    filled += read;
  }
  return filled;
}

/** The async twin of {@link grewPastGate}. */
async function grewPastGateAsync(
  ops: SyncFsOperations,
  fd: number,
  size: number,
): Promise<boolean> {
  const probe = Buffer.allocUnsafe(EOF_PROBE_BYTES);
  return (await ops.readAsync(fd, probe, 0, EOF_PROBE_BYTES, size)) > 0;
}

/**
 * Finishes an `over-gate` sync attempt: reads the fstat'd `size` off the SAME
 * descriptor asynchronously (the threadpool, exactly where an over-gate read
 * belongs), then closes it — one `open` total. A grow-mid-read race (the
 * same EOF-probe defense the sync arm applies) falls back to a fresh
 * `fsOps.readFile`, the only case that still pays a second open.
 */
async function finishOverGateRead(
  ops: SyncFsOperations,
  fsOps: FsOperations,
  real: string,
  fd: number,
  size: number,
): Promise<Uint8Array> {
  if (size > MAX_REUSED_FD_READ_BYTES) {
    ops.closeSync(fd);
    return toBufferView(await fsOps.readFile(real));
  }
  try {
    const buf = Buffer.allocUnsafeSlow(size);
    const filled = await fillAsync(ops, fd, buf, size);
    if (filled === size && (await grewPastGateAsync(ops, fd, size))) {
      return toBufferView(await fsOps.readFile(real));
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, filled);
  } finally {
    ops.closeSync(fd);
  }
}

/**
 * Outcome of `tryReadUtf8`'s sync attempt. `settled: false` means the fast
 * path could not answer at all (non-regular, over the gate, or grew
 * mid-read) — the caller re-runs the async arm from scratch, which
 * recomputes the correct answer or refusal on its own. `settled: true`
 * carries the FINAL answer: `bytes` is `undefined` when an `ENOENT` from the
 * open proved the file absent, and defined otherwise. Kept apart from
 * `readRegularFileSync`'s own "not eligible" `undefined` so a FIFO can never
 * be misread as an absent file.
 */
type SyncReadUtf8Outcome =
  | { readonly settled: false }
  | { readonly settled: true; readonly bytes: Uint8Array | undefined };

/** The outcome the pooled arm starts from: no sync attempt, so nothing settled. */
const UNSETTLED_SYNC_READ: SyncReadUtf8Outcome = { settled: false };

/**
 * `tryReadUtf8`'s sync arm: attempts `readRegularFileSync` under the turn
 * budget. An `ENOENT` from the open is a settled "absent" answer; any other
 * errno maps through `mapErrno` via `throwUnlessEnoent`, never swallowed.
 */
async function tryReadWholeFileSync(
  sync: SyncIoPolicy,
  real: string,
  path: string,
): Promise<SyncReadUtf8Outcome> {
  try {
    const bytes = await runWithinBudget(sync.budget, () =>
      readRegularFileSync(sync.ops, real, sync.maxSyncReadBytes),
    );
    return bytes === undefined ? { settled: false } : { settled: true, bytes };
  } catch (err) {
    throwUnlessEnoent(err, path);
    return { settled: true, bytes: undefined };
  }
}

/**
 * The sync fast path's twin of `readSlice`'s handle-based read: same
 * open/fstat non-regular guard as {@link readRegularFileSync}, then one
 * `readSync` at the given offset/length. `undefined` → the caller's async
 * fallback (non-regular file); a thrown errno propagates raw.
 */
function readSliceSync(
  ops: SyncFsOperations,
  real: string,
  offset: number,
  length: number,
): Uint8Array | undefined {
  const fd = ops.openSync(real, REGULAR_READ_FLAGS);
  try {
    if (!ops.fstatSync(fd).isFile()) return undefined;
    const buf = Buffer.allocUnsafe(length);
    const bytesRead = ops.readSync(fd, buf, 0, length, offset);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  } finally {
    ops.closeSync(fd);
  }
}

function wrapNodeHandle(handle: fsPromises.FileHandle, syncIo?: SyncIoPolicy): FileHandle {
  let closed = false;
  return {
    read: (buffer, offset, length, position) =>
      syncIo === undefined || length > syncIo.maxSyncReadBytes
        ? readHandleAsync(handle, buffer, offset, length, position)
        : runWithinBudget(syncIo.budget, () =>
            syncIo.ops.readSync(handle.fd, buffer, offset, length, position ?? null),
          ),
    write: async (buffer) => {
      await handle.write(buffer, 0, buffer.length);
    },
    stat: () =>
      syncIo === undefined
        ? handle.stat({ bigint: true }).then(mapStat)
        : runWithinBudget(syncIo.budget, () =>
            mapStat(syncIo.ops.fstatSync(handle.fd, { bigint: true })),
          ),
    close: async () => {
      if (closed) return;
      closed = true;
      await handle.close();
    },
  };
}

/** Held-handle `read`, no policy: today's `fs.promises` call, unpacking `bytesRead`. */
async function readHandleAsync(
  handle: fsPromises.FileHandle,
  buffer: Uint8Array,
  offset: number,
  length: number,
  position?: number,
): Promise<number> {
  const { bytesRead } = await handle.read(buffer, offset, length, position ?? null);
  return bytesRead;
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
  // Each field is coerced exactly once into a local, then the RETURNED
  // object is built directly — once, in whichever branch applies — instead
  // of building an intermediate `base` object and spreading it into a
  // second one for the ns-bearing case.
  const ctimeMs = Number(s.ctimeMs);
  const mtimeMs = Number(s.mtimeMs);
  const dev = Number(s.dev);
  const ino = Number(s.ino);
  const mode = Number(s.mode);
  const uid = Number(s.uid);
  const gid = Number(s.gid);
  const size = Number(s.size);
  const isFile = s.isFile();
  const isDirectory = s.isDirectory();
  const isSymbolicLink = s.isSymbolicLink();
  if (s.ctimeNs !== undefined && s.mtimeNs !== undefined) {
    return {
      ctimeMs,
      mtimeMs,
      dev,
      ino,
      mode,
      uid,
      gid,
      size,
      isFile,
      isDirectory,
      isSymbolicLink,
      ctimeNs: s.ctimeNs,
      mtimeNs: s.mtimeNs,
    };
  }
  return { ctimeMs, mtimeMs, dev, ino, mode, uid, gid, size, isFile, isDirectory, isSymbolicLink };
}

/** Injectable dependencies and settings for {@link NodeFileSystem}, every member optional. */
export interface NodeFileSystemOptions {
  /** Path-parsing and containment rules to resolve against. Default `nativePolicy`. */
  readonly pathPolicy?: PathPolicy;
  /** The `node:fs/promises` surface to call through. Default `realFsOps`. */
  readonly fsOps?: FsOperations;
  /**
   * The per-turn synchronous I/O policy. Absent → every method runs
   * today's async code path, byte for byte.
   * @internal
   */
  readonly syncIo?: SyncIoPolicy;
  /** Whether `rootDir`/`rootDirs` are already realpathed. Default `false`. */
  readonly rootsArePreResolved?: boolean;
  /** Bound on concurrent child removals inside `rmRecursive`. Default `REMOVE_TREE_CONCURRENCY`. */
  readonly removeTreeConcurrency?: number;
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

  /** The per-turn sync I/O policy; `undefined` runs every method on the async path. */
  private readonly syncIo: SyncIoPolicy | undefined;

  /**
   * Whether `rootDirs` are ALREADY realpathed, so `canonicalizeRoots` may
   * return them unchanged instead of realpathing each one again. Set only by
   * a caller that performed those realpaths itself and observed every one
   * succeed.
   *
   * Deliberately a flag over the resolved values themselves: the canonical
   * prefixes are UNIONED into the containment set, so accepting an
   * independent array would make it an additive confinement input — a caller
   * passing a broader path than it resolved would WIDEN the set. Re-deriving
   * the prefixes from `rootDirs` means the union is `raw ∪ raw = raw`, so a
   * wrongly-set flag can only ever narrow, never widen. Skipping a
   * recomputation is safe in a way that supplying a second value is not.
   */
  private readonly rootsArePreResolved: boolean;

  /**
   * Bound on concurrent child removals in `removeTree`'s `mapConcurrent`
   * fan-out. `mapConcurrent` lives here (the adapter cannot import from
   * `application/`, where the ioBound concurrency policy lives), so a
   * caller that HAS resolved that policy passes it in; the default
   * (`REMOVE_TREE_CONCURRENCY`) preserves this adapter's historical
   * behaviour for every caller that does not.
   */
  private readonly removeTreeConcurrency: number;

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
   * - `rmRecursive`, `rename` and `rm` of a directory clear the cache, which
   *   is cheap relative to a re-walk. `rm` of a leaf clears nothing — a leaf
   *   removal does not change the parent's realpath, while a removed
   *   directory's path can come back as a symlink leaving the root, and a
   *   stale entry for it would pass the write containment check on the old
   *   real parent. `rename` in particular cannot narrow this to just
   *   `dirname(src)`/`dirname(dst)`: `src` is a legitimate `rename` argument
   *   for a whole directory (`worktree move`, `git mv` on a directory), and
   *   every cached entry keyed AT `src`/`dst` or NESTED under either (a
   *   directory that was itself used as a parent for a deeper write) goes
   *   stale the moment the subtree moves. Pruning exactly those entries
   *   would need to enumerate this cache's keys by prefix — a capability
   *   this LRU cache (shared, and public, across unrelated callers: the
   *   delta-base and bitmap-reconstruction caches) intentionally does not
   *   expose. `clear()` stays the sound choice here.
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

  constructor(rootDir: string | ReadonlyArray<string>, options: NodeFileSystemOptions = {}) {
    const {
      pathPolicy = nativePolicy,
      fsOps = realFsOps,
      syncIo,
      rootsArePreResolved = false,
      removeTreeConcurrency = REMOVE_TREE_CONCURRENCY,
    } = options;
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
    this.syncIo = syncIo;
    this.rootsArePreResolved = rootsArePreResolved;
    this.removeTreeConcurrency = removeTreeConcurrency;
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
   * When `rootsArePreResolved` was set at construction, returns the raw root
   * prefixes unchanged — the caller already realpathed these exact values and
   * observed every one succeed, and `realpath` is idempotent, so re-running it
   * would return the same strings. The union in `loadRootSet` then collapses to
   * `raw ∪ raw = raw`: a wrongly-set flag can only narrow the containment set,
   * never widen it. Otherwise realpaths every
   * root. A root that does not exist yet is a legitimate
   * root (`worktree add` probes its own target before creating it); its
   * canonical prefix is derived from the realpath of its nearest EXISTING ancestor
   * and re-joining the missing tail — exactly the form `realpathForCreation`
   * later produces for leaves under it, so a target beneath a symlinked
   * ancestor (macOS `/tmp` → `/private/tmp`) is admitted rather than
   * spuriously denied. Any non-ENOENT errno rejects the whole resolution
   * rather than being swallowed.
   */
  private async canonicalizeRoots(): Promise<ReadonlyArray<RootPrefix>> {
    if (this.rootsArePreResolved) {
      return this.getRootDirPrefixes();
    }
    const resolved = await Promise.all(this.rootDirs.map((root) => this.canonicalizeRoot(root)));
    return resolved.map((root) => this.toRootPrefix(root));
  }

  /**
   * Realpaths one root: `realpathSync.native` under a policy (raw errno kept
   * — this method classifies `ENOENT` itself, so it must NOT go through
   * `runSync`'s `mapErrno`), else `fsOps.realpath`. The nearest-existing
   * fallback always stays async — it is a cold, one-time path.
   */
  private async canonicalizeRoot(root: string): Promise<string> {
    const sync = this.syncIo;
    try {
      return sync === undefined
        ? await this.fsOps.realpath(root)
        : await runWithinBudget(sync.budget, () => sync.ops.realpathSync.native(root));
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') return this.nearestExistingRoot(root);
      throw err;
    }
  }

  /**
   * The nearest-existing walk itself can ENOENT at the volume root (an
   * unmounted Windows drive / offline UNC share — unreachable on POSIX,
   * where realpath('/') always succeeds). Fall back to the lexical root:
   * its raw prefix still gates, and every op under the unreachable volume
   * fails closed on its own realpath instead of rejecting the whole
   * adapter with an unmapped errno.
   */
  private nearestExistingRoot(root: string): Promise<string> {
    return realpathNearestExisting(root, this.pathPolicy, this.fsOps).catch(
      (nestedErr: unknown) => {
        if (isErrnoException(nestedErr) && nestedErr.code === 'ENOENT') return root;
        throw nestedErr;
      },
    );
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

  read = async (path: string): Promise<Uint8Array> => {
    const { all } = this.resolvedRootSet ?? (await this.loadRootSet());
    const real = this.resolveRead(path, all);
    const fast = await this.readWholeFileFast(real, path);
    if (fast !== undefined) return fast;
    return runFs(async () => toBufferView(await this.fsOps.readFile(real)), path);
  };

  /**
   * `read`/`readUtf8`'s shared sync attempt: `undefined` → the caller's async
   * fallback (non-regular, or grew mid-read). A file over the sync gate is
   * answered here too — the sync probe's descriptor is handed to an async
   * read on the SAME fd rather than closed and re-opened.
   */
  private async readWholeFileFast(real: string, path: string): Promise<Uint8Array | undefined> {
    const sync = this.syncIo;
    if (sync === undefined) return undefined;
    const attempt = await runSync(
      sync.budget,
      () => openAndAttemptSyncRead(sync.ops, real, sync.maxSyncReadBytes),
      path,
    );
    if (attempt.kind === 'read') return attempt.bytes;
    if (attempt.kind === 'ineligible') return undefined;
    return runFs(
      () => finishOverGateRead(sync.ops, this.fsOps, real, attempt.fd, attempt.size),
      path,
    );
  }

  readSlice = async (path: string, offset: number, length: number): Promise<Uint8Array> => {
    if (offset < 0 || length < 0) throw permissionDenied(path);
    const { all } = this.resolvedRootSet ?? (await this.loadRootSet());
    const real = this.resolveRead(path, all);
    const fast = await this.readSliceFast(real, offset, length, path);
    if (fast !== undefined) return fast;
    return this.readSliceViaHandle(real, offset, length, path);
  };

  /** `readSlice`'s sync attempt: `undefined` when over the gate, non-regular, or no policy. */
  private readSliceFast(
    real: string,
    offset: number,
    length: number,
    path: string,
  ): Promise<Uint8Array | undefined> {
    const sync = this.syncIo;
    if (sync === undefined || length > sync.maxSyncReadBytes) return Promise.resolve(undefined);
    return runSync(sync.budget, () => readSliceSync(sync.ops, real, offset, length), path);
  }

  private async readSliceViaHandle(
    real: string,
    offset: number,
    length: number,
    path: string,
  ): Promise<Uint8Array> {
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
  }

  readUtf8 = async (path: string): Promise<string> => {
    const { all } = this.resolvedRootSet ?? (await this.loadRootSet());
    const real = this.resolveRead(path, all);
    const fast = await this.readWholeFileFast(real, path);
    if (fast !== undefined) return decodeUtf8(fast);
    return runFs(() => this.fsOps.readFile(real, 'utf-8'), path);
  };

  /**
   * Resolves `undefined` exactly where `readUtf8` refuses FILE_NOT_FOUND;
   * behaves identically otherwise, a directory's PERMISSION_DENIED included.
   * The sync arm's own "not eligible" outcome (non-regular, over the gate,
   * or grew mid-read) always falls back to the async arm rather than being
   * misread as a miss.
   */
  tryReadUtf8 = async (path: string): Promise<string | undefined> => {
    const { all } = this.resolvedRootSet ?? (await this.loadRootSet());
    const real = this.resolveRead(path, all);
    const sync = this.syncIo;
    const outcome =
      sync === undefined ? UNSETTLED_SYNC_READ : await tryReadWholeFileSync(sync, real, path);
    if (outcome.settled) {
      return outcome.bytes === undefined ? undefined : decodeUtf8(outcome.bytes);
    }
    return orAbsent(() => this.fsOps.readFile(real, 'utf-8'), path);
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
    await this.assertExclusiveCreateLeaf(real, path);
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

  // Attempts the append before creating the parent: the common case (a
  // reflog's directory already exists) then costs one syscall instead of
  // an unconditional `mkdir` on every line. `mkdir` runs only when that
  // first attempt reports the parent is absent — a SECOND `ENOENT` after
  // `mkdir` succeeded is a real fault (e.g. a concurrent removal), not a
  // transient race, so it propagates rather than looping.
  appendUtf8 = async (path: string, content: string): Promise<void> => {
    const real = await this.resolveWrite(path);
    await this.assertWritableLeaf(real, path);
    await runFs(async () => {
      try {
        await this.fsOps.appendFile(real, content, { encoding: 'utf-8', flag: APPEND_FLAGS });
      } catch (err) {
        if (!isErrnoException(err) || err.code !== 'ENOENT') throw err;
        await this.fsOps.mkdir(this.pathPolicy.dirname(real), { recursive: true });
        await this.fsOps.appendFile(real, content, { encoding: 'utf-8', flag: APPEND_FLAGS });
      }
    }, path);
  };

  // `exists` follows symlinks (port contract, `src/ports/file-system.ts`):
  // a dangling symlink must report `false`, not `true`. `stat` already
  // follows, so probing existence via `fsOps.stat` (never `lstat`) keeps
  // that contract while dropping the realpath + double root consultation
  // the old implementation paid on every call.
  exists = async (path: string): Promise<boolean> => this.isPresent(path, 'stat');

  // The no-follow twin of `exists`: the same probe through `fsOps.lstat`, so a
  // dangling symlink counts as present and an absent path costs no refusal.
  lexists = async (path: string): Promise<boolean> => this.isPresent(path, 'lstat');

  private async isPresent(path: string, probe: 'stat' | 'lstat'): Promise<boolean> {
    const { all } = this.resolvedRootSet ?? (await this.loadRootSet());
    const real = this.resolveRead(path, all);
    const sync = this.syncIo;
    if (sync !== undefined) {
      return this.isPresentSync(real, path, probe, sync);
    } else {
      const result = await orAbsent(() => this.fsOps[probe](real), path);
      return result !== undefined;
    }
  }

  /**
   * A non-throwing `throwIfNoEntry: false` probe, escalating to
   * {@link disambiguateMiss} only on a miss — that option alone would
   * swallow `ENOTDIR` into `undefined`, hiding the `NOT_A_DIRECTORY`
   * refusal `isPresent`'s async arm (and the port contract) both require.
   */
  private isPresentSync(
    real: string,
    path: string,
    probe: 'stat' | 'lstat',
    sync: SyncIoPolicy,
  ): Promise<boolean> {
    return runSyncPresence(sync.budget, sync.ops, probe, real, this.pathPolicy.dirname(real), path);
  }

  stat = async (path: string): Promise<FileStat> => {
    const { all } = this.resolvedRootSet ?? (await this.loadRootSet());
    const real = this.resolveRead(path, all);
    const sync = this.syncIo;
    return sync === undefined
      ? runFs(async () => mapStat(await this.fsOps.stat(real, { bigint: true })), path)
      : runSync(sync.budget, () => mapStat(sync.ops.statSync(real, { bigint: true })), path);
  };

  lstat = async (path: string): Promise<FileStat> => {
    const { all } = this.resolvedRootSet ?? (await this.loadRootSet());
    const real = this.resolveRead(path, all);
    const sync = this.syncIo;
    return sync === undefined
      ? runFs(async () => mapStat(await this.fsOps.lstat(real, { bigint: true })), path)
      : runSync(sync.budget, () => mapStat(sync.ops.lstatSync(real, { bigint: true })), path);
  };

  /**
   * Resolves `undefined` exactly where `lstat` refuses FILE_NOT_FOUND;
   * behaves identically otherwise. The sync arm answers a miss with no
   * error object at all; the async arm folds `ENOENT` before `mapErrno`, as
   * `isPresent` does.
   */
  tryLstat = async (path: string): Promise<FileStat | undefined> => {
    const { all } = this.resolvedRootSet ?? (await this.loadRootSet());
    const real = this.resolveRead(path, all);
    const sync = this.syncIo;
    return sync === undefined
      ? orAbsent(async () => mapStat(await this.fsOps.lstat(real, { bigint: true })), path)
      : tryLstatSync(sync, real, this.pathPolicy.dirname(real), path);
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
    // The write guard resolves the parent via realpath and joins the basename without
    // following the leaf, so dangling symlinks — whose realpath would fail
    // — can still be removed. A regular file's containment is still
    // verified via its parent directory, which is the same guarantee.
    const real = await this.resolveWrite(path);
    try {
      await this.fsOps.rm(real);
    } catch (err) {
      // Node's `fs.rm` refuses EVERY directory outright (`ERR_FS_EISDIR`)
      // unless `recursive: true` is passed — it never even checks whether
      // one is empty. The port's own contract is "file or EMPTY directory",
      // so a directory falls back to `rmdir`, which succeeds only when
      // empty and throws `ENOTEMPTY` (mapped to `directoryNotEmpty`)
      // otherwise — never silently recursing into a non-empty one.
      if (isErrnoException(err) && err.code === 'ERR_FS_EISDIR') {
        await this.removeDirectoryEntry(real, path);
        return;
      }
      if (isErrnoException(err)) throw mapErrno(err, path);
      throw err;
    }
    // Node's `fs.rm` without `recursive` only removes leaves — a regular
    // file or symlink. The parent directory and its realpath are
    // unchanged, so the parent-realpath cache entry for `dirname(real)`
    // remains valid; only the directory arm above invalidates.
  };

  /**
   * `rm`'s directory arm. The removed directory may itself be a cached parent
   * (or hold nested ones), and its path may be re-created as a symlink leaving
   * the root, so the cache is cleared in full — see `parentRealpathCache`'s
   * field doc for why no narrower eviction is sound. A failed `rmdir` left the
   * directory in place, so its entries stay valid.
   */
  private async removeDirectoryEntry(real: string, path: string): Promise<void> {
    await runFs(() => this.fsOps.rmdir(real), path);
    this.parentRealpathCache.clear();
  }

  rename = async (src: string, dst: string): Promise<void> => {
    // Neither arm follows its leaf: `rename(2)` itself acts on the link
    // entry, never its target (POSIX and git semantics) — renaming a
    // symlink moves the link and leaves whatever it points at untouched.
    const realSrc = await this.resolveWrite(src);
    const realDst = await this.resolveWrite(dst);
    try {
      await runFs(async () => {
        const replace = await this.mustReplaceDirectory(realSrc, realDst, src);
        await this.fsOps.mkdir(this.pathPolicy.dirname(realDst), { recursive: true });
        if (replace) {
          await this.replaceDirectory(realSrc, realDst);
        } else {
          await this.fsOps.rename(realSrc, realDst);
        }
      }, src);
    } finally {
      // Deliberately a full clear, not a `dirname(src)`/`dirname(dst)`-scoped
      // delete — see `parentRealpathCache`'s field doc for why a directory
      // rename makes that narrowing unsound. Cleared on the failure path too:
      // the replace arm may have removed the destination and may or may not
      // have recreated it, so no cached parent realpath for either side is
      // known to be current.
      this.parentRealpathCache.clear();
    }
  };

  /**
   * POSIX `rename(2)`'s kind rules, enforced here only on a platform whose
   * own rename does not enforce them. Refuses on positive evidence and
   * delegates on everything else, so no arrangement the platform already
   * decides correctly changes shape. `true` means the destination is a
   * directory other than the source that must be removed before the rename;
   * whether it is empty is the removal's own verdict.
   */
  private async mustReplaceDirectory(
    realSrc: string,
    realDst: string,
    reported: string,
  ): Promise<boolean> {
    if (this.pathPolicy.honoursRenameKinds) return false;
    // Byte-identical spellings are one entry with no case-fold involved: the
    // platform's own no-op, decided before any syscall and any removal.
    if (realSrc === realDst) return false;
    // A destination strictly inside the source is the platform's own
    // invalid-argument refusal; deciding it here, before any syscall, also
    // keeps the removal below away from a directory nested in the source.
    if (this.strictlyContains(realSrc, realDst)) return false;
    const source = await this.lstatOrMissing(realSrc);
    // `lstat` never reports a symlink as a directory (a junction is a
    // symlink to it too), so the directory test alone decides the kind.
    if (source === undefined || !source.isDirectory()) return false;
    const destination = await this.lstatOrMissing(realDst);
    if (destination === undefined) return false;
    if (!destination.isDirectory()) throw notADirectory(reported);
    // The source leaf was never canonicalised (an alias of the directory may
    // spell it), while the destination's parent chain was: only the
    // canonical source can say whether the destination sits inside it.
    const canonicalSrc = await this.fsOps.realpath(realSrc);
    // One directory under two spellings is the platform's own no-op; the
    // string compares above cannot see through Win32 name aliases.
    if (await this.sameDirectory(source, destination, canonicalSrc, realDst)) return false;
    return !this.strictlyContains(canonicalSrc, realDst);
  }

  /**
   * One directory under two spellings: by device and inode when the
   * filesystem reports them, else by canonical path — a volume with no
   * inodes still has one final path per entry, and `realpath` already
   * returns the platform's own spelling of it, so the compare is exact.
   */
  private async sameDirectory(
    source: fs.BigIntStats,
    destination: fs.BigIntStats,
    canonicalSrc: string,
    realDst: string,
  ): Promise<boolean> {
    if (reportsInode(source) && reportsInode(destination)) return sameEntry(source, destination);
    return (await this.realpathOrMissing(realDst)) === canonicalSrc;
  }

  /** The canonical path, or `undefined` for a destination that vanished since its probe. */
  private async realpathOrMissing(real: string): Promise<string | undefined> {
    return orMissing(() => this.fsOps.realpath(real));
  }

  /** `child` is strictly below `parent` — equality is NOT containment here. */
  private strictlyContains(parent: string, child: string): boolean {
    const policy = this.pathPolicy;
    const normalizedParent = policy.normalizeForCompare(parent);
    return (
      policy.normalizeForCompare(child) !== normalizedParent &&
      pathContainsNormalized(normalizedParent, child, policy)
    );
  }

  /**
   * The emulated replacement: remove the destination, then rename. A
   * destination that is not empty fails the removal with ENOTEMPTY, which the
   * enclosing operation maps to DIRECTORY_NOT_EMPTY; one that vanished since
   * the probe has already reached the state the removal wanted, and is not
   * recreated. When the rename then fails, a directory this arm removed is
   * recreated on a best-effort basis so the refusal still changes nothing; an
   * errno failure of that restoration is subordinate to the rename failure
   * being reported and is not surfaced.
   */
  private async replaceDirectory(realSrc: string, realDst: string): Promise<void> {
    const removed = await this.removeEmptyDirectory(realDst);
    try {
      await this.fsOps.rename(realSrc, realDst);
    } catch (err) {
      if (removed) await this.restoreEmptyDirectory(realDst);
      throw err;
    }
  }

  /** `false` when nothing was there to remove. */
  private async removeEmptyDirectory(real: string): Promise<boolean> {
    try {
      await this.fsOps.rmdir(real);
      return true;
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') return false;
      throw err;
    }
  }

  /**
   * Best effort: an errno here means the restoration itself failed, and the
   * rename failure being reported is the one that matters. Anything else is
   * a programming error and surfaces in its place.
   */
  private async restoreEmptyDirectory(real: string): Promise<void> {
    try {
      await this.fsOps.mkdir(real);
    } catch (err) {
      if (!isErrnoException(err)) throw err;
    }
  }

  /** "Is there an entry here" — never "what is it". Swallows nothing but absence. */
  private async lstatOrMissing(real: string): Promise<fs.BigIntStats | undefined> {
    return orMissing(() => this.fsOps.lstat(real, { bigint: true }));
  }

  // `rename` above is already atomic on POSIX (`rename(2)`) and clears the
  // parent-realpath cache; the capability is just that guarantee exposed
  // under its own name so callers can rely on it without re-deriving it.
  atomicRename = async (src: string, dst: string): Promise<void> => {
    await this.rename(src, dst);
  };

  readlink = async (path: string): Promise<string> => {
    const { all } = this.resolvedRootSet ?? (await this.loadRootSet());
    const real = this.resolveRead(path, all);
    const sync = this.syncIo;
    if (sync === undefined) return runFs(() => this.fsOps.readlink(real), path);
    return runSync(sync.budget, () => sync.ops.readlinkSync(real), path);
  };

  symlink = async (target: string, path: string): Promise<void> => {
    // A symlink's target — absolute or relative — is opaque bytes, written
    // verbatim, exactly like git: it is never resolved or checked against
    // the root set. Only the link's OWN path is contained; `symlink(2)`
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
    // chmod exists — so, unlike the other leaf-dereferencing write surfaces, it cannot rely on
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
    try {
      await this.removeTree(real, path);
    } finally {
      // Cleared on the failure path too, as `rename` clears on its own: the
      // walk removes children bottom-up, so a rejection part-way leaves
      // siblings already gone and every cached parent realpath under the tree
      // describing a shape that is no longer there.
      this.parentRealpathCache.clear();
    }
  };

  openWithNoFollow = async (path: string, mode: 'read' | 'write'): Promise<FileHandle> => {
    // 'read' never mutates state, so it takes the lexical, syscall-free
    // gate like every other read surface; 'write' takes the write guard
    // and, like every other leaf-dereferencing write surface, leans on `O_NOFOLLOW` at the
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
    // PERMISSION_DENIED on POSIX (which honours `O_NOFOLLOW` at `open`
    // itself); a platform whose `open(2)` does NOT honour it needs the
    // proactive refusal + the discriminator (for errno-bearing failures like
    // EACCES on a symlink target inside an inaccessible parent). Gated on
    // `honoursNoFollow`, not `caseInsensitive` — see `isWindowsSymlinkRefusal`.
    if (!this.pathPolicy.honoursNoFollow && (await this.isSymlinkLeaf(real))) {
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
    return wrapNodeHandle(handle, mode === 'read' ? this.syncIo : undefined);
  };

  private async isSymlinkLeaf(real: string): Promise<boolean> {
    // equivalent-mutant: this method is only called when
    // `!pathPolicy.honoursNoFollow` (Windows today — no shipped policy sets
    // `honoursNoFollow: false` on any other platform). On the Linux mutation
    // runner `posixPolicy.honoursNoFollow` is true, so the body is
    // unreachable and mutating returns/catch produces no observable effect.
    // Windows-mocked tests in `node-file-system-injected.test.ts` (via
    // `windowsPolicy` injected through the `PathPolicy` + `FsOperations` DI
    // seam) cover both arms.
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
    await mapConcurrent(entries, this.removeTreeConcurrency, (entry) =>
      this.removeTree(this.pathPolicy.join(real, entry.name), originalPath),
    );
    await runFs(() => this.fsOps.rmdir(real), originalPath);
  }

  /** lstat the creation leaf and classify it. Unconditional; callers gate on the policy. */
  private async creationLeafIsSymlink(real: string, path: string): Promise<boolean> {
    let lstatResult: { ok: true; isSymlink: boolean } | { ok: false; err: unknown };
    try {
      const leafStat = await this.fsOps.lstat(real);
      lstatResult = { ok: true, isSymlink: leafStat.isSymbolicLink() };
    } catch (err) {
      lstatResult = { ok: false, err };
    }
    return isCreationLeafSymlink(lstatResult, path);
  }

  /**
   * Explicit leaf check for the two situations that cannot rely on
   * `O_NOFOLLOW`: `chmod` (no portable no-follow chmod exists, on any
   * platform) and the Windows arm of every other leaf-dereferencing write surface except
   * `writeExclusive`, which takes `assertExclusiveCreateLeaf` and refuses
   * `FILE_EXISTS` instead (`O_NOFOLLOW` is silently ignored there). A symlink
   * leaf throws `PERMISSION_DENIED`; a leaf that doesn't exist yet (ENOENT) is a no-op
   * — the ordinary creation case — and callers whose leaf must already
   * exist (`chmod`) surface that via their own op's own ENOENT.
   */
  private async assertLeafSafeToWrite(real: string, path: string): Promise<void> {
    if (await this.creationLeafIsSymlink(real, path)) throw permissionDenied(path);
  }

  /** `writeExclusive` only: a symlink leaf refuses with FILE_EXISTS, live or dangling. */
  private async assertExclusiveCreateLeaf(real: string, path: string): Promise<void> {
    if (this.pathPolicy.honoursNoFollow) return; // O_EXCL already answers EEXIST
    if (await this.creationLeafIsSymlink(real, path)) throw fileExists(path);
  }

  /**
   * Fallback for every leaf-dereferencing write surface but `writeExclusive` on a platform
   * whose `open(2)` does not honour `O_NOFOLLOW` (`honoursNoFollow: false` — currently Windows
   * only, where the Win32 API silently ignores the flag): the explicit
   * leaf lstat is the only defence there. A platform that DOES honour
   * `O_NOFOLLOW` relies on it at the `open` itself and skips this entirely.
   */
  private async assertWritableLeaf(real: string, path: string): Promise<void> {
    if (!this.pathPolicy.honoursNoFollow) {
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
   *
   * A RELATIVE `path` (a raw-adapter call — every primitive-facing caller
   * already passes absolute, `${gitDir}/…`-shaped paths) is anchored via
   * `toAbsolute` against `this.rootDir` — the adapter's PRIMARY root, first
   * in whatever `roots` array this instance was constructed with. On an
   * instance with a WIDER root set (a worktree fs built from
   * `[worktreePath, ...layoutRoots]`), a relative path the caller intended
   * as commonDir-relative silently resolves under the worktree root instead —
   * an ambiguity with no principled resolution here (this method has no way
   * to know which of several roots a relative path was meant against).
   * Fail-safe, not a containment escape: the mis-anchored candidate still
   * passes through the SAME `roots.some(…)` check below, so a result that
   * would have landed outside every root is still refused (`''` resolves to
   * `this.rootDir` itself, which reads as a directory and maps to
   * `PERMISSION_DENIED` via `EISDIR`, not silently admitted). Left
   * unenforced deliberately: rejecting every non-absolute path here would
   * break the single-root case's own tested, intentional relative-path
   * support — closing the multi-root ambiguity would need callers to stop
   * passing relative paths at all, not a change local to this method.
   */
  private resolveRead(path: string, roots: ReadonlyArray<RootPrefix>): string {
    const absolute = toAbsolute(path, this.rootDir, this.pathPolicy);
    // Non-allocating `..` prefilter: the facade already rejects `..`
    // segments, so a raw adapter call is the only way this arm fires. `.`
    // segments and duplicate separators are left uncollapsed — both are
    // OS-normalised at the syscall and neither can escape a prefix check.
    // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent — forcing this ternary to always take the resolve() branch only trades the allocation-skip for an unconditional resolve(); when `absolute` carries no '..' substring at all, resolve() only strips `.` segments/duplicate separators/a trailing slash (never collapses anything else, since there's no ".." to collapse), none of which changes a startsWith-prefix containment verdict against the pre-canonicalised root prefixes.
    const candidate = absolute.indexOf('..') === -1 ? absolute : this.pathPolicy.resolve(absolute);
    const normalized = this.pathPolicy.normalizeForCompare(candidate);
    const contained = roots.some((root) =>
      containedByPrefix(normalized, root.normalized, root.withSep),
    );
    if (!contained) throw permissionDenied(path);
    return candidate;
  }

  /**
   * The single write guard: leading-path containment via
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
    // like-for-like AND so `realpathForCreation`'s fallback walk-up
    // (`realpathNearestExisting`, which splits on `policy.sep` alone) can
    // segment the path correctly.
    //
    // Non-allocating prefilter, mirroring `resolveRead`'s: skip `resolve()`
    // only when it is PROVABLY a no-op for both purposes above — no `..` to
    // collapse, and (Windows only) no foreign `/` separator for `resolve()`
    // to fold to `\`. A backslash-free, dot-dot-free POSIX path never needs
    // `resolve()` for either reason, so POSIX always takes the fast path;
    // Windows takes it only when the path is already native-separator.
    const absolute = toAbsolute(path, this.rootDir, this.pathPolicy);
    // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: equivalent — this is a perf-only skip-the-allocating-resolve() prefilter, not a correctness gate: when it wrongly stays false, resolveWrite's downstream path (realpathForCreation → either an OS-level fsOps.realpath, which resolves ".." itself for any path that genuinely exists, or realpathNearestExisting's own `policy.join(real, remaining)`, which is Node's path.join and therefore normalises — collapsing ".." — regardless) reaches the identical canonical `real` either way; the windowsSyntax operand is also unreachable on this posixPolicy-only CI (always false). Hand-verified: forcing the whole condition false, flipping the outer `||` to `&&`, and forcing each operand false in turn all leave the full covering set (node-file-system, node-file-system-injected, index.node) green.
    const needsResolve =
      absolute.indexOf('..') !== -1 || (this.pathPolicy.windowsSyntax && absolute.includes('/'));
    const resolved = needsResolve ? this.pathPolicy.resolve(absolute) : absolute;
    // Every root is constant for the adapter's lifetime; their normalised
    // raw and canonical prefixes are held as one `RootSet` instance field.
    // The same synchronous-first-path idiom as every read surface
    // (`this.resolvedRootSet ?? await this.loadRootSet()`) reads it directly
    // once settled, with no `await`/microtask on the write hot path either
    // — so the case-fold allocations AND the canonicalising microtask each
    // run once per adapter lifetime rather than once per containment check.
    const { all } = this.resolvedRootSet ?? (await this.loadRootSet());
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
