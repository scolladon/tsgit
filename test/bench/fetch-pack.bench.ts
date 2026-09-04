/**
 * Bench: the two-pass pack indexer's wall clock over a delta-chain-heavy
 * pack, through the real receive path (`fetchPack` — quarantine write,
 * disk-windowed read-back, both passes). Every base-with-children entry is
 * read twice today (once per pass); this scenario prices that second read
 * rather than assuming it away, at the base cache's shipped default
 * budget. tsgit-only: there is no isomorphic-git internal-pipeline
 * equivalent to compare pass count against.
 */
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { fetchPack, type NegotiatePackBytes } from '../../src/application/primitives/fetch-pack.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import { buildSyntheticPack, type EntrySpec } from '../unit/application/primitives/pack-fixture.js';
import { benchScenario } from './support/bench-dsl.js';

const ENCODER = new TextEncoder();
const CHAIN_DEPTH = 200;
const CHAIN_COUNT = 8;

/** `CHAIN_COUNT` independent linear OFS chains, `CHAIN_DEPTH` deep each —
 *  every chain's base is read once in pass 1 and once more in pass 2 to
 *  resolve its first delta, exactly the re-read this design's cache
 *  removes. */
const buildChainedEntries = (): EntrySpec[] => {
  const entries: EntrySpec[] = [];
  for (let chain = 0; chain < CHAIN_COUNT; chain += 1) {
    const base = ENCODER.encode(`fetch-pack bench chain ${chain} base content`);
    entries.push({ kind: 'base', type: 'blob', content: base });
    let previous = base;
    const baseOrdinal = entries.length - 1;
    for (let level = 0; level < CHAIN_DEPTH; level += 1) {
      const target = new Uint8Array(previous.length + 1);
      target.set(previous, 0);
      target[previous.length] = level & 0xff;
      entries.push({
        kind: 'ofs-delta',
        baseIndex: level === 0 ? baseOrdinal : entries.length - 1,
        targetContent: target,
      });
      previous = target;
    }
  }
  return entries;
};

/** Frames the whole pack as one chunk, side-band-free — `fetchPack`'s
 *  quarantine writer only needs an `AsyncIterable<Uint8Array>`, and this
 *  scenario measures the index pass, not pkt-line/sideband framing cost. */
const toNegotiator =
  (packBytes: Uint8Array): NegotiatePackBytes =>
  async () => ({
    packBody: (async function* () {
      yield packBytes;
    })(),
    shallow: [],
    unshallow: [],
  });

benchScenario(
  'Given a pack with 8 independent 200-deep OFS delta chains',
  'When fetchPack receives and indexes it in two passes, Then measure tsgit',
  async () => {
    const seedCtx = createMemoryContext();
    const built = await buildSyntheticPack(seedCtx, buildChainedEntries());
    const negotiator = toNegotiator(built.packBytes);

    const sut = async (): Promise<void> => {
      const result = await fetchPack(createMemoryContext(), negotiator, {
        wants: [(built.ids[0] ?? 'a'.repeat(40)) as ObjectId],
        haves: [],
        capabilities: ['side-band-64k', 'ofs-delta'],
        progressOp: 'test:write-objects',
      });
      // A fresh destination per iteration: a shared one would serve a warm
      // delta cache from iteration 2 on, pricing something this scenario
      // does not claim to measure, and re-receiving into an occupied store
      // throws FILE_EXISTS on the writer's sibling artefacts. Reading a
      // field keeps the write observable to the runner.
      if (result.packPath === '') throw new Error('fetchPack wrote no pack');
    };
    return { sut };
  },
);
