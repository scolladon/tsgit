import { describe, expect, it } from 'vitest';
import type { TsgitError } from '../../../../src/domain/error.js';
import { applyDelta, parseDelta } from '../../../../src/domain/storage/delta.js';
import {
  createDeltaIndex,
  DELTA_BLOCK_BYTES,
  encodeDelta,
  encodeDeltaFromIndex,
  MAX_COPY_BYTES,
  MAX_INSERT_BYTES,
  serializeDelta,
} from '../../../../src/domain/storage/delta-encode.js';

/** A `Uint8Array` that records the `end` argument of every `subarray()`
 *  call made against it — the only way to observe, from outside the
 *  module, how far into `target` the scan actually reached before it
 *  stopped emitting literal chunks. */
class SubarrayTrackingTarget extends Uint8Array<ArrayBuffer> {
  readonly subarrayEnds: number[] = [];

  override subarray(start?: number, end?: number): Uint8Array<ArrayBuffer> {
    this.subarrayEnds.push(end ?? this.length);
    return super.subarray(start, end);
  }
}

function fillWithNonRepeatingBytes(target: Uint8Array): void {
  for (let i = 0; i < target.length; i += 1) target[i] = i % 256;
}

describe('delta-encode', () => {
  describe('serializeDelta', () => {
    describe('Given a header and a single INSERT instruction', () => {
      describe('When serializing', () => {
        it('Then parseDelta reads back the same header and instruction', () => {
          // Arrange
          const data = new TextEncoder().encode('abc');
          const sut = serializeDelta;

          // Act
          const result = sut(0, 3, [{ type: 'insert', data }]);

          // Assert
          expect(parseDelta(result)).toEqual({
            sourceLength: 0,
            targetLength: 3,
            instructions: [{ type: 'insert', data }],
          });
        });
      });
    });

    describe('Given a COPY instruction with offset 0', () => {
      describe('When serializing', () => {
        it('Then the instruction is a bare cmd byte with no offset bytes', () => {
          // Arrange
          const sut = serializeDelta;

          // Act
          const result = sut(5, 5, [{ type: 'copy', offset: 0, size: 5 }]);

          // Assert — header is [0x05, 0x05]; instruction is cmd=0x80|0x10=0x90, size byte 0x05
          expect(result.slice(2)).toEqual(new Uint8Array([0x90, 0x05]));
        });
      });
    });

    describe('Given a COPY offset requiring a specific offset byte', () => {
      describe('When serializing', () => {
        it.each([
          { offset: 0x000000ab, cmdBit: 0x01, byteVal: 0xab, label: 'offset byte 0' },
          { offset: 0x0000ab00, cmdBit: 0x02, byteVal: 0xab, label: 'offset byte 1' },
          { offset: 0x00ab0000, cmdBit: 0x04, byteVal: 0xab, label: 'offset byte 2' },
          { offset: 0xab000000, cmdBit: 0x08, byteVal: 0xab, label: 'offset byte 3' },
        ])('Then only $label is set for $label', ({ offset, cmdBit, byteVal }) => {
          // Arrange — sourceLength=10, targetLength=1 both encode as a single header byte,
          // so the instruction starts at a fixed position regardless of offset's magnitude.
          const sut = serializeDelta;

          // Act
          const result = sut(10, 1, [{ type: 'copy', offset, size: 1 }]);

          // Assert — [headerByte, headerByte, cmd, offsetByte, sizeByte(=1)]
          expect(result).toEqual(new Uint8Array([0x0a, 0x01, 0x80 | cmdBit | 0x10, byteVal, 0x01]));
          expect(parseDelta(result).instructions[0]).toEqual({ type: 'copy', offset, size: 1 });
        });
      });
    });

    describe('Given a COPY size requiring a specific size byte', () => {
      describe('When serializing', () => {
        it.each([
          { size: 0x000000ab, cmdBit: 0x10, byteVal: 0xab, label: 'size byte 0' },
          { size: 0x0000ab00, cmdBit: 0x20, byteVal: 0xab, label: 'size byte 1' },
          { size: 0x00ab0000, cmdBit: 0x40, byteVal: 0xab, label: 'size byte 2' },
        ])('Then only $label is set for $label', ({ size, cmdBit, byteVal }) => {
          // Arrange
          const sut = serializeDelta;

          // Act
          const result = sut(size, size, [{ type: 'copy', offset: 0, size }]);

          // Assert
          const parsed = parseDelta(result);
          expect(parsed.instructions[0]).toEqual({ type: 'copy', offset: 0, size });
          const instructionBytes = result.slice(result.length - 2);
          expect(instructionBytes[0]).toBe(0x80 | cmdBit);
          expect(instructionBytes[1]).toBe(byteVal);
        });
      });
    });

    describe('Given a COPY of size exactly 0x10000', () => {
      describe('When serializing', () => {
        it('Then it emits cmd=0xc0 and a single size byte 0x01, never the zero-byte shorthand', () => {
          // Arrange
          const sut = serializeDelta;

          // Act
          const result = sut(0x10000, 0x10000, [{ type: 'copy', offset: 0, size: 0x10000 }]);

          // Assert
          expect(result.slice(result.length - 2)).toEqual(new Uint8Array([0xc0, 0x01]));
        });
      });
    });

    describe('Given a COPY at the MAX_COPY_BYTES boundary', () => {
      describe('When serializing', () => {
        it('Then a size of exactly MAX_COPY_BYTES is accepted', () => {
          // Arrange
          const sut = serializeDelta;

          // Act
          const result = sut(MAX_COPY_BYTES, MAX_COPY_BYTES, [
            { type: 'copy', offset: 0, size: MAX_COPY_BYTES },
          ]);

          // Assert
          expect(parseDelta(result).instructions[0]).toEqual({
            type: 'copy',
            offset: 0,
            size: MAX_COPY_BYTES,
          });
        });
      });
    });

    describe('Given a COPY size of zero', () => {
      describe('When serializing', () => {
        it('Then throws INVALID_DELTA for COPY size must be non-zero', () => {
          // Arrange
          const sut = serializeDelta;

          // Act & Assert
          try {
            sut(1, 1, [{ type: 'copy', offset: 0, size: 0 }]);
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual({
              code: 'INVALID_DELTA',
              reason: 'COPY size must be non-zero',
            });
          }
        });
      });
    });

    describe('Given a COPY size exceeding MAX_COPY_BYTES', () => {
      describe('When serializing', () => {
        it('Then throws INVALID_DELTA for the size-exceeds-max reason', () => {
          // Arrange
          const sut = serializeDelta;
          const size = MAX_COPY_BYTES + 1;

          // Act & Assert
          try {
            sut(size, size, [{ type: 'copy', offset: 0, size }]);
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual({
              code: 'INVALID_DELTA',
              reason: `COPY size ${size} exceeds ${MAX_COPY_BYTES}`,
            });
          }
        });
      });
    });

    describe('Given a COPY offset below zero', () => {
      describe('When serializing', () => {
        it('Then throws INVALID_DELTA for the offset-out-of-range reason', () => {
          // Arrange
          const sut = serializeDelta;

          // Act & Assert
          try {
            sut(1, 1, [{ type: 'copy', offset: -1, size: 1 }]);
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual({
              code: 'INVALID_DELTA',
              reason: 'COPY offset -1 out of range',
            });
          }
        });
      });
    });

    describe('Given a COPY offset above 0xffffffff', () => {
      describe('When serializing', () => {
        it('Then throws INVALID_DELTA for the offset-out-of-range reason', () => {
          // Arrange
          const sut = serializeDelta;
          const offset = 0x100000000;

          // Act & Assert
          try {
            sut(1, 1, [{ type: 'copy', offset, size: 1 }]);
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual({
              code: 'INVALID_DELTA',
              reason: `COPY offset ${offset} out of range`,
            });
          }
        });
      });
    });

    describe('Given an INSERT at the MAX_INSERT_BYTES boundary', () => {
      describe('When serializing', () => {
        it.each([
          { length: 1, label: '1 byte' },
          { length: MAX_INSERT_BYTES, label: 'MAX_INSERT_BYTES' },
        ])('Then a length of $label is accepted', ({ length }) => {
          // Arrange
          const sut = serializeDelta;
          const data = new Uint8Array(length).fill(0x41);

          // Act
          const result = sut(0, length, [{ type: 'insert', data }]);

          // Assert
          expect(parseDelta(result).instructions[0]).toEqual({ type: 'insert', data });
        });
      });
    });

    describe('Given an INSERT with N=0', () => {
      describe('When serializing', () => {
        it('Then throws INVALID_DELTA for the reserved-N=0 reason', () => {
          // Arrange
          const sut = serializeDelta;

          // Act & Assert
          try {
            sut(0, 0, [{ type: 'insert', data: new Uint8Array(0) }]);
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual({
              code: 'INVALID_DELTA',
              reason: 'INSERT with N=0 is reserved',
            });
          }
        });
      });
    });

    describe('Given an INSERT exceeding MAX_INSERT_BYTES', () => {
      describe('When serializing', () => {
        it('Then throws INVALID_DELTA for the length-exceeds-max reason', () => {
          // Arrange
          const sut = serializeDelta;
          const data = new Uint8Array(MAX_INSERT_BYTES + 1);

          // Act & Assert
          try {
            sut(0, data.length, [{ type: 'insert', data }]);
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual({
              code: 'INVALID_DELTA',
              reason: `INSERT length ${data.length} exceeds ${MAX_INSERT_BYTES}`,
            });
          }
        });
      });
    });

    describe('Given a header length varint needing more than 5 bytes', () => {
      describe('When serializing', () => {
        it('Then throws INVALID_DELTA for the too-long reason', () => {
          // Arrange
          const sut = serializeDelta;

          // Act & Assert
          try {
            sut(2 ** 35, 0, []);
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual({
              code: 'INVALID_DELTA',
              reason: 'variable-length integer too long',
            });
          }
        });
      });
    });
  });

  describe('createDeltaIndex', () => {
    describe('Given a base of 8 identical 16-byte blocks', () => {
      describe('When indexing', () => {
        it('Then heads has one non-sentinel bucket whose chain is most-recent-first', () => {
          // Arrange
          const base = new Uint8Array(8 * DELTA_BLOCK_BYTES).fill(0xaa);
          const sut = createDeltaIndex;

          // Act
          const result = sut(base);

          // Assert
          const nonSentinelBuckets = Array.from(result.heads).filter((h) => h !== -1);
          expect(nonSentinelBuckets).toHaveLength(1);

          const chain: number[] = [];
          let block = nonSentinelBuckets[0]!;
          while (block !== -1) {
            chain.push(block);
            block = result.next[block]!;
          }
          expect(chain).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
        });
      });
    });

    describe('Given a base shorter than one block', () => {
      describe('When indexing', () => {
        it('Then heads is all sentinel and next is empty', () => {
          // Arrange
          const base = new Uint8Array(DELTA_BLOCK_BYTES - 1);
          const sut = createDeltaIndex;

          // Act
          const result = sut(base);

          // Assert
          expect(Array.from(result.heads)).toEqual([-1]);
          expect(result.next).toHaveLength(0);
        });
      });
    });
  });

  describe('encodeDelta', () => {
    describe('Given an identical base and target', () => {
      describe('When encoding', () => {
        it('Then the result is one COPY and no INSERT', () => {
          // Arrange
          const content = new TextEncoder().encode('0123456789abcdef0123456789abcdef');
          const sut = encodeDelta;

          // Act
          const result = sut(content, content);

          // Assert
          expect(result).toBeDefined();
          const parsed = parseDelta(result!);
          expect(parsed.instructions).toEqual([{ type: 'copy', offset: 0, size: content.length }]);
        });
      });
    });

    describe('Given disjoint base and target content', () => {
      describe('When encoding', () => {
        it('Then every instruction is an INSERT', () => {
          // Arrange
          const base = new TextEncoder().encode('0123456789abcdef0123456789abcdef');
          const target = new Uint8Array(20).fill(0xff);
          const sut = encodeDelta;

          // Act
          const result = sut(base, target);

          // Assert
          const parsed = parseDelta(result!);
          expect(parsed.instructions.every((i) => i.type === 'insert')).toBe(true);
          expect(applyDelta(base, result!)).toEqual(target);
        });
      });
    });

    describe('Given a target that is the base plus an unrelated suffix', () => {
      describe('When encoding', () => {
        it('Then the result is a COPY of the base followed by an INSERT of the suffix', () => {
          // Arrange
          const base = new TextEncoder().encode('0123456789abcdef0123456789abcdef');
          const suffix = new Uint8Array(10).fill(0xff);
          const target = new Uint8Array(base.length + suffix.length);
          target.set(base, 0);
          target.set(suffix, base.length);
          const sut = encodeDelta;

          // Act
          const result = sut(base, target);

          // Assert
          const parsed = parseDelta(result!);
          expect(parsed.instructions).toEqual([
            { type: 'copy', offset: 0, size: base.length },
            { type: 'insert', data: suffix },
          ]);
        });
      });
    });

    describe('Given a target that is an unrelated prefix plus the base', () => {
      describe('When encoding', () => {
        it('Then the result is an INSERT of the prefix followed by a COPY of the base', () => {
          // Arrange
          const base = new TextEncoder().encode('0123456789abcdef0123456789abcdef');
          const prefix = new Uint8Array(10).fill(0xff);
          const target = new Uint8Array(prefix.length + base.length);
          target.set(prefix, 0);
          target.set(base, prefix.length);
          const sut = encodeDelta;

          // Act
          const result = sut(base, target);

          // Assert
          const parsed = parseDelta(result!);
          expect(parsed.instructions).toEqual([
            { type: 'insert', data: prefix },
            { type: 'copy', offset: 0, size: base.length },
          ]);
        });
      });
    });

    describe('Given a match whose block-aligned anchor starts mid-run in the target', () => {
      describe('When encoding', () => {
        it('Then backward extension folds the earlier bytes into the COPY', () => {
          // Arrange — base block0 = 13 filler bytes + a 3-byte tail, block1 = 16
          // distinguishable content bytes; target = the tail + the content bytes.
          // The hashed 16-byte window at target pos=3 matches block1 exactly, then
          // backward extension recovers the 3-byte tail from block0's end.
          const filler = new Uint8Array(13).fill(0x41);
          const tail = new Uint8Array(3).fill(0x5a);
          const content = Uint8Array.from({ length: 16 }, (_, i) => i);
          const base = new Uint8Array(32);
          base.set(filler, 0);
          base.set(tail, 13);
          base.set(content, 16);
          const target = new Uint8Array(19);
          target.set(tail, 0);
          target.set(content, 3);
          const sut = encodeDelta;

          // Act
          const result = sut(base, target);

          // Assert
          const parsed = parseDelta(result!);
          expect(parsed.instructions).toEqual([{ type: 'copy', offset: 13, size: 19 }]);
        });
      });
    });

    describe('Given a target shorter than one block', () => {
      describe('When encoding', () => {
        it('Then every instruction is an INSERT', () => {
          // Arrange
          const base = new TextEncoder().encode('0123456789abcdef0123456789abcdef');
          const target = new TextEncoder().encode('abcde');
          const sut = encodeDelta;

          // Act
          const result = sut(base, target);

          // Assert
          const parsed = parseDelta(result!);
          expect(parsed.instructions.every((i) => i.type === 'insert')).toBe(true);
          expect(applyDelta(base, result!)).toEqual(target);
        });
      });
    });

    describe('Given an empty target', () => {
      describe('When encoding', () => {
        it('Then the result is the header with no instructions', () => {
          // Arrange
          const base = new TextEncoder().encode('0123456789abcdef');
          const target = new Uint8Array(0);
          const sut = encodeDelta;

          // Act
          const result = sut(base, target);

          // Assert
          expect(parseDelta(result!)).toEqual({
            sourceLength: base.length,
            targetLength: 0,
            instructions: [],
          });
        });
      });
    });

    describe('Given an empty base', () => {
      describe('When encoding', () => {
        it('Then every instruction is an INSERT', () => {
          // Arrange
          const base = new Uint8Array(0);
          const target = new TextEncoder().encode('0123456789abcdef0123456789');
          const sut = encodeDelta;

          // Act
          const result = sut(base, target);

          // Assert
          const parsed = parseDelta(result!);
          expect(parsed.instructions.every((i) => i.type === 'insert')).toBe(true);
          expect(applyDelta(base, result!)).toEqual(target);
        });
      });
    });

    describe('Given a maxSize smaller than the header itself', () => {
      describe('When encoding', () => {
        it('Then returns undefined before any instruction is emitted', () => {
          // Arrange
          const base = new Uint8Array(20);
          const target = new Uint8Array(20);
          const sut = encodeDelta;

          // Act
          const result = sut(base, target, 0);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given a maxSize crossed mid-stream', () => {
      describe('When encoding', () => {
        it('Then returns undefined', () => {
          // Arrange
          const base = new Uint8Array(0);
          const target = new Uint8Array(300).fill(0x41);
          const sut = encodeDelta;
          const full = sut(base, target)!;

          // Act
          const result = sut(base, target, full.length - 1);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given a maxSize that fits the sourceLength varint but not the targetLength varint', () => {
      describe('When encoding', () => {
        it('Then returns undefined while still emitting the header', () => {
          // Arrange — sourceLength=0 encodes as 1 byte; targetLength=5 needs 1 more.
          const base = new Uint8Array(0);
          const target = new Uint8Array(5);
          const sut = encodeDelta;

          // Act
          const result = sut(base, target, 1);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given a maxSize crossed while flushing pending literals before a COPY', () => {
      describe('When encoding', () => {
        it('Then returns undefined without emitting the COPY', () => {
          // Arrange — header is 2 bytes; the 10-byte unrelated prefix flushes as one
          // 11-byte INSERT (length byte + data) right before the COPY of the base.
          const base = new TextEncoder().encode('0123456789abcdef0123456789abcdef');
          const prefix = new Uint8Array(10).fill(0xff);
          const target = new Uint8Array(prefix.length + base.length);
          target.set(prefix, 0);
          target.set(base, prefix.length);
          const sut = encodeDelta;

          // Act
          const result = sut(base, target, 12);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given a maxSize crossed while emitting the COPY itself', () => {
      describe('When encoding', () => {
        it('Then returns undefined after the preceding literal fit', () => {
          // Arrange — same fixture: header(2) + INSERT(11) fit in 14, but the
          // 2-byte COPY that follows pushes emitted past it.
          const base = new TextEncoder().encode('0123456789abcdef0123456789abcdef');
          const prefix = new Uint8Array(10).fill(0xff);
          const target = new Uint8Array(prefix.length + base.length);
          target.set(prefix, 0);
          target.set(base, prefix.length);
          const sut = encodeDelta;

          // Act
          const result = sut(base, target, 14);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given two block-aligned occurrences of the same 16 bytes, the older extending less', () => {
      describe('When encoding', () => {
        it('Then the more recent, longer candidate wins and the older shorter one is rejected', () => {
          // Arrange — block0 and block2 both equal `pattern`, so they collide into the
          // same bucket. Chain order visits block2 (more recent, extends by 4 more
          // matching bytes) before block0 (extends by 0), so isBetterMatch must reject
          // the second, shorter candidate rather than accepting it.
          const pattern = new Uint8Array(16).fill(0x01);
          const mismatchTail = new Uint8Array(12).fill(0x03);
          const matchTail = new Uint8Array(4).fill(0x04);
          const base = new Uint8Array(64);
          base.set(pattern, 0);
          base.set(new Uint8Array(4).fill(0x02), 16);
          base.set(mismatchTail, 20);
          base.set(pattern, 32);
          base.set(matchTail, 48);
          base.set(new Uint8Array(12).fill(0x05), 52);
          const target = new Uint8Array(20);
          target.set(pattern, 0);
          target.set(matchTail, 16);
          const sut = encodeDelta;

          // Act
          const result = sut(base, target);

          // Assert
          const parsed = parseDelta(result!);
          expect(parsed.instructions).toEqual([{ type: 'copy', offset: 32, size: 20 }]);
        });
      });
    });

    describe('Given a base of 8 identical 16-byte blocks and a fully-matching target', () => {
      describe('When encoding', () => {
        it('Then the chosen COPY offset skips the candidates beyond MAX_CANDIDATES_PER_BUCKET', () => {
          // Arrange — all 8 blocks tie on match length; the 6-candidate cap excludes
          // the 2 oldest, so the winning (lowest-offset) candidate is block index 2.
          const base = new Uint8Array(8 * DELTA_BLOCK_BYTES).fill(0xaa);
          const target = new Uint8Array(40).fill(0xaa);
          const sut = encodeDelta;

          // Act
          const result = sut(base, target);

          // Assert
          const parsed = parseDelta(result!);
          expect(parsed.instructions).toEqual([
            { type: 'copy', offset: 2 * DELTA_BLOCK_BYTES, size: target.length },
          ]);
        });
      });
    });

    describe('Given a literal run of exactly MAX_INSERT_BYTES unmatched bytes', () => {
      describe('When encoding', () => {
        it('Then it emits a single INSERT instruction of length MAX_INSERT_BYTES', () => {
          // Arrange
          const base = new Uint8Array(0);
          const target = new Uint8Array(MAX_INSERT_BYTES);
          fillWithNonRepeatingBytes(target);
          const sut = encodeDelta;

          // Act
          const result = sut(base, target);

          // Assert
          const parsed = parseDelta(result!);
          expect(parsed.instructions).toEqual([{ type: 'insert', data: target }]);
        });
      });
    });

    describe('Given a literal run of MAX_INSERT_BYTES + 1 unmatched bytes', () => {
      describe('When encoding', () => {
        it('Then it emits two INSERT instructions split exactly at MAX_INSERT_BYTES', () => {
          // Arrange
          const base = new Uint8Array(0);
          const target = new Uint8Array(MAX_INSERT_BYTES + 1);
          fillWithNonRepeatingBytes(target);
          const sut = encodeDelta;

          // Act
          const result = sut(base, target);

          // Assert
          const parsed = parseDelta(result!);
          expect(parsed.instructions).toEqual([
            { type: 'insert', data: target.subarray(0, MAX_INSERT_BYTES) },
            { type: 'insert', data: target.subarray(MAX_INSERT_BYTES) },
          ]);
        });
      });
    });

    describe('Given a literal run of at least 128 KB that matches nothing in the base', () => {
      describe('When encoding with no maxSize', () => {
        it('Then it does not throw and the result round-trips through applyDelta', () => {
          // Arrange — an empty base guarantees every byte is a literal; the
          // length exceeds the ~120,000-element V8 spread-arity ceiling that
          // crashed the old element-based emitter.
          const base = new Uint8Array(0);
          const target = new Uint8Array(140_000);
          fillWithNonRepeatingBytes(target);
          const sut = encodeDelta;

          // Act
          const result = sut(base, target);

          // Assert
          expect(result).toBeDefined();
          expect(applyDelta(base, result!)).toEqual(target);
        });
      });
    });

    describe('Given a literal run of at least 128 KB and a maxSize that comfortably fits it', () => {
      describe('When encoding via encodeDeltaFromIndex', () => {
        it('Then it does not throw and the result round-trips through applyDelta', () => {
          // Arrange — maxSize alone never protected against the crash: it
          // only rejected on the cumulative total, so a single run under
          // budget was still spread verbatim.
          const base = new Uint8Array(0);
          const index = createDeltaIndex(base);
          const target = new Uint8Array(140_000);
          fillWithNonRepeatingBytes(target);
          const sut = encodeDeltaFromIndex;

          // Act — generous enough to absorb the per-chunk length-prefix
          // overhead the 127-byte INSERT chunking adds on top of raw bytes.
          const result = sut(index, target, target.length * 2);

          // Assert
          expect(result).toBeDefined();
          expect(applyDelta(base, result!)).toEqual(target);
        });
      });
    });

    describe('Given a losing-candidate scan and a maxSize breached well before the end of target', () => {
      describe('When encoding via encodeDeltaFromIndex', () => {
        it('Then it stops flushing literal chunks long before reaching the end of target', () => {
          // Arrange — empty base means nothing ever matches, so this is the
          // dominant "nothing wins" scan shape; the assertion is on how far
          // subarray() was actually called, not on timing.
          const base = new Uint8Array(0);
          const index = createDeltaIndex(base);
          const target = new SubarrayTrackingTarget(new ArrayBuffer(10_000));
          fillWithNonRepeatingBytes(target);
          const sut = encodeDeltaFromIndex;

          // Act
          const result = sut(index, target, 500);

          // Assert
          expect(result).toBeUndefined();
          const maxObservedEnd = Math.max(...target.subarrayEnds);
          expect(maxObservedEnd).toBeLessThan(target.length / 2);
        });
      });
    });
  });
});
