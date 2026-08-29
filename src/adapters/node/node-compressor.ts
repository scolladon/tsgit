import { promisify } from 'node:util';
import {
  createInflate,
  deflate as deflateCallback,
  deflateRaw as deflateRawCallback,
  deflateRawSync,
  deflateSync,
  inflateSync,
} from 'node:zlib';
import { compressFailed, decompressFailed } from '../../domain/index.js';
import type { Compressor, InflateStreamResult } from '../../ports/compressor.js';

const deflateAsync = promisify(deflateCallback);
const deflateRawAsync = promisify(deflateRawCallback);

/** @internal Exported so we can exercise the non-Error fallback branch under unit tests. */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Hard cap on inflated output to defeat zip-bomb amplification. Mirrors the
 * delta `targetLength` cap (2 GiB) so a single object cannot exhaust heap.
 */
const MAX_INFLATED_OBJECT_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * This gate applies to `deflate`/`deflateRaw` ONLY — see the design note
 * below for why. `inflate` always stays on `inflateSync`; it is never worth
 * gating (measured table below).
 *
 * The callback zlib API is dispatched to the libuv threadpool and returns
 * the JS thread to the event loop while it runs. Per call, that round trip
 * costs MORE than the equivalent `*Sync` call — there is no in-repo caller
 * that runs `deflate`/`deflateRaw` concurrently (the pack writer's own loop
 * is sequential), so this is not a throughput win. The gate exists because a
 * single large `deflateSync` call blocks the whole process — including
 * unrelated work a host application has scheduled on the same event loop —
 * for as long as it runs; the callback arm avoids that stall at the cost of
 * its own per-call overhead. `inflate` is excluded because decompression is
 * cheap enough per byte that the stall this trades away never gets large
 * enough to be worth the overhead, at any size measured.
 *
 * MEASURED, not derived (concurrency 1 throughout — no concurrent producer
 * to benchmark against):
 *
 * Per-call latency, median of 21 runs:
 *
 * | size    | deflate sync | deflate callback | inflate sync | inflate callback |
 * |---------|--------------|-------------------|---------------|--------------------|
 * | 4 KiB   | 0.039 ms     | 0.079 ms           | 0.005 ms      | 0.044 ms            |
 * | 16 KiB  | 0.090 ms     | 0.131 ms           | 0.005 ms      | 0.041 ms            |
 * | 64 KiB  | 0.516 ms     | 0.643 ms           | 0.011 ms      | 0.076 ms            |
 *
 * The callback arm is strictly slower per call at every size, for both
 * `deflate` and `inflate` — this table alone would argue for gating neither.
 * The `deflate` gate is justified by a second effect the above table can't
 * show: how long an UNRELATED `setTimeout` scheduled at the same moment is
 * delayed (median of 15 runs, nominal delay 5 ms):
 *
 * | size    | sync-path delay to unrelated timer | callback-path delay |
 * |---------|-------------------------------------|-----------------------|
 * | 16 KiB  | 6.454 ms (+1.454 stall)              | 6.582 ms (noise)       |
 * | 256 KiB | 5.130 ms (noise)                     | 5.364 ms (noise)       |
 * | 1 MiB   | 12.596 ms (+7.596 ms stall)           | 4.572 ms (no stall)    |
 *
 * At 16 KiB — the current threshold — the stall this buys back is
 * indistinguishable from noise; the gate is not earning its keep yet at the
 * boundary itself. It becomes real by 1 MiB (~8 ms of avoided stall to
 * whatever else shares the event loop). The threshold is kept where it is
 * — not raised to where the benefit first becomes measurable — because the
 * per-call cost of gating early is small in absolute terms (tens of
 * microseconds) and objects large enough to matter are rare enough that a
 * more precise threshold is not worth tuning against a single measuring
 * machine.
 */
export const CALLBACK_DISPATCH_THRESHOLD_BYTES = 16 * 1024;

/**
 * The reason `streamInflate` reports for a zlib stream that ends before its
 * data does. Owned in-repo rather than passed through from node:zlib: node's
 * own wording for this condition ("unexpected end of file") is node's to
 * change at any point, but callers that classify `DECOMPRESS_FAILED` errors
 * by reason (`fetch-pack.ts`'s window-growth retry) need a string this repo
 * controls. Matches the zero-dependency decoder's wording for the identical
 * condition (`inflateZlibMember`, `src/adapters/inflate.ts`) so both
 * adapters report one reason regardless of which one decoded the stream.
 */
const TRUNCATED_STREAM_REASON = 'unexpected end of deflate stream';

/** Whether `err` is node:zlib's own signal for "the stream ended before the
 *  data did" — detected structurally via `code`, never via `message`, which
 *  is the wording `TRUNCATED_STREAM_REASON` exists to stop depending on. */
const isTruncatedStreamError = (err: NodeJS.ErrnoException): boolean => err.code === 'Z_BUF_ERROR';

interface NodeCompressorOptions {
  /** Override the inflated-output cap. Tests use a small value to exercise the overflow branch. */
  readonly maxInflatedBytes?: number;
}

export class NodeCompressor implements Compressor {
  private readonly maxInflatedBytes: number;

  constructor(options?: NodeCompressorOptions) {
    this.maxInflatedBytes = options?.maxInflatedBytes ?? MAX_INFLATED_OBJECT_BYTES;
  }

  /** Clamps a caller-supplied `streamInflate` bound to this instance's own
   *  cap: a caller may narrow it, never raise it above the instance default. */
  private effectiveCap(maxOutputBytes: number | undefined): number {
    return maxOutputBytes === undefined
      ? this.maxInflatedBytes
      : Math.min(maxOutputBytes, this.maxInflatedBytes);
  }

  /** Above the threshold, dispatch through Node's callback zlib API (libuv
   *  threadpool) to keep the event loop free during a large compression
   *  call; at or below it, that stall never gets big enough to be worth the
   *  callback API's own per-call overhead. Consulted by `deflate`/
   *  `deflateRaw` only — `inflate` never benefits from this trade (see
   *  `CALLBACK_DISPATCH_THRESHOLD_BYTES` for the measured tables) and always
   *  stays on `inflateSync`. */
  private usesCallbackDispatch(data: Uint8Array): boolean {
    return data.length > CALLBACK_DISPATCH_THRESHOLD_BYTES;
  }

  deflate = async (data: Uint8Array, level?: number): Promise<Uint8Array> => {
    try {
      if (this.usesCallbackDispatch(data)) {
        return new Uint8Array(
          // Stryker disable next-line ConditionalExpression: equivalent — forcing the else arm calls `deflateAsync(data, { level: undefined })`; node's callback zlib API shares the sync API's options-normalisation, so this is byte-for-byte identical to the no-options `deflateAsync(data)`, same as the sync arm below.
          level === undefined ? await deflateAsync(data) : await deflateAsync(data, { level }),
        );
      }
      // Stryker disable next-line ConditionalExpression: equivalent — forcing the else arm calls `deflateSync(data, { level: undefined })`, which Node treats identically to the no-options `deflateSync(data)`, byte-for-byte across all inputs.
      return new Uint8Array(level === undefined ? deflateSync(data) : deflateSync(data, { level }));
    } catch (err) {
      throw compressFailed(describeError(err));
    }
  };

  deflateRaw = async (data: Uint8Array, level?: number): Promise<Uint8Array> => {
    try {
      if (this.usesCallbackDispatch(data)) {
        return new Uint8Array(
          // Stryker disable next-line ConditionalExpression: equivalent — forcing the else arm calls `deflateRawAsync(data, { level: undefined })`; node's callback zlib API shares the sync API's options-normalisation, so this is byte-for-byte identical to the no-options `deflateRawAsync(data)`, same as the sync arm below.
          level === undefined
            ? await deflateRawAsync(data)
            : await deflateRawAsync(data, { level }),
        );
      }
      // Stryker disable next-line ConditionalExpression: equivalent — forcing the else arm calls `deflateRawSync(data, { level: undefined })`, which Node treats identically to the no-options `deflateRawSync(data)`, byte-for-byte across all inputs.
      return new Uint8Array(
        level === undefined ? deflateRawSync(data) : deflateRawSync(data, { level }),
      );
    } catch (err) {
      throw compressFailed(describeError(err));
    }
  };

  // Always synchronous: decompression is cheap enough per byte that the
  // libuv threadpool hop never pays off in the measured range — see
  // CALLBACK_DISPATCH_THRESHOLD_BYTES. Unlike deflate/deflateRaw, inflate
  // does not gate on payload size.
  inflate = async (data: Uint8Array): Promise<Uint8Array> => {
    try {
      return new Uint8Array(inflateSync(data, { maxOutputLength: this.maxInflatedBytes }));
    } catch (err) {
      throw decompressFailed(describeError(err));
    }
  };

  streamInflate = async (
    bytes: Uint8Array,
    offset: number,
    maxOutputBytes?: number,
  ): Promise<InflateStreamResult> => {
    // Node's createInflate is stream-aware: when the zlib stream ends, it emits
    // 'end'. We additionally count bytes here because createInflate's
    // maxOutputLength enforcement is unreliable for streaming use (it caps
    // the *internal* buffer rather than the cumulative output).
    const cap = this.effectiveCap(maxOutputBytes);
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
      inflate.on('error', (err: NodeJS.ErrnoException) => {
        reject(
          decompressFailed(isTruncatedStreamError(err) ? TRUNCATED_STREAM_REASON : err.message),
        );
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
    let resolveEnd!: () => void;
    let rejectEnd!: (err: unknown) => void;
    // endPromise is created eagerly (not inside start()) so both the 'data'
    // handler's cancellation catch and the cancel() hook below can settle it
    // directly — see stopForCancellation.
    const endPromise = new Promise<void>((resolve, reject) => {
      resolveEnd = resolve;
      rejectEnd = reject;
    });

    // No "already settled" guard is needed here or below: Node guarantees a
    // Readable emits at most one of {'end', 'error'} and no 'data' after
    // either, and destroy() (called on every teardown path below) is
    // documented to stop further emission too — so each teardown path can
    // only ever run once per stream, and resolveEnd()/rejectEnd() are
    // idempotent regardless. Verified empirically: racing cancellation and
    // cap-exceeded against multi-megabyte, many-chunk payloads never
    // produced a second call into any of these paths.
    //
    // A cancelled consumer is an expected termination, not a decompression
    // failure: stop the zlib pump and resolve (never reject) endPromise
    // ourselves. Once flush() has already run — the common case, since the
    // whole input is typically written and the source closed in one shot,
    // well before decompression finishes — the Streams runtime aliases
    // reader.cancel()'s promise to this SAME in-flight finish promise instead
    // of re-invoking the transformer's cancel() hook. Without settling it
    // here, cancellation would hang forever awaiting an 'end' that destroy()
    // prevents from ever firing.
    function stopForCancellation(): void {
      inflate.destroy();
      resolveEnd();
    }

    // lib.dom.d.ts's Transformer type predates the WHATWG spec's addition of
    // an optional cancel() hook; Node's runtime TransformStream honours it
    // (verified empirically). Typing the transformer through this local
    // extension — rather than widening the ambient Transformer type used by
    // the browser/memory adapters — keeps the gap-fill scoped to this file.
    const transformer: Transformer<Uint8Array, Uint8Array> & {
      cancel(reason: unknown): void;
    } = {
      start(c) {
        controller = c;
        inflate.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > cap) {
            controller?.error(decompressFailed('inflated output exceeds safety cap'));
            inflate.destroy();
            // destroy() means no 'end' will ever fire, so an in-flight flush()
            // would wait forever. RESOLVE, never reject: the controller already
            // carries the cap error, and rejecting here would replace it with a
            // duplicate on the writable side.
            resolveEnd();
            return;
          }
          try {
            controller?.enqueue(new Uint8Array(chunk));
          } catch {
            // `enqueue` throws only when the readable side is already finished,
            // and there are exactly three ways to get there. Two are the paths
            // above and below — the cap error and the 'error' handler — which
            // have already reported the failure and settled endPromise, so
            // re-running the teardown is a no-op. The third is the one this
            // handles: the consumer cancelled the reader between 'data' events.
            // Once flush() has started, the Streams runtime has already cleared
            // the cancel() hook below (verified empirically), so this catch is
            // the only place cancellation can be noticed. Nothing is rethrown
            // because nothing is left to report — and a throw out of a Node
            // 'data' handler is an uncaught exception, not a caller-visible
            // error.
            stopForCancellation();
          }
        });
        inflate.on('end', () => {
          controller?.terminate();
          resolveEnd();
        });
        inflate.on('error', (err: Error) => {
          const mapped = decompressFailed(err.message);
          controller?.error(mapped);
          rejectEnd(mapped);
        });
      },
      transform(chunk) {
        inflate.write(chunk);
      },
      flush() {
        inflate.end();
        return endPromise;
      },
      // Belt-and-braces: invoked by the Streams runtime when the consumer
      // cancels the readable side *before* flush() has started (e.g. a
      // multi-write source not yet fully consumed). In that timing this hook
      // does fire and stops the pump at the root; in the timing exercised by
      // the regression test above, the 'data' handler's catch is what fires.
      //
      // Stryker disable next-line BlockStatement: equivalent — flush() has not started in this timing, so endPromise is awaited by nobody and the next 'data' enqueue throws into the catch above, reaching the same teardown one chunk later.
      cancel() {
        stopForCancellation();
      },
    };

    return new TransformStream<Uint8Array, Uint8Array>(transformer);
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
