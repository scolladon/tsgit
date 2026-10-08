/** Separates the encoded deltas. */
export const DELTA_SEPARATOR = ',';
/** Radix of each encoded delta: base 36 keeps the generated tables short. */
export const DELTA_RADIX = 36;

/**
 * Rebuilds an ascending code point list from its delta encoding, where each
 * value is the distance from the previous code point (the first, from zero).
 */
export const decodeDeltaIntervals = (encoded: string): readonly number[] => {
  const codePoints: number[] = [];
  let previous = 0;
  for (const delta of encoded.split(DELTA_SEPARATOR)) {
    previous += Number.parseInt(delta, DELTA_RADIX);
    codePoints.push(previous);
  }
  return codePoints;
};
