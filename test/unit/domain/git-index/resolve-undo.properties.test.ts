import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { indexPathKey } from '../../../../src/domain/git-index/index-path-key.js';
import { compareEntryPath } from '../../../../src/domain/git-index/index-writer.js';
import {
  parseResolveUndo,
  recordResolveUndo,
  serializeResolveUndo,
} from '../../../../src/domain/git-index/resolve-undo.js';
import { bytesEqual } from '../../../../src/domain/objects/encoding.js';
import { arbResolveUndoRecord, encodeResolveUndo } from './arbitraries.js';

const DIGEST = 20;
const arbRecords = fc.array(arbResolveUndoRecord(), { maxLength: 5 });
const arbUniqueRecords = fc.uniqueArray(arbResolveUndoRecord(), {
  maxLength: 5,
  selector: indexPathKey,
});

describe('resolve-undo codec properties', () => {
  describe('Given arbitrary records each naming at least one stage', () => {
    describe('When parseResolveUndo(encodeResolveUndo(records))', () => {
      it('Then it returns the records', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbRecords, (records) => {
            expect(parseResolveUndo(encodeResolveUndo(records), DIGEST)).toEqual(records);
          }),
        );
      });
    });

    describe('When parseResolveUndo(serializeResolveUndo(records))', () => {
      it('Then it returns the records', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbRecords, (records) => {
            expect(parseResolveUndo(serializeResolveUndo(records), DIGEST)).toEqual(records);
          }),
          { numRuns: 200 },
        );
      });
    });

    describe('When the oracle bytes are parsed then serialized', () => {
      it('Then they are the oracle bytes again', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbRecords, (records) => {
            const bytes = encodeResolveUndo(records);
            const parsed = parseResolveUndo(bytes, DIGEST) ?? [];
            expect(bytesEqual(serializeResolveUndo(parsed), bytes)).toBe(true);
          }),
        );
      });
    });
  });

  describe('Given prior and resolved records', () => {
    describe('When recordResolveUndo merges them', () => {
      it('Then the output is sorted, key-unique, keeps every resolved stage and untouched record', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbRecords, arbUniqueRecords, (prior, resolved) => {
            const result = recordResolveUndo(prior, resolved);
            const keys = result.map(indexPathKey);
            expect(new Set(keys).size).toBe(keys.length);
            expect(
              result.every((r, i) => i === 0 || compareEntryPath(result[i - 1] ?? r, r) <= 0),
            ).toBe(true);
            for (const record of resolved) {
              const merged = result.find((r) => indexPathKey(r) === indexPathKey(record));
              for (const stage of record.stages) {
                expect(merged?.stages).toContainEqual(stage);
              }
            }
          }),
        );
      });

      it('Then a prior record no resolved record names is unchanged', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbRecords, arbUniqueRecords, (prior, resolved) => {
            const touched = new Set(resolved.map(indexPathKey));
            const result = recordResolveUndo(prior, resolved);
            const lastPrior = new Map(prior.map((r) => [indexPathKey(r), r]));
            for (const [key, record] of lastPrior) {
              if (touched.has(key)) continue;
              expect(result.find((r) => indexPathKey(r) === key)).toEqual(record);
            }
          }),
        );
      });

      it('Then applying the resolved records twice changes nothing', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbRecords, arbUniqueRecords, (prior, resolved) => {
            const once = recordResolveUndo(prior, resolved);
            expect(recordResolveUndo(once, resolved)).toEqual(once);
          }),
        );
      });
    });
  });
});
