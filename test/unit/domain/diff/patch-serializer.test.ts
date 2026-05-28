import { describe, expect, it } from 'vitest';
import type { PatchFile } from '../../../../src/domain/diff/patch-serializer.js';
import { renderPatch } from '../../../../src/domain/diff/patch-serializer.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';

const OID_A = 'a'.repeat(40) as ObjectId;
const OID_B = 'b'.repeat(40) as ObjectId;
const OID_C = 'c'.repeat(40) as ObjectId;
const utf8 = new TextEncoder();

const addFile = (path: string, content: string, oid: ObjectId = OID_A): PatchFile => ({
  change: {
    type: 'add',
    newPath: path as FilePath,
    newId: oid,
    newMode: FILE_MODE.REGULAR,
  },
  newContent: utf8.encode(content),
});

const deleteFile = (path: string, content: string, oid: ObjectId = OID_A): PatchFile => ({
  change: {
    type: 'delete',
    oldPath: path as FilePath,
    oldId: oid,
    oldMode: FILE_MODE.REGULAR,
  },
  oldContent: utf8.encode(content),
});

const modifyFile = (
  path: string,
  oldContent: string,
  newContent: string,
  oldOid: ObjectId = OID_A,
  newOid: ObjectId = OID_B,
): PatchFile => ({
  change: {
    type: 'modify',
    path: path as FilePath,
    oldId: oldOid,
    newId: newOid,
    oldMode: FILE_MODE.REGULAR,
    newMode: FILE_MODE.REGULAR,
  },
  oldContent: utf8.encode(oldContent),
  newContent: utf8.encode(newContent),
});

describe('patch-serializer', () => {
  describe('Given an empty PatchFile array', () => {
    describe('When renderPatch is called', () => {
      it('Then returns an empty string', () => {
        // Arrange
        const sut = renderPatch;

        // Act
        const result = sut([]);

        // Assert
        expect(result).toBe('');
      });
    });
  });

  describe('Given a single-line add file change', () => {
    describe('When renderPatch is called', () => {
      it('Then emits the canonical add header with one + line', () => {
        // Arrange
        const sut = renderPatch;
        const file = addFile('hello.txt', 'hello\n', OID_B);

        // Act
        const result = sut([file]);

        // Assert
        expect(result).toBe(
          [
            'diff --git a/hello.txt b/hello.txt',
            'new file mode 100644',
            'index 0000000..bbbbbbb',
            '--- /dev/null',
            '+++ b/hello.txt',
            '@@ -0,0 +1 @@',
            '+hello',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a multi-line add file change', () => {
    describe('When renderPatch is called', () => {
      it('Then emits @@ -0,0 +1,N @@ with N + lines', () => {
        // Arrange
        const sut = renderPatch;
        const file = addFile('multi.txt', 'one\ntwo\nthree\n', OID_C);

        // Act
        const result = sut([file]);

        // Assert
        expect(result).toBe(
          [
            'diff --git a/multi.txt b/multi.txt',
            'new file mode 100644',
            'index 0000000..ccccccc',
            '--- /dev/null',
            '+++ b/multi.txt',
            '@@ -0,0 +1,3 @@',
            '+one',
            '+two',
            '+three',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given an empty-content add file change', () => {
    describe('When renderPatch is called', () => {
      it('Then emits the add header without a hunk', () => {
        // Arrange
        const sut = renderPatch;
        const file = addFile('empty.txt', '', OID_A);

        // Act
        const result = sut([file]);

        // Assert
        expect(result).toBe(
          [
            'diff --git a/empty.txt b/empty.txt',
            'new file mode 100644',
            'index 0000000..aaaaaaa',
            '--- /dev/null',
            '+++ b/empty.txt',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given an add file change whose content lacks a trailing LF', () => {
    describe('When renderPatch is called', () => {
      it('Then emits the no-newline marker after the last + line', () => {
        // Arrange
        const sut = renderPatch;
        const file = addFile('no-eol.txt', 'one\ntwo', OID_B);

        // Act
        const result = sut([file]);

        // Assert
        expect(result).toBe(
          [
            'diff --git a/no-eol.txt b/no-eol.txt',
            'new file mode 100644',
            'index 0000000..bbbbbbb',
            '--- /dev/null',
            '+++ b/no-eol.txt',
            '@@ -0,0 +1,2 @@',
            '+one',
            '+two',
            '\\ No newline at end of file',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a single-line delete file change', () => {
    describe('When renderPatch is called', () => {
      it('Then emits the canonical delete header with one - line', () => {
        // Arrange
        const sut = renderPatch;
        const file = deleteFile('goodbye.txt', 'goodbye\n', OID_A);

        // Act
        const result = sut([file]);

        // Assert
        expect(result).toBe(
          [
            'diff --git a/goodbye.txt b/goodbye.txt',
            'deleted file mode 100644',
            'index aaaaaaa..0000000',
            '--- a/goodbye.txt',
            '+++ /dev/null',
            '@@ -1 +0,0 @@',
            '-goodbye',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given an empty-content delete file change', () => {
    describe('When renderPatch is called', () => {
      it('Then emits the delete header without a hunk', () => {
        // Arrange
        const sut = renderPatch;
        const file = deleteFile('empty.txt', '', OID_C);

        // Act
        const result = sut([file]);

        // Assert
        expect(result).toBe(
          [
            'diff --git a/empty.txt b/empty.txt',
            'deleted file mode 100644',
            'index ccccccc..0000000',
            '--- a/empty.txt',
            '+++ /dev/null',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a delete file change whose content lacks a trailing LF', () => {
    describe('When renderPatch is called', () => {
      it('Then emits the no-newline marker after the last - line', () => {
        // Arrange
        const sut = renderPatch;
        const file = deleteFile('no-eol.txt', 'one\ntwo', OID_A);

        // Act
        const result = sut([file]);

        // Assert
        expect(result).toBe(
          [
            'diff --git a/no-eol.txt b/no-eol.txt',
            'deleted file mode 100644',
            'index aaaaaaa..0000000',
            '--- a/no-eol.txt',
            '+++ /dev/null',
            '@@ -1,2 +0,0 @@',
            '-one',
            '-two',
            '\\ No newline at end of file',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given two add changes with a custom path prefix', () => {
    describe('When renderPatch is called with pathPrefix: { old: "", new: "" }', () => {
      it('Then headers use bare paths', () => {
        // Arrange
        const sut = renderPatch;
        const file = addFile('a.txt', 'x\n', OID_A);

        // Act
        const result = sut([file], { pathPrefix: { old: '', new: '' } });

        // Assert
        expect(result).toBe(
          [
            'diff --git a.txt a.txt',
            'new file mode 100644',
            'index 0000000..aaaaaaa',
            '--- /dev/null',
            '+++ a.txt',
            '@@ -0,0 +1 @@',
            '+x',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a single-line modify with no equal lines', () => {
    describe('When renderPatch is called', () => {
      it('Then emits one - and one + line under one hunk header', () => {
        // Arrange
        const sut = renderPatch;
        const file = modifyFile('foo.txt', 'old\n', 'new\n');

        // Act
        const result = sut([file]);

        // Assert
        expect(result).toBe(
          [
            'diff --git a/foo.txt b/foo.txt',
            'index aaaaaaa..bbbbbbb 100644',
            '--- a/foo.txt',
            '+++ b/foo.txt',
            '@@ -1 +1 @@',
            '-old',
            '+new',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a modify in the middle of a 10-line file', () => {
    describe('When renderPatch is called with default contextLines (3)', () => {
      it('Then emits one hunk with three lines of context on each side', () => {
        // Arrange
        const sut = renderPatch;
        const oldText = '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n';
        const newText = '1\n2\n3\n4\nFOUR\n6\n7\n8\n9\n10\n';
        const file = modifyFile('lines.txt', oldText, newText);

        // Act
        const result = sut([file]);

        // Assert
        expect(result).toBe(
          [
            'diff --git a/lines.txt b/lines.txt',
            'index aaaaaaa..bbbbbbb 100644',
            '--- a/lines.txt',
            '+++ b/lines.txt',
            '@@ -2,7 +2,7 @@',
            ' 2',
            ' 3',
            ' 4',
            '-5',
            '+FOUR',
            ' 6',
            ' 7',
            ' 8',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given two changes separated by 1 equal line', () => {
    describe('When renderPatch is called with default contextLines (3)', () => {
      it('Then coalesces into one hunk', () => {
        // Arrange — change at line 1 + change at line 3, with line 2 in between
        const sut = renderPatch;
        const file = modifyFile('foo.txt', 'a\nb\nc\n', 'A\nb\nC\n');

        // Act
        const result = sut([file]);

        // Assert
        expect(result).toBe(
          [
            'diff --git a/foo.txt b/foo.txt',
            'index aaaaaaa..bbbbbbb 100644',
            '--- a/foo.txt',
            '+++ b/foo.txt',
            '@@ -1,3 +1,3 @@',
            '-a',
            '+A',
            ' b',
            '-c',
            '+C',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given two changes separated by 8 equal lines', () => {
    describe('When renderPatch is called with default contextLines (3)', () => {
      it('Then emits two hunks', () => {
        // Arrange — change at line 1, then equal lines 2-9, change at line 10.
        // Gap = 8 equal lines, > 2*3 = 6, so hunks split.
        const sut = renderPatch;
        const oldText = 'a\n2\n3\n4\n5\n6\n7\n8\n9\nz\n';
        const newText = 'A\n2\n3\n4\n5\n6\n7\n8\n9\nZ\n';
        const file = modifyFile('foo.txt', oldText, newText);

        // Act
        const result = sut([file]);

        // Assert — first hunk ends after 3 context lines (2,3,4), second
        // hunk starts 3 context lines before line 10 (lines 7,8,9).
        expect(result).toBe(
          [
            'diff --git a/foo.txt b/foo.txt',
            'index aaaaaaa..bbbbbbb 100644',
            '--- a/foo.txt',
            '+++ b/foo.txt',
            '@@ -1,4 +1,4 @@',
            '-a',
            '+A',
            ' 2',
            ' 3',
            ' 4',
            '@@ -7,4 +7,4 @@',
            ' 7',
            ' 8',
            ' 9',
            '-z',
            '+Z',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given contextLines is 0', () => {
    describe('When renderPatch is called with a multi-line modify', () => {
      it('Then every hunk has no surrounding context', () => {
        // Arrange
        const sut = renderPatch;
        const oldText = '1\n2\n3\n4\n5\n';
        const newText = '1\n2\nTHREE\n4\n5\n';
        const file = modifyFile('foo.txt', oldText, newText);

        // Act
        const result = sut([file], { contextLines: 0 });

        // Assert
        expect(result).toBe(
          [
            'diff --git a/foo.txt b/foo.txt',
            'index aaaaaaa..bbbbbbb 100644',
            '--- a/foo.txt',
            '+++ b/foo.txt',
            '@@ -3 +3 @@',
            '-3',
            '+THREE',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a modify where the old side lacks a trailing LF', () => {
    describe('When renderPatch is called', () => {
      it('Then emits the no-newline marker after the last - line', () => {
        // Arrange
        const sut = renderPatch;
        const file = modifyFile('foo.txt', 'old', 'new\n');

        // Act
        const result = sut([file]);

        // Assert
        expect(result).toBe(
          [
            'diff --git a/foo.txt b/foo.txt',
            'index aaaaaaa..bbbbbbb 100644',
            '--- a/foo.txt',
            '+++ b/foo.txt',
            '@@ -1 +1 @@',
            '-old',
            '\\ No newline at end of file',
            '+new',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a modify where both sides lack trailing LFs', () => {
    describe('When renderPatch is called', () => {
      it('Then emits the no-newline marker after each last line', () => {
        // Arrange
        const sut = renderPatch;
        const file = modifyFile('foo.txt', 'old', 'new');

        // Act
        const result = sut([file]);

        // Assert
        expect(result).toBe(
          [
            'diff --git a/foo.txt b/foo.txt',
            'index aaaaaaa..bbbbbbb 100644',
            '--- a/foo.txt',
            '+++ b/foo.txt',
            '@@ -1 +1 @@',
            '-old',
            '\\ No newline at end of file',
            '+new',
            '\\ No newline at end of file',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a negative contextLines option', () => {
    describe('When renderPatch is called', () => {
      it('Then throws INVALID_DIFF_INPUT', () => {
        // Arrange
        const sut = renderPatch;
        const file = modifyFile('foo.txt', 'a\n', 'b\n');

        // Act
        let caught: unknown;
        try {
          sut([file], { contextLines: -1 });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } } | undefined)?.data?.code).toBe(
          'INVALID_DIFF_INPUT',
        );
      });
    });
  });

  describe('Given a non-integer contextLines option', () => {
    describe('When renderPatch is called', () => {
      it('Then throws INVALID_DIFF_INPUT', () => {
        // Arrange
        const sut = renderPatch;
        const file = modifyFile('foo.txt', 'a\n', 'b\n');

        // Act
        let caught: unknown;
        try {
          sut([file], { contextLines: 1.5 });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } } | undefined)?.data?.code).toBe(
          'INVALID_DIFF_INPUT',
        );
      });
    });
  });
});
