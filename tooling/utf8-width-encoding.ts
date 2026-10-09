/**
 * The delta encoding `gen-utf8-width.ts` writes and `decodeDeltaIntervals`
 * reads: each code point as its base-36 distance from the previous one.
 * Side-effect free, so the generator and the decoder's property test share it.
 */
import { DELTA_RADIX, DELTA_SEPARATOR } from '../src/domain/pretty/delta-intervals.ts';

export const encodeDeltas = (table: readonly number[]): string =>
  table
    .map((codePoint, index) => codePoint - (index === 0 ? 0 : (table[index - 1] as number)))
    .map((delta) => delta.toString(DELTA_RADIX))
    .join(DELTA_SEPARATOR);
