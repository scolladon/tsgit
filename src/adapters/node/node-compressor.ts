import { createInflate, deflateSync, inflateSync } from 'node:zlib';
import { compressFailed, decompressFailed } from '../../domain/index.js';
import type { Compressor, InflateStreamResult } from '../../ports/compressor.js';

/** @internal Exported so we can exercise the non-Error fallback branch under unit tests. */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Hard cap on inflated output to defeat zip-bomb amplification. Mirrors the
 * delta `targetLength` cap (2 GiB) so a single object cannot exhaust heap.
 */
const MAX_INFLATED_OBJECT_BYTES = 2 * 1024 * 1024 * 1024;

interface NodeCompressorOptions {
  /** Override the inflated-output cap. Tests use a small value to exercise the overflow branch. */
  readonly maxInflatedBytes?: number;
}

export class NodeCompressor implements Compressor {
  private readonly maxInflatedBytes: number;

  constructor(options?: NodeCompressorOptions) {
    this.maxInflatedBytes = options?.maxInflatedBytes ?? MAX_INFLATED_OBJECT_BYTES;
  }

  deflate = async (data: Uint8Array, level?: number): Promise<Uint8Array> => {
    try {
      // equivalent-mutant: forcing the `else` arm (mutating the condition to `false`) calls
      // `deflateSync(data, { level: undefined })`, which Node treats identically to the no-options
      // `deflateSync(data)` — byte-for-byte identical output across all inputs.
      return new Uint8Array(level === undefined ? deflateSync(data) : deflateSync(data, { level }));
    } catch (err) {
      throw compressFailed(describeError(err));
    }
  };

  inflate = async (data: Uint8Array): Promise<Uint8Array> => {
    try {
      return new Uint8Array(inflateSync(data, { maxOutputLength: this.maxInflatedBytes }));
    } catch (err) {
      throw decompressFailed(describeError(err));
    }
  };

  streamInflate = async (bytes: Uint8Array, offset: number): Promise<InflateStreamResult> => {
    // Node's createInflate is stream-aware: when the zlib stream ends, it emits
    // 'end'. We additionally count bytes here because createInflate's
    // maxOutputLength enforcement is unreliable for streaming use (it caps
    // the *internal* buffer rather than the cumulative output).
    const cap = this.maxInflatedBytes;
    return new Promise<InflateStreamResult>((resolve, reject) => {
      const inflate = createInflate();
      const chunks: Uint8Array[] = [];
      let total = 0;
      const slice = bytes.subarray(offset);
      inflate.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > cap) {
          inflate.destroy();
          reject(decompressFailed('inflated output exceeds safety cap'));
          return;
        }
        chunks.push(new Uint8Array(chunk));
      });
      inflate.on('end', () => {
        // `bytesWritten` is the number of compressed bytes the decoder fully
        // accepted as part of the zlib stream.
        const consumed = (inflate as unknown as { bytesWritten: number }).bytesWritten;
        const output = concatUint8(chunks);
        resolve({ output, bytesConsumed: consumed });
      });
      inflate.on('error', (err: Error) => {
        reject(decompressFailed(err.message));
      });
      // Write all available bytes; Node's inflate will stop at the zlib end
      // and any excess is left unread in the node stream's buffer.
      inflate.end(slice);
    });
  };

  createInflateStream = (): TransformStream<Uint8Array, Uint8Array> => {
    const cap = this.maxInflatedBytes;
    const inflate = createInflate();
    let controller: TransformStreamDefaultController<Uint8Array> | undefined;
    let total = 0;
    // start() runs synchronously before any transform/flush, so endPromise is guaranteed to
    // be assigned by the time flush() executes.
    let endPromise!: Promise<void>;

    return new TransformStream<Uint8Array, Uint8Array>({
      start(c) {
        controller = c;
        inflate.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > cap) {
            controller?.error(decompressFailed('inflated output exceeds safety cap'));
            inflate.destroy();
            return;
          }
          controller?.enqueue(new Uint8Array(chunk));
        });
        // endPromise must both resolve (normal completion) AND reject (error completion)
        // so that flush() does not hang when the underlying stream emits 'error'. Node's
        // createInflate() does not emit 'end' after 'error', so wiring only 'end' → resolve
        // would leave flush() awaiting a promise that never settles in the error path.
        endPromise = new Promise<void>((resolve, reject) => {
          inflate.on('end', () => {
            controller?.terminate();
            resolve();
          });
          inflate.on('error', (err: Error) => {
            const mapped = decompressFailed(err.message);
            controller?.error(mapped);
            reject(mapped);
          });
        });
      },
      transform(chunk) {
        inflate.write(chunk);
      },
      flush() {
        inflate.end();
        return endPromise;
      },
    });
  };
}

function concatUint8(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
