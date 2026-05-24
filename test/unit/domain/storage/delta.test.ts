import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TsgitError } from '../../../../src/domain/error.js';
import {
  applyDelta,
  MAX_DELTA_CHAIN_DEPTH,
  parseDelta,
  readDeltaTargetSize,
} from '../../../../src/domain/storage/delta.js';
import { buildDelta } from './arbitraries.js';

type DeltaInst =
  | { type: 'copy'; offset: number; size: number }
  | { type: 'insert'; data: Uint8Array };

function filterValidInstructions(
  base: Uint8Array,
  raw: ReadonlyArray<DeltaInst>,
): { instructions: DeltaInst[]; expected: Uint8Array } {
  const instructions: DeltaInst[] = [];
  const parts: Uint8Array[] = [];
  for (const inst of raw) {
    if (inst.type === 'copy' && inst.offset + inst.size <= base.length) {
      instructions.push(inst);
      parts.push(base.slice(inst.offset, inst.offset + inst.size));
    } else if (inst.type === 'insert') {
      instructions.push(inst);
      parts.push(inst.data);
    }
  }
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const expected = new Uint8Array(totalLen);
  let pos = 0;
  for (const p of parts) {
    expected.set(p, pos);
    pos += p.length;
  }
  return { instructions, expected };
}

function arbDeltaTriple(): fc.Arbitrary<{
  base: Uint8Array;
  instructions: DeltaInst[];
  expected: Uint8Array;
}> {
  return fc
    .tuple(
      fc.uint8Array({ minLength: 0, maxLength: 200 }),
      fc.array(
        fc.oneof(
          fc.record({
            type: fc.constant('insert' as const),
            data: fc.uint8Array({ minLength: 1, maxLength: 50 }),
          }),
          fc
            .integer({ min: 0, max: 199 })
            .chain((offset) =>
              fc
                .integer({ min: 1, max: Math.max(1, 200 - offset) })
                .map((size) => ({ type: 'copy' as const, offset, size })),
            ),
        ),
        { minLength: 1, maxLength: 5 },
      ),
    )
    .map(([base, raw]) => {
      const { instructions, expected } = filterValidInstructions(base, raw);
      return { base, instructions, expected };
    });
}

describe('delta', () => {
  describe('applyDelta', () => {
    describe("Given base 'hello' and delta that copies all", () => {
      describe('When applying', () => {
        it("Then result equals 'hello'", () => {
          // Arrange
          const base = new TextEncoder().encode('hello');
          const delta = buildDelta(5, 5, [{ type: 'copy', offset: 0, size: 5 }]);

          // Act
          const sut = applyDelta(base, delta);

          // Assert
          expect(sut).toEqual(base);
        });
      });
    });

    describe("Given base 'hello world' and delta with COPY offset=6 size=5", () => {
      describe('When applying', () => {
        it("Then result is 'world'", () => {
          // Arrange
          const base = new TextEncoder().encode('hello world');
          const delta = buildDelta(11, 5, [{ type: 'copy', offset: 6, size: 5 }]);

          // Act
          const sut = applyDelta(base, delta);

          // Assert
          expect(new TextDecoder().decode(sut)).toBe('world');
        });
      });
    });

    describe('Given base and delta with INSERT of literal bytes', () => {
      describe('When applying', () => {
        it('Then result contains inserted bytes', () => {
          // Arrange
          const base = new Uint8Array(0);
          const insertData = new TextEncoder().encode('inserted');
          const delta = buildDelta(0, 8, [{ type: 'insert', data: insertData }]);

          // Act
          const sut = applyDelta(base, delta);

          // Assert
          expect(new TextDecoder().decode(sut)).toBe('inserted');
        });
      });
    });

    describe('Given base and delta with mixed COPY + INSERT', () => {
      describe('When applying', () => {
        it('Then result matches expected', () => {
          // Arrange
          const base = new TextEncoder().encode('hello world');
          const insertData = new TextEncoder().encode(' dear');
          const delta = buildDelta(11, 16, [
            { type: 'copy', offset: 0, size: 5 },
            { type: 'insert', data: insertData },
            { type: 'copy', offset: 5, size: 6 },
          ]);

          // Act
          const sut = applyDelta(base, delta);

          // Assert
          expect(new TextDecoder().decode(sut)).toBe('hello dear world');
        });
      });
    });

    describe('Given base >= 64KB and delta with COPY size=0 (→ 0x10000)', () => {
      describe('When applying', () => {
        it('Then copies 64KB', () => {
          // Arrange
          const base = new Uint8Array(0x10000);
          base.fill(0xaa);
          const delta = buildDelta(0x10000, 0x10000, [{ type: 'copy', offset: 0, size: 0x10000 }]);

          // Act
          const sut = applyDelta(base, delta);

          // Assert
          expect(sut.length).toBe(0x10000);
          expect(sut[0]).toBe(0xaa);
          expect(sut[0xffff]).toBe(0xaa);
        });
      });
    });

    describe('Given delta with source length != base.length', () => {
      describe('When applying', () => {
        it('Then throws INVALID_DELTA', () => {
          // Arrange
          const base = new Uint8Array(10);
          const delta = buildDelta(20, 5, [{ type: 'copy', offset: 0, size: 5 }]);

          // Act & Assert
          try {
            applyDelta(base, delta);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_DELTA',
                reason: expect.stringContaining('source length mismatch'),
              }),
            );
          }
        });
      });
    });

    describe('Given delta with COPY offset+size > base.length', () => {
      describe('When applying', () => {
        it('Then throws INVALID_DELTA', () => {
          // Arrange
          const base = new Uint8Array(5);
          const delta = buildDelta(5, 10, [{ type: 'copy', offset: 3, size: 7 }]);

          // Act & Assert
          try {
            applyDelta(base, delta);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_DELTA',
                reason: expect.stringContaining('COPY out of bounds'),
              }),
            );
          }
        });
      });
    });

    describe('Given delta with COPY that overflows result buffer', () => {
      describe('When applying', () => {
        it('Then throws INVALID_DELTA', () => {
          // Arrange
          const base = new Uint8Array(20);
          const delta = buildDelta(20, 5, [{ type: 'copy', offset: 0, size: 10 }]);

          // Act & Assert
          try {
            applyDelta(base, delta);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_DELTA',
                reason: expect.stringContaining('overflows target'),
              }),
            );
          }
        });
      });
    });

    describe('Given delta with INSERT that overflows result buffer', () => {
      describe('When applying', () => {
        it('Then throws INVALID_DELTA', () => {
          // Arrange
          const base = new Uint8Array(0);
          const delta = buildDelta(0, 3, [{ type: 'insert', data: new Uint8Array(5) }]);

          // Act & Assert
          try {
            applyDelta(base, delta);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_DELTA',
                reason: expect.stringContaining('INSERT overflows target'),
              }),
            );
          }
        });
      });
    });

    describe('Given delta with INSERT N=0', () => {
      describe('When applying', () => {
        it('Then throws INVALID_DELTA', () => {
          // Arrange — manually craft a delta with INSERT 0
          const delta = new Uint8Array([5, 5, 0x00]);
          const base = new Uint8Array(5);

          // Act & Assert
          try {
            applyDelta(base, delta);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_DELTA',
                reason: expect.stringContaining('INSERT with N=0'),
              }),
            );
          }
        });
      });
    });

    describe('Given empty byte array as delta', () => {
      describe('When applying', () => {
        it('Then throws INVALID_DELTA (truncated varint)', () => {
          // Arrange
          const base = new Uint8Array(0);
          const delta = new Uint8Array(0);

          // Act & Assert
          try {
            applyDelta(base, delta);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_DELTA',
                reason: expect.stringContaining('truncated'),
              }),
            );
          }
        });
      });
    });

    describe('Given delta with varint truncated mid-stream (2 continuation bytes then EOF)', () => {
      describe('When applying', () => {
        it('Then throws INVALID_DELTA', () => {
          // Arrange — 2 bytes with continuation bit set, then EOF (no terminal byte)
          const delta = new Uint8Array([0x80, 0x80]);

          // Act & Assert
          try {
            applyDelta(new Uint8Array(0), delta);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_DELTA',
                reason: expect.stringContaining('truncated'),
              }),
            );
          }
        });
      });
    });

    describe('Given delta with varint continuation exceeding 5 bytes', () => {
      describe('When applying', () => {
        it('Then throws INVALID_DELTA', () => {
          // Arrange — 6 bytes all with continuation bit set
          const delta = new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80]);

          // Act & Assert
          try {
            applyDelta(new Uint8Array(0), delta);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_DELTA',
                reason: expect.stringContaining('too long'),
              }),
            );
          }
        });
      });
    });

    describe('Given delta with target length exceeding 2GB', () => {
      describe('When applying', () => {
        it('Then throws INVALID_DELTA', () => {
          // Arrange — manually craft varint encoding sourceLength=0, targetLength=0x80000001 (>2GB)
          // sourceLength = 0 → [0x00]
          // targetLength = 0x80000001 → varint: [0x81, 0x80, 0x80, 0x80, 0x08]
          const delta = new Uint8Array([0x00, 0x81, 0x80, 0x80, 0x80, 0x08]);

          // Act & Assert
          try {
            applyDelta(new Uint8Array(0), delta);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_DELTA',
                reason: expect.stringContaining('exceeds maximum allowed size'),
              }),
            );
          }
        });
      });
    });

    describe('Given delta with COPY instruction missing field bytes', () => {
      describe('When applying', () => {
        it('Then throws INVALID_DELTA', () => {
          // Arrange — sourceLength=5, targetLength=5, COPY cmd=0xFF (all 7 fields), but no field bytes
          const delta = new Uint8Array([5, 5, 0xff]);

          // Act & Assert
          try {
            applyDelta(new Uint8Array(5), delta);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_DELTA',
                reason: expect.stringContaining('COPY instruction truncated'),
              }),
            );
          }
        });
      });
    });

    describe('Given empty delta (sourceLength=0, targetLength=0, no instructions)', () => {
      describe('When applying with empty base', () => {
        it('Then returns empty', () => {
          // Arrange
          const base = new Uint8Array(0);
          const delta = buildDelta(0, 0, []);

          // Act
          const sut = applyDelta(base, delta);

          // Assert
          expect(sut.length).toBe(0);
        });
      });
    });

    describe('Given delta with sourceLength>0 targetLength>0 but no instructions', () => {
      describe('When applying', () => {
        it('Then throws INVALID_DELTA (underfill)', () => {
          // Arrange
          const base = new Uint8Array(5);
          const delta = buildDelta(5, 5, []);

          // Act & Assert
          try {
            applyDelta(base, delta);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_DELTA',
                reason: expect.stringContaining('underfill'),
              }),
            );
          }
        });
      });
    });

    describe('Given delta with COPY spanning entire base', () => {
      describe('When applying', () => {
        it('Then result equals base', () => {
          // Arrange
          const base = new TextEncoder().encode('entire base content');
          const delta = buildDelta(base.length, base.length, [
            { type: 'copy', offset: 0, size: base.length },
          ]);

          // Act
          const sut = applyDelta(base, delta);

          // Assert
          expect(sut).toEqual(base);
        });
      });
    });

    describe('Given delta with multiple consecutive INSERT instructions', () => {
      describe('When applying', () => {
        it('Then all literal data present', () => {
          // Arrange
          const base = new Uint8Array(0);
          const insert1 = new TextEncoder().encode('abc');
          const insert2 = new TextEncoder().encode('def');
          const delta = buildDelta(0, 6, [
            { type: 'insert', data: insert1 },
            { type: 'insert', data: insert2 },
          ]);

          // Act
          const sut = applyDelta(base, delta);

          // Assert
          expect(new TextDecoder().decode(sut)).toBe('abcdef');
        });
      });
    });

    describe('Given delta that partially fills target', () => {
      describe('When applying', () => {
        it('Then throws INVALID_DELTA (underfill)', () => {
          // Arrange
          const base = new Uint8Array(10);
          const delta = buildDelta(10, 10, [{ type: 'copy', offset: 0, size: 5 }]);

          // Act & Assert
          try {
            applyDelta(base, delta);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_DELTA',
                reason: expect.stringContaining('underfill'),
              }),
            );
          }
        });
      });
    });
  });

  describe('applyDelta — COPY byte selector coverage', () => {
    describe('Given COPY with offset byte 1 (bit 1)', () => {
      describe('When applying', () => {
        it('Then reads offset byte 1', () => {
          // Arrange — offset = 0x0100 (256), size = 1
          const base = new Uint8Array(0x0200);
          base[0x0100] = 0xab;
          const delta = buildDelta(base.length, 1, [{ type: 'copy', offset: 0x0100, size: 1 }]);

          // Act
          const sut = applyDelta(base, delta);

          // Assert
          expect(sut[0]).toBe(0xab);
        });
      });
    });

    describe('Given COPY with offset byte 2 (bit 2)', () => {
      describe('When applying', () => {
        it('Then reads offset byte 2', () => {
          // Arrange — offset = 0x010000, size = 1
          const base = new Uint8Array(0x010001);
          base[0x010000] = 0xcd;
          const delta = buildDelta(base.length, 1, [{ type: 'copy', offset: 0x010000, size: 1 }]);

          // Act
          const sut = applyDelta(base, delta);

          // Assert
          expect(sut[0]).toBe(0xcd);
        });
      });
    });

    describe('Given COPY with size byte 1 (bit 5)', () => {
      describe('When applying', () => {
        it('Then reads size high byte', () => {
          // Arrange — offset = 0, size = 0x0100 (256)
          const base = new Uint8Array(0x0200);
          base.fill(0xee);
          const delta = buildDelta(base.length, 0x0100, [
            { type: 'copy', offset: 0, size: 0x0100 },
          ]);

          // Act
          const sut = applyDelta(base, delta);

          // Assert
          expect(sut.length).toBe(0x0100);
          expect(sut[0]).toBe(0xee);
        });
      });
    });

    describe('Given COPY with size byte 2 (bit 6)', () => {
      describe('When applying', () => {
        it('Then reads size highest byte', () => {
          // Arrange — offset = 0, size = 0x020000 (131072, needs byte 2)
          const base = new Uint8Array(0x020001);
          base.fill(0x11);
          const delta = buildDelta(base.length, 0x020000, [
            { type: 'copy', offset: 0, size: 0x020000 },
          ]);

          // Act
          const sut = applyDelta(base, delta);

          // Assert
          expect(sut.length).toBe(0x020000);
        });
      });
    });

    describe('Given COPY with offset byte 3 (bit 3)', () => {
      describe('When applying', () => {
        it('Then reads high offset byte', () => {
          // Arrange — offset with byte 3 set: 0x01000000
          const offsetVal = 0x01000000;
          const base = new Uint8Array(offsetVal + 1);
          base[offsetVal] = 0x77;
          const delta = buildDelta(base.length, 1, [{ type: 'copy', offset: offsetVal, size: 1 }]);

          // Act
          const sut = applyDelta(base, delta);

          // Assert
          expect(sut[0]).toBe(0x77);
        });
      });
    });

    describe('Given delta with truncated INSERT data', () => {
      describe('When applying', () => {
        it('Then throws INVALID_DELTA with truncated reason', () => {
          // Arrange — manually craft: sourceLength=0, targetLength=5, INSERT 5 bytes but only 2 bytes follow
          const delta = new Uint8Array([0, 5, 5, 0xaa, 0xbb]);

          // Act & Assert
          try {
            applyDelta(new Uint8Array(0), delta);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_DELTA',
                reason: expect.stringContaining('truncated'),
              }),
            );
          }
        });
      });
    });

    describe('Given delta with trailing bytes after target is full', () => {
      describe('When applying', () => {
        it('Then throws INVALID_DELTA with overflow reason', () => {
          // Arrange — manually craft delta with extra INSERT after complete
          const base = new Uint8Array(5);
          base.fill(0xaa);
          const validDelta = buildDelta(5, 5, [{ type: 'copy', offset: 0, size: 5 }]);
          // Append extra INSERT instruction byte
          const delta = new Uint8Array(validDelta.length + 2);
          delta.set(validDelta);
          delta[validDelta.length] = 0x01;
          delta[validDelta.length + 1] = 0xbb;

          // Act & Assert
          try {
            applyDelta(base, delta);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_DELTA',
                reason: expect.stringContaining('overflows target'),
              }),
            );
          }
        });
      });
    });
  });

  describe('parseDelta', () => {
    describe('Given a delta with 1 COPY + 1 INSERT', () => {
      describe('When parsing', () => {
        it('Then returns correct lengths and 2 instructions', () => {
          // Arrange
          const delta = buildDelta(10, 8, [
            { type: 'copy', offset: 0, size: 5 },
            { type: 'insert', data: new TextEncoder().encode('abc') },
          ]);

          // Act
          const sut = parseDelta(delta);

          // Assert
          expect(sut.sourceLength).toBe(10);
          expect(sut.targetLength).toBe(8);
          expect(sut.instructions).toHaveLength(2);
        });
      });
    });

    describe('Given a COPY instruction', () => {
      describe('When parsed', () => {
        it('Then type=copy with correct offset and size', () => {
          // Arrange
          const delta = buildDelta(20, 5, [{ type: 'copy', offset: 3, size: 5 }]);

          // Act
          const sut = parseDelta(delta);

          // Assert
          expect(sut.instructions[0]).toEqual({ type: 'copy', offset: 3, size: 5 });
        });
      });
    });

    describe('Given an INSERT instruction', () => {
      describe('When parsed', () => {
        it('Then type=insert with correct data', () => {
          // Arrange
          const insertData = new TextEncoder().encode('xyz');
          const delta = buildDelta(0, 3, [{ type: 'insert', data: insertData }]);

          // Act
          const sut = parseDelta(delta);

          // Assert
          const inst = sut.instructions[0]!;
          expect(inst.type).toBe('insert');
          expect(inst.type === 'insert' && inst.data).toEqual(insertData);
        });
      });
    });

    describe('Given same delta', () => {
      describe('When parsed', () => {
        it('Then InsertInstruction.data is independent copy', () => {
          // Arrange
          const insertData = new TextEncoder().encode('xyz');
          const delta = buildDelta(0, 3, [{ type: 'insert', data: insertData }]);

          // Act
          const sut = parseDelta(delta);
          delta[delta.length - 1] = 0xff;

          // Assert
          const inst = sut.instructions[0]!;
          expect(inst.type).toBe('insert');
          expect(inst.type === 'insert' && inst.data[2]).not.toBe(0xff);
        });
      });
    });

    describe('Given delta with INSERT N=0', () => {
      describe('When parsing', () => {
        it('Then throws INVALID_DELTA', () => {
          // Arrange
          const delta = new Uint8Array([5, 5, 0x00]);

          // Act & Assert
          try {
            parseDelta(delta);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_DELTA',
                reason: expect.stringContaining('INSERT with N=0'),
              }),
            );
          }
        });
      });
    });
  });

  describe('parseDelta — security guards', () => {
    describe('Given parseDelta with INSERT referencing more data than available', () => {
      describe('When parsing', () => {
        it('Then throws INVALID_DELTA', () => {
          // Arrange — sourceLength=0, targetLength=10, INSERT N=10 but only 3 bytes follow
          const delta = new Uint8Array([0, 10, 10, 0xaa, 0xbb, 0xcc]);

          // Act & Assert
          try {
            parseDelta(delta);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_DELTA',
                reason: expect.stringContaining('INSERT data truncated'),
              }),
            );
          }
        });
      });
    });
  });

  describe('property-based tests', () => {
    describe('Given any generated delta', () => {
      describe('When applying', () => {
        it('Then result matches expected output', () => {
          // Arrange + Assert
          fc.assert(
            fc.property(arbDeltaTriple(), ({ base, instructions, expected }) => {
              fc.pre(instructions.length > 0 && expected.length > 0);
              const delta = buildDelta(base.length, expected.length, instructions);
              const sut = applyDelta(base, delta);

              expect(sut).toEqual(expected);
              expect(sut.length).toBe(expected.length);
            }),
            { numRuns: 50 },
          );
        });
      });
    });

    describe('Given any valid delta', () => {
      describe('When applying', () => {
        it('Then result length equals targetLength', () => {
          // Arrange + Assert
          fc.assert(
            fc.property(fc.uint8Array({ minLength: 1, maxLength: 100 }), (base) => {
              const insert = base.slice(0, Math.min(10, base.length));
              const delta = buildDelta(base.length, insert.length, [
                { type: 'insert', data: insert },
              ]);

              const sut = applyDelta(base, delta);

              expect(sut.length).toBe(insert.length);
            }),
          );
        });
      });
    });
  });

  describe('readVariableLengthInt boundary — second varint at exact EOF', () => {
    describe('Given a delta whose second varint starts exactly at bytes.length', () => {
      describe('When reading target size', () => {
        it('Then throws INVALID_DELTA (truncated)', () => {
          // Arrange — single byte: first varint consumes it (o1=1), second varint starts at offset 1 === length 1
          const delta = new Uint8Array([0x00]);

          // Act & Assert
          try {
            readDeltaTargetSize(delta);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual({
              code: 'INVALID_DELTA',
              reason: 'truncated variable-length integer',
            });
          }
        });
      });
    });

    describe('Given a delta with a varint continuation byte then exact EOF', () => {
      describe('When reading target size', () => {
        it('Then throws INVALID_DELTA (truncated mid-loop)', () => {
          // Arrange — byte0=0x05 (first varint, no continuation), then 0x80,0x80: second varint continues then hits EOF at pos===length
          const delta = new Uint8Array([0x05, 0x80, 0x80]);

          // Act & Assert
          try {
            readDeltaTargetSize(delta);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual({
              code: 'INVALID_DELTA',
              reason: 'truncated variable-length integer',
            });
          }
        });
      });
    });

    describe('Given a well-formed delta', () => {
      describe('When reading target size', () => {
        it('Then returns the encoded target length', () => {
          // Arrange — sourceLength=10, targetLength=300, one COPY (irrelevant to the peek)
          const delta = buildDelta(10, 300, [{ type: 'copy', offset: 0, size: 10 }]);

          // Act
          const sut = readDeltaTargetSize(delta);

          // Assert
          expect(sut).toBe(300);
        });
      });
    });
  });

  describe('readVariableLengthInt — MAX_VARINT_BYTES boundary', () => {
    describe('Given a varint with exactly 5 continuation bytes (no terminator)', () => {
      describe('When applying', () => {
        it('Then throws too-long before reading a 6th byte', () => {
          // Arrange — 5 bytes all with continuation bit: the 5th byte's continuation must trip the length guard,
          // NOT fall through to a truncation read of a 6th byte.
          const delta = new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80]);

          // Act & Assert
          try {
            applyDelta(new Uint8Array(0), delta);
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

  describe('countCopyFieldBytes — per-bit field accounting', () => {
    const bits: ReadonlyArray<{ bit: number; label: string }> = [
      { bit: 0x01, label: 'offset byte 0' },
      { bit: 0x02, label: 'offset byte 1' },
      { bit: 0x04, label: 'offset byte 2' },
      { bit: 0x08, label: 'offset byte 3' },
      { bit: 0x10, label: 'size byte 0' },
      { bit: 0x20, label: 'size byte 1' },
      { bit: 0x40, label: 'size byte 2' },
    ];

    describe('Given a COPY cmd with one field bit flagged but zero field bytes', () => {
      describe('When applying', () => {
        for (const { bit, label } of bits) {
          it(`Then ${label} flagged throws COPY-truncated`, () => {
            // Arrange — sourceLength=0, targetLength=1, COPY cmd with exactly one field bit and NO field byte.
            // countCopyFieldBytes must report 1; any miscount skips the truncation guard.
            const delta = new Uint8Array([0x00, 0x01, 0x80 | bit]);

            // Act & Assert
            try {
              applyDelta(new Uint8Array(0), delta);
              // Assert
              expect.fail('Should have thrown');
            } catch (e) {
              const err = e as TsgitError;
              expect(err.data).toEqual({
                code: 'INVALID_DELTA',
                reason: 'COPY instruction truncated: needs 1 bytes at position 3',
              });
            }
          });
        }
      });
    });
  });

  describe('validateDeltaHeader — target length at exact maximum', () => {
    describe('Given a delta with targetLength exactly at the 2GB maximum', () => {
      describe('When applying', () => {
        it('Then it is accepted (no exceeds-maximum error)', () => {
          // Arrange — sourceLength=0, targetLength = 2*1024*1024*1024, no instructions.
          // Boundary: `>` accepts === MAX; `>=` would wrongly reject it.
          const maxTarget = 2 * 1024 * 1024 * 1024;
          const delta = buildDelta(0, maxTarget, []);

          // Act & Assert — the header passes; the apply loop then fails on underfill, NOT on the size cap.
          try {
            applyDelta(new Uint8Array(0), delta);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual({
              code: 'INVALID_DELTA',
              reason: `underfill: produced 0 bytes but target length is ${maxTarget}`,
            });
          }
        });
      });
    });
  });

  describe('applyDelta — empty delta vs early-return removal', () => {
    describe('Given a non-empty delta (sourceLength=0, targetLength>0)', () => {
      describe('When applying', () => {
        it('Then it is NOT short-circuited to an empty result', () => {
          // Arrange — would-be early-return condition operands: source=0 but target≠0 and instructions present.
          const insertData = new TextEncoder().encode('inserted');
          const delta = buildDelta(0, insertData.length, [{ type: 'insert', data: insertData }]);

          // Act
          const sut = applyDelta(new Uint8Array(0), delta);

          // Assert
          expect(new TextDecoder().decode(sut)).toBe('inserted');
          expect(sut.length).toBe(8);
        });
      });
    });
  });

  describe('parseDelta — truncated INSERT available-byte count', () => {
    describe('Given an INSERT claiming more bytes than remain', () => {
      describe('When parsing', () => {
        it('Then the error reports the exact available count', () => {
          // Arrange — sourceLength=0, targetLength=10, INSERT N=10, only 3 data bytes follow.
          // Available = delta.length(6) - pos(3) = 3.
          const delta = new Uint8Array([0, 10, 10, 0xaa, 0xbb, 0xcc]);

          // Act & Assert
          try {
            parseDelta(delta);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual({
              code: 'INVALID_DELTA',
              reason: 'INSERT data truncated: needs 10 bytes at position 3, only 3 available',
            });
          }
        });
      });
    });
  });

  describe('MAX_DELTA_CHAIN_DEPTH', () => {
    describe('Given the exported constant', () => {
      describe('When read', () => {
        it('Then equals 50 (git default)', () => {
          // Arrange + Assert
          expect(MAX_DELTA_CHAIN_DEPTH).toBe(50);
        });
      });
    });
  });
});
