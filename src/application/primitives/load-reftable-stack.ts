/**
 * Loads and memoises one reftable stack: reads `tables.list`, opens every
 * table it names, and merges the loaded tables into a `ReftableStack` view.
 *
 * The load protocol is spec-mandated, not defensive: compaction unlinks a
 * merged table as the LAST step of its own protocol, and tsgit's
 * `FileSystem` reads by path rather than through a held file descriptor, so
 * a table `tables.list` still names can vanish between the listing read and
 * the file open — no POSIX unlink-survives-open protection applies. One
 * retry (re-reading `tables.list` fresh, then every table it now names)
 * absorbs that race; a table still missing after the retry refuses.
 *
 * Memoised per `Context` and per stack directory (a `Context` backs up to
 * two stacks — the common dir's and a linked worktree's own) with an
 * mtime+size key on `tables.list`, mirroring `createRefStore`'s own
 * packed-refs memo: both the update and compaction protocols rewrite
 * `tables.list` as their final step, so the key catches every committed
 * change.
 *
 * An absent `tables.list` — whether its own file was never written, or the
 * whole `.git/reftable/` directory never existed — degrades to an empty
 * stack rather than propagating: `internal/reftable-source.ts`'s tiering
 * classifies both shapes the same way canonical git itself treats them, a
 * legitimately empty ref space rather than damage.
 */
import { TsgitError } from '../../domain/error.js';
import { invalidReftable } from '../../domain/refs/error.js';
import { type LoadedReftable, loadReftable } from '../../domain/refs/reftable/reftable-log.js';
import {
  createReftableStack,
  type ReftableStack,
} from '../../domain/refs/reftable/reftable-stack.js';
import { createLruCache, type LruCache } from '../../domain/storage/lru-cache.js';
import type { Context } from '../../ports/context.js';
import type { FileStat } from '../../ports/file-system.js';
import { isDegradableReftableFault } from './internal/reftable-source.js';

const TABLES_LIST_FILE = 'tables.list';

/** A stack this size or smaller comfortably covers any real git-produced
 *  layout (auto-compaction keeps the table count near `log2(ref count)`);
 *  beyond it, opening every named table one file descriptor at a time is a
 *  resource-exhaustion vector `tables.list` itself never bounds. */
const MAX_TABLES_PER_STACK = 4096;

/** A generous per-table ceiling — the design's own measured tables (even a
 *  3001-ref fixture) are under 100KB — checked via `stat`, before any
 *  `read`, so an oversized file is refused without ever being slurped into
 *  memory. */
const MAX_TABLE_FILE_BYTES = 64 * 1024 * 1024;

interface CachedStack {
  readonly stack: ReftableStack;
  readonly mtimeKey: string;
}

/** Bounds how much a single repository's stack memo retains — both by total
 *  bytes (a stack's tables plus their inflated log blocks) and by entry
 *  count, whichever binds first. A repository backs at most two stacks per
 *  Context (common dir + a linked worktree's own), but a long-running
 *  process cycling through MANY worktrees over its lifetime would otherwise
 *  retain a fully-loaded stack per distinct `reftableDir` it ever visited —
 *  nothing prunes an entry when its worktree is removed. Comfortably above
 *  any realistic per-call working set (a handful of concurrently-active
 *  worktrees), so eviction only ever bites the long tail. */
const MAX_CACHED_STACK_BYTES = 256 * 1024 * 1024;
const MAX_CACHED_STACKS = 64;

/**
 * Per-repository, per-stack-directory memo — a repository may back two
 * independent stacks (common dir + a linked worktree's own). Keyed by
 * `ctx.deltaCache` rather than `ctx` itself: every `Context` derived from
 * the same `openRepository()`/`createXContext()` call carries the SAME
 * `deltaCache` object by reference (it survives every spread-derivation this
 * codebase does — `deriveWorktreeContext`, `deriveSubmoduleContext`, …),
 * whereas `ctx` — and even `ctx.fs` — does not: `list-worktrees.ts` builds a
 * FRESH Context per worktree, and a linked worktree's own `fs` is a fresh
 * confinement wrapper (`worktreeFs(path)`, rebuilt on every call, never
 * memoised) on top of that. Keying on `ctx` (or `ctx.fs`) therefore misses
 * this memo on every worktree, forcing `listWorktrees` to reload the SAME
 * common stack once per worktree instead of once for the whole call.
 * `deltaCache` is otherwise unrelated to ref storage — reused here purely as
 * a stable, per-repository identity anchor already threaded everywhere a
 * `Context` goes, never a global path-keyed cache (which would alias
 * independent repositories that happen to share a path string, e.g. two
 * `createMemoryContext()` instances in the same test process). The INNER
 * cache is itself bounded (see {@link MAX_CACHED_STACK_BYTES}), so retention
 * tracks recent use rather than growing for the repository's whole
 * lifetime.
 */
const stackCache = new WeakMap<Context['deltaCache'], LruCache<CachedStack>>();

/** A stack's retained footprint: every table's own on-disk bytes plus its
 *  log blocks' INFLATED bytes (never smaller, sometimes larger, than their
 *  compressed on-disk extent) — the two buffers `LoadedReftable` actually
 *  keeps resident. Floored at 1: `LruCache.set` requires a positive
 *  `byteSize`, and a genuinely empty (zero-table) stack is still worth
 *  caching — it's the `mtimeMs`+`size` re-`stat` this memo exists to skip,
 *  not a meaningful amount of memory either way. */
function stackByteSize(stack: ReftableStack): number {
  let total = 0;
  for (const table of stack.tables) {
    total += table._bytes.length;
    for (const block of table.logBlocks) {
      total += block.length;
    }
  }
  return Math.max(1, total);
}

function isFileNotFound(err: unknown): boolean {
  return err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND';
}

/**
 * Real git 2.55.0's own writer always names a table
 * `0x<12 hex>-0x<12 hex>-<8 hex>.ref` — but measured against the peer
 * binary, its READER enforces no grammar at all: it happily follows
 * `../../../outside/escape.ref`, or even an absolute path, wherever
 * `tables.list` points it. tsgit diverges here deliberately (documented,
 * not silent): every entry is interpolated straight into a path for a
 * `read`, a table-lock `writeExclusive`, and an `rm`, so an unconstrained
 * grammar turns `tables.list` into a path-traversal primitive the moment
 * this loader's own directory confinement is the only thing standing in
 * the way. Rather than pin git's exact writer form (which would refuse
 * otherwise-harmless names a future writer might choose), this rejects only
 * what can escape the stack directory or otherwise misdirect a path join:
 * a path separator (either OS's), a `..` traversal segment anywhere in the
 * name, a NUL byte, and a leading `.` (dotfile/relative-component tricks).
 */
const UNSAFE_TABLE_NAME = /[/\\]|\.\.|\0/;

function isSafeTableName(name: string): boolean {
  return !name.startsWith('.') && !UNSAFE_TABLE_NAME.test(name);
}

/**
 * `tables.list`'s body: one filename per line, LF-terminated INCLUDING the
 * last line. Anything else — a missing trailing LF, a blank line other than
 * that terminator, or an entry {@link isSafeTableName} refuses — is a
 * malformed listing. Exported for `reftable-ref-store.ts`'s
 * `verifyIntegrity`, which needs the same manifest grammar without the
 * eager throw-on-first-fault load protocol.
 */
export function parseTablesList(text: string): readonly string[] {
  if (text === '') return [];
  if (!text.endsWith('\n')) {
    throw invalidReftable('tables-list', 'tables.list is not newline-terminated');
  }
  const lines = text.slice(0, -1).split('\n');
  if (lines.some((line) => line.length === 0)) {
    throw invalidReftable('tables-list', 'tables.list contains a blank line');
  }
  if (lines.length > MAX_TABLES_PER_STACK) {
    throw invalidReftable(
      'tables-list',
      `tables.list names ${lines.length} tables, exceeding the ${MAX_TABLES_PER_STACK}-table limit`,
    );
  }
  const unsafe = lines.find((line) => !isSafeTableName(line));
  if (unsafe !== undefined) {
    throw invalidReftable('tables-list', `tables.list entry is unsafe: ${unsafe}`);
  }
  return lines;
}

/**
 * The per-table size ceiling, enforced universally: `stat`s `path` before
 * ever reading it, so an oversized `.ref` is refused by its declared size
 * alone — never slurped whole into memory first. The one gate every reftable
 * table read goes through, not just this module's own load path: exported
 * for `reftable-transaction.ts`'s `readFreshStack` and `mergeSegment`, and
 * `reftable-ref-store.ts`'s `verifyOneTable`, which used to call
 * `ctx.fs.read` directly and so had no ceiling at all. Every failure —
 * including `FILE_NOT_FOUND` — propagates unchanged; a caller that wants
 * "missing is a legitimate signal" builds that on top (see
 * {@link readTableBytes} below).
 */
export async function readSizeCheckedTableBytes(ctx: Context, path: string): Promise<Uint8Array> {
  const stat = await ctx.fs.stat(path);
  if (stat.size > MAX_TABLE_FILE_BYTES) {
    throw invalidReftable(
      'tables-list',
      `table ${path} is ${stat.size} bytes, exceeding the ${MAX_TABLE_FILE_BYTES}-byte limit`,
    );
  }
  return ctx.fs.read(path);
}

/** `undefined` on a `FILE_NOT_FOUND` miss — every other failure propagates.
 *  Built on {@link readSizeCheckedTableBytes}, this module's own load-path
 *  convenience: a missing table mid-load is worth one retry, never an
 *  immediate refusal. */
async function readTableBytes(ctx: Context, path: string): Promise<Uint8Array | undefined> {
  try {
    return await readSizeCheckedTableBytes(ctx, path);
  } catch (err) {
    if (isFileNotFound(err)) return undefined;
    throw err;
  }
}

type LoadAttempt =
  | { readonly ok: true; readonly tables: readonly LoadedReftable[] }
  | { readonly ok: false };

/** One pass of the load protocol: a fresh `tables.list` read, then every
 *  table it names. `ok: false` on the first missing table — the caller
 *  decides whether that is worth a retry. */
async function attemptLoad(ctx: Context, reftableDir: string): Promise<LoadAttempt> {
  const text = await ctx.fs.readUtf8(`${reftableDir}/${TABLES_LIST_FILE}`);
  const names = parseTablesList(text);
  const tables: LoadedReftable[] = [];
  for (const name of names) {
    const bytes = await readTableBytes(ctx, `${reftableDir}/${name}`);
    if (bytes === undefined) return { ok: false };
    tables.push(await loadReftable(bytes, ctx.compressor.streamInflate));
  }
  return { ok: true, tables };
}

/** Opens every table `tables.list` currently names — one retry on a miss; a
 *  table still missing after the retry refuses with `check: 'tables-list'`. */
async function openTables(ctx: Context, reftableDir: string): Promise<readonly LoadedReftable[]> {
  const first = await attemptLoad(ctx, reftableDir);
  if (first.ok) return first.tables;
  const retried = await attemptLoad(ctx, reftableDir);
  if (retried.ok) return retried.tables;
  throw invalidReftable(
    'tables-list',
    `a table named by ${reftableDir}/${TABLES_LIST_FILE} is still missing after one retry`,
  );
}

function scopedCache(ctx: Context): LruCache<CachedStack> {
  let scoped = stackCache.get(ctx.deltaCache);
  if (scoped === undefined) {
    scoped = createLruCache<CachedStack>(MAX_CACHED_STACK_BYTES, MAX_CACHED_STACKS);
    stackCache.set(ctx.deltaCache, scoped);
  }
  return scoped;
}

/**
 * Loads (or returns the memoised) `ReftableStack` for the stack rooted at
 * `reftableDir` (`path-layout.ts`'s `reftableDir(gitDir)` — the common
 * dir's, or a linked worktree's own). Eager: every table is fully parsed —
 * including its log blocks, inflated via `ctx.compressor.streamInflate` —
 * before this resolves.
 */
/**
 * Drops `reftableDir`'s memoised stack for `ctx`, if cached — the write
 * path's own escape from the mtime+size cache key (`reftable-transaction.ts`'s
 * commit-protocol step 10), since a same-second commit could alias the
 * post-commit `tables.list` against the pre-commit cache entry. A no-op when
 * nothing was cached yet.
 */
export function invalidateReftableStack(ctx: Context, reftableDir: string): void {
  stackCache.get(ctx.deltaCache)?.delete(reftableDir);
}

export async function loadReftableStack(ctx: Context, reftableDir: string): Promise<ReftableStack> {
  let stat: FileStat;
  try {
    stat = await ctx.fs.stat(`${reftableDir}/${TABLES_LIST_FILE}`);
  } catch (err) {
    if (isDegradableReftableFault(err)) return createReftableStack([]);
    throw err;
  }
  const mtimeKey = `${stat.mtimeMs}:${stat.size}`;
  const cache = scopedCache(ctx);
  const cached = cache.get(reftableDir);
  if (cached !== undefined && cached.mtimeKey === mtimeKey) {
    return cached.stack;
  }
  const tables = await openTables(ctx, reftableDir);
  const stack = createReftableStack(tables);
  cache.set(reftableDir, { stack, mtimeKey }, stackByteSize(stack));
  return stack;
}
