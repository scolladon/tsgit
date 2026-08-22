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
 */
import { TsgitError } from '../../domain/error.js';
import { invalidReftable } from '../../domain/refs/error.js';
import { type LoadedReftable, loadReftable } from '../../domain/refs/reftable/reftable-log.js';
import {
  createReftableStack,
  type ReftableStack,
} from '../../domain/refs/reftable/reftable-stack.js';
import type { Context } from '../../ports/context.js';

const TABLES_LIST_FILE = 'tables.list';

interface CachedStack {
  readonly stack: ReftableStack;
  readonly mtimeKey: string;
}

/** Per-`Context`, per-stack-directory memo — a `Context` may back two
 *  independent stacks (common dir + a linked worktree's own). */
const stackCache = new WeakMap<Context, Map<string, CachedStack>>();

function isFileNotFound(err: unknown): boolean {
  return err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND';
}

/**
 * `tables.list`'s body: one filename per line, LF-terminated INCLUDING the
 * last line. Anything else — a missing trailing LF, or a blank line other
 * than that terminator — is a malformed listing.
 */
function parseTablesList(text: string): readonly string[] {
  if (text === '') return [];
  if (!text.endsWith('\n')) {
    throw invalidReftable('tables-list', 'tables.list is not newline-terminated');
  }
  const lines = text.slice(0, -1).split('\n');
  if (lines.some((line) => line.length === 0)) {
    throw invalidReftable('tables-list', 'tables.list contains a blank line');
  }
  return lines;
}

/** `undefined` on a `FILE_NOT_FOUND` miss — every other failure propagates. */
async function readTableBytes(ctx: Context, path: string): Promise<Uint8Array | undefined> {
  try {
    return await ctx.fs.read(path);
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

function scopedCache(ctx: Context): Map<string, CachedStack> {
  let scoped = stackCache.get(ctx);
  if (scoped === undefined) {
    scoped = new Map();
    stackCache.set(ctx, scoped);
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
export async function loadReftableStack(ctx: Context, reftableDir: string): Promise<ReftableStack> {
  const stat = await ctx.fs.stat(`${reftableDir}/${TABLES_LIST_FILE}`);
  const mtimeKey = `${stat.mtimeMs}:${stat.size}`;
  const cache = scopedCache(ctx);
  const cached = cache.get(reftableDir);
  if (cached !== undefined && cached.mtimeKey === mtimeKey) {
    return cached.stack;
  }
  const tables = await openTables(ctx, reftableDir);
  const stack = createReftableStack(tables);
  cache.set(reftableDir, { stack, mtimeKey });
  return stack;
}
