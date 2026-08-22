/**
 * Reftable-refs scenario — reframes the opened repository onto the reftable
 * backend (the same `withReftableStorage` reframing the reftable backend's
 * own unit/integration suites use), materialises a hand-built reftable
 * table, then reads and writes through it. Proves node ≡ memory ≡ browser
 * agreement for the reftable `RefStore`, not faithfulness to canonical git —
 * that is the interop suite's job.
 *
 * The browser adapter has no `atomicRename` (`ctx.fs.atomicRename ===
 * undefined`), so its commit takes the write transaction's degraded path —
 * write the new `tables.list` body into the lock, then delete it. This
 * scenario plants a STALE lock (body identical to the current `tables.list`)
 * before the write on exactly that adapter, to exercise the one sanctioned
 * recovery: a lock whose body matches the current list is provably a lost
 * `rm` after a completed write, and is broken rather than left to time out —
 * the browser is the only adapter where that code path runs.
 *
 * `nonLogPrefixMatches` is the byte-comparable half of the write: the ref
 * section is rebuilt from the newest table's own logical records via
 * `buildReftableRefSection` — pure, sync, no compression — and compared to
 * that table's actual on-disk bytes up to `logPosition`. The comparison
 * deliberately stops there: the LOG section is deflate-compressed, and
 * Node's zlib and the browser's `CompressionStream` produce different
 * compressed bytes for identical logical content, so a raw byte comparison
 * past `logPosition` would fail for a reason that is not a defect. Log
 * content is instead compared semantically, via `reflogSubjects` (the
 * decoded message text, not the compressed block).
 *
 * Surfaces closed:
 *   primitives: resolveRef, updateRef
 */

import { loadReftableStack } from '../../../src/application/primitives/load-reftable-stack.ts';
import {
  reftableDir,
  tablesListLockPath,
  tablesListPath,
} from '../../../src/application/primitives/path-layout.ts';
import { resolveRef } from '../../../src/application/primitives/resolve-ref.ts';
import { updateRef } from '../../../src/application/primitives/update-ref.ts';
import { bytesEqual } from '../../../src/domain/objects/encoding.ts';
import { ObjectId, RefName } from '../../../src/domain/objects/index.ts';
import {
  buildReftableRefSection,
  compactionMetric,
  DEFAULT_GEOMETRIC_FACTOR,
  iterateReftableRefs,
  suggestCompactionSegment,
} from '../../../src/domain/refs/index.ts';
import { DEFAULT_RESTART_INTERVAL } from '../../../src/domain/refs/reftable/reftable-writer.ts';
import type { Context } from '../../../src/ports/context.ts';
import {
  buildRefBlock,
  buildReftable,
  buildReftableHeader,
} from '../../fixtures/refs/reftable-writers.ts';
import { AUTHOR, MESSAGES } from '../fixtures.ts';
import type { Scenario } from './types.ts';

const MAIN_REF = RefName.from('refs/heads/main');
const OLD_OID = ObjectId.from('a'.repeat(40));
const NEW_OID = ObjectId.from('b'.repeat(40));
const REFLOG_MESSAGE = 'reftable-refs scenario update';

interface ReftableRefsScenarioResult {
  readonly oidBeforeWrite: string;
  readonly oidAfterWrite: string;
  readonly reflogSubjects: ReadonlyArray<string>;
  readonly nonLogPrefixMatches: boolean;
  readonly hasCompactionSuggestion: boolean;
}

/** Reframe `ctx`'s layout onto the reftable backend — the acceptance gate's
 *  own inverse (`test/unit/repository/reftable-extension-accepted.test.ts`)
 *  proves a real declared repository reaches this backend through
 *  discovery; this scenario proves the backend agrees across adapters. */
const withReftableStorage = (ctx: Context): Context => ({
  ...ctx,
  layout: { ...ctx.layout, refStorage: 'reftable' },
});

/** A minimal one-record ref-block table: `refs/heads/main -> id`. */
const buildSeedTable = (): Uint8Array => {
  const headerSpec = { version: 1 as const, minUpdateIndex: 1n, maxUpdateIndex: 1n };
  const header = buildReftableHeader(headerSpec);
  const block = buildRefBlock({
    records: [{ name: MAIN_REF, value: { kind: 'direct', id: new Uint8Array(20).fill(0xaa) } }],
    restartIndices: [0],
    isFirstBlock: true,
    headerLength: header.length,
  });
  return buildReftable({ ...headerSpec, blocks: [block] });
};

/** Plants a lock whose body equals the CURRENT `tables.list` — the shape a
 *  crashed degraded commit leaves (the new body was written into the lock,
 *  only the final unlink was lost). Recovery is provable only where this is
 *  planted deliberately: a real crash mid-write is not reproducible here. */
const plantStaleTablesListLock = async (ctx: Context, gitDir: string): Promise<void> => {
  const currentListBody = await ctx.fs.read(tablesListPath(gitDir));
  await ctx.fs.write(tablesListLockPath(gitDir), currentListBody);
};

export const reftableRefsScenario: Scenario<ReftableRefsScenarioResult> = {
  name: 'reftable-refs',
  inputs: { files: [], author: AUTHOR, message: MESSAGES.seed },
  expected: {
    oidBeforeWrite: OLD_OID,
    oidAfterWrite: NEW_OID,
    reflogSubjects: [REFLOG_MESSAGE],
    nonLogPrefixMatches: true,
    hasCompactionSuggestion: false,
  },
  run: async (repo) => {
    const ctx = withReftableStorage(repo.ctx);
    const dir = reftableDir(ctx.layout.gitDir);
    // A real `--ref-format=reftable` repository always has a `config` file;
    // writing one here (rather than leaving it absent) keeps
    // `resolveReflogIdentity`'s config read on its ordinary found-a-file
    // path instead of its missing-file fallback.
    await ctx.fs.writeUtf8(
      `${ctx.layout.gitDir}/config`,
      '[core]\n\trepositoryformatversion = 1\n[extensions]\n\trefstorage = reftable\n',
    );
    await ctx.fs.writeUtf8(tablesListPath(ctx.layout.gitDir), 'seed.ref\n');
    await ctx.fs.write(`${dir}/seed.ref`, buildSeedTable());

    const oidBeforeWrite = await resolveRef(ctx, MAIN_REF);

    // Degraded-path-only: the atomic adapters would time out acquiring a
    // lock that is never broken on their path (REFTABLE_LOCKED) — planting
    // it unconditionally would fail node/memory rather than exercise
    // browser's recovery.
    if (ctx.fs.atomicRename === undefined) {
      await plantStaleTablesListLock(ctx, ctx.layout.gitDir);
    }

    await updateRef(ctx, MAIN_REF, NEW_OID, { reflogMessage: REFLOG_MESSAGE });
    const oidAfterWrite = await resolveRef(ctx, MAIN_REF);

    const stack = await loadReftableStack(ctx, dir);
    const newest = stack.tables[stack.tables.length - 1]!;
    const refs = [...iterateReftableRefs(newest)];
    const rebuiltPrefix = buildReftableRefSection(refs, {
      hashId: newest.header.hashId,
      blockSize: newest.header.blockSize,
      restartInterval: DEFAULT_RESTART_INTERVAL,
      indexObjects: true,
      minUpdateIndex: newest.header.minUpdateIndex,
      maxUpdateIndex: newest.header.maxUpdateIndex,
    });
    const actualPrefix = newest._bytes.subarray(0, newest.footer.logPosition);

    const reflogSubjects = [...stack.logs(MAIN_REF)]
      .filter((record) => record.entry.kind === 'entry')
      .map((record) => (record.entry as { readonly message: string }).message.replace(/\n+$/, ''));

    const sizes = stack.tables.map((table) =>
      compactionMetric(table._bytes.length, table.header.version),
    );
    const segment = suggestCompactionSegment(sizes, DEFAULT_GEOMETRIC_FACTOR);

    return {
      oidBeforeWrite,
      oidAfterWrite,
      reflogSubjects,
      nonLogPrefixMatches: bytesEqual(rebuiltPrefix, actualPrefix),
      hasCompactionSuggestion: segment.start !== segment.end,
    };
  },
};
