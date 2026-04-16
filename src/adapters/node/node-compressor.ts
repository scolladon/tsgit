import { createInflate, deflateSync, inflateSync } from 'node:zlib';
import { compressFailed, decompressFailed } from '../../domain/index.js';
import type { Compressor } from '../../ports/compressor.js';

/** @internal Exported so we can exercise the non-Error fallback branch under unit tests. */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class NodeCompressor implements Compressor {
  deflate = async (data: Uint8Array): Promise<Uint8Array> => {
    try {
      return new Uint8Array(deflateSync(data));
    } catch (err) {
      throw compressFailed(describeError(err));
    }
  };

  inflate = async (data: Uint8Array): Promise<Uint8Array> => {
    try {
      return new Uint8Array(inflateSync(data));
    } catch (err) {
      throw decompressFailed(describeError(err));
    }
  };

  createInflateStream = (): TransformStream<Uint8Array, Uint8Array> => {
    const inflate = createInflate();
    let controller: TransformStreamDefaultController<Uint8Array> | undefined;
    // start() runs synchronously before any transform/flush, so endPromise is guaranteed to
    // be assigned by the time flush() executes.
    let endPromise!: Promise<void>;

    return new TransformStream<Uint8Array, Uint8Array>({
      start(c) {
        controller = c;
        inflate.on('data', (chunk: Buffer) => {
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
