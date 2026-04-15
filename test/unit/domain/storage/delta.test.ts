import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TsgitError } from '../../../../src/domain/error.js';
import { applyDelta, parseDelta } from '../../../../src/domain/storage/delta.js';
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
    it("Given base 'hello' and delta that copies all, When applying, Then result equals 'hello'", () => {
      // Arrange
      const base = new TextEncoder().encode('hello');
      const delta = buildDelta(5, 5, [{ type: 'copy', offset: 0, size: 5 }]);

      // Act
      const sut = applyDelta(base, delta);

      // Assert
      expect(sut).toEqual(base);
    });

    it("Given base 'hello world' and delta with COPY offset=6 size=5, When applying, Then result is 'world'", () => {
      // Arrange
      const base = new TextEncoder().encode('hello world');
      const delta = buildDelta(11, 5, [{ type: 'copy', offset: 6, size: 5 }]);

      // Act
      const sut = applyDelta(base, delta);

      // Assert
      expect(new TextDecoder().decode(sut)).toBe('world');
    });

    it('Given base and delta with INSERT of literal bytes, When applying, Then result contains inserted bytes', () => {
      // Arrange
      const base = new Uint8Array(0);
      const insertData = new TextEncoder().encode('inserted');
      const delta = buildDelta(0, 8, [{ type: 'insert', data: insertData }]);

      // Act
      const sut = applyDelta(base, delta);

      // Assert
      expect(new TextDecoder().decode(sut)).toBe('inserted');
    });

    it('Given base and delta with mixed COPY + INSERT, When applying, Then result matches expected', () => {
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

    it('Given base >= 64KB and delta with COPY size=0 (→ 0x10000), When applying, Then copies 64KB', () => {
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

    it('Given delta with source length != base.length, When applying, Then throws INVALID_DELTA', () => {
      // Arrange
      const base = new Uint8Array(10);
      const delta = buildDelta(20, 5, [{ type: 'copy', offset: 0, size: 5 }]);

      // Act & Assert
      try {
        applyDelta(base, delta);
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

    it('Given delta with COPY offset+size > base.length, When applying, Then throws INVALID_DELTA', () => {
      // Arrange
      const base = new Uint8Array(5);
      const delta = buildDelta(5, 10, [{ type: 'copy', offset: 3, size: 7 }]);

      // Act & Assert
      try {
        applyDelta(base, delta);
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

    it('Given delta with COPY that overflows result buffer, When applying, Then throws INVALID_DELTA', () => {
      // Arrange
      const base = new Uint8Array(20);
      const delta = buildDelta(20, 5, [{ type: 'copy', offset: 0, size: 10 }]);

      // Act & Assert
      try {
        applyDelta(base, delta);
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

    it('Given delta with INSERT that overflows result buffer, When applying, Then throws INVALID_DELTA', () => {
      // Arrange
      const base = new Uint8Array(0);
      const delta = buildDelta(0, 3, [{ type: 'insert', data: new Uint8Array(5) }]);

      // Act & Assert
      try {
        applyDelta(base, delta);
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

    it('Given delta with INSERT N=0, When applying, Then throws INVALID_DELTA', () => {
      // Arrange — manually craft a delta with INSERT 0
      const delta = new Uint8Array([5, 5, 0x00]);
      const base = new Uint8Array(5);

      // Act & Assert
      try {
        applyDelta(base, delta);
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

    it('Given empty byte array as delta, When applying, Then throws INVALID_DELTA (truncated varint)', () => {
      // Arrange
      const base = new Uint8Array(0);
      const delta = new Uint8Array(0);

      // Act & Assert
      try {
        applyDelta(base, delta);
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

    it('Given delta with varint truncated mid-stream (2 continuation bytes then EOF), When applying, Then throws INVALID_DELTA', () => {
      // Arrange — 2 bytes with continuation bit set, then EOF (no terminal byte)
      const delta = new Uint8Array([0x80, 0x80]);

      // Act & Assert
      try {
        applyDelta(new Uint8Array(0), delta);
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

    it('Given delta with varint continuation exceeding 5 bytes, When applying, Then throws INVALID_DELTA', () => {
      // Arrange — 6 bytes all with continuation bit set
      const delta = new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80]);

      // Act & Assert
      try {
        applyDelta(new Uint8Array(0), delta);
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

    it('Given delta with target length exceeding 2GB, When applying, Then throws INVALID_DELTA', () => {
      // Arrange — manually craft varint encoding sourceLength=0, targetLength=0x80000001 (>2GB)
      // sourceLength = 0 → [0x00]
      // targetLength = 0x80000001 → varint: [0x81, 0x80, 0x80, 0x80, 0x08]
      const delta = new Uint8Array([0x00, 0x81, 0x80, 0x80, 0x80, 0x08]);

      // Act & Assert
      try {
        applyDelta(new Uint8Array(0), delta);
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

    it('Given delta with COPY instruction missing field bytes, When applying, Then throws INVALID_DELTA', () => {
      // Arrange — sourceLength=5, targetLength=5, COPY cmd=0xFF (all 7 fields), but no field bytes
      const delta = new Uint8Array([5, 5, 0xff]);

      // Act & Assert
      try {
        applyDelta(new Uint8Array(5), delta);
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

    it('Given empty delta (sourceLength=0, targetLength=0, no instructions), When applying with empty base, Then returns empty', () => {
      // Arrange
      const base = new Uint8Array(0);
      const delta = buildDelta(0, 0, []);

      // Act
      const sut = applyDelta(base, delta);

      // Assert
      expect(sut.length).toBe(0);
    });

    it('Given delta with sourceLength>0 targetLength>0 but no instructions, When applying, Then throws INVALID_DELTA (underfill)', () => {
      // Arrange
      const base = new Uint8Array(5);
      const delta = buildDelta(5, 5, []);

      // Act & Assert
      try {
        applyDelta(base, delta);
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

    it('Given delta with COPY spanning entire base, When applying, Then result equals base', () => {
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

    it('Given delta with multiple consecutive INSERT instructions, When applying, Then all literal data present', () => {
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

    it('Given delta that partially fills target, When applying, Then throws INVALID_DELTA (underfill)', () => {
      // Arrange
      const base = new Uint8Array(10);
      const delta = buildDelta(10, 10, [{ type: 'copy', offset: 0, size: 5 }]);

      // Act & Assert
      try {
        applyDelta(base, delta);
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

  describe('applyDelta — COPY byte selector coverage', () => {
    it('Given COPY with offset byte 1 (bit 1), When applying, Then reads offset byte 1', () => {
      // Arrange — offset = 0x0100 (256), size = 1
      const base = new Uint8Array(0x0200);
      base[0x0100] = 0xab;
      const delta = buildDelta(base.length, 1, [{ type: 'copy', offset: 0x0100, size: 1 }]);

      // Act
      const sut = applyDelta(base, delta);

      // Assert
      expect(sut[0]).toBe(0xab);
    });

    it('Given COPY with offset byte 2 (bit 2), When applying, Then reads offset byte 2', () => {
      // Arrange — offset = 0x010000, size = 1
      const base = new Uint8Array(0x010001);
      base[0x010000] = 0xcd;
      const delta = buildDelta(base.length, 1, [{ type: 'copy', offset: 0x010000, size: 1 }]);

      // Act
      const sut = applyDelta(base, delta);

      // Assert
      expect(sut[0]).toBe(0xcd);
    });

    it('Given COPY with size byte 1 (bit 5), When applying, Then reads size high byte', () => {
      // Arrange — offset = 0, size = 0x0100 (256)
      const base = new Uint8Array(0x0200);
      base.fill(0xee);
      const delta = buildDelta(base.length, 0x0100, [{ type: 'copy', offset: 0, size: 0x0100 }]);

      // Act
      const sut = applyDelta(base, delta);

      // Assert
      expect(sut.length).toBe(0x0100);
      expect(sut[0]).toBe(0xee);
    });

    it('Given COPY with size byte 2 (bit 6), When applying, Then reads size highest byte', () => {
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

    it('Given COPY with offset byte 3 (bit 3), When applying, Then reads high offset byte', () => {
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

    it('Given delta with truncated INSERT data, When applying, Then throws INVALID_DELTA with truncated reason', () => {
      // Arrange — manually craft: sourceLength=0, targetLength=5, INSERT 5 bytes but only 2 bytes follow
      const delta = new Uint8Array([0, 5, 5, 0xaa, 0xbb]);

      // Act & Assert
      try {
        applyDelta(new Uint8Array(0), delta);
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

    it('Given delta with trailing bytes after target is full, When applying, Then throws INVALID_DELTA with overflow reason', () => {
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

  describe('parseDelta', () => {
    it('Given a delta with 1 COPY + 1 INSERT, When parsing, Then returns correct lengths and 2 instructions', () => {
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

    it('Given a COPY instruction, When parsed, Then type=copy with correct offset and size', () => {
      // Arrange
      const delta = buildDelta(20, 5, [{ type: 'copy', offset: 3, size: 5 }]);

      // Act
      const sut = parseDelta(delta);

      // Assert
      expect(sut.instructions[0]).toEqual({ type: 'copy', offset: 3, size: 5 });
    });

    it('Given an INSERT instruction, When parsed, Then type=insert with correct data', () => {
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

    it('Given same delta, When parsed, Then InsertInstruction.data is independent copy', () => {
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

    it('Given delta with INSERT N=0, When parsing, Then throws INVALID_DELTA', () => {
      // Arrange
      const delta = new Uint8Array([5, 5, 0x00]);

      // Act & Assert
      try {
        parseDelta(delta);
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

  describe('parseDelta — security guards', () => {
    it('Given parseDelta with INSERT referencing more data than available, When parsing, Then throws INVALID_DELTA', () => {
      // Arrange — sourceLength=0, targetLength=10, INSERT N=10 but only 3 bytes follow
      const delta = new Uint8Array([0, 10, 10, 0xaa, 0xbb, 0xcc]);

      // Act & Assert
      try {
        parseDelta(delta);
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

  describe('property-based tests', () => {
    it('Given any generated delta, When applying, Then result matches expected output', () => {
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

    it('Given any valid delta, When applying, Then result length equals targetLength', () => {
      fc.assert(
        fc.property(fc.uint8Array({ minLength: 1, maxLength: 100 }), (base) => {
          const insert = base.slice(0, Math.min(10, base.length));
          const delta = buildDelta(base.length, insert.length, [{ type: 'insert', data: insert }]);

          const sut = applyDelta(base, delta);

          expect(sut.length).toBe(insert.length);
        }),
      );
    });
  });
});
