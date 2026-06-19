import { describe, expect, it } from 'vitest';
import type { PatchFile } from '../../../../src/domain/diff/patch-serializer.js';
import { computeHunks, renderPatch } from '../../../../src/domain/diff/patch-serializer.js';
import { MAX_SCORE } from '../../../../src/domain/diff/similarity.js';
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
    oldId: OID_A,
    newId: OID_A,
    oldMode: FILE_MODE.REGULAR,
    newMode: FILE_MODE.REGULAR,
    similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
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

  describe('Given a sub-100% rename change with text content (matrix #1 shape)', () => {
    describe('When renderPatch is called', () => {
      it('Then emits similarity index + rename from/to + index line + hunk body', () => {
        // Arrange — R087 shape: same-mode rename, old/new ids differ, score < MAX_SCORE
        const oldContent = utf8.encode('line 00\nline 01\nline 02\n');
        const newContent = utf8.encode('CHANGED\nline 01\nline 02\n');
        const file: PatchFile = {
          change: {
            type: 'rename',
            oldPath: 'original.txt' as FilePath,
            newPath: 'moved.txt' as FilePath,
            oldId: OID_A,
            newId: OID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: 52200, maxScore: MAX_SCORE }, // toSimilarityPercent → 87
          },
          oldContent,
          newContent,
        };

        // Act
        const sut = renderPatch([file]);

        // Assert — header + similarity index 87% + rename from/to + index (with mode) + hunk
        expect(sut).toBe(
          [
            'diff --git a/original.txt b/moved.txt',
            'similarity index 87%',
            'rename from original.txt',
            'rename to moved.txt',
            'index aaaaaaa..bbbbbbb 100644',
            '--- a/original.txt',
            '+++ b/moved.txt',
            '@@ -1,3 +1,3 @@',
            '-line 00',
            '+CHANGED',
            ' line 01',
            ' line 02',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a sub-100% rename change whose hydrated content is absent', () => {
    describe('When renderPatch is called', () => {
      it('Then emits the header and index line with an empty body (no hunk)', () => {
        // Arrange — a two-path change below MAX_SCORE with neither side hydrated;
        // the serializer treats absent content as empty rather than throwing.
        const file: PatchFile = {
          change: {
            type: 'rename',
            oldPath: 'original.txt' as FilePath,
            newPath: 'moved.txt' as FilePath,
            oldId: OID_A,
            newId: OID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: 52200, maxScore: MAX_SCORE },
          },
        };

        // Act
        const sut = renderPatch([file]);

        // Assert — header + index + the diff body markers, but no `@@` hunk
        expect(sut).toBe(
          [
            'diff --git a/original.txt b/moved.txt',
            'similarity index 87%',
            'rename from original.txt',
            'rename to moved.txt',
            'index aaaaaaa..bbbbbbb 100644',
            '--- a/original.txt',
            '+++ b/moved.txt',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a mode-change + sub-100% rename (matrix #4)', () => {
    describe('When renderPatch is called', () => {
      it('Then emits old mode / new mode BEFORE similarity index, and index line WITHOUT trailing mode', () => {
        // Arrange — modes differ: preamble precedes similarity; index omits mode suffix
        const oldContent = utf8.encode('#!/bin/sh\necho hi\n');
        const newContent = utf8.encode('#!/bin/sh\necho hello\n');
        const file: PatchFile = {
          change: {
            type: 'rename',
            oldPath: 'run.sh' as FilePath,
            newPath: 'run-new.sh' as FilePath,
            oldId: OID_A,
            newId: OID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.EXECUTABLE,
            similarity: { score: 42600, maxScore: MAX_SCORE }, // toSimilarityPercent → 71
          },
          oldContent,
          newContent,
        };

        // Act
        const sut = renderPatch([file]);

        // Assert — mode preamble BEFORE similarity; index line NO trailing mode
        expect(sut).toBe(
          [
            'diff --git a/run.sh b/run-new.sh',
            'old mode 100644',
            'new mode 100755',
            'similarity index 71%',
            'rename from run.sh',
            'rename to run-new.sh',
            'index aaaaaaa..bbbbbbb',
            '--- a/run.sh',
            '+++ b/run-new.sh',
            '@@ -1,2 +1,2 @@',
            ' #!/bin/sh',
            '-echo hi',
            '+echo hello',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a pure R100 rename change (regression pin from slice 2)', () => {
    describe('When renderPatch is called', () => {
      it('Then emits exactly 4 header lines with no index line and no hunk', () => {
        // Arrange — score === MAX_SCORE: byte-identical to the slice 2 form
        const file = renameFile('old/path.txt', 'new/path.txt');

        // Act
        const sut = renderPatch([file]);

        // Assert — byte-identical to the pre-slice-4 output
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

  describe('Given a sub-100% rename change with binary content', () => {
    describe('When renderPatch is called', () => {
      it('Then emits similarity + rename from/to + index + Binary files differ', () => {
        // Arrange — binary bytes (contain NUL) trigger isBinary path
        const binaryOld = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
        const binaryNew = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]);
        const file: PatchFile = {
          change: {
            type: 'rename',
            oldPath: 'logo.png' as FilePath,
            newPath: 'icon.png' as FilePath,
            oldId: OID_A,
            newId: OID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: 30000, maxScore: MAX_SCORE }, // toSimilarityPercent → 50
          },
          oldContent: binaryOld,
          newContent: binaryNew,
        };

        // Act
        const sut = renderPatch([file]);

        // Assert — binary rename: index line present (same mode) + Binary files differ
        expect(sut).toBe(
          [
            'diff --git a/logo.png b/icon.png',
            'similarity index 50%',
            'rename from logo.png',
            'rename to icon.png',
            'index aaaaaaa..bbbbbbb 100644',
            'Binary files a/logo.png and b/icon.png differ',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a sub-100% copy change with text content (matrix #C1 shape)', () => {
    describe('When renderPatch is called', () => {
      it('Then emits copy from/copy to instead of rename from/to, plus index line and hunk', () => {
        // Arrange — C072 shape: same-mode copy, old/new ids differ, score < MAX_SCORE
        const oldContent = utf8.encode('line 00\nline 01\nline 02\nline 03\n');
        const newContent = utf8.encode('line 00\nline 01\nCHANGED\nline 03\n');
        const file: PatchFile = {
          change: {
            type: 'copy',
            oldPath: 'source.txt' as FilePath,
            newPath: 'dest.txt' as FilePath,
            oldId: OID_A,
            newId: OID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: 43200, maxScore: MAX_SCORE }, // toSimilarityPercent → 72
          },
          oldContent,
          newContent,
        };

        // Act
        const sut = renderPatch([file]);

        // Assert — header + similarity index 72% + copy from/to + index (with mode) + hunk
        expect(sut).toBe(
          [
            'diff --git a/source.txt b/dest.txt',
            'similarity index 72%',
            'copy from source.txt',
            'copy to dest.txt',
            'index aaaaaaa..bbbbbbb 100644',
            '--- a/source.txt',
            '+++ b/dest.txt',
            '@@ -1,4 +1,4 @@',
            ' line 00',
            ' line 01',
            '-line 02',
            '+CHANGED',
            ' line 03',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given an exact copy (score === MAX_SCORE, matrix #C4)', () => {
    describe('When renderPatch is called', () => {
      it('Then emits only the header + similarity 100% + copy from/to (no index line, no hunk)', () => {
        // Arrange — C100: content byte-identical
        const file: PatchFile = {
          change: {
            type: 'copy',
            oldPath: 'original.txt' as FilePath,
            newPath: 'copied.txt' as FilePath,
            oldId: OID_A,
            newId: OID_A,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
        };

        // Act
        const sut = renderPatch([file]);

        // Assert — C100: no index line, no hunk; 4 lines only (diff + similarity + from + to)
        expect(sut).toBe(
          [
            'diff --git a/original.txt b/copied.txt',
            'similarity index 100%',
            'copy from original.txt',
            'copy to copied.txt',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a copy change with unsafe oldPath', () => {
    describe('When renderPatch is called', () => {
      it('Then throws INVALID_DIFF_INPUT', () => {
        // Arrange — covers the copy branch of assertSafePaths
        const file: PatchFile = {
          change: {
            type: 'copy',
            oldPath: 'evil\nindex forged' as FilePath,
            newPath: 'dest.txt' as FilePath,
            oldId: OID_A,
            newId: OID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
        };

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

  describe('Given a broken modify with fully-disjoint content (dissimilarity index 100%)', () => {
    describe('When renderPatch is called', () => {
      it('Then emits dissimilarity index 100% + index line + full D/A hunk (matrix B1)', () => {
        // Arrange — broken = { score: MAX_SCORE, maxScore: MAX_SCORE } (100% dissimilarity)
        const oldContent = utf8.encode('old line 1\nold line 2\n');
        const newContent = utf8.encode('new line A\nnew line B\n');
        const file: PatchFile = {
          change: {
            type: 'modify',
            path: 'rewrite.txt' as FilePath,
            oldId: OID_A,
            newId: OID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            broken: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
          oldContent,
          newContent,
        };

        // Act
        const sut = renderPatch([file]);

        // Assert — dissimilarity index 100% replaces the normal index-predecessor;
        // index line carries mode (same oldMode/newMode); full D/A hunk follows.
        expect(sut).toBe(
          [
            'diff --git a/rewrite.txt b/rewrite.txt',
            'dissimilarity index 100%',
            'index aaaaaaa..bbbbbbb 100644',
            '--- a/rewrite.txt',
            '+++ b/rewrite.txt',
            '@@ -1,2 +1,2 @@',
            '-old line 1',
            '-old line 2',
            '+new line A',
            '+new line B',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a non-broken modify (regression pin)', () => {
    describe('When renderPatch is called', () => {
      it('Then emits the normal index line (no dissimilarity line) byte-identical to before', () => {
        // Arrange — plain modify: no broken field; must be byte-identical to today
        const file = modifyFile('foo.txt', 'old\n', 'new\n');

        // Act
        const sut = renderPatch([file]);

        // Assert — no dissimilarity line; normal index line
        expect(sut).not.toContain('dissimilarity index');
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

  describe('Given a broken modify with a specific dissimilarity percent', () => {
    describe('When renderPatch is called', () => {
      it('Then emits dissimilarity index <p>% with the correct truncated percent', () => {
        // Arrange — broken.score = 39600 → toSimilarityPercent(39600) = 66
        const oldContent = utf8.encode('alpha\nbeta\ngamma\n');
        const newContent = utf8.encode('delta\nepsilon\nzeta\n');
        const file: PatchFile = {
          change: {
            type: 'modify',
            path: 'file.txt' as FilePath,
            oldId: OID_A,
            newId: OID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            broken: { score: 39600, maxScore: MAX_SCORE }, // toSimilarityPercent(39600) = 66
          },
          oldContent,
          newContent,
        };

        // Act
        const sut = renderPatch([file]);

        // Assert — full byte-equality: dissimilarity index 66% (truncated, not rounded),
        // followed by the index line and the complete D/A hunk.
        expect(sut).toBe(
          [
            'diff --git a/file.txt b/file.txt',
            'dissimilarity index 66%',
            'index aaaaaaa..bbbbbbb 100644',
            '--- a/file.txt',
            '+++ b/file.txt',
            '@@ -1,3 +1,3 @@',
            '-alpha',
            '-beta',
            '-gamma',
            '+delta',
            '+epsilon',
            '+zeta',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a broken modify with binary content', () => {
    describe('When renderPatch is called', () => {
      it('Then emits dissimilarity index line followed by binary files differ', () => {
        // Arrange — binary bytes contain NUL (0x00) which triggers isBinary path
        const oldContent = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
        const newContent = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]);
        const file: PatchFile = {
          change: {
            type: 'modify',
            path: 'image.png' as FilePath,
            oldId: OID_A,
            newId: OID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            broken: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
          oldContent,
          newContent,
        };

        // Act
        const sut = renderPatch([file]);

        // Assert — full byte-equality: dissimilarity line precedes binary block.
        expect(sut).toBe(
          [
            'diff --git a/image.png b/image.png',
            'dissimilarity index 100%',
            'index aaaaaaa..bbbbbbb 100644',
            'Binary files a/image.png and b/image.png differ',
            '',
          ].join('\n'),
        );
      });
    });
  });

  describe('Given a broken modify whose mode also changed', () => {
    describe('When renderPatch is called', () => {
      it('Then emits index line without mode suffix (differing-mode branch)', () => {
        // Arrange — oldMode ≠ newMode; index line omits the mode suffix
        const oldContent = utf8.encode('alpha\n');
        const newContent = utf8.encode('beta\n');
        const file: PatchFile = {
          change: {
            type: 'modify',
            path: 'script.sh' as FilePath,
            oldId: OID_A,
            newId: OID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.EXECUTABLE,
            broken: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
          oldContent,
          newContent,
        };

        // Act
        const sut = renderPatch([file]);

        // Assert — index line has no trailing mode when modes differ
        expect(sut).toContain('dissimilarity index 100%');
        // mode suffix absent: "index aaa..bbb" not "index aaa..bbb 100644"
        expect(sut).toContain('index aaaaaaa..bbbbbbb\n');
      });
    });
  });

  describe('Given a broken modify where only the new content is binary', () => {
    describe('When renderPatch is called', () => {
      it('Then emits Binary files differ (single binary side is sufficient)', () => {
        // Arrange — old side is text, new side contains NUL → isBinary(new) is true.
        // The || guard at line 510 fires on the binary side alone; && would miss it.
        const textOld = utf8.encode('plain text\n');
        const binaryNew = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
        const file: PatchFile = {
          change: {
            type: 'modify',
            path: 'image.png' as FilePath,
            oldId: OID_A,
            newId: OID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            broken: { score: MAX_SCORE, maxScore: MAX_SCORE },
          },
          oldContent: textOld,
          newContent: binaryNew,
        };

        // Act
        const sut = renderPatch([file]);

        // Assert — binary new side triggers the binary path even when old is text
        expect(sut).toContain('Binary files a/image.png and b/image.png differ');
        // No hunk markers should appear (binary path returns early)
        expect(sut).not.toContain('@@');
      });
    });
  });

  describe('Given a sub-100% rename change where only the new content is binary', () => {
    describe('When renderPatch is called', () => {
      it('Then emits Binary files differ (single binary side is sufficient)', () => {
        // Arrange — old side is text, new side contains NUL → isBinary(new) is true.
        // The || guard fires on the binary side alone; && would miss it (old is not binary).
        const textOld = utf8.encode('plain text file\n');
        const binaryNew = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
        const file: PatchFile = {
          change: {
            type: 'rename',
            oldPath: 'readme.txt' as FilePath,
            newPath: 'logo.png' as FilePath,
            oldId: OID_A,
            newId: OID_B,
            oldMode: FILE_MODE.REGULAR,
            newMode: FILE_MODE.REGULAR,
            similarity: { score: 0, maxScore: MAX_SCORE },
          },
          oldContent: textOld,
          newContent: binaryNew,
        };

        // Act
        const sut = renderPatch([file]);

        // Assert — binary new side triggers the binary path even when old is text
        expect(sut).toContain('Binary files a/readme.txt and b/logo.png differ');
        // No hunk markers should appear (binary path returns early)
        expect(sut).not.toContain('@@');
      });
    });
  });

  describe('Given a lineKey patch option', () => {
    describe('When renderPatch is called with mode:all on a file with a ws-only and a real change (#M1)', () => {
      it('Then renders the ws-only line as context with the post-image bytes and the real change as delete/insert', () => {
        // Arrange — ws-only line:  "  ws" → "    ws" (only whitespace change)
        // real line: "real" → "REAL" (content change)
        const file = modifyFile('f.txt', '  ws\nreal\n', '    ws\nREAL\n');

        // Act
        const sut = renderPatch([file], { lineKey: { mode: 'all', ignoreCrAtEol: false } });

        // Assert — the ws-only line is context (single-space prefix) carrying the
        // NEW-side bytes "    ws" (git emits context from the post-image);
        // the real line appears as a delete/insert pair.
        expect(sut).toBe(
          [
            'diff --git a/f.txt b/f.txt',
            'index aaaaaaa..bbbbbbb 100644',
            '--- a/f.txt',
            '+++ b/f.txt',
            '@@ -1,2 +1,2 @@',
            '     ws',
            '-real',
            '+REAL',
            '',
          ].join('\n'),
        );
      });
    });

    describe('When renderPatch is called with mode:all on a tab-vs-space ws-only context line', () => {
      it('Then the context line carries the post-image spaces, not the pre-image tabs', () => {
        // Arrange — old has two tabs, new has four spaces before "ws"; equal under
        // mode:all, so the line is context. The bytes disambiguate which side wins.
        const file = modifyFile('t.txt', '\t\tws\nreal\n', '    ws\nREAL\n');

        // Act
        const sut = renderPatch([file], { lineKey: { mode: 'all', ignoreCrAtEol: false } });

        // Assert — context line is the new-side "    ws" (4 spaces), never "\t\tws".
        expect(sut).toContain('\n     ws\n');
        expect(sut).not.toContain('\t\tws');
      });
    });

    describe('When computeHunks is called with 3 args (range-diff/patch-id compatibility)', () => {
      it('Then returns byte-identical hunks to the no-options call', () => {
        // Arrange — 3-arg call must compile unchanged and produce the same hunks
        const oldBytes = utf8.encode('line1\nline2\n');
        const newBytes = utf8.encode('line1\nchanged\n');

        // Act
        const sut = computeHunks(oldBytes, newBytes, 3);
        const result = computeHunks(oldBytes, newBytes, 3, {});

        // Assert — byte-identical results for both call forms
        expect(sut).toEqual(result);
      });
    });

    describe('When renderPatch is called with no options', () => {
      it('Then produces output byte-identical to the default (regression guard)', () => {
        // Arrange — a file with whitespace differences
        const file = modifyFile('reg.txt', 'old  \n', 'new  \n');

        // Act
        const sut = renderPatch([file]);
        const result = renderPatch([file], {});

        // Assert — both call forms are identical
        expect(sut).toBe(result);
      });
    });
  });

  describe('Given ignoreBlankLines', () => {
    describe('When renderPatch is called on a blank-only modify (#BL1)', () => {
      it('Then returns an empty document (no header, no hunk)', () => {
        // Arrange — the only change is inserting a blank line (empty after any key)
        const file = modifyFile('blank.txt', 'a\n', 'a\n\n');

        // Act
        const sut = renderPatch([file], { ignoreBlankLines: true });

        // Assert — #BL1: no diff --git header, empty document
        expect(sut).toBe('');
      });
    });

    describe('When renderPatch is called on a blank insert + real change (#BL2)', () => {
      it('Then keeps the real change hunk and drops only the blank group', () => {
        // Arrange — one blank line added AND a real line changed
        const file = modifyFile('mixed.txt', 'a\nb\n', 'a\n\nB\n');

        // Act
        const sut = renderPatch([file], { ignoreBlankLines: true });

        // Assert — #BL2: diff --git header present, real change hunk emitted
        expect(sut).toContain('diff --git');
        expect(sut).toContain('-b');
        expect(sut).toContain('+B');
      });
    });

    describe('When renderPatch is called on a blank-only modify with no options', () => {
      it('Then emits the full diff with the blank hunk (default unchanged)', () => {
        // Arrange — default (no ignoreBlankLines) must emit the blank-line hunk
        const file = modifyFile('blank.txt', 'a\n', 'a\n\n');

        // Act
        const sut = renderPatch([file]);

        // Assert — hunk is present (regression guard — ignoreBlankLines inactive)
        expect(sut).toContain('diff --git');
        expect(sut).toContain('@@');
      });
    });
  });
});
