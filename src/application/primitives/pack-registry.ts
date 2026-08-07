/**
 * Lazy scan + cache of .idx files under .git/objects/pack/.
 * Returns a PackRegistry facade used by object-resolver and readObject.
 */
import { TsgitError, type TsgitErrorData } from '../../domain/error.js';
import type { ObjectId } from '../../domain/objects/index.js';
import { invalidPackHeader, invalidPackIndex } from '../../domain/storage/error.js';
import {
  entryOffsets,
  lookupPackIndex,
  type PackIndex,
  parsePackIndex,
} from '../../domain/storage/index.js';
import {
  PACK_HEADER_SIZE,
  type PackHeader,
  parsePackHeader,
} from '../../domain/storage/pack-entry.js';
import type { Context } from '../../ports/context.js';
import { createPromiseMemo } from './internal/promise-memo.js';
import { commonGitDir, packsDir } from './path-layout.js';
import { exceedsMaxPackIdxBytes, REASON_PACK_IDX_EXCEEDS_MAX } from './validators.js';

// Discriminates "this adapter cannot open persistent handles" (the browser
// adapter's openWithNoFollow refusal) from errno-mapped faults that share the
// same code — mapErrno folds unrecognised errnos (EMFILE, EIO, …) into
// UNSUPPORTED_OPERATION with operation 'filesystem', and those must surface,
// not silently reroute every later read through the per-call fallback.
function isUnsupportedOperation(err: unknown): boolean {
  return (
    err instanceof TsgitError &&
    err.data.code === 'UNSUPPORTED_OPERATION' &&
    err.data.operation === 'openWithNoFollow'
  );
}

function isSkippableIoFault(err: unknown): boolean {
  return (
    err instanceof TsgitError &&
    (err.data.code === 'FILE_NOT_FOUND' || err.data.code === 'PERMISSION_DENIED')
  );
}

// The pack file itself is unusable: bad signature, short file, version outside
// 2|3, or a header/index object-count disagreement. Scoped to the lookup layer
// ONLY — INVALID_PACK_INDEX is deliberately absent, because nextOffsetForEntry
// and buildOffsetTable throw it for a MID-READ corruption, and folding those in
// would turn a detected corruption into a silent miss after the gate passed.
function isSkippablePackFault(err: unknown): err is TsgitError {
  return (
    (err instanceof TsgitError && err.data.code === 'INVALID_PACK_HEADER') ||
    isSkippableIoFault(err)
  );
}

// Scan layer: the .idx cannot be turned into a PackIndex (a corrupt or
// unreadable index). Deliberately NOT unioned with isSkippablePackFault —
// INVALID_PACK_INDEX is skippable only here, where the parse happens; at the
// lookup layer it also means a mid-read corruption, which must never be
// laundered into "this pack has no objects".
function isSkippableIdxFault(err: unknown): err is TsgitError {
  return (
    (err instanceof TsgitError && err.data.code === 'INVALID_PACK_INDEX') || isSkippableIoFault(err)
  );
}

// Flat and string-valued on purpose: the Logger port sanitises TOP-LEVEL string
// values only, and a pack name comes from a readdir entry an attacker with repo
// write access controls. Nesting `err.data` would route it round the sanitiser.
const faultContext = (data: TsgitErrorData): Readonly<Record<string, string>> =>
  'reason' in data ? { code: data.code, reason: data.reason } : { code: data.code };

export interface PackOffsetTable {
  readonly sortedOffsets: ReadonlyArray<number>;
  readonly packFileSize: number;
  readonly trailerStart: number;
}

export interface RegisteredPack {
  readonly name: string;
  readonly index: PackIndex;
  readonly packPath: string;
  readonly idxPath: string;
  /**
   * Memoised 12-byte header read + validation — git's `open_packed_git_1` gate.
   * Rejects with `INVALID_PACK_HEADER` for a bad signature, a short file, a
   * version outside 2|3, or a header/index `objectCount` disagreement. One read
   * per pack per successful validation; a rejection clears the memo, so a
   * refused pack is re-probed on the next lookup that hits its index.
   */
  readonly header: () => Promise<PackHeader>;
  /**
   * Lazily-built, cached sorted entry offsets + trailer bound for this pack.
   * Callers must hold a `PackLookupHit` from `lookup` — the header gate's
   * completeness rests on every pack-byte read passing through `lookup` first,
   * and nothing here structurally forces that to stay true.
   */
  readonly offsetTable: () => Promise<PackOffsetTable>;
  /**
   * Read `length` bytes at `offset` via a lazily-opened, memoised persistent
   * `FileHandle` — one `open` per pack for its whole delta-chain walk, not one
   * per step. Falls back to a per-call `ctx.fs.readSlice` on adapters that
   * cannot open a handle (browser OPFS throws `UNSUPPORTED_OPERATION`).
   * Callers must hold a `PackLookupHit` from `lookup` — the header gate's
   * completeness rests on every pack-byte read passing through `lookup` first,
   * and nothing here structurally forces that to stay true.
   */
  readonly readSlice: (offset: number, length: number) => Promise<Uint8Array>;
  /** Release the persistent handle, if one was ever opened. Idempotent. */
  readonly close: () => Promise<void>;
}

export interface PackLookupHit {
  readonly pack: RegisteredPack;
  readonly offset: number;
}

export interface PackRegistry {
  all(): Promise<ReadonlyArray<RegisteredPack>>;
  lookup(id: ObjectId): Promise<PackLookupHit | undefined>;
  /** Drop the cached `.idx` scan so the next `all`/`lookup` re-scans the
   *  pack directory — used after a lazy-fetch writes a new pack. */
  refresh(): void;
  /** Close every loaded pack's persistent handle. Idempotent; a registry
   *  that never scanned the pack directory disposes without touching `fs`. */
  dispose(): Promise<void>;
}

// Control characters are rejected at this boundary so a hostile filename can
// never carry a newline into a line-oriented logger sink downstream — the
// display sanitiser deliberately preserves tab and newline.
const isControlChar = (ch: string): boolean => ch.charCodeAt(0) < 0x20;

function isSafePackName(name: string): boolean {
  return (
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..') &&
    ![...name].some(isControlChar)
  );
}

function isCandidate(entry: { isFile: boolean; name: string }): boolean {
  return entry.isFile && entry.name.endsWith('.idx') && isSafePackName(entry.name);
}

// Single source for the `.idx` → base-name rule: both the scan layer's
// sibling-.pack check and loadPack's own packPath derivation depend on it.
const packBaseName = (idxEntryName: string): string => idxEntryName.slice(0, -'.idx'.length);

async function readBoundedIdx(ctx: Context, idxPath: string): Promise<Uint8Array> {
  // Pre-check stat; reject .idx files large enough to exhaust heap before
  // any allocation. Mirrors the readIndex pattern.
  const stat = await ctx.fs.stat(idxPath);
  if (exceedsMaxPackIdxBytes(stat.size)) {
    throw invalidPackIndex(REASON_PACK_IDX_EXCEEDS_MAX);
  }
  const bytes = await ctx.fs.read(idxPath);
  // Post-check defends against TOCTOU growth between stat and read.
  if (exceedsMaxPackIdxBytes(bytes.length)) {
    throw invalidPackIndex(REASON_PACK_IDX_EXCEEDS_MAX);
  }
  return bytes;
}

async function loadPack(ctx: Context, dir: string, entryName: string): Promise<RegisteredPack> {
  const idxPath = `${dir}/${entryName}`;
  const idxBytes = await readBoundedIdx(ctx, idxPath);
  const index = parsePackIndex(idxBytes);
  const name = packBaseName(entryName);
  const packPath = `${dir}/${name}.pack`;

  const headerMemo = createPromiseMemo(async (): Promise<PackHeader> => {
    const header = parsePackHeader(await ctx.fs.readSlice(packPath, 0, PACK_HEADER_SIZE));
    if (header.objectCount !== index.objectCount) {
      throw invalidPackHeader(
        `object count disagrees with index: pack ${header.objectCount}, index ${index.objectCount}`,
      );
    }
    return header;
  });

  const buildOffsetTable = async (): Promise<PackOffsetTable> => {
    const stat = await ctx.fs.stat(packPath);
    const packFileSize = stat.size;
    const raw = entryOffsets(index);
    const sortedOffsets = [...raw].sort((a, b) => a - b);
    // The pack file trailer is a single pack-checksum digest (SHA-1: 20 bytes,
    // SHA-256: 32 bytes). The last entry's data ends exactly at trailerStart.
    const trailerStart = packFileSize - ctx.hashConfig.digestLength;
    if (trailerStart < 0) {
      throw invalidPackIndex('pack file too small to contain a trailer');
    }
    return { sortedOffsets, packFileSize, trailerStart };
  };
  const offsetTable = createPromiseMemo(buildOffsetTable).get;

  // Lazily-opened, memoised persistent handle for this pack's slice reads.
  // The memo clears itself on any open rejection (a transient EMFILE must
  // not pin later reads — or dispose() — to a stale fault), and the
  // known-unsupported arm below (browser OPFS) clears it too so every later
  // `readSlice` falls back cleanly; `close()` tolerates a rejected memo and
  // closes nothing.
  const handleMemo = createPromiseMemo(() => ctx.fs.openWithNoFollow(packPath, 'read'));
  // `refresh()` closes outgoing packs while sibling reads may still be
  // mid-slice on this instance: in-flight reads are tracked so `close()`
  // drains them first, and a read arriving after `close()` falls back to the
  // per-call path instead of re-opening a handle nothing would ever close.
  const inFlight = new Set<Promise<unknown>>();
  let retired = false;

  const readSlice = async (offset: number, length: number): Promise<Uint8Array> => {
    if (retired) return ctx.fs.readSlice(packPath, offset, length);
    const read = (async (): Promise<Uint8Array> => {
      const handle = await handleMemo.get();
      const buffer = new Uint8Array(length);
      const bytesRead = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    })();
    inFlight.add(read);
    try {
      return await read;
    } catch (err) {
      if (!isUnsupportedOperation(err)) throw err;
      handleMemo.clear();
      return ctx.fs.readSlice(packPath, offset, length);
    } finally {
      // NOTE: this block's BlockStatement mutant (`{}`) is equivalent — inFlight's only
      // reader is close()'s `Promise.allSettled(inFlight)`, which settles identically
      // whether or not already-settled entries remain (an already-settled promise adds no
      // wait and its outcome is discarded), so dropping this deletion cannot change any
      // observable return value or thrown error — only when the settled reference becomes
      // eligible for GC. No inline ignore-comment can attach here and stay equivalent-only,
      // scoped: a comment placed before this block (outside the catch clause) would need
      // `} finally {` split across lines, which the formatter always collapses back onto
      // one line, and a comment placed inside the block (as here) attaches to the first
      // STATEMENT's line, not the block's own line, so it can never target this exact
      // mutant's reported location (verified against the instrumenter's comment handling).
      inFlight.delete(read);
    }
  };

  const close = async (): Promise<void> => {
    retired = true;
    const pending = handleMemo.clear();
    if (pending === undefined) return;
    // Let sibling reads that already hold the handle finish before closing
    // it under them (their own rejections surface to their callers).
    await Promise.allSettled(inFlight);
    // A pending open that rejected has no handle to close; its error already
    // surfaced to the read that triggered it and must not resurface here.
    const handle = await pending.catch(() => undefined);
    if (handle === undefined) return;
    await handle.close();
  };

  return { name, index, packPath, idxPath, header: headerMemo.get, offsetTable, readSlice, close };
}

function bisectLeft(arr: ReadonlyArray<number>, value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((arr[mid] as number) < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export function nextOffsetForEntry(table: PackOffsetTable, offset: number): number {
  const { sortedOffsets, trailerStart } = table;
  const rank = bisectLeft(sortedOffsets, offset);
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — bisectLeft returns rank in [0, len], so rank > len is unreachable; at rank===len sortedOffsets[len] is undefined !== any numeric offset, so whether the first clause is forced always-false or its >= is mutated, the second clause fires the identical throw
  if (rank >= sortedOffsets.length || sortedOffsets[rank] !== offset) {
    throw invalidPackIndex('offset not in pack index: corrupt index');
  }
  if (rank === sortedOffsets.length - 1) {
    return trailerStart;
  }
  return sortedOffsets[rank + 1] as number;
}

const NO_PACKS: ReadonlyArray<RegisteredPack> = Object.freeze([]);

/**
 * Resolve one `.idx` candidate to a `RegisteredPack`, or `undefined` when it
 * must be excluded from the generation: an orphan (no sibling `.pack` in the
 * scan's own listing) or a skippable idx-layer fault (unreadable/unparseable
 * `.idx`). An unrecognised fault still propagates to the caller.
 */
async function loadCandidatePack(
  ctx: Context,
  dir: string,
  entry: { readonly name: string },
  fileNames: ReadonlySet<string>,
): Promise<RegisteredPack | undefined> {
  const name = packBaseName(entry.name);
  if (!fileNames.has(`${name}.pack`)) {
    ctx.logger?.warn?.('packRegistry: skipping pack index with no pack file', {
      idx: entry.name,
    });
    return undefined;
  }
  try {
    return await loadPack(ctx, dir, entry.name);
  } catch (err) {
    if (!isSkippableIdxFault(err)) throw err;
    ctx.logger?.warn?.('packRegistry: skipping unreadable pack index', {
      idx: entry.name,
      ...faultContext(err.data),
    });
    return undefined;
  }
}

export function createPackRegistry(ctx: Context): PackRegistry {
  const scanPacks = async (): Promise<ReadonlyArray<RegisteredPack>> => {
    const dir = packsDir(commonGitDir(ctx));
    if (!(await ctx.fs.exists(dir))) return NO_PACKS;
    const entries = await ctx.fs.readdir(dir);
    // git registers a pack only when its .pack exists by name — an orphaned
    // .idx is garbage, never a pack. The listing already in hand is the same
    // data, so the check costs no I/O.
    // Regular files only: a symlinked .pack is out of scope by the same
    // no-follow policy the data reads enforce, so its .idx drops here too.
    const fileNames = new Set(entries.filter((entry) => entry.isFile).map((entry) => entry.name));
    const packs: RegisteredPack[] = [];
    for (const entry of entries) {
      if (!isCandidate(entry)) continue;
      const pack = await loadCandidatePack(ctx, dir, entry, fileNames);
      if (pack !== undefined) packs.push(pack);
    }
    return packs;
  };
  const scan = createPromiseMemo(scanPacks);

  let disposed = false;
  const pendingCloses = new Set<Promise<unknown>>();

  // Only ever handed a promise that cannot reject (Promise.allSettled never does),
  // or this bookkeeping .finally would become an unhandled rejection of its own.
  const trackClose = (settled: Promise<unknown>): void => {
    pendingCloses.add(settled);
    // Stryker disable next-line BlockStatement: equivalent — a never-shrinking pendingCloses only makes drainPendingCloses's Promise.allSettled await already-settled entries too, which resolves immediately with no observable outcome change; the only effect is the settled reference staying reachable instead of becoming eligible for GC
    void settled.finally(() => {
      pendingCloses.delete(settled);
    });
  };

  const drainPendingCloses = async (): Promise<void> => {
    // allSettled, not all: the drain must never re-raise — a tracked batch is
    // allSettled-derived and cannot reject, but the drain does not rest on
    // that invariant holding forever.
    await Promise.allSettled([...pendingCloses]);
  };

  // Terminal disposal binds the read path too: once disposed, never start a
  // scan — its packs would be unreachable from refresh() (a no-op by then)
  // and from dispose() (already resolved), so nothing could ever close their
  // handles. A memo still populated keeps returning the closed, retired set —
  // including a pending scan that later rejects, whose error reaches these
  // read callers exactly as it reaches pre-dispose joiners. An empty memo
  // (never scanned, or self-cleared by a scan rejection) resolves empty
  // instead of scanning.
  const allPacks = (): Promise<ReadonlyArray<RegisteredPack>> => {
    if (!disposed) return scan.get();
    return scan.peek() ?? Promise.resolve(NO_PACKS);
  };

  return {
    all: allPacks,
    refresh(): void {
      if (disposed) return;
      // The outgoing packs may hold open persistent handles; close them before
      // dropping the references or every refresh leaks one fd per touched pack.
      const outgoing = scan.clear();
      if (outgoing === undefined) return;
      trackClose(
        outgoing.then(
          (packs) => Promise.allSettled(packs.map((pack) => pack.close())),
          // A rejected scan produced no packs and therefore no handles. The error is
          // not discarded: it is delivered to the all()/lookup() caller that triggered
          // the scan — this arm only declines to close a set that does not exist.
          // Stryker disable next-line ArrowFunction: equivalent — this .then result is consumed only by trackClose, which discards it via Promise.allSettled; returning undefined instead of NO_PACKS changes nothing observable (unlike dispose()'s `.catch(() => NO_PACKS)` below, whose result feeds packs.map and whose mutant was killed)
          () => NO_PACKS,
        ),
      );
    },
    async lookup(id: ObjectId): Promise<PackLookupHit | undefined> {
      const packs = await allPacks();
      for (const pack of packs) {
        const offset = lookupPackIndex(pack.index, id);
        if (offset === undefined) continue; // an unclaimed pack is never opened
        try {
          await pack.header(); // git's open_packed_git_1 / is_pack_valid gate
        } catch (err) {
          if (!isSkippablePackFault(err)) throw err;
          ctx.logger?.warn?.('packRegistry: skipping unusable pack', {
            pack: pack.name,
            ...faultContext(err.data),
          });
          continue;
        }
        return { pack, offset };
      }
      return undefined;
    },
    async dispose(): Promise<void> {
      disposed = true;
      // A registry that never scanned the pack directory has no handles to
      // close — skip the scan entirely rather than triggering one just to
      // find nothing. Peek, not clear: all() keeps returning the closed,
      // retired set after disposal. A refresh that ran before this dispose
      // may still have a close batch in flight, so this arm must still
      // drain it.
      const pending = scan.peek();
      if (pending === undefined) return drainPendingCloses();
      // A pending scan's own rejection already has an owner — the all()/
      // lookup() caller that triggered it. Absorb it here without closing
      // anything: a rejected scan produced no packs and therefore no handles.
      const packs = await pending.catch(() => NO_PACKS);
      // Settle every close so one failing handle cannot strand the others.
      const results = await Promise.allSettled(packs.map((pack) => pack.close()));
      await drainPendingCloses();
      const failure = results.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );
      if (failure !== undefined) throw failure.reason;
    },
  };
}
