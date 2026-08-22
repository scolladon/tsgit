/**
 * Shared reftable-stack fixture helpers for the primitives test pair
 * (`load-reftable-stack.test.ts`, `reftable-ref-store.test.ts`): reframing a
 * memory `Context` onto the reftable backend, and writing a hand-built
 * `tables.list` + table files under a stack directory. Built on
 * `test/fixtures/refs/reftable-writers.ts`'s byte-level writers — kept
 * separate from that module (which stays free of any test-only dependency)
 * because these helpers do I/O against a `Context`.
 */
import { reftableDir } from '../../../../src/application/primitives/path-layout.js';
import type { Context } from '../../../../src/ports/context.js';

/** Reframe `ctx`'s layout onto the reftable backend — the counterpart to
 *  `commondir-per-worktree-refs.test.ts`'s own `asWorktreeChild` reframing. */
export const withReftableStorage = (ctx: Context): Context => ({
  ...ctx,
  layout: { ...ctx.layout, refStorage: 'reftable' },
});

export interface FixtureTable {
  /** The `tables.list` line — an opaque filename, never parsed for meaning. */
  readonly name: string;
  readonly bytes: Uint8Array;
}

/**
 * Writes `tables.list` (one name per line, LF-terminated including the
 * last) plus every named table's bytes, under `dir` — a
 * `path-layout.ts` `reftableDir(...)` result.
 */
export async function writeReftableFiles(
  ctx: Context,
  dir: string,
  tables: ReadonlyArray<FixtureTable>,
): Promise<void> {
  const listing = tables.map((table) => `${table.name}\n`).join('');
  await ctx.fs.writeUtf8(`${dir}/tables.list`, listing);
  for (const table of tables) {
    await ctx.fs.write(`${dir}/${table.name}`, table.bytes);
  }
}

/** `reftableDir(ctx.layout.gitDir)` — the common-dir stack for a Context
 *  with no linked-worktree split. */
export const commonReftableDir = (ctx: Context): string => reftableDir(ctx.layout.gitDir);
