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
import { unsupportedOperation } from '../../domain/error.js';
import type { AuthorIdentity } from '../../domain/objects/author-identity.js';
import { bytesEqual } from '../../domain/objects/encoding.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { sanitizeReflogMessage } from '../../domain/reflog/reflog-format.js';
import { shouldAutocreateReflog } from '../../domain/reflog/should-log.js';
import { refNotFound, reftableLocked, refUpdateConflict } from '../../domain/refs/error.js';
import {
  createReftableStack,
  loadReftable,
  type ReftableLogRecord,
  type ReftableRefRecord,
  type ReftableStack,
  type ReftableWriteOptions,
  serializeReftable,
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
  tablesListLockPath,
  tablesListPath,
} from './path-layout.js';
import type { ReflogAppend, RefUpdate } from './ref-store.js';
import { resolveReflogIdentity } from './reflog-identity.js';

const TEXT_ENCODER = new TextEncoder();

/** git's own `reftable.lockTimeout` default: 100ms, jittered backoff. */
const LOCK_RETRY_BUDGET_MS = 100;
const LOCK_RETRY_BASE_MS = 10;

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

function hasLogHistory(stack: ReftableStack, name: RefName): boolean {
  for (const _entry of stack.logs(name)) return true;
  return false;
}

/** The reftable counterpart to `record-ref-update.ts`'s `isLoggable`: "has a
 *  reflog" is any log record anywhere in the stack, not a physical file. */
async function isReftableLoggable(
  ctx: Context,
  stack: ReftableStack,
  name: RefName,
): Promise<boolean> {
  if (hasLogHistory(stack, name)) return true;
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
  stack: ReftableStack,
  logs: ReftableLogRecord[],
  name: RefName,
  updateIndex: bigint,
  identity: AuthorIdentity,
  reflog: ReflogAppend | undefined,
): Promise<boolean> {
  if (reflog === undefined) return false;
  if (reflog.unconditional !== true && !(await isReftableLoggable(ctx, stack, name))) return false;
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
  for (const record of stack.logs(name)) {
    if (record.entry.kind === 'entry') {
      logs.push({ name, updateIndex: record.updateIndex, entry: { kind: 'deletion' } });
    }
  }
}

async function applyOneUpdate(
  ctx: Context,
  stack: ReftableStack,
  update: RefUpdate,
  updateIndex: bigint,
  identity: AuthorIdentity,
  refs: ReftableRefRecord[],
  logs: ReftableLogRecord[],
): Promise<void> {
  switch (update.kind) {
    case 'set':
      refs.push({ name: update.name, updateIndex, value: { kind: 'direct', id: update.id } });
      await maybeAppendReflog(ctx, stack, logs, update.name, updateIndex, identity, update.reflog);
      return;
    case 'setSymbolic':
      refs.push({
        name: update.name,
        updateIndex,
        value: { kind: 'symbolic', target: update.target },
      });
      await maybeAppendReflog(ctx, stack, logs, update.name, updateIndex, identity, update.reflog);
      return;
    case 'delete':
      applyDeleteRecords(stack, update.name, updateIndex, refs, logs);
      return;
    case 'reflogOnly':
      await maybeAppendReflog(ctx, stack, logs, update.name, updateIndex, identity, update.reflog);
      return;
    case 'reflogReplace':
      throw unsupportedOperation(
        'reftable-reflog-replace',
        'reflog history editing is not yet implemented for the reftable backend',
      );
  }
}

interface PreparedStackWrite {
  readonly gitDir: string;
  readonly lockPath: string;
  readonly existingNames: readonly string[];
  readonly refs: readonly ReftableRefRecord[];
  readonly logs: readonly ReftableLogRecord[];
  readonly updateIndex: bigint;
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
  const refs: ReftableRefRecord[] = [];
  const logs: ReftableLogRecord[] = [];
  for (const update of updates) {
    await applyOneUpdate(ctx, stack, update, updateIndex, identity, refs, logs);
  }
  return {
    gitDir,
    lockPath,
    existingNames,
    refs: sortRefRecords(refs),
    logs: sortLogRecords(logs),
    updateIndex,
  };
}

// --- Steps 6-7: table file naming and write --------------------------------

function formatUpdateIndexPair(updateIndex: bigint): string {
  const hex = updateIndex.toString(16).padStart(12, '0');
  return `0x${hex}-0x${hex}`;
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

function writeOptionsFor(ctx: Context, updateIndex: bigint): ReftableWriteOptions {
  return {
    hashId: ctx.hashConfig.algorithm === 'sha256' ? 's256' : 'sha1',
    blockSize: DEFAULT_BLOCK_SIZE,
    restartInterval: DEFAULT_RESTART_INTERVAL,
    indexObjects: true,
    minUpdateIndex: updateIndex,
    maxUpdateIndex: updateIndex,
  };
}

interface StagedStackWrite extends PreparedStackWrite {
  readonly tableName: string;
}

async function writeStackTableFile(
  ctx: Context,
  write: PreparedStackWrite,
): Promise<StagedStackWrite> {
  const options = writeOptionsFor(ctx, write.updateIndex);
  const bytes = await serializeReftable(write.refs, write.logs, options, ctx.compressor.deflate);
  const dir = reftableDir(write.gitDir);
  const prefix = formatUpdateIndexPair(write.updateIndex);
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

async function commitStackList(ctx: Context, write: StagedStackWrite): Promise<void> {
  const body = TEXT_ENCODER.encode(tablesListBody([...write.existingNames, write.tableName]));
  await ctx.fs.write(write.lockPath, body);
  if (ctx.fs.atomicRename !== undefined) {
    await ctx.fs.atomicRename(write.lockPath, tablesListPath(write.gitDir));
    return;
  }
  await ctx.fs.write(tablesListPath(write.gitDir), body);
  await ctx.fs.rm(write.lockPath);
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

async function releaseLocksReverse(ctx: Context, locks: readonly string[]): Promise<void> {
  for (const lockPath of [...locks].reverse()) {
    await removeIfPresent(ctx, lockPath);
  }
}

/**
 * Applies every update in `updates` through git's reftable stack-lock
 * protocol (see module JSDoc). Locks for every stack the update list spans
 * are acquired up front (common first), every stack's CAS check runs before
 * any stack is written, then every stack is written and committed in the
 * same fixed order. Any lock still present when this returns or throws is
 * best-effort released in reverse acquisition order — a no-op for a lock
 * already consumed by a successful commit.
 */
export async function applyReftableUpdates(
  ctx: Context,
  updates: readonly RefUpdate[],
): Promise<void> {
  const buckets = partitionByStack(ctx, updates);
  if (buckets.length === 0) return;
  const identity = await resolveReflogIdentity(ctx);
  const locks: string[] = [];

  try {
    const prepared: PreparedStackWrite[] = [];
    for (const bucket of buckets) {
      const lockPath = await acquireStackLock(ctx, bucket.gitDir);
      locks.push(lockPath);
      prepared.push(
        await prepareStackWrite(ctx, bucket.gitDir, lockPath, bucket.updates, identity),
      );
    }
    const staged = await writeAllTables(ctx, prepared);
    for (const write of staged) {
      await commitStackList(ctx, write);
      invalidateReftableStack(ctx, reftableDir(write.gitDir));
    }
  } finally {
    await releaseLocksReverse(ctx, locks);
  }
}
