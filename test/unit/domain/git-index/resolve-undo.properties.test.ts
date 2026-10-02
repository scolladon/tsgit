import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  parseResolveUndo,
  type ResolveUndoRecord,
} from '../../../../src/domain/git-index/resolve-undo.js';
import { hexToBytes } from '../../../../src/domain/objects/encoding.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';

const DIGEST = 20;
const MAX_MODE = 0o177777;

const arbId = fc
  .uint8Array({ minLength: DIGEST, maxLength: DIGEST })
  .map(
    (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('') as ObjectId,
  );

const arbStage = fc.option(fc.record({ mode: fc.integer({ min: 1, max: MAX_MODE }), id: arbId }), {
  nil: undefined,
});

const arbRecord: fc.Arbitrary<ResolveUndoRecord> = fc
  .record({
    path: fc
      .string({ minLength: 1, unit: 'grapheme-ascii' })
      .filter((path) => !path.includes('\0')),
    stages: fc.tuple(arbStage, arbStage, arbStage),
  })
  .filter(({ stages }) => stages.some((stage) => stage !== undefined))
  .map(({ path, stages }) => ({
    path,
    stages: stages.flatMap((stage, index) =>
      stage === undefined ? [] : [{ stage: (index + 1) as 1 | 2 | 3, ...stage }],
    ),
  }));

/** git's `resolve_undo_write` layout for `records`. */
const encode = (records: ReadonlyArray<ResolveUndoRecord>): Uint8Array => {
  const bytes: number[] = [];
  for (const { path, stages } of records) {
    const modes = [1, 2, 3].map(
      (stage) => stages.find((entry) => entry.stage === stage)?.mode ?? 0,
    );
    bytes.push(
      ...new TextEncoder().encode(`${path}\0${modes.map((mode) => mode.toString(8)).join('\0')}\0`),
    );
    for (const { id } of stages) bytes.push(...hexToBytes(id));
  }
  return Uint8Array.from(bytes);
};

describe('resolve-undo parser properties', () => {
  describe('Given arbitrary records each naming at least one stage', () => {
    describe('When parseResolveUndo(encode(records))', () => {
      it('Then it returns the records', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(fc.array(arbRecord, { maxLength: 5 }), (records) => {
            expect(parseResolveUndo(encode(records), DIGEST)).toEqual(records);
          }),
        );
      });
    });
  });
});
