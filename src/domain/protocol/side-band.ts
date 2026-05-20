import { invalidSidebandChannel, sidebandFatal } from './error.js';
import type { PktLine } from './pkt-line.js';

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

const CHANNEL_PACK = 1;
const CHANNEL_PROGRESS = 2;
const CHANNEL_FATAL = 3;

const safeInvoke = (cb: ((text: string) => void) | undefined, text: string): void => {
  if (!cb) return;
  try {
    cb(text);
  } catch {
    // swallow callback errors
  }
};

export interface SideBandOptions {
  readonly onProgress?: (text: string) => void;
  readonly onError?: (text: string) => void;
}

export const parseSideBand = (
  source: AsyncIterable<PktLine>,
  options: SideBandOptions,
): AsyncIterable<Uint8Array> => ({
  [Symbol.asyncIterator]: () => demux(source, options),
});

async function* demux(
  source: AsyncIterable<PktLine>,
  options: SideBandOptions,
): AsyncGenerator<Uint8Array, void, unknown> {
  for await (const pkt of source) {
    if (pkt.kind !== 'data') {
      // flush / delim / response-end terminate the sideband stream.
      return;
    }
    if (pkt.payload.byteLength === 0) {
      // A sideband packet must carry at least one byte (the channel marker).
      throw invalidSidebandChannel(-1);
    }
    const channel = pkt.payload[0] as number;
    const body = pkt.payload.subarray(1);
    if (channel === CHANNEL_PACK) {
      yield body;
      continue;
    }
    if (channel === CHANNEL_PROGRESS) {
      safeInvoke(options.onProgress, TEXT_DECODER.decode(body));
      continue;
    }
    if (channel === CHANNEL_FATAL) {
      const message = TEXT_DECODER.decode(body);
      safeInvoke(options.onError, message);
      throw sidebandFatal(message);
    }
    throw invalidSidebandChannel(channel);
  }
}
