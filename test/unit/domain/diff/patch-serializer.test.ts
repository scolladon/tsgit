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

const modeChangeOnly = (
  path: string,
  content: string,
  oldMode: typeof FILE_MODE.REGULAR | typeof FILE_MODE.EXECUTABLE,
  newMode: typeof FILE_MODE.REGULAR | typeof FILE_MODE.EXECUTABLE,
): PatchFile => ({
  change: {
    type: 'modify',
    path: path as FilePath,
    oldId: OID_A,
    newId: OID_A,
    oldMode,
    newMode,
  },
  oldContent: utf8.encode(content),
  newContent: utf8.encode(content),
});

const typeChangeFile = (path: string, oldText: string, newText: string): PatchFile => ({
  change: {
    type: 'type-change',
    path: path as FilePath,
    oldId: OID_A,
    newId: OID_B,
    oldMode: FILE_MODE.REGULAR,
    newMode: FILE_MODE.SYMLINK,
  },
  oldContent: utf8.encode(oldText),
  newContent: utf8.encode(newText),
});

const renameFile = (oldPath: string, newPath: string): PatchFile => ({
  change: {
    type: 'rename',
    oldPath: oldPath as FilePath,
    newPath: newPath as FilePath,
    id: OID_A,
    mode: FILE_MODE.REGULAR,
  },
});

describe('patch-serializer', () => {
  describe('Given an empty PatchFile array', () => {
    describe('When renderPatch is called', () => {
      it('Then returns an empty string', () => {
        // Arrange — no PatchFile entries; nothing to materialise.
        const files: ReadonlyArray<PatchFile> = [];

        // Act
        const sut = renderPatch(files);

        // Assert
        expect(sut).toBe('');
      });
    });
  });

  describe('Given a single-line add file change', () => {
    describe('When renderPatch is called', () => {
      it('Then emits the canonical add header with one + line', () => {
        // Arrange
        const file = addFile('hello.txt', 'hello\n', OID_B);

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
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
        const file = addFile('multi.txt', 'one\ntwo\nthree\n', OID_C);

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
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
        const file = addFile('empty.txt', '', OID_A);

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
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
        const file = addFile('no-eol.txt', 'one\ntwo', OID_B);

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
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
        const file = deleteFile('goodbye.txt', 'goodbye\n', OID_A);

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
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
        const file = deleteFile('empty.txt', '', OID_C);

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
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
        const file = deleteFile('no-eol.txt', 'one\ntwo', OID_A);

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
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
        const file = addFile('a.txt', 'x\n', OID_A);

        // Act
        const sut = renderPatch([file], { pathPrefix: { old: '', new: '' } });

        // Assert
        expect(sut).toBe(
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
        const file = modifyFile('foo.txt', 'old\n', 'new\n');

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
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
        const oldText = '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n';
        const newText = '1\n2\n3\n4\nFOUR\n6\n7\n8\n9\n10\n';
        const file = modifyFile('lines.txt', oldText, newText);

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
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
        const file = modifyFile('foo.txt', 'a\nb\nc\n', 'A\nb\nC\n');

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
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
        const oldText = 'a\n2\n3\n4\n5\n6\n7\n8\n9\nz\n';
        const newText = 'A\n2\n3\n4\n5\n6\n7\n8\n9\nZ\n';
        const file = modifyFile('foo.txt', oldText, newText);

        // Act
        const sut = renderPatch([file]);

        // Assert — first hunk ends after 3 context lines (2,3,4), second
        // hunk starts 3 context lines before line 10 (lines 7,8,9).
        expect(sut).toBe(
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
        const oldText = '1\n2\n3\n4\n5\n';
        const newText = '1\n2\nTHREE\n4\n5\n';
        const file = modifyFile('foo.txt', oldText, newText);

        // Act
        const sut = renderPatch([file], { contextLines: 0 });

        // Assert
        expect(sut).toBe(
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
        const file = modifyFile('foo.txt', 'old', 'new\n');

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
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
        const file = modifyFile('foo.txt', 'old', 'new');

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
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
        const file = modifyFile('foo.txt', 'a\n', 'b\n');

        // Act
        let caught: unknown;
        try {
          renderPatch([file], { contextLines: -1 });
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
        const file = modifyFile('foo.txt', 'a\n', 'b\n');

        // Act
        let caught: unknown;
        try {
          renderPatch([file], { contextLines: 1.5 });
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

  describe('Given a modify with content change AND mode flip', () => {
    describe('When renderPatch is called', () => {
      it('Then emits old mode + new mode + index (no trailing mode) + hunks', () => {
        // Arrange
        const file: PatchFile = {
          change: {
            type: 'modify',
            path: 'foo.sh' as FilePath,
            oldId: OID_A,
            newId: OID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.EXECUTABLE,
          },
          oldContent: utf8.encode('old\n'),
          newContent: utf8.encode('new\n'),
        };

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
          [
            'diff --git a/foo.sh b/foo.sh',
            'old mode 100644',
            'new mode 100755',
            'index aaaaaaa..bbbbbbb',
            '--- a/foo.sh',
            '+++ b/foo.sh',
            '@@ -1 +1 @@',
            '-old',
            '+new',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a mode-only modify (content identical)', () => {
    describe('When renderPatch is called', () => {
      it('Then emits old mode + new mode + index only (no --- / +++ / hunks)', () => {
        // Arrange
        const file = modeChangeOnly('foo.sh', 'echo hi\n', FILE_MODE.REGULAR, FILE_MODE.EXECUTABLE);

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
          [
            'diff --git a/foo.sh b/foo.sh',
            'old mode 100644',
            'new mode 100755',
            'index aaaaaaa..aaaaaaa',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a type change from regular to symlink', () => {
    describe('When renderPatch is called', () => {
      it('Then emits old mode 100644, new mode 120000, index, and content hunk', () => {
        // Arrange
        const file = typeChangeFile('foo', 'old contents\n', '/some/symlink/target');

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
          [
            'diff --git a/foo b/foo',
            'old mode 100644',
            'new mode 120000',
            'index aaaaaaa..bbbbbbb',
            '--- a/foo',
            '+++ b/foo',
            '@@ -1 +1 @@',
            '-old contents',
            '+/some/symlink/target',
            '\\ No newline at end of file',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a pure rename change', () => {
    describe('When renderPatch is called', () => {
      it('Then emits similarity index 100% + rename from + rename to (no hunks)', () => {
        // Arrange
        const file = renameFile('old/path.txt', 'new/path.txt');

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
          [
            'diff --git a/old/path.txt b/new/path.txt',
            'similarity index 100%',
            'rename from old/path.txt',
            'rename to new/path.txt',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a binary modify change', () => {
    describe('When renderPatch is called', () => {
      it('Then emits the Binary files ... differ block', () => {
        // Arrange — NUL byte in content triggers isBinary
        const oldBytes = new Uint8Array([0x01, 0x00, 0x02, 0x03]);
        const newBytes = new Uint8Array([0x01, 0x00, 0x02, 0x04]);
        const file: PatchFile = {
          change: {
            type: 'modify',
            path: 'logo.png' as FilePath,
            oldId: OID_A,
            newId: OID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
          },
          oldContent: oldBytes,
          newContent: newBytes,
        };

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
          [
            'diff --git a/logo.png b/logo.png',
            'index aaaaaaa..bbbbbbb 100644',
            'Binary files a/logo.png and b/logo.png differ',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a binary add change', () => {
    describe('When renderPatch is called', () => {
      it('Then emits Binary files /dev/null and b/X differ', () => {
        // Arrange
        const file: PatchFile = {
          change: {
            type: 'add',
            newPath: 'logo.png' as FilePath,
            newId: OID_B,
            newMode: FILE_MODE.REGULAR,
          },
          newContent: new Uint8Array([0x00, 0x01, 0x02]),
        };

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
          [
            'diff --git a/logo.png b/logo.png',
            'new file mode 100644',
            'index 0000000..bbbbbbb',
            'Binary files /dev/null and b/logo.png differ',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a path containing an embedded newline', () => {
    describe('When renderPatch is called', () => {
      it('Then throws INVALID_DIFF_INPUT', () => {
        // Arrange — defence-in-depth: tree-object parsers accept arbitrary
        // non-`/` bytes in entry names, so a hostile remote could ship a
        // path containing `\n`. The serializer must refuse to render it
        // because the resulting headers would smuggle forged hunks past
        // any downstream parser.
        const file = addFile('evil\nindex 0000000..deadbeef', 'hi\n');

        // Act
        let caught: unknown;
        try {
          renderPatch([file]);
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

  describe('Given a path containing a NUL byte', () => {
    describe('When renderPatch is called', () => {
      it('Then throws INVALID_DIFF_INPUT', () => {
        // Arrange
        const file = addFile('evil\x00path', 'hi\n');

        // Act
        let caught: unknown;
        try {
          renderPatch([file]);
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

  describe('Given a pathPrefix containing a newline', () => {
    describe('When renderPatch is called', () => {
      it('Then throws INVALID_DIFF_INPUT', () => {
        // Arrange — covers the prefix-injection vector independently of the
        // change-path one.
        const file = addFile('ok.txt', 'hi\n');

        // Act
        let caught: unknown;
        try {
          renderPatch([file], { pathPrefix: { old: 'a/', new: 'b/\nrename from /etc/passwd' } });
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

  describe('Given a delete change with an unsafe path', () => {
    describe('When renderPatch is called', () => {
      it('Then throws INVALID_DIFF_INPUT', () => {
        // Arrange — covers the `delete` branch of assertSafePaths.
        const file = deleteFile('bad\nindex deadbeef', 'x\n');

        // Act
        let caught: unknown;
        try {
          renderPatch([file]);
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

  describe('Given a rename change with an unsafe newPath', () => {
    describe('When renderPatch is called', () => {
      it('Then throws INVALID_DIFF_INPUT', () => {
        // Arrange — covers the `rename` branch of assertSafePaths.
        const file = renameFile('old.txt', 'new\nindex forged');

        // Act
        let caught: unknown;
        try {
          renderPatch([file]);
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

  describe('Given a modify whose contents are byte-identical (synthetic — caller passed identical bytes with different ids)', () => {
    describe('When renderPatch is called', () => {
      it('Then emits header + index + --- + +++ with no hunks (groups.length === 0 path)', () => {
        // Arrange — ids differ but bytes match: renderTextBody → groupHunks
        // sees no change edits, returns no hunks. Exercises the `groups.length
        // === 0` early-return.
        const file = modifyFile('foo.txt', 'same\n', 'same\n');

        // Act
        const sut = renderPatch([file]);

        // Assert — body is the header + index + --- + +++ + EOF.
        expect(sut).toBe(
          [
            'diff --git a/foo.txt b/foo.txt',
            'index aaaaaaa..bbbbbbb 100644',
            '--- a/foo.txt',
            '+++ b/foo.txt',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a modify whose oldId and newId differ AND both contents are empty', () => {
    describe('When renderPatch is called', () => {
      it('Then emits header + index + --- + +++ with no hunks (edits.length === 0 path)', () => {
        // Arrange — empty/empty drives diffLines to produce a single
        // zero-range "common" hunk, so the edit stream is empty.
        const file = modifyFile('foo.txt', '', '');

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
          [
            'diff --git a/foo.txt b/foo.txt',
            'index aaaaaaa..bbbbbbb 100644',
            '--- a/foo.txt',
            '+++ b/foo.txt',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given an add PatchFile with no newContent', () => {
    describe('When renderPatch is called', () => {
      it('Then treats it as an empty add', () => {
        // Arrange
        const file: PatchFile = {
          change: {
            type: 'add',
            newPath: 'empty.txt' as FilePath,
            newId: OID_A,
            newMode: FILE_MODE.REGULAR,
          },
        };

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
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

  describe('Given a delete PatchFile with no oldContent', () => {
    describe('When renderPatch is called', () => {
      it('Then treats it as an empty delete', () => {
        // Arrange
        const file: PatchFile = {
          change: {
            type: 'delete',
            oldPath: 'empty.txt' as FilePath,
            oldId: OID_A,
            oldMode: FILE_MODE.REGULAR,
          },
        };

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
          [
            'diff --git a/empty.txt b/empty.txt',
            'deleted file mode 100644',
            'index aaaaaaa..0000000',
            '--- a/empty.txt',
            '+++ /dev/null',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a modify PatchFile with no oldContent provided', () => {
    describe('When renderPatch is called', () => {
      it('Then treats the missing side as empty bytes', () => {
        // Arrange — exercises the `file.oldContent ?? new Uint8Array(0)`
        // fallback in renderFile.
        const file: PatchFile = {
          change: {
            type: 'modify',
            path: 'foo.txt' as FilePath,
            oldId: OID_A,
            newId: OID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
          },
          newContent: utf8.encode('hi\n'),
        };

        // Act
        const sut = renderPatch([file]);

        // Assert — old side acts like an empty file; one `+hi` line emitted.
        expect(sut).toBe(
          [
            'diff --git a/foo.txt b/foo.txt',
            'index aaaaaaa..bbbbbbb 100644',
            '--- a/foo.txt',
            '+++ b/foo.txt',
            '@@ -0,0 +1 @@',
            '+hi',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a modify PatchFile with no newContent provided', () => {
    describe('When renderPatch is called', () => {
      it('Then treats the missing side as empty bytes', () => {
        // Arrange — exercises the `file.newContent ?? new Uint8Array(0)`
        // fallback in renderFile.
        const file: PatchFile = {
          change: {
            type: 'modify',
            path: 'foo.txt' as FilePath,
            oldId: OID_A,
            newId: OID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
          },
          oldContent: utf8.encode('bye\n'),
        };

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
          [
            'diff --git a/foo.txt b/foo.txt',
            'index aaaaaaa..bbbbbbb 100644',
            '--- a/foo.txt',
            '+++ b/foo.txt',
            '@@ -1 +0,0 @@',
            '-bye',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a modify whose old side is empty and new side is binary (synthetic edge case)', () => {
    describe('When renderPatch is called', () => {
      it('Then emits Binary files /dev/null and b/X differ', () => {
        // Arrange — renderBinaryBody substitutes /dev/null on the empty side.
        const file: PatchFile = {
          change: {
            type: 'modify',
            path: 'logo.png' as FilePath,
            oldId: OID_A,
            newId: OID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
          },
          oldContent: new Uint8Array(0),
          newContent: new Uint8Array([0x00, 0x01, 0x02]),
        };

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
          [
            'diff --git a/logo.png b/logo.png',
            'index aaaaaaa..bbbbbbb 100644',
            'Binary files /dev/null and b/logo.png differ',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a modify whose new side is empty and old side is binary (synthetic edge case)', () => {
    describe('When renderPatch is called', () => {
      it('Then emits Binary files a/X and /dev/null differ', () => {
        // Arrange — symmetric of the above; exercises the `newBytes.length === 0` branch.
        const file: PatchFile = {
          change: {
            type: 'modify',
            path: 'logo.png' as FilePath,
            oldId: OID_A,
            newId: OID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
          },
          oldContent: new Uint8Array([0x00, 0x01, 0x02]),
          newContent: new Uint8Array(0),
        };

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
          [
            'diff --git a/logo.png b/logo.png',
            'index aaaaaaa..bbbbbbb 100644',
            'Binary files a/logo.png and /dev/null differ',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a modify where the last shared line lacks trailing LF on both sides', () => {
    describe('When renderPatch is called', () => {
      it('Then emits the no-newline marker as the trailing body element', () => {
        // Arrange — change line 1 only; last lines `b`, `c` are byte-identical
        // and lack trailing LF on both sides. The marker must surface as the
        // final body element regardless of which line Myers labels as
        // context vs. the no-op tail.
        const file = modifyFile('foo.txt', 'a\nb\nc', 'A\nb\nc');

        // Act
        const sut = renderPatch([file]);

        // Assert — Decoupled from Myers' specific labelling: the marker is
        // the last non-empty line, immediately after the last body line.
        const lines = sut.split('\n');
        expect(lines.at(-1)).toBe(''); // trailing newline
        expect(lines.at(-2)).toBe('\\ No newline at end of file');
        // And it must be preceded by a body line carrying either side's last
        // textual content (`c`) — context, delete, or insert — never blank.
        const beforeMarker = lines.at(-3) ?? '';
        expect(beforeMarker.length).toBeGreaterThan(0);
        expect(' -+'.includes(beforeMarker[0] ?? '')).toBe(true);
        // The full header pieces are still produced.
        expect(sut).toContain('diff --git a/foo.txt b/foo.txt');
        expect(sut).toContain('index aaaaaaa..bbbbbbb 100644');
        expect(sut).toContain('--- a/foo.txt');
        expect(sut).toContain('+++ b/foo.txt');
      });
    });
  });

  describe('Given a pure insertion at the end with contextLines=0', () => {
    describe('When renderPatch is called', () => {
      it('Then emits a hunk with oldLen=0 anchored at the prior line', () => {
        // Arrange — appending `b` after the only line `a`. With contextLines=0
        // the slice carries one insert; oldLen=0 forces the zero-length-anchor
        // branch in computeRange.
        const file = modifyFile('foo.txt', 'a\n', 'a\nb\n');

        // Act
        const sut = renderPatch([file], { contextLines: 0 });

        // Assert
        expect(sut).toBe(
          [
            'diff --git a/foo.txt b/foo.txt',
            'index aaaaaaa..bbbbbbb 100644',
            '--- a/foo.txt',
            '+++ b/foo.txt',
            '@@ -1,0 +2 @@',
            '+b',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a pure deletion at the end with contextLines=0', () => {
    describe('When renderPatch is called', () => {
      it('Then emits a hunk with newLen=0 anchored at the prior line', () => {
        // Arrange — symmetric to the insertion case: forces newLen=0 in
        // computeRange.
        const file = modifyFile('foo.txt', 'a\nb\n', 'a\n');

        // Act
        const sut = renderPatch([file], { contextLines: 0 });

        // Assert
        expect(sut).toBe(
          [
            'diff --git a/foo.txt b/foo.txt',
            'index aaaaaaa..bbbbbbb 100644',
            '--- a/foo.txt',
            '+++ b/foo.txt',
            '@@ -2 +1,0 @@',
            '-b',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a binary delete change', () => {
    describe('When renderPatch is called', () => {
      it('Then emits Binary files a/X and /dev/null differ', () => {
        // Arrange
        const file: PatchFile = {
          change: {
            type: 'delete',
            oldPath: 'logo.png' as FilePath,
            oldId: OID_A,
            oldMode: FILE_MODE.REGULAR,
          },
          oldContent: new Uint8Array([0x00, 0x01, 0x02]),
        };

        // Act
        const sut = renderPatch([file]);

        // Assert
        expect(sut).toBe(
          [
            'diff --git a/logo.png b/logo.png',
            'deleted file mode 100644',
            'index aaaaaaa..0000000',
            'Binary files a/logo.png and /dev/null differ',
            '',
          ].join('\n'),
        );
      });
    });
  });
});
