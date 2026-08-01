/**
 * Shared fd/readdir/readSlice accounting fixture for pack-registry tests.
 *
 * Wraps a Context's `fs` port to count `openWithNoFollow`, `readdir` and
 * `readSlice` calls plus completed handle closes, replacing five hand-rolled
 * local counters that duplicated the same bookkeeping across the test file.
 */
import type { Context } from '../../../../src/ports/context.js';
import type { DirEntry, FileHandle } from '../../../../src/ports/file-system.js';

export interface HandleLedger {
  /** The wrapped Context to hand to createPackRegistry. */
  readonly ctx: Context;
  /** ctx.fs.openWithNoFollow call count. */
  readonly opens: () => number;
  /** Completed close() calls on handles this ledger handed out. */
  readonly closes: () => number;
  /** opens − closes: handles still open. */
  readonly outstanding: () => number;
  /** ctx.fs.readdir call count. */
  readonly readdirCalls: () => number;
  /** ctx.fs.readSlice call count — the per-call fallback path. */
  readonly perCallReads: () => number;
}

export function withHandleLedger(base: Context): HandleLedger {
  let opens = 0;
  let closes = 0;
  let readdirCalls = 0;
  let perCallReads = 0;

  const ctx: Context = {
    ...base,
    fs: {
      ...base.fs,
      openWithNoFollow: async (path: string, mode: 'read' | 'write'): Promise<FileHandle> => {
        opens += 1;
        const handle = await base.fs.openWithNoFollow(path, mode);
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
  };
}
