/// <reference lib="dom" />
import { describe, expect, it } from 'vitest';
import { BrowserFileSystem } from '../../../../src/adapters/browser/browser-file-system.js';
import { TsgitError } from '../../../../src/domain/index.js';

describe('BrowserFileSystem', () => {
  describe('Given a browser file system', () => {
    describe('When checking for the atomicRename capability', () => {
      it('Then the adapter does not expose atomicRename (structurally absent, not merely undefined)', () => {
        // Arrange
        const sut = new BrowserFileSystem({} as unknown as FileSystemDirectoryHandle);

        // Act
        const result = 'atomicRename' in sut;

        // Assert — OPFS has no atomic rename; the member must be omitted
        // entirely rather than present as a throwing stub, so callers can
        // branch on its absence before attempting the operation.
        expect(result).toBe(false);
      });
    });
  });
});

describe('BrowserFileSystem rejection classification', () => {
  // A root handle whose file lookup rejects with the given value; a root-level leaf never
  // walks a parent, so this is the only OPFS call the write reaches.
  const rootRejectingWith = (rejection: unknown): FileSystemDirectoryHandle =>
    ({
      getFileHandle: async () => {
        throw rejection;
      },
    }) as unknown as FileSystemDirectoryHandle;

  describe('Given a root handle whose file lookup rejects with a plain object named TypeMismatchError', () => {
    describe('When writing a root-level file', () => {
      it('Then throws PERMISSION_DENIED — the name is read structurally, not through instanceof', async () => {
        // Arrange
        const sut = new BrowserFileSystem(rootRejectingWith({ name: 'TypeMismatchError' }));

        // Act
        let caught: unknown;
        try {
          await sut.write('occupied', new Uint8Array([1]));
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('PERMISSION_DENIED');
        if (data.code === 'PERMISSION_DENIED') expect(data.path).toBe('occupied');
      });
    });
  });

  describe('Given a root handle whose file lookup rejects with a bare string', () => {
    describe('When writing a root-level file', () => {
      it('Then throws FILE_NOT_FOUND — a rejection without a name is not a directory occupant', async () => {
        // Arrange
        const sut = new BrowserFileSystem(rootRejectingWith('TypeMismatchError'));

        // Act
        let caught: unknown;
        try {
          await sut.write('occupied', new Uint8Array([1]));
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('FILE_NOT_FOUND');
      });
    });
  });

  describe('Given a root handle whose file lookup rejects with an object whose name is not a string', () => {
    describe('When writing a root-level file', () => {
      it('Then throws FILE_NOT_FOUND', async () => {
        // Arrange
        const sut = new BrowserFileSystem(rootRejectingWith({ name: 42 }));

        // Act
        let caught: unknown;
        try {
          await sut.write('occupied', new Uint8Array([1]));
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('FILE_NOT_FOUND');
      });
    });
  });
});
