/**
 * Shared fd/readdir/readSlice accounting fixture for pack-registry tests.
 *
 * Wraps a Context's `fs` port to count `openWithNoFollow`, `readdir` and
 * `readSlice` calls plus completed handle closes, replacing five hand-rolled
 * local counters that duplicated the same bookkeeping across the test file.
 */
import type { Context } from '../../../../src/ports/context.js';
import type { DirEntry, FileHandle } from '../../../../src/ports/file-system.js';

/**
 * Per-call gate on the wrapped `readdir`, used to pin single-flight
 * ordering: call #n only performs the real `readdir` once `settle(n)` (or
 * `fail(n, …)`) releases it. Per-call, not one shared gate, because some
 * scenarios need two scans in flight simultaneously and must settle them in
 * a chosen order.
 */
export interface ReaddirGate {
  /** Resolves when readdir call #n reaches the gate. */
  readonly arrived: (call: number) => Promise<void>;
  /** Release call #n; it then performs the real readdir. */
  readonly settle: (call: number) => void;
  /** Reject call #n with `error`. */
  readonly fail: (call: number, error: unknown) => void;
}

export interface HandleLedger {
  /** The wrapped Context to hand to createPackRegistry. */
  readonly ctx: Context;
  /** Successful ctx.fs.openWithNoFollow calls (a rejected open yields no handle). */
  readonly opens: () => number;
  /** Completed close() calls on handles this ledger handed out. */
  readonly closes: () => number;
  /** opens − closes: handles still open. */
  readonly outstanding: () => number;
  /** ctx.fs.readdir call count. */
  readonly readdirCalls: () => number;
  /** ctx.fs.readSlice call count — the per-call fallback path. */
  readonly perCallReads: () => number;
  /** Gates each readdir call; only takes effect when `gateReaddir` was requested. */
  readonly readdirGate: ReaddirGate;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function getOrCreate<T>(store: Map<number, Deferred<T>>, call: number): Deferred<T> {
  const existing = store.get(call);
  if (existing !== undefined) return existing;
  const created = createDeferred<T>();
  store.set(call, created);
  return created;
}

interface ReaddirGateHarness {
  readonly gate: ReaddirGate;
  /** Signal call #n's arrival and block until it is released. */
  readonly awaitTurn: (call: number) => Promise<void>;
}

function createReaddirGateHarness(): ReaddirGateHarness {
  const arrivals = new Map<number, Deferred<void>>();
  const releases = new Map<number, Deferred<void>>();

  return {
    gate: {
      arrived: (call) => getOrCreate(arrivals, call).promise,
      settle: (call) => getOrCreate(releases, call).resolve(undefined),
      fail: (call, error) => getOrCreate(releases, call).reject(error),
    },
    awaitTurn: async (call) => {
      getOrCreate(arrivals, call).resolve(undefined);
      await getOrCreate(releases, call).promise;
    },
  };
}

export function withHandleLedger(base: Context, opts?: { gateReaddir?: boolean }): HandleLedger {
  let opens = 0;
  let closes = 0;
  let readdirCalls = 0;
  let perCallReads = 0;
  let nextCall = 0;
  const gateReaddir = opts?.gateReaddir ?? false;
  const { gate, awaitTurn } = createReaddirGateHarness();

  const ctx: Context = {
    ...base,
    fs: {
      ...base.fs,
      openWithNoFollow: async (path: string, mode: 'read' | 'write'): Promise<FileHandle> => {
        // Count only successful opens: a rejected open never yields a handle,
        // so counting it would make outstanding() report a phantom leak.
        const handle = await base.fs.openWithNoFollow(path, mode);
        opens += 1;
        return {
          ...handle,
          close: async () => {
            await handle.close();
            closes += 1;
          },
        };
      },
      readdir: async (path: string): Promise<ReadonlyArray<DirEntry>> => {
        readdirCalls += 1;
        if (gateReaddir) {
          const call = nextCall;
          nextCall += 1;
          await awaitTurn(call);
        }
        return base.fs.readdir(path);
      },
      readSlice: async (path: string, offset: number, length: number): Promise<Uint8Array> => {
        perCallReads += 1;
        return base.fs.readSlice(path, offset, length);
      },
    },
  };

  return {
    ctx,
    opens: () => opens,
    closes: () => closes,
    outstanding: () => opens - closes,
    readdirCalls: () => readdirCalls,
    perCallReads: () => perCallReads,
    readdirGate: gate,
  };
}
