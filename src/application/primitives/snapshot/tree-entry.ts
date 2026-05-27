import type { TreeEntryRow } from '../../../domain/snapshot/index.js';
import type { Context } from '../../../ports/context.js';
import { readBlob } from '../read-blob.js';

/**
 * Application-tier wrapper around `TreeEntryRow`. Inherits the sync data
 * fields (path/oid/mode/kind) and adds the I/O method `read()`, which
 * pulls the blob bytes for this entry's oid via the existing object
 * resolver chain.
 *
 * Each entry binds to the `Context` it was created with. Holding an entry
 * past its context's lifetime is undefined — the resolver may reject the
 * read with an aborted-operation error if the context's signal fires.
 */
export interface TreeEntry extends TreeEntryRow {
  read(): Promise<Uint8Array>;
}

/**
 * Wrap a domain `TreeEntryRow` with the I/O surface that consumers expect.
 * Consumers receive the row's sync fields by spread; the `read()` method
 * defers to the existing `readBlob` primitive so caching/decompression
 * behaviour follows the rest of the application tier.
 */
export const createTreeEntry = (ctx: Context, row: TreeEntryRow): TreeEntry => ({
  ...row,
  read: async () => (await readBlob(ctx, row.oid)).content,
});
