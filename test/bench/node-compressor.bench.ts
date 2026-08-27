/**
 * Bench: `NodeCompressor`'s sync/callback dispatch split around
 * `CALLBACK_DISPATCH_THRESHOLD_BYTES`. No fixture, no `git` — pure in-memory
 * bytes, incompressible (random) so the deflated size tracks the raw size
 * and the threshold is actually crossed.
 *
 * `deflate`/`deflateRaw` gate on size: the callback arm is chosen not
 * because any in-repo caller deflates concurrently — the pack writer's
 * loop is sequential — but because a single large deflate call still keeps
 * the event loop free for unrelated work while it runs on the libuv
 * threadpool, at the cost of the threadpool round-trip. This bench prices
 * that per-call trade-off directly (not a concurrency-4 throughput
 * scenario — vitest's `bench()` runs iterations sequentially).
 *
 * `inflate` never gates — it stays on `inflateSync` at every size (see
 * node-compressor.ts). The below/above-threshold pair here is a regression
 * guard: if a future change reintroduces a size gate on inflate, this bench
 * will show the callback arm's fixed dispatch overhead reappearing.
 */
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import {
  CALLBACK_DISPATCH_THRESHOLD_BYTES,
  NodeCompressor,
} from '../../src/adapters/node/node-compressor.js';
import { benchScenario } from './support/bench-dsl.js';

interface SizeSpec {
  readonly label: string;
  readonly bytes: number;
}

const SIZES: readonly SizeSpec[] = [
  { label: 'below threshold (8 KiB)', bytes: 8 * 1024 },
  { label: 'just above threshold (17 KiB)', bytes: CALLBACK_DISPATCH_THRESHOLD_BYTES + 1024 },
  { label: 'well above threshold (256 KiB)', bytes: 256 * 1024 },
  { label: 'far above threshold (1 MiB)', bytes: 1024 * 1024 },
];

for (const size of SIZES) {
  const raw = randomBytes(size.bytes);

  benchScenario(
    `Given an incompressible payload ${size.label}`,
    'When NodeCompressor.deflate() dispatches, Then measure tsgit',
    () => {
      const compressor = new NodeCompressor();
      return { sut: async (): Promise<void> => void (await compressor.deflate(raw)) };
    },
  );

  const compressed = deflateSync(raw);
  benchScenario(
    `Given a deflated incompressible payload ${size.label}`,
    'When NodeCompressor.inflate() runs (always synchronous), Then measure tsgit',
    () => {
      const compressor = new NodeCompressor();
      return { sut: async (): Promise<void> => void (await compressor.inflate(compressed)) };
    },
  );
}
