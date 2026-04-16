/// <reference lib="dom" />
import { compressFailed, decompressFailed } from '../../domain/index.js';
import type { Compressor } from '../../ports/compressor.js';

export class BrowserCompressor implements Compressor {
  async deflate(data: Uint8Array): Promise<Uint8Array> {
    try {
      const stream = new Blob([data as BlobPart])
        .stream()
        .pipeThrough(new CompressionStream('deflate'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (err) {
      throw compressFailed(err instanceof Error ? err.message : String(err));
    }
  }

  async inflate(data: Uint8Array): Promise<Uint8Array> {
    try {
      const stream = new Blob([data as BlobPart])
        .stream()
        .pipeThrough(new DecompressionStream('deflate'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (err) {
      throw decompressFailed(err instanceof Error ? err.message : String(err));
    }
  }

  createInflateStream(): TransformStream<Uint8Array, Uint8Array> {
    return new DecompressionStream('deflate') as unknown as TransformStream<Uint8Array, Uint8Array>;
  }
}
