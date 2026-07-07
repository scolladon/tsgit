/**
 * Property tests for inflateZlibMember: proves the decoder round-trips the
 * whole DEFLATE grammar against node:zlib's deflateSync as an independent
 * oracle, across arbitrary payloads and compression levels.
 */
import { deflateSync } from 'node:zlib';
import fc from 'fast-check';
import { describe, it } from 'vitest';
import { inflateZlibMember } from '../../../src/adapters/inflate.js';
import { arbBytes, arbBytesList } from './arbitraries.js';

const sut = inflateZlibMember;

const ROUND_TRIP_NUM_RUNS = 200;
const CONCAT_BOUNDARY_NUM_RUNS = 200;

/** Levels spanning stored-only (0), the zlib default, and max compression —
 * so stored, fixed, and dynamic Huffman blocks all occur across runs. */
function arbCompressionLevel(): fc.Arbitrary<number> {
  return fc.constantFrom(0, 6, 9);
}

function bytesEqual(actual: Uint8Array, expected: Uint8Array): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((byte, i) => byte === expected[i]);
}

function concatBuffers(buffers: ReadonlyArray<Uint8Array>): Uint8Array {
  const totalLength = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
  const concatenated = new Uint8Array(totalLength);
  let offset = 0;
  for (const buffer of buffers) {
    concatenated.set(buffer, offset);
    offset += buffer.length;
  }
  return concatenated;
}

describe('Given an arbitrary byte payload deflated at an arbitrary compression level', () => {
  describe('When decoding the resulting zlib member from its start', () => {
    it('Then it round-trips to the original payload with byte-exact bytesConsumed', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbBytes(), arbCompressionLevel(), (payload, level) => {
          const member = deflateSync(payload, { level });

          const result = sut(member, 0);

          return bytesEqual(result.output, payload) && result.bytesConsumed === member.length;
        }),
        { numRuns: ROUND_TRIP_NUM_RUNS },
      );
    });
  });
});

describe('Given an arbitrary list of byte payloads, each deflated independently', () => {
  describe('When concatenating the members and decoding sequentially by bytesConsumed', () => {
    it('Then every payload is recovered in order at its exact member boundary', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbBytesList(), (payloads) => {
          const members = payloads.map((payload) => deflateSync(payload));
          const concatenated = concatBuffers(members);

          let readOffset = 0;
          for (let i = 0; i < payloads.length; i += 1) {
            const expectedPayload = payloads[i];
            const expectedMember = members[i];
            if (expectedPayload === undefined || expectedMember === undefined) return false;

            const result = sut(concatenated, readOffset);
            if (!bytesEqual(result.output, expectedPayload)) return false;
            if (result.bytesConsumed !== expectedMember.length) return false;
            readOffset += result.bytesConsumed;
          }
          return true;
        }),
        { numRuns: CONCAT_BOUNDARY_NUM_RUNS },
      );
    });
  });
});
