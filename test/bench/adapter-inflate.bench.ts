/**
 * Bench: `inflateZlibMember` (the bundled, synchronous, zero-dependency
 * whole-member decoder) vs native `DecompressionStream` — the go/no-go bench
 * for the browser/memory adapter decision: buffered inflate is only worth
 * routing through the bundled decoder if it clearly beats the native stream
 * on large inputs, not just on tiny ones. No fixture, no `git`; a size
 * ladder of zlib members, both highly-compressible and incompressible, so a
 * decoder that wins on a tiny input but loses on a multi-megabyte one is
 * caught here rather than assumed.
 */
import { inflateZlibMember } from '../../src/adapters/inflate.js';
import { benchScenario } from './support/bench-dsl.js';

/** Web Crypto rejects a single `getRandomValues` call over 65,536 bytes. */
const CRYPTO_QUOTA = 65_536;

interface SizeSpec {
  readonly label: string;
  readonly bytes: number;
}

const SIZES: readonly SizeSpec[] = [
  { label: '64 KiB', bytes: 64 * 1024 },
  { label: '1 MiB', bytes: 1024 * 1024 },
  { label: '8 MiB', bytes: 8 * 1024 * 1024 },
];

function highlyCompressible(size: number): Uint8Array {
  return new Uint8Array(size).fill(0x61);
}

function incompressible(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let start = 0; start < size; start += CRYPTO_QUOTA) {
    crypto.getRandomValues(out.subarray(start, Math.min(start + CRYPTO_QUOTA, size)));
  }
  return out;
}

interface VariantSpec {
  readonly label: string;
  readonly build: (size: number) => Uint8Array;
}

const VARIANTS: readonly VariantSpec[] = [
  { label: 'highly compressible', build: highlyCompressible },
  { label: 'incompressible', build: incompressible },
];

async function deflateZlibMember(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function nativeInflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const pumped = new Blob([data as BlobPart])
    .stream()
    .pipeTo(ds.writable)
    .catch(() => {});
  const output = new Uint8Array(await new Response(ds.readable).arrayBuffer());
  await pumped;
  return output;
}

for (const variant of VARIANTS) {
  for (const size of SIZES) {
    const deflatedMember = deflateZlibMember(variant.build(size.bytes));

    benchScenario(
      `Given a ${size.label} ${variant.label} zlib member`,
      'When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit',
      async () => {
        const deflated = await deflatedMember;
        return {
          sut: (): void => {
            inflateZlibMember(deflated, 0);
          },
        };
      },
    );

    benchScenario(
      `Given a ${size.label} ${variant.label} zlib member`,
      'When native DecompressionStream decodes it, Then measure tsgit',
      async () => {
        const deflated = await deflatedMember;
        return {
          sut: async (): Promise<void> => {
            await nativeInflate(deflated);
          },
        };
      },
    );
  }
}
