/**
 * The reftable backend's write path — the only place that mutates a stack.
 * Implements git's own stack-lock protocol, measured with a
 * `reference-transaction` hook snapshotting `.git/reftable/` at each step:
 *
 * ```
 * 1  acquire   <dir>/tables.list.lock   fs.writeExclusive(path, empty) -> FILE_EXISTS ⇒ retry
 * 2  read      <dir>/tables.list        (fresh, NOT the memo)
 * 3  verify    every `expected` against the freshly loaded stack
 * 4  assign    update_index = stack.maxUpdateIndex + 1n
 * 5  build     ref records + log records for the whole update list
 * 6  write     <dir>/<name>.temp.<rand>  fs.writeExclusive
 * 7  rename    -> <dir>/0x…-0x…-<rand>.ref
 * 8  write     the new tables.list body into the LOCK file
 * 9  rename    <dir>/tables.list.lock -> tables.list     <- THE SINGLE COMMIT POINT
 * 10 invalidate the per-Context stack memo
 * ```
 *
 * Step 11 (auto-compaction) is a later part's own protocol and best-effort
 * concern — not implemented here.
 *
 * **Cross-stack transactions.** An update list may span both the common and
 * a linked worktree's own stack. Both locks are acquired up front, in a
 * FIXED order (common first, then worktree), so two tsgit writers can never
 * deadlock against each other; each stack is written and committed only
 * after every stack in the transaction has passed its own step-3 CAS check,
 * so a refusal on one stack never leaves the other mutated. Each stack keeps
 * its own independent `update_index` sequence, and the pair commits without
 * cross-stack atomicity — matching git's own guarantee.
 *
 * **Durability gap.** git `fsync`s the lock fd before renaming it away. The
 * `FileSystem` port has no `fsync`, so this commit is ordered (the rename is
 * the single visible commit point) but not durable against power loss
 * between the write and the rename — the same gap `atomicWriteRef` has
 * always had for the files backend, unchanged here and out of scope to
 * close.
 *
 * **The degraded path (no `atomicRename`).** `BrowserFileSystem` omits the
 * capability, so step 9 decomposes into: overwrite `tables.list`, then
 * delete the lock. A crash between those two leaves the transaction
 * COMMITTED with `tables.list.lock` stranded — reads stay correct, but every
 * later write is blocked by a lock the writer itself created, on a platform
 * with no shell to remove it.
 *
 * **Stale-lock recovery — the one sanctioned divergence from git here.** On
 * the atomic path the lock body stays empty, byte-faithful to git, and a
 * stale lock is NEVER broken — `REFTABLE_LOCKED` names the path so a human
 * can act. On the degraded path, step 8 writes the new `tables.list` body
 * into the lock before deleting it, so that body becomes the ownership
 * proof: when acquiring a lock that already exists, its body is compared to
 * the ON-DISK `tables.list` — equal means the commit provably completed and
 * only the `rm` was lost (breaking the lock is then semantically a no-op),
 * unequal is indistinguishable from a live writer and refuses
 * `REFTABLE_LOCKED`. git never reads a lock body and never runs on OPFS, so
 * this non-empty body can never confuse it.
 */
import type { AuthorIdentity } from '../../domain/objects/author-identity.js';
import { bytesEqual } from '../../domain/objects/encoding.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { sanitizeReflogMessage } from '../../domain/reflog/reflog-format.js';
import { shouldAutocreateReflog } from '../../domain/reflog/should-log.js';
import { refNotFound, reftableLocked, refUpdateConflict } from '../../domain/refs/error.js';
import {
  compactionMetric,
  createReftableStack,
  DEFAULT_GEOMETRIC_FACTOR,
  iterateReftableLogs,
  iterateReftableRefs,
  type LoadedReftable,
  loadReftable,
  type ReftableLogRecord,
  type ReftableRefRecord,
  type ReftableStack,
  type ReftableWriteOptions,
  readMagicAndVersion,
  serializeReftable,
  suggestCompactionSegment,
} from '../../domain/refs/index.js';
import {
  DEFAULT_BLOCK_SIZE,
  DEFAULT_RESTART_INTERVAL,
} from '../../domain/refs/reftable/reftable-writer.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from './config-read.js';
import { errorDataCode } from './internal/error-data-code.js';
import { isDegradableReftableFault } from './internal/reftable-source.js';
import { invalidateReftableStack, parseTablesList } from './load-reftable-stack.js';
import {
  commonGitDir,
  perWorktreeRefDir,
  reftableDir,
  reftableTableLockPath,
  tablesListLockPath,
  tablesListPath,
} from './path-layout.js';
import type { ReflogAppend, RefUpdate } from './ref-store.js';
import { resolveReflogIdentity } from './reflog-identity.js';

const TEXT_ENCODER = new TextEncoder();

/** git's own `reftable.lockTimeout` default: 100ms, jittered backoff. */
const LOCK_RETRY_BUDGET_MS = 100;
const LOCK_RETRY_BASE_MS = 10;

/** `readMagicAndVersion`'s own input width: 4-byte magic + 1-byte version —
 *  the size-probe's whole read per table. */
const MAGIC_AND_VERSION_PREFIX_BYTES = 5;

function isFileExists(err: unknown): boolean {
  return errorDataCode(err) === 'FILE_EXISTS';
}

function isFileNotFound(err: unknown): boolean {
  return errorDataCode(err) === 'FILE_NOT_FOUND';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredBackoff(): number {
  return LOCK_RETRY_BASE_MS + Math.random() * LOCK_RETRY_BASE_MS;
}

function randomHex8(): string {
  return Math.floor(Math.random() * 0x100000000)
    .toString(16)
    .padStart(8, '0');
}

// --- Step 1: lock acquisition, with the degraded-path stale-lock rule -----

async function removeIfPresent(ctx: Context, path: string): Promise<void> {
  try {
    await ctx.fs.rm(path);
  } catch (err) {
    if (!isFileNotFound(err)) throw err;
  }
}

async function tryAcquireLock(ctx: Context, lockPath: string): Promise<boolean> {
  try {
    await ctx.fs.writeExclusive(lockPath, new Uint8Array(0));
    return true;
  } catch (err) {
    if (isFileExists(err)) return false;
    throw err;
  }
}

/**
 * Degraded-path-only recovery (see module JSDoc). Never breaks a lock on
 * the atomic path — git's own contract: a stale lock is only ever removed
 * by a human.
 */
async function breakStaleLockIfProvable(
  ctx: Context,
  gitDir: string,
  lockPath: string,
): Promise<boolean> {
  if (ctx.fs.atomicRename !== undefined) return false;
  let lockBody: Uint8Array;
  let listBody: Uint8Array;
  try {
    [lockBody, listBody] = await Promise.all([
      ctx.fs.read(lockPath),
      ctx.fs.read(tablesListPath(gitDir)),
    ]);
  } catch {
    return false;
  }
  if (!bytesEqual(lockBody, listBody)) return false;
  await removeIfPresent(ctx, lockPath);
  return true;
}

async function acquireStackLock(ctx: Context, gitDir: string): Promise<string> {
  const lockPath = tablesListLockPath(gitDir);
  const deadline = Date.now() + LOCK_RETRY_BUDGET_MS;
  while (true) {
    if (await tryAcquireLock(ctx, lockPath)) return lockPath;
    if (await breakStaleLockIfProvable(ctx, gitDir, lockPath)) continue;
    if (Date.now() >= deadline) throw reftableLocked(reftableDir(gitDir), `held: ${lockPath}`);
    await sleep(jitteredBackoff());
  }
}

// --- Steps 2-5: fresh read, CAS verification, record building -------------

interface FreshStackRead {
  readonly stack: ReftableStack;
  readonly existingNames: readonly string[];
}

async function readFreshStack(ctx: Context, gitDir: string): Promise<FreshStackRead> {
  let text: string;
  try {
    text = await ctx.fs.readUtf8(tablesListPath(gitDir));
  } catch (err) {
    if (isDegradableReftableFault(err))
      return { stack: createReftableStack([]), existingNames: [] };
    throw err;
  }
  const existingNames = parseTablesList(text);
  const dir = reftableDir(gitDir);
  const tables = [];
  for (const name of existingNames) {
    const bytes = await ctx.fs.read(`${dir}/${name}`);
    tables.push(await loadReftable(bytes, ctx.compressor.streamInflate));
  }
  return { stack: createReftableStack(tables), existingNames };
}

/**
 * `tables.list`'s own name listing — `readFreshStack`'s `existingNames`
 * half, without opening (let alone log-block-inflating) a single table.
 * `compactWholeStack` needs nothing else: its segment is always the whole
 * stack, so there is no per-table decision to make from the bytes.
 */
async function readFreshTableNames(ctx: Context, gitDir: string): Promise<readonly string[]> {
  let text: string;
  try {
    text = await ctx.fs.readUtf8(tablesListPath(gitDir));
  } catch (err) {
    if (isDegradableReftableFault(err)) return [];
    throw err;
  }
  return parseTablesList(text);
}

interface StackSizeProbe {
  readonly existingNames: readonly string[];
  readonly sizes: readonly number[];
}

/**
 * `readFreshStack`'s size-only counterpart: `planCompaction`'s geometric
 * decision needs each table's on-disk size and format version, never its
 * parsed ref/log records — so this sizes every table with one `stat` and a
 * 5-byte `readSlice` apiece instead of reading (and, via `loadReftable`,
 * fully log-block-inflating) each one whole. Correctness is unaffected:
 * `acquireCompactionLocks` re-verifies the probed name list against a fresh
 * `tables.list` read under the lock before anything is merged, and the
 * merge itself (`mergeSegment`) loads the ACTUAL tables it merges in full —
 * a table this probe mis-sizes (impossible for a well-formed file) or skips
 * validating beyond its header would still be caught there.
 */
async function probeStackSizes(ctx: Context, gitDir: string): Promise<StackSizeProbe> {
  const existingNames = await readFreshTableNames(ctx, gitDir);
  const dir = reftableDir(gitDir);
  const sizes: number[] = [];
  for (const name of existingNames) {
    const path = `${dir}/${name}`;
    const fileSize = (await ctx.fs.stat(path)).size;
    const prefix = await ctx.fs.readSlice(path, 0, MAGIC_AND_VERSION_PREFIX_BYTES);
    const { version } = readMagicAndVersion(prefix, fileSize);
    sizes.push(compactionMetric(fileSize, version));
  }
  return { existingNames, sizes };
}

function expectedOf(update: RefUpdate): ObjectId | 'absent' | undefined {
  return update.kind === 'set' || update.kind === 'setSymbolic' || update.kind === 'delete'
    ? update.expected
    : undefined;
}

function actualFor(record: ReturnType<ReftableStack['lookup']>): ObjectId | 'absent' {
  if (record === undefined) return 'absent';
  return record.value.kind === 'direct' || record.value.kind === 'peeled'
    ? record.value.id
    : 'absent';
}

/** Byte-wise total order over ref names, matching git's own ref ordering —
 *  the same comparator every other backend/store module in this codebase
 *  defines locally (`ref-store.ts`, `reftable-ref-store.ts`) rather than
 *  sharing across an import for one four-line function. */
function compareRefNames(a: RefName, b: RefName): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** `serializeReftable`'s own contract: `refs` must already be sorted by
 *  name — this function never reorders them. `applyOneUpdate` builds `refs`
 *  in UPDATE-LIST order, not name order, so every write threads through
 *  here before it reaches the writer. */
function sortRefRecords(refs: readonly ReftableRefRecord[]): readonly ReftableRefRecord[] {
  return [...refs].sort((a, b) => compareRefNames(a.name, b.name));
}

/** `serializeReftable`'s own contract: `logs` must already be sorted by
 *  `(name, reverse update_index)` — ascending name, and DESCENDING
 *  `update_index` within one name (the log key reverses it on disk so the
 *  newest entry sorts first). Getting this wrong doesn't corrupt tsgit's
 *  own linear-scan reader, but it corrupts git's restart-point BINARY
 *  search: measured — an out-of-order log section left `git log -g HEAD`
 *  reporting a stale entry while the correctly-ordered-by-luck neighbour
 *  name read fine. */
function sortLogRecords(logs: readonly ReftableLogRecord[]): readonly ReftableLogRecord[] {
  return [...logs].sort((a, b) => {
    const byName = compareRefNames(a.name, b.name);
    if (byName !== 0) return byName;
    if (a.updateIndex > b.updateIndex) return -1;
    if (a.updateIndex < b.updateIndex) return 1;
    return 0;
  });
}

/** Step 3 — every `expected` against the freshly loaded stack, before ANY
 *  write happens for ANY stack in this transaction. */
function verifyExpectations(updates: readonly RefUpdate[], stack: ReftableStack): void {
  for (const update of updates) {
    const expected = expectedOf(update);
    if (expected === undefined) continue;
    const actual = actualFor(stack.lookup(update.name));
    if (expected !== actual) throw refUpdateConflict(update.name, expected, actual);
  }
}

/**
 * Every name with at least one LIVE log record anywhere in `stack` — one
 * pass over every table's log records (newest table first, mirroring
 * `mergeLogRecords`'s own `(name, update_index)` shadow key), computed ONCE
 * per {@link prepareStackWrite} rather than re-derived by a fresh
 * `stack.logs(name)` scan — an O(stack log records) walk on its own — for
 * EVERY update in the batch. `hasLogHistory` below is then an O(1) lookup
 * against this set.
 */
function collectLoggableNames(stack: ReftableStack): ReadonlySet<RefName> {
  const live = new Set<RefName>();
  const shadowedKeys = new Set<string>();
  for (const table of [...stack.tables].reverse()) {
    for (const record of iterateReftableLogs(table)) {
      const key = `${record.name}\0${record.updateIndex}`;
      if (shadowedKeys.has(key)) continue;
      shadowedKeys.add(key);
      if (record.entry.kind !== 'deletion') live.add(record.name);
    }
  }
  return live;
}

function hasLogHistory(loggableNames: ReadonlySet<RefName>, name: RefName): boolean {
  return loggableNames.has(name);
}

/** The reftable counterpart to `record-ref-update.ts`'s `isLoggable`: "has a
 *  reflog" is any log record anywhere in the stack, not a physical file. */
async function isReftableLoggable(
  ctx: Context,
  loggableNames: ReadonlySet<RefName>,
  name: RefName,
): Promise<boolean> {
  if (hasLogHistory(loggableNames, name)) return true;
  const config = await readConfig(ctx);
  return shouldAutocreateReflog(name, config.core ?? {});
}

/** Appends `reflog` when it applies, reporting whether it did — the
 *  `reflogOnly` caller needs that signal to decide whether it also owes the
 *  table a same-table ref record (see {@link applyOneUpdate}'s `reflogOnly`
 *  arm). Returns `false` without appending when there is nothing to log or
 *  the loggability gate is closed. */
async function maybeAppendReflog(
  ctx: Context,
  loggableNames: ReadonlySet<RefName>,
  logs: ReftableLogRecord[],
  name: RefName,
  updateIndex: bigint,
  identity: AuthorIdentity,
  reflog: ReflogAppend | undefined,
): Promise<boolean> {
  if (reflog === undefined) return false;
  if (reflog.unconditional !== true && !(await isReftableLoggable(ctx, loggableNames, name)))
    return false;
  logs.push({
    name,
    updateIndex,
    entry: {
      kind: 'entry',
      oldId: reflog.oldId,
      newId: reflog.newId,
      identity,
      message: sanitizeReflogMessage(reflog.message),
    },
  });
  return true;
}

/** Tombstones every log record `stack.logs(name)` currently reports as
 *  live, each at ITS OWN `update_index` — never a freshly assigned one.
 *  Shared by a ref deletion (git deletes the whole reflog with it) and a
 *  reflog replace (which must first shadow whatever is on disk before
 *  writing the replacement set — see {@link applyReflogReplaceRecords}). */
function tombstoneExistingLogs(
  stack: ReftableStack,
  name: RefName,
  logs: ReftableLogRecord[],
): void {
  for (const record of stack.logs(name)) {
    logs.push({ name, updateIndex: record.updateIndex, entry: { kind: 'deletion' } });
  }
}

/** A deletion appends a ref tombstone at the NEW `update_index`, plus one
 *  log tombstone per EXISTING live reflog entry, each at THAT entry's own
 *  `update_index` — never the new one. Refuses `REF_NOT_FOUND` when the ref
 *  is not currently live, matching the files backend. */
function applyDeleteRecords(
  stack: ReftableStack,
  name: RefName,
  updateIndex: bigint,
  refs: ReftableRefRecord[],
  logs: ReftableLogRecord[],
): void {
  if (stack.lookup(name) === undefined) throw refNotFound(name);
  refs.push({ name, updateIndex, value: { kind: 'deletion' } });
  tombstoneExistingLogs(stack, name, logs);
}

/**
 * `reflogReplace`'s reftable decomposition: tombstone every record
 * currently on disk for `name` — shadowing whatever history is there now —
 * then write `update.entries` (oldest -> newest, the shared `ReflogEntry`
 * contract) as fresh log records, each at its own newly allocated index so
 * every entry keeps a distinct `(name, update_index)` key.
 *
 * `ReflogEntry` carries no `update_index` of its own — the files backend
 * has no such concept, so nothing upstream of this call could preserve one
 * even if it wanted to. The exact numeric values chosen here are therefore
 * an internal storage choice, not an observable one: no reader anywhere in
 * this codebase surfaces `update_index` as data, only the ORDER and CONTENT
 * of entries, both of which this preserves exactly.
 */
function applyReflogReplaceRecords(
  stack: ReftableStack,
  update: Extract<RefUpdate, { kind: 'reflogReplace' }>,
  baseIndex: bigint,
  logs: ReftableLogRecord[],
): void {
  tombstoneExistingLogs(stack, update.name, logs);
  update.entries.forEach((entry, position) => {
    logs.push({
      name: update.name,
      updateIndex: baseIndex + BigInt(position),
      entry: {
        kind: 'entry',
        oldId: entry.oldId,
        newId: entry.newId,
        identity: entry.identity,
        message: sanitizeReflogMessage(entry.message),
      },
    });
  });
}

async function applyOneUpdate(
  ctx: Context,
  stack: ReftableStack,
  loggableNames: ReadonlySet<RefName>,
  update: RefUpdate,
  updateIndex: bigint,
  identity: AuthorIdentity,
  refs: ReftableRefRecord[],
  logs: ReftableLogRecord[],
): Promise<void> {
  switch (update.kind) {
    case 'set':
      refs.push({ name: update.name, updateIndex, value: { kind: 'direct', id: update.id } });
      await maybeAppendReflog(
        ctx,
        loggableNames,
        logs,
        update.name,
        updateIndex,
        identity,
        update.reflog,
      );
      return;
    case 'setSymbolic':
      refs.push({
        name: update.name,
        updateIndex,
        value: { kind: 'symbolic', target: update.target },
      });
      await maybeAppendReflog(
        ctx,
        loggableNames,
        logs,
        update.name,
        updateIndex,
        identity,
        update.reflog,
      );
      return;
    case 'delete':
      applyDeleteRecords(stack, update.name, updateIndex, refs, logs);
      return;
    case 'reflogOnly':
      await maybeAppendReflog(
        ctx,
        loggableNames,
        logs,
        update.name,
        updateIndex,
        identity,
        update.reflog,
      );
      return;
    case 'reflogReplace':
      applyReflogReplaceRecords(stack, update, updateIndex, logs);
      return;
  }
}

interface PreparedStackWrite {
  readonly gitDir: string;
  readonly lockPath: string;
  readonly existingNames: readonly string[];
  readonly refs: readonly ReftableRefRecord[];
  readonly logs: readonly ReftableLogRecord[];
  readonly minUpdateIndex: bigint;
  readonly maxUpdateIndex: bigint;
}

/** The table header's true `(min, max)` update_index bounds for one write.
 *  Every record shares `base` UNLESS a `reflogReplace` in this batch placed
 *  some below it (a shadowed entry's own, older index) — ref records never
 *  do, so `base` alone is always a safe starting accumulator for both
 *  bounds. Ref-record delta-encoding (`reftable-writer.ts`) requires
 *  `minUpdateIndex <= every ref record's updateIndex`, so this must be the
 *  TRUE minimum, never just `base` reused for both ends. */
function boundingIndices(
  base: bigint,
  refs: readonly ReftableRefRecord[],
  logs: readonly ReftableLogRecord[],
): { readonly min: bigint; readonly max: bigint } {
  let min = base;
  let max = base;
  for (const record of [...refs, ...logs]) {
    if (record.updateIndex < min) min = record.updateIndex;
    if (record.updateIndex > max) max = record.updateIndex;
  }
  return { min, max };
}

async function prepareStackWrite(
  ctx: Context,
  gitDir: string,
  lockPath: string,
  updates: readonly RefUpdate[],
  identity: AuthorIdentity,
): Promise<PreparedStackWrite> {
  const { stack, existingNames } = await readFreshStack(ctx, gitDir);
  verifyExpectations(updates, stack);
  const updateIndex = stack.maxUpdateIndex + 1n;
  const loggableNames = collectLoggableNames(stack);
  const refs: ReftableRefRecord[] = [];
  const logs: ReftableLogRecord[] = [];
  for (const update of updates) {
    await applyOneUpdate(ctx, stack, loggableNames, update, updateIndex, identity, refs, logs);
  }
  const bounds = boundingIndices(updateIndex, refs, logs);
  return {
    gitDir,
    lockPath,
    existingNames,
    refs: sortRefRecords(refs),
    logs: sortLogRecords(logs),
    minUpdateIndex: bounds.min,
    maxUpdateIndex: bounds.max,
  };
}

// --- Steps 6-7: table file naming and write --------------------------------

function formatUpdateIndexPair(minUpdateIndex: bigint, maxUpdateIndex: bigint): string {
  const min = minUpdateIndex.toString(16).padStart(12, '0');
  const max = maxUpdateIndex.toString(16).padStart(12, '0');
  return `0x${min}-0x${max}`;
}

/** `fs.writeExclusive` gives the collision check for free — the `%08x`
 *  random is redrawn on every retry, matching `reftable_rand()`. */
async function writeTempTable(
  ctx: Context,
  dir: string,
  prefix: string,
  bytes: Uint8Array,
): Promise<string> {
  while (true) {
    const tempPath = `${dir}/${prefix}-${randomHex8()}.temp`;
    try {
      await ctx.fs.writeExclusive(tempPath, bytes);
      return tempPath;
    } catch (err) {
      if (!isFileExists(err)) throw err;
    }
  }
}

function writeOptionsFor(
  ctx: Context,
  minUpdateIndex: bigint,
  maxUpdateIndex: bigint,
): ReftableWriteOptions {
  return {
    hashId: ctx.hashConfig.algorithm === 'sha256' ? 's256' : 'sha1',
    blockSize: DEFAULT_BLOCK_SIZE,
    restartInterval: DEFAULT_RESTART_INTERVAL,
    indexObjects: true,
    minUpdateIndex,
    maxUpdateIndex,
  };
}

interface StagedStackWrite extends PreparedStackWrite {
  readonly tableName: string;
}

async function writeStackTableFile(
  ctx: Context,
  write: PreparedStackWrite,
): Promise<StagedStackWrite> {
  const options = writeOptionsFor(ctx, write.minUpdateIndex, write.maxUpdateIndex);
  const bytes = await serializeReftable(write.refs, write.logs, options, ctx.compressor.deflate);
  const dir = reftableDir(write.gitDir);
  const prefix = formatUpdateIndexPair(write.minUpdateIndex, write.maxUpdateIndex);
  const tempPath = await writeTempTable(ctx, dir, prefix, bytes);
  const tableName = `${prefix}-${randomHex8()}.ref`;
  await ctx.fs.rename(tempPath, `${dir}/${tableName}`);
  return { ...write, tableName };
}

function isActiveWrite(write: PreparedStackWrite): boolean {
  return write.refs.length > 0 || write.logs.length > 0;
}

async function writeAllTables(
  ctx: Context,
  prepared: readonly PreparedStackWrite[],
): Promise<readonly StagedStackWrite[]> {
  const staged: StagedStackWrite[] = [];
  for (const write of prepared.filter(isActiveWrite)) {
    staged.push(await writeStackTableFile(ctx, write));
  }
  return staged;
}

// --- Steps 8-9: tables.list rewrite, single commit point -------------------

function tablesListBody(names: readonly string[]): string {
  return names.map((name) => `${name}\n`).join('');
}

/** Writes `names` through `lockPath` and commits it over `tables.list` —
 *  the atomic-vs-degraded branching shared by the main write's own commit
 *  (step 9) and auto-compaction's (step 11's own step 7). */
async function commitListBody(
  ctx: Context,
  gitDir: string,
  lockPath: string,
  names: readonly string[],
): Promise<void> {
  const body = TEXT_ENCODER.encode(tablesListBody(names));
  await ctx.fs.write(lockPath, body);
  if (ctx.fs.atomicRename !== undefined) {
    await ctx.fs.atomicRename(lockPath, tablesListPath(gitDir));
    return;
  }
  await ctx.fs.write(tablesListPath(gitDir), body);
  await ctx.fs.rm(lockPath);
}

async function commitStackList(ctx: Context, write: StagedStackWrite): Promise<void> {
  await commitListBody(ctx, write.gitDir, write.lockPath, [
    ...write.existingNames,
    write.tableName,
  ]);
}

// --- Step 11: auto-compaction ------------------------------------------
//
// Runs once per stack, after that stack's own write has committed (see
// `applyReftableUpdates` below). Consumes the pure
// `suggestCompactionSegment` / `compactionMetric` policy unchanged; this
// section is only the I/O protocol around it, measured against git's own
// `stack_compact_range`:
//
//   1  acquire tables.list.lock; verify the stack is still the one the
//      segment was planned against, else abort
//   2  acquire <table>.ref.lock for every table in the segment, newest ->
//      oldest; a held lock shrinks the range; fewer than two remaining
//      gives up
//   3  release tables.list.lock — concurrent appends may proceed while the
//      merge (step 4) runs
//   4  merge the locked tables into a temp file
//   5  re-acquire tables.list.lock; re-read tables.list; verify the
//      compacted names still appear, contiguously and in the same order;
//      abort if not
//   6  rename the temp file in — unless the merge produced an empty
//      table, which is simply omitted
//   7  write the new tables.list through the lock and rename it over
//   8  unlink the merged tables, best effort; release the per-table locks
//
// Every abort above (an outdated stack, or too few lockable tables) is a
// plain early return, never a throw, so "auto-compaction never fails a
// write" holds for those paths by construction — nothing to catch. The one
// path that DOES throw is `tables.list.lock` itself (steps 1 and 5)
// timing out its retry budget (REFTABLE_LOCKED, reusing acquireStackLock).
// `tryAutoCompact` below swallows exactly that, and only that, narrowly,
// and only after the write it follows has already committed.

interface CompactionPlan {
  readonly plannedNames: readonly string[]; // contiguous, oldest -> newest
}

function planCompaction(
  existingNames: readonly string[],
  sizes: readonly number[],
): CompactionPlan | undefined {
  const segment = suggestCompactionSegment(sizes, DEFAULT_GEOMETRIC_FACTOR);
  if (segment.start === segment.end) return undefined;
  return { plannedNames: existingNames.slice(segment.start, segment.end) };
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

interface LockedSegment {
  readonly tableNames: readonly string[]; // oldest -> newest, possibly shrunk
  readonly tableLockPaths: readonly string[]; // same order as tableNames
  readonly startsAtStackZero: boolean;
}

/** Step 2: per-table locks, newest -> oldest, one attempt each — no retry;
 *  a held lock shrinks the range rather than waiting. `undefined` when
 *  fewer than two end up locked, having released whatever was taken (the
 *  give-up-silently rule). */
async function lockTablesNewestToOldest(
  ctx: Context,
  gitDir: string,
  plannedNames: readonly string[],
  wholeStackOldest: string | undefined,
): Promise<LockedSegment | undefined> {
  const lockedNewestFirst: string[] = [];
  const lockPathsNewestFirst: string[] = [];
  for (const name of [...plannedNames].reverse()) {
    const lockPath = reftableTableLockPath(gitDir, name);
    if (!(await tryAcquireLock(ctx, lockPath))) break;
    lockedNewestFirst.push(name);
    lockPathsNewestFirst.push(lockPath);
  }
  if (lockedNewestFirst.length < 2) {
    await releaseLocksReverse(ctx, lockPathsNewestFirst);
    return undefined;
  }
  const tableNames = [...lockedNewestFirst].reverse();
  return {
    tableNames,
    tableLockPaths: [...lockPathsNewestFirst].reverse(),
    startsAtStackZero: tableNames[0] === wholeStackOldest,
  };
}

/** Steps 1-3: acquire `tables.list.lock`, verify the probed stack is still
 *  current, lock the segment's tables, then release the list lock so
 *  concurrent appends may proceed while the merge (step 4) runs.
 *  `undefined` on either abort path — an outdated probe, or too few
 *  lockable tables. */
async function acquireCompactionLocks(
  ctx: Context,
  gitDir: string,
  probedNames: readonly string[],
  plannedNames: readonly string[],
): Promise<LockedSegment | undefined> {
  const listLockPath = await acquireStackLock(ctx, gitDir);
  try {
    const current = parseTablesList(await ctx.fs.readUtf8(tablesListPath(gitDir)));
    if (!sameNames(current, probedNames)) return undefined;
    return await lockTablesNewestToOldest(ctx, gitDir, plannedNames, probedNames[0]);
  } finally {
    await removeIfPresent(ctx, listLockPath);
  }
}

/** One ref record per name — the newest merged table's record wins, the
 *  same newest-first precedence `reftable-stack.ts`'s view applies, but
 *  over records rather than resolved values, and restricted to the tables
 *  actually being merged. A winning tombstone is dropped only when
 *  `dropTombstones` — the segment's own `start === 0` rule, passed in as
 *  an explicit boolean, never re-derived here. */
function mergeRefRecords(
  tablesOldestFirst: readonly LoadedReftable[],
  dropTombstones: boolean,
): readonly ReftableRefRecord[] {
  const winners = new Map<RefName, ReftableRefRecord>();
  for (const table of tablesOldestFirst) {
    for (const record of iterateReftableRefs(table)) {
      winners.set(record.name, record);
    }
  }
  return [...winners.values()].filter(
    (record) => !(dropTombstones && record.value.kind === 'deletion'),
  );
}

/** Log records are keyed by `(name, update_index)` — not by name alone, the
 *  way `mergeRefRecords` reduces — but a tombstone REUSES the shadowed
 *  entry's own key rather than a fresh one (`applyDeleteRecords`), so the
 *  same key can legitimately recur across the merged tables: an older
 *  table's live entry and a newer table's tombstone for it. Reducing by the
 *  full `(name, update_index)` key, newest table winning (oldest-first
 *  iteration order means a later `.set()` always overwrites an earlier one
 *  for the same key), is what `mergeRefRecords` already does for names —
 *  this mirrors it. Getting this wrong either resurrects the shadowed entry
 *  (a plain concatenation only drops the tombstone record itself) or writes
 *  both records at one key, corrupting git's restart-point binary search
 *  (`sortLogRecords`'s own contract). A winning tombstone is dropped only
 *  when `dropTombstones` — the segment's own `start === 0` rule. */
function mergeLogRecords(
  tablesOldestFirst: readonly LoadedReftable[],
  dropTombstones: boolean,
): readonly ReftableLogRecord[] {
  const winners = new Map<string, ReftableLogRecord>();
  for (const table of tablesOldestFirst) {
    for (const record of iterateReftableLogs(table)) {
      winners.set(`${record.name}\0${record.updateIndex}`, record);
    }
  }
  return [...winners.values()].filter(
    (record) => !(dropTombstones && record.entry.kind === 'deletion'),
  );
}

interface MergedSegment {
  readonly mergedName: string | undefined; // undefined => empty result, omitted
  readonly tempPath: string | undefined;
}

/** Step 4: loads the locked tables, merges them per the tombstone rule,
 *  and writes the result to a temp file — unless the merge produced no
 *  records at all, reported as `mergedName: undefined` rather than
 *  written (an empty table is never renamed in). */
async function mergeSegment(
  ctx: Context,
  gitDir: string,
  locked: LockedSegment,
): Promise<MergedSegment> {
  const dir = reftableDir(gitDir);
  const tables: LoadedReftable[] = [];
  for (const name of locked.tableNames) {
    tables.push(
      await loadReftable(await ctx.fs.read(`${dir}/${name}`), ctx.compressor.streamInflate),
    );
  }
  const refs = sortRefRecords(mergeRefRecords(tables, locked.startsAtStackZero));
  const logs = sortLogRecords(mergeLogRecords(tables, locked.startsAtStackZero));
  if (refs.length === 0 && logs.length === 0) {
    return { mergedName: undefined, tempPath: undefined };
  }
  const minUpdateIndex = tables[0]!.header.minUpdateIndex;
  const maxUpdateIndex = tables[tables.length - 1]!.header.maxUpdateIndex;
  const options = writeOptionsFor(ctx, minUpdateIndex, maxUpdateIndex);
  const bytes = await serializeReftable(refs, logs, options, ctx.compressor.deflate);
  const prefix = formatUpdateIndexPair(minUpdateIndex, maxUpdateIndex);
  const tempPath = await writeTempTable(ctx, dir, prefix, bytes);
  return { mergedName: `${prefix}-${randomHex8()}.ref`, tempPath };
}

/** The re-verified `tables.list` with the locked segment spliced out —
 *  replaced by the merged table's name (or simply removed, if the merge
 *  was empty). `undefined` when the locked names no longer appear as a
 *  contiguous, in-order run — the stack-outdated abort. Names outside the
 *  segment (including any newly appended since step 3's release) pass
 *  through untouched. */
function spliceLockedSegment(
  fresh: readonly string[],
  lockedNames: readonly string[],
  mergedName: string | undefined,
): readonly string[] | undefined {
  const startIndex = fresh.indexOf(lockedNames[0]!);
  if (startIndex === -1) return undefined;
  const slice = fresh.slice(startIndex, startIndex + lockedNames.length);
  if (!sameNames(slice, lockedNames)) return undefined;
  const before = fresh.slice(0, startIndex);
  const after = fresh.slice(startIndex + lockedNames.length);
  return mergedName === undefined ? [...before, ...after] : [...before, mergedName, ...after];
}

async function discardTempFile(ctx: Context, tempPath: string | undefined): Promise<void> {
  if (tempPath !== undefined) await removeIfPresent(ctx, tempPath);
}

async function unlinkSegmentTables(
  ctx: Context,
  gitDir: string,
  names: readonly string[],
): Promise<void> {
  const dir = reftableDir(gitDir);
  for (const name of names) {
    await removeIfPresent(ctx, `${dir}/${name}`);
  }
}

/** Steps 5-8, list-lock scoped: re-verify, rename the merged table in
 *  (unless empty), rewrite `tables.list`, unlink the merged tables. Silent
 *  no-op (after discarding the temp file) when re-verification finds the
 *  segment no longer intact — the stack-outdated abort. Once
 *  `commitListBody` has consumed `listLockPath`, this transaction no longer
 *  owns whatever lives at that path — the `finally` below must not unlink
 *  it, or it can delete a different writer's legitimately-acquired lock
 *  (the same rule {@link applyReftableUpdates} applies to its own lock). */
async function commitMergedList(
  ctx: Context,
  gitDir: string,
  locked: LockedSegment,
  merged: MergedSegment,
): Promise<void> {
  const listLockPath = await acquireStackLock(ctx, gitDir);
  let consumed = false;
  try {
    const fresh = parseTablesList(await ctx.fs.readUtf8(tablesListPath(gitDir)));
    const spliced = spliceLockedSegment(fresh, locked.tableNames, merged.mergedName);
    if (spliced === undefined) {
      await discardTempFile(ctx, merged.tempPath);
      return;
    }
    if (merged.tempPath !== undefined && merged.mergedName !== undefined) {
      await ctx.fs.rename(merged.tempPath, `${reftableDir(gitDir)}/${merged.mergedName}`);
    }
    await commitListBody(ctx, gitDir, listLockPath, spliced);
    consumed = true;
  } finally {
    if (!consumed) await removeIfPresent(ctx, listLockPath);
  }
  await unlinkSegmentTables(ctx, gitDir, locked.tableNames);
}

async function commitCompaction(
  ctx: Context,
  gitDir: string,
  locked: LockedSegment,
  merged: MergedSegment,
): Promise<void> {
  try {
    await commitMergedList(ctx, gitDir, locked, merged);
  } finally {
    await releaseLocksReverse(ctx, [...locked.tableLockPaths].reverse());
  }
}

async function runAutoCompaction(ctx: Context, gitDir: string): Promise<void> {
  const { existingNames, sizes } = await probeStackSizes(ctx, gitDir);
  const plan = planCompaction(existingNames, sizes);
  if (plan === undefined) return;

  const locked = await acquireCompactionLocks(ctx, gitDir, existingNames, plan.plannedNames);
  if (locked === undefined) return;

  const merged = await mergeSegment(ctx, gitDir, locked);
  await commitCompaction(ctx, gitDir, locked, merged);
}

/**
 * Step 11's own boundary: the ref update this follows has already
 * committed, so a lock conflict acquiring `tables.list.lock` for the
 * compaction pass (steps 1 or 5's retry budget expiring) is swallowed here
 * — narrowly, by error code, and only from this call. Every OTHER abort
 * path inside auto-compaction (an outdated stack, or fewer than two
 * tables left lockable) is already a silent no-op by construction and
 * never reaches this catch. Anything of a different shape — a corrupt
 * table, a genuine I/O fault — propagates and fails the whole
 * transaction, exactly like any other unexpected error.
 */
async function tryAutoCompact(ctx: Context, gitDir: string): Promise<void> {
  try {
    await runAutoCompaction(ctx, gitDir);
  } catch (err) {
    if (errorDataCode(err) === 'REFTABLE_LOCKED') return;
    throw err;
  }
}

// --- packRefs: forced full-stack compaction + orphan sweep -----------------
//
// Unlike step 11's auto-compaction (a geometric SUGGESTION), `packRefs`
// always targets the WHOLE stack — segment `[0, existingNames.length)` — so
// tombstones are always elided (a merge that starts at table 0 always
// qualifies). Reuses the exact same lock/merge machinery as auto-compaction:
// under contention it degrades exactly the same way (shrink the lockable
// range, give up silently below two tables), because "never assert the
// table count" applies here too — a caller that races packRefs against a
// concurrent writer gets a best-effort compaction, not a guaranteed single
// table.
//
// Then, separately, under a FRESH `tables.list.lock` acquisition, every
// `*.ref` / `*.temp` file the CURRENT `tables.list` doesn't name is
// unlinked — crash residue this module's own write protocol can leave
// behind (steps 6/7), or a stale byproduct of any compaction, tsgit's or
// git's own. The lock is held across the WHOLE readdir + unlink walk, not
// just the `tables.list` read: "absent from a list read under the lock" is
// only a safe deletion criterion for a file that EXISTED at read time — a
// writer that stages its own table (steps 6-7) DURING an unlocked window
// produces a file that is legitimately absent from that stale list too, and
// an unlink then deletes a live, in-flight table out from under it. Holding
// the lock throughout — git's own `reftable_stack_clean` — closes that
// window by construction: no writer can even begin staging while the sweep
// holds it.

/** Forces a compaction over the WHOLE stack rather than the geometric
 *  suggestion — `plannedNames = probedNames` in full, so the segment is
 *  always `[0, n)` when nothing shrinks it under contention. A stack of
 *  fewer than two tables has nothing to compact. */
async function compactWholeStack(ctx: Context, gitDir: string): Promise<void> {
  const existingNames = await readFreshTableNames(ctx, gitDir);
  if (existingNames.length < 2) return;
  const locked = await acquireCompactionLocks(ctx, gitDir, existingNames, existingNames);
  if (locked === undefined) return;
  const merged = await mergeSegment(ctx, gitDir, locked);
  await commitCompaction(ctx, gitDir, locked, merged);
  invalidateReftableStack(ctx, reftableDir(gitDir));
}

const ORPHAN_TABLE_SUFFIXES: readonly string[] = ['.ref', '.temp'];

function isOrphanCandidate(fileName: string): boolean {
  return ORPHAN_TABLE_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
}

/** Unlinks every `*.ref` / `*.temp` file the tables.list read under the lock
 *  doesn't name — the lock held across the readdir + unlink walk too (see
 *  the module comment above), so no writer can stage a table this sweep
 *  would then mistake for an orphan. Best effort within that protected
 *  window: a file already gone by the time the unlink runs (a concurrent
 *  reader's own cleanup) is not an error. */
async function sweepOrphanTables(ctx: Context, gitDir: string): Promise<number> {
  const listLockPath = await acquireStackLock(ctx, gitDir);
  try {
    const currentNames = parseTablesList(await ctx.fs.readUtf8(tablesListPath(gitDir)));
    const dir = reftableDir(gitDir);
    const keep = new Set(currentNames);
    let removedOrphanCount = 0;
    for (const entry of await ctx.fs.readdir(dir)) {
      if (entry.isDirectory || keep.has(entry.name) || !isOrphanCandidate(entry.name)) continue;
      await removeIfPresent(ctx, `${dir}/${entry.name}`);
      removedOrphanCount += 1;
    }
    return removedOrphanCount;
  } finally {
    await removeIfPresent(ctx, listLockPath);
  }
}

/**
 * `packRefs`'s reftable-backend I/O protocol for ONE stack directory:
 * compact the whole stack, then sweep whatever the compacted `tables.list`
 * no longer names. The caller (`reftable-ref-store.ts`) runs this once per
 * stack the Context can see (the common dir, plus a linked worktree's own)
 * and derives the packed ref COUNT from its own `listRefs()` merge view
 * afterwards — this function reports only what it uniquely knows.
 */
export async function packReftableStack(
  ctx: Context,
  gitDir: string,
): Promise<{ readonly removedOrphanCount: number }> {
  await compactWholeStack(ctx, gitDir);
  return { removedOrphanCount: await sweepOrphanTables(ctx, gitDir) };
}

// --- Cross-stack partitioning -----------------------------------------------

interface StackBucket {
  readonly gitDir: string;
  readonly updates: readonly RefUpdate[];
}

/** Fixed order: common dir first, then a linked worktree's own — the
 *  deadlock-avoidance rule the module JSDoc documents. */
function partitionByStack(ctx: Context, updates: readonly RefUpdate[]): readonly StackBucket[] {
  const commonDir = commonGitDir(ctx);
  const ownDir = ctx.layout.gitDir;
  const buckets = new Map<string, RefUpdate[]>([[commonDir, []]]);
  if (ownDir !== commonDir) buckets.set(ownDir, []);
  for (const update of updates) {
    const gitDir = perWorktreeRefDir(ctx, update.name);
    buckets.get(gitDir)!.push(update);
  }
  return [...buckets.entries()]
    .map(([gitDir, bucketUpdates]) => ({ gitDir, updates: bucketUpdates }))
    .filter((bucket) => bucket.updates.length > 0);
}

// --- Top-level orchestration -------------------------------------------------

/** Releases every lock in `locks` NOT already in `consumed` — git's own
 *  `commit_lock_file` semantics: once a lock's rename/write-then-rm has
 *  committed the state it guarded, this transaction no longer owns the path,
 *  and a release step that still unlinks it by path can delete a DIFFERENT
 *  writer's lock legitimately acquired there in the meantime. Skipping a
 *  consumed path outright — never re-probing the filesystem to decide — is
 *  what closes that window rather than merely narrowing it. */
async function releaseLocksReverse(
  ctx: Context,
  locks: readonly string[],
  consumed: ReadonlySet<string> = new Set(),
): Promise<void> {
  for (const lockPath of [...locks].reverse()) {
    if (consumed.has(lockPath)) continue;
    await removeIfPresent(ctx, lockPath);
  }
}

/**
 * Applies every update in `updates` through git's reftable stack-lock
 * protocol (see module JSDoc). Locks for every stack the update list spans
 * are acquired up front (common first), every stack's CAS check runs before
 * any stack is written, then every stack is written and committed in the
 * same fixed order. Any lock still present when this returns or throws is
 * best-effort released in reverse acquisition order — except one this
 * transaction already consumed via a successful commit, which is never
 * touched again (see {@link releaseLocksReverse}).
 */
export async function applyReftableUpdates(
  ctx: Context,
  updates: readonly RefUpdate[],
): Promise<void> {
  const buckets = partitionByStack(ctx, updates);
  if (buckets.length === 0) return;
  const identity = await resolveReflogIdentity(ctx);
  const locks: string[] = [];
  const consumed = new Set<string>();
  let staged: readonly StagedStackWrite[] = [];

  try {
    const prepared: PreparedStackWrite[] = [];
    for (const bucket of buckets) {
      const lockPath = await acquireStackLock(ctx, bucket.gitDir);
      locks.push(lockPath);
      prepared.push(
        await prepareStackWrite(ctx, bucket.gitDir, lockPath, bucket.updates, identity),
      );
    }
    staged = await writeAllTables(ctx, prepared);
    for (const write of staged) {
      await commitStackList(ctx, write);
      consumed.add(write.lockPath);
      invalidateReftableStack(ctx, reftableDir(write.gitDir));
    }
  } finally {
    await releaseLocksReverse(ctx, locks, consumed);
  }

  // Step 11, per stack that actually committed a table — every lock above
  // is already released, so compaction takes its own independent locks.
  for (const write of staged) {
    await tryAutoCompact(ctx, write.gitDir);
  }
}
