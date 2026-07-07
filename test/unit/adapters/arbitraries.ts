import fc from 'fast-check';

const MAX_PAYLOAD_BYTES = 4096;
const MIN_PAYLOAD_LIST_LENGTH = 1;
const MAX_PAYLOAD_LIST_LENGTH = 5;

/** An arbitrary byte payload, small enough to keep property runs fast while
 * still spanning empty, tiny, and multi-KB inputs (stored/fixed/dynamic
 * blocks all become reachable across the size range). */
export function arbBytes(): fc.Arbitrary<Uint8Array> {
  return fc.uint8Array({ minLength: 0, maxLength: MAX_PAYLOAD_BYTES });
}

/** A non-empty list of arbitrary byte payloads, for the concat-boundary
 * invariant (each payload deflated and decoded independently in sequence). */
export function arbBytesList(): fc.Arbitrary<ReadonlyArray<Uint8Array>> {
  return fc.array(arbBytes(), {
    minLength: MIN_PAYLOAD_LIST_LENGTH,
    maxLength: MAX_PAYLOAD_LIST_LENGTH,
  });
}
