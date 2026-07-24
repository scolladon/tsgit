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
  describe('Given a commit with a message, When rendered', () => {
    it.each([
      {
        message: 'subject\n\nbody one\nbody two\n',
        expected:
          ' ## Metadata ##\nAuthor: Alice <a@x>\n\n ## Commit message ##\n    subject\n\n    body one\n    body two\n',
        label:
          'the metadata and 4-space-indented message sections are produced for a multi-paragraph message',
      },
      {
        message: '',
        expected: ' ## Metadata ##\nAuthor: Alice <a@x>\n\n ## Commit message ##\n',
        label: 'the commit message section carries no body lines for an empty message',
      },
      {
        message: 'summary line',
        expected:
          ' ## Metadata ##\nAuthor: Alice <a@x>\n\n ## Commit message ##\n    summary line\n',
        label:
          'the whole final line is kept, 4-space indented, for a message without a trailing newline',
      },
    ])('Then $label', ({ message, expected }) => {
      // Arrange
      const sut = renderRangePatch;
      const input = baseInput({ message });

      // Act
      const result = sut(input);

      // Assert
      expect(result.patch).toBe(expected);
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

  describe('Given two hunks in one file separated by a later function definition, When rendered', () => {
    it('Then the second @@ heading names that function, scanned only back to the first hunk', () => {
      // Arrange — the second hunk's funcname scan is bounded by the first hunk's
      // start, so it must reach `int g(void)` (sitting between the two hunks) and
      // must not retain the first hunk's `int f(void)` heading.
      const sut = renderRangePatch;
      const oldLines = [
        'int f(void)',
        '{',
        '    f1;',
        '}',
        'int g(void)',
        '    g1;',
        '    g2;',
        '    g3;',
        '    g4;',
        '    g5;',
        '    g6;',
        '    g7;',
        '    g8;',
        '    g9;',
        '    g10;',
        '    g11;',
        '    g12;',
        '    g13;',
        '    g14;',
        '    g15;',
        '}',
      ];
      const bump = (line: string): string => {
        if (line === '    g3;') return '    G3;';
        if (line === '    g15;') return '    G15;';
        return line;
      };
      const newLines = oldLines.map(bump);
      const input = baseInput({
        files: [modify('m.c', `${oldLines.join('\n')}\n`, `${newLines.join('\n')}\n`)],
      });

      // Act
      const result = sut(input);

      // Assert
      expect(result.diff).toBe(
        ' ## m.c ##\n' +
          '@@ m.c: int f(void)\n int g(void)\n     g1;\n     g2;\n-    g3;\n+    G3;\n     g4;\n     g5;\n     g6;\n' +
          '@@ m.c: int g(void)\n     g12;\n     g13;\n     g14;\n-    g15;\n+    G15;\n }\n',
      );
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

  describe('Given a single-file change, When rendered', () => {
    it.each([
      {
        file: {
          change: {
            type: 'add',
            newPath: path('added.txt'),
            newId: oid('c'),
            newMode: FILE_MODE.REGULAR,
          },
          newContent: bytes('hello\n'),
        } satisfies PatchFile,
        expected: ' ## added.txt (new) ##\n@@\n+hello\n',
        label: 'the header is annotated (new) for a new file',
      },
      {
        file: {
          change: {
            type: 'delete',
            oldPath: path('gone.txt'),
            oldId: oid('d'),
            oldMode: FILE_MODE.REGULAR,
          },
          oldContent: bytes('bye\n'),
        } satisfies PatchFile,
        expected: ' ## gone.txt (deleted) ##\n@@\n-bye\n',
        label: 'the header is annotated (deleted) for a deleted file',
      },
      {
        file: {
          change: {
            type: 'rename',
            oldPath: path('old.txt'),
            newPath: path('new.txt'),
            oldId: oid('a'),
            newId: oid('a'),
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
        } satisfies PatchFile,
        expected: ' ## old.txt => new.txt ##\n',
        label: 'the header records old => new for a rename',
      },
      {
        file: {
          change: {
            type: 'copy',
            oldPath: path('src.txt'),
            newPath: path('dst.txt'),
            oldId: oid('a'),
            newId: oid('b'),
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
        } satisfies PatchFile,
        expected: ' ## src.txt => dst.txt ##\n',
        label:
          'fileHeader records old => new and displayName returns newPath for a copy change — the path-pair format (like rename); no hunk since no content',
      },
      {
        file: {
          change: {
            type: 'add',
            newPath: path('blob.bin'),
            newId: oid('c'),
            newMode: FILE_MODE.REGULAR,
          },
          newContent: new Uint8Array([0x01, 0x00, 0x02]),
        } satisfies PatchFile,
        expected: ' ## blob.bin (new) ##\n Binary files /dev/null and blob.bin differ\n',
        label: 'a Binary files line is emitted against /dev/null for a new binary file',
      },
      {
        file: {
          change: {
            type: 'delete',
            oldPath: path('blob.bin'),
            oldId: oid('d'),
            oldMode: FILE_MODE.REGULAR,
          },
          oldContent: new Uint8Array([0x00, 0x01]),
        } satisfies PatchFile,
        expected: ' ## blob.bin (deleted) ##\n Binary files blob.bin and /dev/null differ\n',
        label: 'a Binary files line is emitted against /dev/null for a deleted binary file',
      },
      {
        file: {
          change: {
            type: 'modify',
            path: path('blob.bin'),
            oldId: oid('a'),
            newId: oid('b'),
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
          },
          oldContent: new Uint8Array([0x00, 0x01]),
          newContent: new Uint8Array([0x00, 0x02]),
        } satisfies PatchFile,
        expected: ' ## blob.bin ##\n Binary files blob.bin and blob.bin differ\n',
        label: 'a Binary files line names both sides for a modified binary file',
      },
    ])('Then $label', ({ file, expected }) => {
      // Arrange
      const sut = renderRangePatch;
      const input = baseInput({ files: [file] });

      // Act
      const result = sut(input);

      // Assert
      expect(result.diff).toBe(expected);
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
});
