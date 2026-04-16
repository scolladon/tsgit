import { compressFailed, decompressFailed } from '../../domain/index.js';
import type { Compressor } from '../../ports/compressor.js';

export class MemoryCompressor implements Compressor {
  constructor() {
    if (typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined') {
      throw compressFailed('CompressionStream/DecompressionStream unavailable');
    }
  }

  deflate = async (data: Uint8Array): Promise<Uint8Array> => {
    try {
      return await runTransform(data, new CompressionStream('deflate'));
    } catch (err) {
      throw compressFailed(describeError(err));
    }
  };

  inflate = async (data: Uint8Array): Promise<Uint8Array> => {
    try {
      return await runTransform(data, new DecompressionStream('deflate'));
    } catch (err) {
      throw decompressFailed(describeError(err));
    }
  };

  createInflateStream = (): TransformStream<Uint8Array, Uint8Array> => {
    return new DecompressionStream('deflate') as unknown as TransformStream<Uint8Array, Uint8Array>;
  };
}

async function runTransform(
  data: Uint8Array,
  transform: TransformStream<Uint8Array, Uint8Array> | CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const stream = source.pipeThrough(
    transform as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
