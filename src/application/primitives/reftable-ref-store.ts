/**
 * The reftable backend's `RefStore` implementation. Every read verb answers
 * from a `loadReftableStack`-loaded stack merge view; `applyRefUpdates` (the
 * write path) commits through `reftable-transaction.ts`'s stack-lock
 * protocol.
 */
import { TsgitError } from '../../domain/error.js';
import type { RefName } from '../../domain/objects/index.js';
import type { ReflogEntry } from '../../domain/reflog/reflog-entry.js';
import {
  iterateReftableLogs,
  loadReftable,
  type ReftableCheck,
  type ReftableRefValue,
  type ReftableStack,
} from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { isDegradableReftableFault } from './internal/reftable-source.js';
import {
  loadReftableStack,
  parseTablesList,
  readSizeCheckedTableBytes,
} from './load-reftable-stack.js';
import { commonGitDir, perWorktreeRefDir, reftableDir } from './path-layout.js';
import type {
  PackRefsOutcome,
  RefEntry,
  RefIntegrityFinding,
  RefStore,
  RefUpdate,
  ResolveDirectResult,
} from './ref-store.js';
import { applyReftableUpdates, packReftableStack } from './reftable-transaction.js';

const TABLES_LIST_FILE = 'tables.list';

/** One finding for a table that failed a structural check — `check` is
 *  whatever the caller already extracted from the caught
 *  `INVALID_REFTABLE` error. */
function tableFinding(table: string, check: ReftableCheck): RefIntegrityFinding {
  return { table, msgId: 'badReftableTable', check };
}

/** `err.data.check` when `err` is an `INVALID_REFTABLE` `TsgitError`,
 *  `undefined` for anything else — the shared narrowing both
 *  `verifyStackTables` and `verifyOneTable` catch on. */
function invalidReftableCheck(err: unknown): ReftableCheck | undefined {
  return err instanceof TsgitError && err.data.code === 'INVALID_REFTABLE'
    ? err.data.check
    : undefined;
}

/**
 * Reads and parses one table `tables.list` names, in isolation from every
 * other table in the stack: a table that has vanished since the listing
 * read (the same compaction race `load-reftable-stack.ts` retries once
 * for) or a structural fault in its bytes both become ONE finding rather
 * than aborting the whole audit.
 */
async function verifyOneTable(
  ctx: Context,
  dir: string,
  name: string,
): Promise<RefIntegrityFinding | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await readSizeCheckedTableBytes(ctx, `${dir}/${name}`);
  } catch (err) {
    if (isDegradableReftableFault(err)) return tableFinding(name, 'tables-list');
    const check = invalidReftableCheck(err);
    if (check !== undefined) return tableFinding(name, check);
    throw err;
  }
  try {
    const table = await loadReftable(bytes, ctx.compressor.streamInflate);
    // `loadReftable` only inflates each log block; it never walks the
    // records inside one, so a block whose restart array or log keys are
    // malformed would otherwise pass this audit as healthy. Consuming the
    // iterator is what forces `logBlockBounds`/`splitLogKey`'s own guards to
    // run against every block this table carries.
    for (const _record of iterateReftableLogs(table)) {
      // Walked for its structural side effect only — see comment above.
    }
    return undefined;
  } catch (err) {
    const check = invalidReftableCheck(err);
    if (check !== undefined) return tableFinding(name, check);
    throw err;
  }
}

/**
 * One stack directory's findings. An absent `tables.list` is a
 * legitimately empty stack — no findings, mirroring `load-reftable-stack.ts`'s
 * own degrade — a malformed manifest is one finding naming the manifest
 * itself, and every table the manifest DOES name is then verified
 * independently by {@link verifyOneTable}.
 */
async function verifyStackTables(
  ctx: Context,
  dir: string,
): Promise<readonly RefIntegrityFinding[]> {
  let text: string;
  try {
    text = await ctx.fs.readUtf8(`${dir}/${TABLES_LIST_FILE}`);
  } catch (err) {
    if (isDegradableReftableFault(err)) return [];
    throw err;
  }

  let names: readonly string[];
  try {
    names = parseTablesList(text);
  } catch (err) {
    const check = invalidReftableCheck(err);
    if (check !== undefined) return [tableFinding(TABLES_LIST_FILE, check)];
    throw err;
  }

  const findings: RefIntegrityFinding[] = [];
  for (const name of names) {
    const finding = await verifyOneTable(ctx, dir, name);
    if (finding !== undefined) findings.push(finding);
  }
  return findings;
}

/** Byte-wise total order over ref names, matching git's own ref ordering —
 *  the same comparator `ref-store.ts` defines for the files backend, kept
 *  local here rather than shared across a cross-backend import for one
 *  four-line function. */
const compareRefNames = (a: RefName, b: RefName): number => {
  // Stryker disable next-line EqualityOperator: equivalent — every array this sorts is pre-deduplicated (per-dir ownership-filtered names / a Set), so a === b never occurs and <= behaves exactly like < on the only reachable inputs.
  if (a < b) return -1;
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — reachable only when a > b (uniqueness above rules out a === b); Array.prototype.sort orders purely off the < 0 sign from the branch above, so true/false/>=/<= here all yield the identical sorted result (verified empirically across 2000 randomized unique-key trials, sizes 3-32; re-proved for this file's own call sites, not carried over from ref-store.ts's separate copy).
  if (a > b) return 1;
  return 0;
};

const byName = (a: RefEntry, b: RefEntry): number => compareRefNames(a.name, b.name);

/**
 * A live ref record's value → the backend-neutral `ResolveDirectResult`.
 * `'peeled'` collapses onto `'direct'`: this backend doesn't expose peel
 * metadata through `resolveDirect` any more than the files backend does —
 * `resolve-ref.ts`'s own peel walk re-derives it from the object store.
 */
function toResolveResult(value: ReftableRefValue): ResolveDirectResult {
  if (value.kind === 'symbolic') {
    return { kind: 'symbolic', target: value.target };
  }
  if (value.kind === 'direct' || value.kind === 'peeled') {
    return { kind: 'direct', id: value.id };
  }
  // Stryker disable next-line ObjectLiteral,StringLiteral: equivalent — `value.kind === 'deletion'` is unreachable here: this function is only ever called with a `stack.lookup()` result, and `lookupInStack` (`reftable-stack.ts`) already shadows a deletion record to `undefined` before it can reach a caller. The arm exists solely so this function stays exhaustive against `ReftableRefValue`'s full kind union.
  return { kind: 'missing' };
}

export function createReftableRefStore(ctx: Context): RefStore {
  async function stackAt(dir: string): Promise<ReftableStack> {
    return loadReftableStack(ctx, reftableDir(dir));
  }

  /** The stack that owns `name`'s record — routes exactly like the files
   *  backend's `refDir(name)`, on the same classification. */
  const stackFor = (name: RefName): Promise<ReftableStack> => stackAt(perWorktreeRefDir(ctx, name));

  /** Every stack this Context can see: the common dir's, plus a linked
   *  worktree's own when it differs from the common dir. */
  async function everyStack(): Promise<readonly ReftableStack[]> {
    const common = commonGitDir(ctx);
    const commonStack = await stackAt(common);
    if (ctx.layout.gitDir === common) return [commonStack];
    return [commonStack, await stackAt(ctx.layout.gitDir)];
  }

  /** Same set of stacks as `everyStack()`, as directory paths rather than
   *  loaded stacks — `verifyIntegrity` needs its own by-table walk, never
   *  `stackAt`'s eager, throw-on-first-fault `loadReftableStack`. */
  function stackDirs(): readonly string[] {
    const common = commonGitDir(ctx);
    const dirs = [reftableDir(common)];
    if (ctx.layout.gitDir !== common) dirs.push(reftableDir(ctx.layout.gitDir));
    return dirs;
  }

  /** `everyStack()`'s own two-dir construction, as gitDirs rather than
   *  reftable subdirectories or loaded stacks — `packRefs` runs its I/O
   *  protocol (`reftable-transaction.ts`) per gitDir, which derives its
   *  own `reftableDir` internally. */
  function gitDirs(): readonly string[] {
    const common = commonGitDir(ctx);
    return ctx.layout.gitDir === common ? [common] : [common, ctx.layout.gitDir];
  }

  async function resolveDirect(name: RefName): Promise<ResolveDirectResult> {
    const stack = await stackFor(name);
    const record = stack.lookup(name);
    return record === undefined ? { kind: 'missing' } : toResolveResult(record.value);
  }

  const matchesPrefix = (name: RefName, prefix: RefName | undefined): boolean =>
    prefix === undefined || name.startsWith(prefix);

  /**
   * Every name a Context can see, collected from its OWNING stack only: a
   * per-worktree name (HEAD, `refs/bisect/…`) is kept only when found in
   * `perWorktreeRefDir`'s own directory, never the common dir's — a linked
   * worktree's Context walks the common stack too (for its shared refs),
   * and that stack, for the main worktree, doubles as the main worktree's
   * OWN per-worktree state. Without this filter a linked worktree's
   * `listRefs` would surface the main worktree's own HEAD as if it were the
   * caller's. Resolution happens separately, in `listRefs` itself, through
   * `stackFor(name)` — never the stack a name happened to be SEEN in here —
   * so a name collected from the wrong stack can never win a wrong value.
   */
  async function collectCandidateNames(prefix: RefName | undefined): Promise<ReadonlySet<RefName>> {
    const names = new Set<RefName>();
    for (const dir of gitDirs()) {
      const stack = await stackAt(dir);
      for (const name of stack.names()) {
        if (matchesPrefix(name, prefix) && perWorktreeRefDir(ctx, name) === dir) {
          names.add(name);
        }
      }
    }
    return names;
  }

  /**
   * Every ref this Context can see, resolved. Walks `stack.entries()` per
   * dir — the same ownership filter `collectCandidateNames` applies for
   * names alone — rather than collecting candidate names first and
   * re-deriving each one's record through `stackFor(name)` + `lookup()`:
   * `entries()` already IS that per-name winning record, computed once by
   * the same k-way merge `names()` walks.
   */
  async function listRefs(prefix?: RefName): Promise<readonly RefEntry[]> {
    const entries: RefEntry[] = [];
    for (const dir of gitDirs()) {
      const stack = await stackAt(dir);
      for (const record of stack.entries()) {
        if (!matchesPrefix(record.name, prefix)) continue;
        if (perWorktreeRefDir(ctx, record.name) !== dir) continue;
        entries.push({ name: record.name, value: toResolveResult(record.value) });
      }
    }
    return entries.sort(byName);
  }

  async function listRefNames(prefix?: RefName): Promise<readonly RefName[]> {
    return [...(await collectCandidateNames(prefix))].sort(compareRefNames);
  }

  /**
   * Backend-owned ref-content health, per `stackDirs()` (the common stack,
   * plus a linked worktree's own when it differs). Unlike `stackAt`'s eager
   * `loadReftableStack`, this never denies the whole audit for one broken
   * table: each table is read and parsed independently, so a structural
   * fault on one becomes its own `badReftableTable` finding — naming the
   * table and the failed check — and the walk continues past it. There is
   * no raw per-ref text in a reftable, so `badRefContent`'s loose-grammar
   * fault class is structurally unreachable here, and object-backing
   * verification (`badRefOid`'s reftable counterpart) is a separate
   * concern this backend does not perform yet.
   */
  async function verifyIntegrity(): Promise<readonly RefIntegrityFinding[]> {
    const findings: RefIntegrityFinding[] = [];
    for (const dir of stackDirs()) {
      findings.push(...(await verifyStackTables(ctx, dir)));
    }
    return findings;
  }

  async function readReflog(name: RefName): Promise<readonly ReflogEntry[]> {
    const stack = await stackFor(name);
    const entries: ReflogEntry[] = [];
    for (const record of stack.logs(name)) {
      if (record.entry.kind === 'entry') {
        const { oldId, newId, identity, message } = record.entry;
        // The on-disk log record's message always carries the single
        // trailing `\n` the writer appends (`canonicaliseLogMessage`); the
        // shared `ReflogEntry.message` contract is newline-free, matching
        // the files backend's own line-delimited parse.
        entries.push({ oldId, newId, identity, message: message.replace(/\n$/, '') });
      }
    }
    // `stack.logs` yields newest-first; `RefStore.readReflog` promises oldest-first.
    return entries.reverse();
  }

  /**
   * `RefStore.readReflogLenient`'s reftable implementation: a plain alias of
   * {@link readReflog}. A reftable log record is length-prefixed binary
   * inside a block, so a damaged record damages the whole BLOCK, not one
   * entry — there is no per-line grammar to be lenient about the way the
   * files backend's text format has one. `readReflog` already skips
   * non-`entry` records (tombstones), and inventing a per-record tolerance
   * beyond that would need an oracle real git's reftable format does not
   * provide.
   */
  const readReflogLenient = readReflog;

  /** Whether `stack.logs(name)` — already tombstone-shadowed — yields at
   *  least one live entry. A name whose raw tables carry only shadowed-away
   *  entries has no reflog at all, matching the files backend's own
   *  file-deleted-means-gone behaviour. */
  function hasLiveReflog(stack: ReftableStack, name: RefName): boolean {
    for (const _record of stack.logs(name)) return true;
    return false;
  }

  async function hasReflog(name: RefName): Promise<boolean> {
    return hasLiveReflog(await stackFor(name), name);
  }

  /** Every name ANY raw table in `stack` carries a log record for — a
   *  superset candidate list `hasLiveReflog` then filters down to names
   *  still live after tombstone shadowing. */
  function candidateReflogNames(stack: ReftableStack): ReadonlySet<RefName> {
    const candidates = new Set<RefName>();
    for (const table of stack.tables) {
      for (const record of iterateReftableLogs(table)) {
        candidates.add(record.name);
      }
    }
    return candidates;
  }

  /** `stack`'s own live reflog names — the candidates that survive
   *  tombstone shadowing. */
  function liveReflogNames(stack: ReftableStack): ReadonlySet<RefName> {
    const names = new Set<RefName>();
    for (const name of candidateReflogNames(stack)) {
      if (hasLiveReflog(stack, name)) names.add(name);
    }
    return names;
  }

  async function listReflogs(): Promise<readonly RefName[]> {
    const stacks = await everyStack();
    const names = new Set<RefName>();
    for (const stack of stacks) {
      for (const name of liveReflogNames(stack)) names.add(name);
    }
    return [...names];
  }

  async function applyRefUpdates(updates: readonly RefUpdate[]): Promise<void> {
    await applyReftableUpdates(ctx, updates);
  }

  /**
   * `packRefs`'s reftable-backend verb: forces a full compaction (and
   * unlinks orphaned tables) on every stack this Context can see, then
   * reports the packed ref count from a fresh `listRefs()` merge view —
   * `packReftableStack` reports only what it uniquely knows (the orphan
   * count), never a table count.
   */
  async function packRefs(): Promise<PackRefsOutcome> {
    let removedOrphanCount = 0;
    for (const dir of gitDirs()) {
      removedOrphanCount += (await packReftableStack(ctx, dir)).removedOrphanCount;
    }
    const packedRefCount = (await listRefs()).length;
    return { packedRefCount, prunedLooseRefCount: 0, removedOrphanCount };
  }

  return {
    resolveDirect,
    applyRefUpdates,
    listRefs,
    listRefNames,
    verifyIntegrity,
    readReflog,
    readReflogLenient,
    hasReflog,
    listReflogs,
    packRefs,
  };
}
