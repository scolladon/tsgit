/// <reference lib="dom" />
import { describe, expect, it, vi } from 'vitest';
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

  describe('Given a root handle whose file lookup rejects with null', () => {
    describe('When writing a root-level file', () => {
      it('Then throws FILE_NOT_FOUND — a null rejection carries no name to classify', async () => {
        // Arrange
        const sut = new BrowserFileSystem(rootRejectingWith(null));

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

describe('BrowserFileSystem readdir rejection classification', () => {
  // A root handle whose directory lookup rejects with the given value; a root-level path never
  // walks a parent, so this is the only OPFS call the listing reaches.
  const rootWhoseDirectoryLookupRejectsWith = (rejection: unknown): FileSystemDirectoryHandle =>
    ({
      getDirectoryHandle: async () => {
        throw rejection;
      },
    }) as unknown as FileSystemDirectoryHandle;

  describe('Given a root handle whose directory lookup rejects with TypeMismatchError, as OPFS does for a file entry', () => {
    describe('When listing that root-level entry', () => {
      it('Then throws NOT_A_DIRECTORY carrying the requested path', async () => {
        // Arrange
        const sut = new BrowserFileSystem(
          rootWhoseDirectoryLookupRejectsWith({ name: 'TypeMismatchError' }),
        );

        // Act
        let caught: unknown;
        try {
          await sut.readdir('regular-file');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('NOT_A_DIRECTORY');
        if (data.code === 'NOT_A_DIRECTORY') expect(data.path).toBe('regular-file');
      });
    });
  });

  describe('Given a root handle whose directory lookup rejects with NotFoundError', () => {
    describe('When listing that root-level entry', () => {
      it('Then throws FILE_NOT_FOUND carrying the requested path', async () => {
        // Arrange
        const sut = new BrowserFileSystem(
          rootWhoseDirectoryLookupRejectsWith({ name: 'NotFoundError' }),
        );

        // Act
        let caught: unknown;
        try {
          await sut.readdir('missing-entry');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('FILE_NOT_FOUND');
        if (data.code === 'FILE_NOT_FOUND') expect(data.path).toBe('missing-entry');
      });
    });
  });
});

const rejectionNamed = (name: string): { readonly name: string } => ({ name });

// A file handle holding one byte, enough for a read to succeed.
const fileHandle = { getFile: async () => new Blob([new Uint8Array([1])]) };

// A directory handle whose child lookups answer from `children`, as OPFS does whatever `create`
// asks: a `'file'` child resolves a file lookup and rejects a directory lookup with
// TypeMismatchError, a directory child the reverse, and a missing child rejects both with
// NotFoundError.
const directory = (
  children: Readonly<Record<string, 'file' | FileSystemDirectoryHandle>>,
): FileSystemDirectoryHandle => {
  const lookup = (name: string, kind: 'file' | 'directory'): Promise<unknown> => {
    const child = children[name];
    if (child === undefined) return Promise.reject(rejectionNamed('NotFoundError'));
    const isFile = child === 'file';
    if (isFile !== (kind === 'file')) return Promise.reject(rejectionNamed('TypeMismatchError'));
    return Promise.resolve(isFile ? fileHandle : child);
  };
  return {
    getFileHandle: vi.fn((name: string) => lookup(name, 'file')),
    getDirectoryHandle: vi.fn((name: string) => lookup(name, 'directory')),
  } as unknown as FileSystemDirectoryHandle;
};

describe('BrowserFileSystem beneath a regular file', () => {
  const beneath = 'file.txt/x';

  describe.each([
    { name: 'read', invoke: (sut: BrowserFileSystem) => sut.read(beneath) },
    { name: 'readSlice', invoke: (sut: BrowserFileSystem) => sut.readSlice(beneath, 0, 1) },
    { name: 'readUtf8', invoke: (sut: BrowserFileSystem) => sut.readUtf8(beneath) },
    { name: 'write', invoke: (sut: BrowserFileSystem) => sut.write(beneath, new Uint8Array([1])) },
    {
      name: 'writeStream',
      invoke: (sut: BrowserFileSystem) =>
        sut.writeStream(
          beneath,
          (async function* () {
            yield new Uint8Array([1]);
          })(),
        ),
    },
    {
      name: 'writeExclusive',
      invoke: (sut: BrowserFileSystem) => sut.writeExclusive(beneath, new Uint8Array([1])),
    },
    { name: 'writeUtf8', invoke: (sut: BrowserFileSystem) => sut.writeUtf8(beneath, 'x') },
    { name: 'appendUtf8', invoke: (sut: BrowserFileSystem) => sut.appendUtf8(beneath, 'x') },
    { name: 'exists', invoke: (sut: BrowserFileSystem) => sut.exists(beneath) },
    { name: 'stat', invoke: (sut: BrowserFileSystem) => sut.stat(beneath) },
    { name: 'lstat', invoke: (sut: BrowserFileSystem) => sut.lstat(beneath) },
    { name: 'lexists', invoke: (sut: BrowserFileSystem) => sut.lexists(beneath) },
    { name: 'readdir', invoke: (sut: BrowserFileSystem) => sut.readdir(beneath) },
    { name: 'mkdir', invoke: (sut: BrowserFileSystem) => sut.mkdir(beneath) },
    { name: 'rm', invoke: (sut: BrowserFileSystem) => sut.rm(beneath) },
    { name: 'rename source', invoke: (sut: BrowserFileSystem) => sut.rename(beneath, 'moved.txt') },
    {
      name: 'rename destination',
      invoke: (sut: BrowserFileSystem) => sut.rename('file.txt', beneath),
    },
    { name: 'chmod', invoke: (sut: BrowserFileSystem) => sut.chmod(beneath, 0o644) },
    { name: 'rmRecursive', invoke: (sut: BrowserFileSystem) => sut.rmRecursive(beneath) },
  ])(
    'Given a regular file standing where a directory is needed, When $name addresses a path beneath it',
    ({ invoke }) => {
      it('Then it throws NOT_A_DIRECTORY carrying the requested path', async () => {
        // Arrange
        const sut = new BrowserFileSystem(directory({ 'file.txt': 'file' }));

        // Act
        let caught: unknown;
        try {
          await invoke(sut);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('NOT_A_DIRECTORY');
        if (data.code === 'NOT_A_DIRECTORY') expect(data.path).toBe(beneath);
      });
    },
  );

  describe('Given a directory lookup that rejects with anything but TypeMismatchError, When read addresses a path beneath it', () => {
    it('Then it still throws FILE_NOT_FOUND', async () => {
      // Arrange
      const sut = new BrowserFileSystem(directory({}));

      // Act
      let caught: unknown;
      try {
        await sut.read('gone/x');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('FILE_NOT_FOUND');
    });
  });
});

describe('BrowserFileSystem lexists', () => {
  describe.each([
    { label: 'a file', path: 'sub/file.txt', expected: true },
    { label: 'a directory', path: 'sub/nested', expected: true },
    { label: 'a missing entry in an existing directory', path: 'sub/missing.txt', expected: false },
    { label: 'an entry beneath a missing directory', path: 'gone/file.txt', expected: false },
    { label: 'the root', path: '/', expected: true },
  ])('Given $label', ({ path, expected }) => {
    describe('When lexists probes it', () => {
      it(`Then it reports ${expected}`, async () => {
        // Arrange
        const root = directory({ sub: directory({ 'file.txt': 'file', nested: directory({}) }) });
        const sut = new BrowserFileSystem(root);

        // Act
        const result = await sut.lexists(path);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a missing entry in an existing directory', () => {
    describe('When lexists probes it', () => {
      it('Then it looks the leaf up once, as a file, and never again as a directory', async () => {
        // Arrange
        const sub = directory({});
        const sut = new BrowserFileSystem(directory({ sub }));

        // Act
        await sut.lexists('sub/missing.txt');

        // Assert
        expect(sub.getFileHandle).toHaveBeenCalledTimes(1);
        expect(sub.getDirectoryHandle).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a path with a parent-directory segment', () => {
    describe('When lexists probes it', () => {
      it('Then it throws PERMISSION_DENIED carrying the path', async () => {
        // Arrange
        const sut = new BrowserFileSystem(directory({}));

        // Act
        let caught: unknown;
        try {
          await sut.lexists('sub/../escape');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('PERMISSION_DENIED');
        if (data.code === 'PERMISSION_DENIED') expect(data.path).toBe('sub/../escape');
      });
    });
  });
});
