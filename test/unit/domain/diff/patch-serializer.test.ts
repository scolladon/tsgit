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
});
