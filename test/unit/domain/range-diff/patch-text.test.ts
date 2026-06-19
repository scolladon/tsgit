import { describe, expect, it } from 'vitest';
import type { DiffChange, PatchFile } from '../../../../src/domain/diff/index.js';
import { MAX_SCORE } from '../../../../src/domain/diff/similarity.js';
import { FILE_MODE, type FilePath, type ObjectId } from '../../../../src/domain/objects/index.js';
import {
  type CommitPatchInput,
  renderRangePatch,
} from '../../../../src/domain/range-diff/patch-text.js';

const oid = (char: string): ObjectId => char.repeat(40) as ObjectId;
const path = (p: string): FilePath => p as FilePath;
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

const modify = (p: string, oldC: string, newC: string): PatchFile => ({
  change: {
    type: 'modify',
    path: path(p),
    oldId: oid('a'),
    newId: oid('b'),
    oldMode: FILE_MODE.REGULAR,
    newMode: FILE_MODE.REGULAR,
  } satisfies DiffChange,
  oldContent: bytes(oldC),
  newContent: bytes(newC),
});

const baseInput = (over: Partial<CommitPatchInput> = {}): CommitPatchInput => ({
  id: oid('1'),
  authorName: 'Alice',
  authorEmail: 'a@x',
  subject: 'do a thing',
  message: 'do a thing\n',
  files: [],
  ...over,
});

describe('renderRangePatch', () => {
  describe('Given a commit with metadata and a multi-paragraph message, When rendered', () => {
    it('Then the metadata and 4-space-indented message sections are produced', () => {
      // Arrange
      const sut = renderRangePatch;
      const input = baseInput({ message: 'subject\n\nbody one\nbody two\n' });

      // Act
      const result = sut(input);

      // Assert
      expect(result.patch).toBe(
        ' ## Metadata ##\nAuthor: Alice <a@x>\n\n ## Commit message ##\n    subject\n\n    body one\n    body two\n',
      );
    });
  });

  describe('Given a single-file modification, When rendered', () => {
    it('Then the file header, stripped @@ and prefixed body lines appear in the diff slice', () => {
      // Arrange
      const sut = renderRangePatch;
      const input = baseInput({ files: [modify('f.txt', 'one\ntwo\n', 'one\nTWO\n')] });

      // Act
      const result = sut(input);

      // Assert — diff slice begins at the file header; @@ has no line numbers
      expect(result.diff).toBe(' ## f.txt ##\n@@\n one\n-two\n+TWO\n');
      expect(result.patch.endsWith(result.diff)).toBe(true);
      expect(result.diffsize).toBe(5); // header + @@ + context one + -two + +TWO
    });
  });

  describe('Given a function-bearing source change, When rendered', () => {
    it('Then the @@ line carries the path and the enclosing function heading', () => {
      // Arrange
      const sut = renderRangePatch;
      const before =
        'int main(void)\n{\n\tint a = 1;\n\tint b = 2;\n\tint c = 3;\n\tint d = 4;\n\treturn 0;\n}\n';
      const after =
        'int main(void)\n{\n\tint a = 1;\n\tint b = 2;\n\tint c = 3;\n\tint d = 44;\n\treturn 0;\n}\n';
      const input = baseInput({ files: [modify('m.c', before, after)] });

      // Act
      const result = sut(input);

      // Assert
      expect(result.diff).toContain('@@ m.c: int main(void)\n');
    });
  });

  describe('Given a new file, When rendered', () => {
    it('Then the header is annotated (new)', () => {
      // Arrange
      const sut = renderRangePatch;
      const add: PatchFile = {
        change: {
          type: 'add',
          newPath: path('added.txt'),
          newId: oid('c'),
          newMode: FILE_MODE.REGULAR,
        },
        newContent: bytes('hello\n'),
      };
      const input = baseInput({ files: [add] });

      // Act
      const result = sut(input);

      // Assert
      expect(result.diff).toBe(' ## added.txt (new) ##\n@@\n+hello\n');
    });
  });

  describe('Given a deleted file, When rendered', () => {
    it('Then the header is annotated (deleted)', () => {
      // Arrange
      const sut = renderRangePatch;
      const del: PatchFile = {
        change: {
          type: 'delete',
          oldPath: path('gone.txt'),
          oldId: oid('d'),
          oldMode: FILE_MODE.REGULAR,
        },
        oldContent: bytes('bye\n'),
      };
      const input = baseInput({ files: [del] });

      // Act
      const result = sut(input);

      // Assert
      expect(result.diff).toBe(' ## gone.txt (deleted) ##\n@@\n-bye\n');
    });
  });

  describe('Given a mode-changing modification, When rendered', () => {
    it('Then the header records the mode change', () => {
      // Arrange
      const sut = renderRangePatch;
      const change: DiffChange = {
        type: 'modify',
        path: path('s.sh'),
        oldId: oid('a'),
        newId: oid('a'),
        oldMode: FILE_MODE.REGULAR,
        newMode: FILE_MODE.EXECUTABLE,
      };
      const input = baseInput({
        files: [{ change, oldContent: bytes('x\n'), newContent: bytes('x\n') }],
      });

      // Act
      const result = sut(input);

      // Assert
      expect(result.diff).toBe(' ## s.sh (mode change 100644 => 100755) ##\n');
      expect(result.diffsize).toBe(1);
    });
  });

  describe('Given a rename, When rendered', () => {
    it('Then the header records old => new', () => {
      // Arrange
      const sut = renderRangePatch;
      const change: DiffChange = {
        type: 'rename',
        oldPath: path('old.txt'),
        newPath: path('new.txt'),
        oldId: oid('a'),
        newId: oid('a'),
        oldMode: FILE_MODE.REGULAR,
        newMode: FILE_MODE.REGULAR,
        similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
      };
      const input = baseInput({ files: [{ change }] });

      // Act
      const result = sut(input);

      // Assert
      expect(result.diff).toBe(' ## old.txt => new.txt ##\n');
    });
  });

  describe('Given a copy change, When rendered', () => {
    it('Then fileHeader records old => new and displayName returns newPath', () => {
      // Arrange — copy mirrors rename in the range-diff: path-only header, displayName = newPath
      const sut = renderRangePatch;
      const change: DiffChange = {
        type: 'copy',
        oldPath: path('src.txt'),
        newPath: path('dst.txt'),
        oldId: oid('a'),
        newId: oid('b'),
        oldMode: FILE_MODE.REGULAR,
        newMode: FILE_MODE.REGULAR,
        similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
      };
      const input = baseInput({ files: [{ change }] });

      // Act
      const result = sut(input);

      // Assert — header uses the path-pair format (like rename); no hunk since no content
      expect(result.diff).toBe(' ## src.txt => dst.txt ##\n');
    });
  });

  describe('Given a commit with no diff, When rendered', () => {
    it('Then the diff equals the whole patch and the size is zero', () => {
      // Arrange
      const sut = renderRangePatch;
      const input = baseInput({ files: [] });

      // Act
      const result = sut(input);

      // Assert
      expect(result.diff).toBe(result.patch);
      expect(result.diffsize).toBe(0);
    });
  });

  describe('Given a file whose new content lacks a trailing newline, When rendered', () => {
    it('Then the no-newline marker follows the changed line', () => {
      // Arrange
      const sut = renderRangePatch;
      const input = baseInput({ files: [modify('f.txt', 'one\ntwo\n', 'one\nTWO')] });

      // Act
      const result = sut(input);

      // Assert
      expect(result.diff).toContain('+TWO\n \\ No newline at end of file\n');
    });
  });

  describe('Given a new binary file, When rendered', () => {
    it('Then a Binary files line is emitted against /dev/null', () => {
      // Arrange
      const sut = renderRangePatch;
      const add: PatchFile = {
        change: {
          type: 'add',
          newPath: path('blob.bin'),
          newId: oid('c'),
          newMode: FILE_MODE.REGULAR,
        },
        newContent: new Uint8Array([0x01, 0x00, 0x02]),
      };
      const input = baseInput({ files: [add] });

      // Act
      const result = sut(input);

      // Assert
      expect(result.diff).toBe(
        ' ## blob.bin (new) ##\n Binary files /dev/null and blob.bin differ\n',
      );
    });
  });

  describe('Given a deleted binary file, When rendered', () => {
    it('Then a Binary files line is emitted against /dev/null', () => {
      // Arrange
      const sut = renderRangePatch;
      const del: PatchFile = {
        change: {
          type: 'delete',
          oldPath: path('blob.bin'),
          oldId: oid('d'),
          oldMode: FILE_MODE.REGULAR,
        },
        oldContent: new Uint8Array([0x00, 0x01]),
      };
      const input = baseInput({ files: [del] });

      // Act
      const result = sut(input);

      // Assert
      expect(result.diff).toBe(
        ' ## blob.bin (deleted) ##\n Binary files blob.bin and /dev/null differ\n',
      );
    });
  });

  describe('Given a modified binary file, When rendered', () => {
    it('Then a Binary files line names both sides', () => {
      // Arrange
      const sut = renderRangePatch;
      const change: DiffChange = {
        type: 'modify',
        path: path('blob.bin'),
        oldId: oid('a'),
        newId: oid('b'),
        oldMode: FILE_MODE.REGULAR,
        newMode: FILE_MODE.REGULAR,
      };
      const input = baseInput({
        files: [
          {
            change,
            oldContent: new Uint8Array([0x00, 0x01]),
            newContent: new Uint8Array([0x00, 0x02]),
          },
        ],
      });

      // Act
      const result = sut(input);

      // Assert
      expect(result.diff).toBe(' ## blob.bin ##\n Binary files blob.bin and blob.bin differ\n');
    });
  });
});
