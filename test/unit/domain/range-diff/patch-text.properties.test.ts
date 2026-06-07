import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { PatchFile } from '../../../../src/domain/diff/index.js';
import { FILE_MODE, type FilePath, type ObjectId } from '../../../../src/domain/objects/index.js';
import {
  type CommitPatchInput,
  renderRangePatch,
} from '../../../../src/domain/range-diff/patch-text.js';

const oid = (char: string): ObjectId => char.repeat(40) as ObjectId;
const text = fc
  .array(fc.constantFrom('a', 'b', 'c', 'd'), { maxLength: 20 })
  .map((lines) => (lines.length === 0 ? '' : `${lines.join('\n')}\n`));

const modifyFile = fc.tuple(text, text).map(
  ([oldText, newText]): PatchFile => ({
    change: {
      type: 'modify',
      path: 'f.txt' as FilePath,
      oldId: oid('a'),
      newId: oid('b'),
      oldMode: FILE_MODE.REGULAR,
      newMode: FILE_MODE.REGULAR,
    },
    oldContent: new TextEncoder().encode(oldText),
    newContent: new TextEncoder().encode(newText),
  }),
);

const arbInput = fc
  .record({
    authorName: fc.string({ maxLength: 12 }),
    message: fc.string({ maxLength: 40 }),
    files: fc.array(modifyFile, { maxLength: 1 }),
  })
  .map(
    ({ authorName, message, files }): CommitPatchInput => ({
      id: oid('1'),
      authorName,
      authorEmail: 'a@x',
      subject: 'subject',
      message,
      files,
    }),
  );

const lineCount = (s: string): number => (s === '' ? 0 : s.split('\n').length - 1);

describe('Given an arbitrary single-file commit patch input', () => {
  describe('When renderRangePatch renders it', () => {
    it('Then diff is a suffix of patch and is rendered deterministically', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbInput, (input) => {
          const result = renderRangePatch(input);
          expect(result.patch.endsWith(result.diff)).toBe(true);
          expect(renderRangePatch(input)).toEqual(result);
        }),
        { numRuns: 100 },
      );
    });

    it('Then diffsize equals the diff slice line count (single file: no inter-file blanks)', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbInput, (input) => {
          const result = renderRangePatch(input);
          if (input.files.length === 0) {
            expect(result.diff).toBe(result.patch);
            expect(result.diffsize).toBe(0);
          } else {
            expect(result.diffsize).toBe(lineCount(result.diff));
          }
        }),
        { numRuns: 100 },
      );
    });
  });
});
