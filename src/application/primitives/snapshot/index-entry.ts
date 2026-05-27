import type { IndexEntryRow } from '../../../domain/snapshot/index.js';
import type { Context } from '../../../ports/context.js';
import { readBlob } from '../read-blob.js';

/**
 * Application-tier wrapper around `IndexEntryRow`. Inherits the sync data
 * fields (path/oid/mode/stage/flags/cachedStat) and adds `read()`, which
 * pulls the blob bytes by oid via the existing object resolver chain.
 *
 * Index entries' `cachedStat` reflects the index's stat-cache; it MAY
 * disagree with the live filesystem. Consumers that need fresh stat
 * data should consult a `WorkdirSnapshot` instead.
 */
export interface IndexEntry extends IndexEntryRow {
  read(): Promise<Uint8Array>;
}

/**
 * Wrap a domain `IndexEntryRow` with the I/O surface that consumers expect.
 * Identical shape to `createTreeEntry` — the read path is byte-for-byte
 * the same once we have an `oid`.
 */
export const createIndexEntry = (ctx: Context, row: IndexEntryRow): IndexEntry => ({
  ...row,
  read: async () => (await readBlob(ctx, row.oid)).content,
});
