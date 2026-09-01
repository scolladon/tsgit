/**
 * Bench: `deltifyEntries`'s wasted-search cost — the window search's
 * overhead when every candidate loses. Pure in-memory, no `git`, no scaled
 * fixture: a corpus of mutually-unrelated blobs (xorshift-unique content,
 * matching the scaled-fixture generator's own blob shape) means every
 * `pack.window` candidate is a thrown-away `encodeDeltaFromIndex` call,
 * since none of them ever beats its own base entry on disk.
 *
 * Replaces a former `maintenance.bench.ts` scenario that ran this same
 * shape through a full `gc` over the medium fixture's 35 003 objects:
 * tinybench's default 5 warmup + 10 measured iterations of that full gc
 * cost ~7-8 minutes for one scenario, against `bench.yml`'s 30-minute
 * budget for the WHOLE suite — and diluted the search-cost signal it meant
 * to isolate under enumerate/read/deflate/pack-write cost sharing the same
 * number. Measuring `deltifyEntries` directly removes that dilution too: a
 * search regression now moves the number instead of being smoothed away by
 * everything else a full gc also does.
 */
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { deltifyEntries } from '../../src/application/primitives/internal/deltify.js';
import { writeObject } from '../../src/application/primitives/write-object.js';
import type { Blob, ObjectId } from '../../src/domain/objects/index.js';
import { resolveDeltaPolicy } from '../../src/domain/storage/delta-policy.js';
import { benchScenario } from './support/bench-dsl.js';

const WASTED_SEARCH_BLOB_COUNT = 3_000;
/** Matches `fixture-generator.ts`'s `MEDIUM_FIXTURE.blobBytes`. */
const WASTED_SEARCH_BLOB_BYTES = 2_560;

/** xorshift32 fill, keyed by blob index — the same generator
 *  `fixture-generator.ts` uses for its scaled fixtures' blob content, so
 *  this corpus reproduces the same barely-deltifiable shape without
 *  spawning `git fast-import`. */
function xorshiftBlobContent(blobIndex: number, bytes: number): Uint8Array {
  const buf = new Uint8Array(bytes);
  let state = (blobIndex + 1) >>> 0;
  for (let i = 0; i < bytes; i += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    buf[i] = state & 0xff;
  }
  return buf;
}

benchScenario(
  `Given ${WASTED_SEARCH_BLOB_COUNT} mutually-unrelated blobs (barely-deltifiable, xorshift-unique content)`,
  'When deltifyEntries runs the window search, Then measure tsgit',
  async () => {
    const ctx = createMemoryContext();
    const oids: ObjectId[] = [];
    for (let i = 0; i < WASTED_SEARCH_BLOB_COUNT; i += 1) {
      const blob: Blob = {
        type: 'blob',
        id: '' as ObjectId,
        content: xorshiftBlobContent(i, WASTED_SEARCH_BLOB_BYTES),
      };
      oids.push(await writeObject(ctx, blob));
    }
    const policy = resolveDeltaPolicy({});

    const sut = async (): Promise<void> => {
      await deltifyEntries(ctx, oids, policy);
    };
    return { sut };
  },
);
