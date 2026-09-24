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
    { name: 'tryLstat', invoke: (sut: BrowserFileSystem) => sut.tryLstat(beneath) },
    { name: 'tryReadUtf8', invoke: (sut: BrowserFileSystem) => sut.tryReadUtf8(beneath) },
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

describe('BrowserFileSystem mkdir', () => {
  describe('Given a regular file holding the path itself, When mkdir creates it', () => {
    it('Then it throws FILE_EXISTS carrying the requested path, as the node adapter does', async () => {
      // Arrange
      const sut = new BrowserFileSystem(directory({ 'file.txt': 'file' }));

      // Act
      let caught: unknown;
      try {
        await sut.mkdir('file.txt');
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('FILE_EXISTS');
      if (data.code === 'FILE_EXISTS') expect(data.path).toBe('file.txt');
    });
  });

  // A root handle whose every directory lookup rejects with the given value.
  const rootWhoseDirectoryCreationRejectsWith = (rejection: unknown): FileSystemDirectoryHandle =>
    ({
      getDirectoryHandle: async () => {
        throw rejection;
      },
    }) as unknown as FileSystemDirectoryHandle;

  describe.each([
    { name: 'NotAllowedError', rejection: rejectionNamed('NotAllowedError') },
    { name: 'InvalidModificationError', rejection: rejectionNamed('InvalidModificationError') },
    { name: 'QuotaExceededError', rejection: rejectionNamed('QuotaExceededError') },
    { name: 'TypeError', rejection: new TypeError('name is not allowed') },
  ])('Given OPFS rejects a directory creation with $name', ({ rejection }) => {
    describe.each([
      { segment: 'the leaf', path: 'entry' },
      { segment: 'a parent', path: 'parent/entry' },
    ])('When mkdir creates $segment', ({ path }) => {
      it('Then it throws FILE_NOT_FOUND carrying the path, as every other walk maps it', async () => {
        // Arrange
        const sut = new BrowserFileSystem(rootWhoseDirectoryCreationRejectsWith(rejection));

        // Act
        let caught: unknown;
        try {
          await sut.mkdir(path);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('FILE_NOT_FOUND');
        if (data.code === 'FILE_NOT_FOUND') expect(data.path).toBe(path);
      });
    });
  });
});

describe('BrowserFileSystem rename onto itself', () => {
  describe('Given a file, When renamed onto its own path', () => {
    it('Then it resolves as a no-op without removing the entry', async () => {
      // Arrange
      const root = directory({ 'same.txt': 'file' });
      const sut = new BrowserFileSystem(root);

      // Act
      await sut.rename('same.txt', 'same.txt');
      const result = await sut.exists('same.txt');

      // Assert
      expect(result).toBe(true);
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

describe('BrowserFileSystem tryLstat / tryReadUtf8 — non-throwing probes', () => {
  describe('Given a path with no entry', () => {
    describe('When tryLstat is called', () => {
      it("Then it resolves undefined, matching lstat's FILE_NOT_FOUND", async () => {
        // Arrange
        const sut = new BrowserFileSystem(directory({}));

        // Act
        const result = await sut.tryLstat('missing.bin');

        // Assert
        expect(result).toBeUndefined();
      });
    });

    describe('When tryReadUtf8 is called', () => {
      it("Then it resolves undefined, matching readUtf8's FILE_NOT_FOUND", async () => {
        // Arrange
        const sut = new BrowserFileSystem(directory({}));

        // Act
        const result = await sut.tryReadUtf8('missing.txt');

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a present regular file', () => {
    const presentFileHandle = (content: string): FileSystemFileHandle =>
      ({
        getFile: async () => new File([content], 'probe', { lastModified: 1_700_000_000_000 }),
      }) as unknown as FileSystemFileHandle;

    describe('When tryLstat is called', () => {
      it('Then it equals lstat', async () => {
        // Arrange
        const root = {
          getFileHandle: async () => presentFileHandle('x'),
        } as unknown as FileSystemDirectoryHandle;
        const sut = new BrowserFileSystem(root);

        // Act
        const [result, expected] = await Promise.all([
          sut.tryLstat('present.bin'),
          sut.lstat('present.bin'),
        ]);

        // Assert
        expect(result).toEqual(expected);
      });
    });

    describe('When tryReadUtf8 is called', () => {
      it('Then it equals readUtf8', async () => {
        // Arrange
        const root = {
          getFileHandle: async () => presentFileHandle('hello'),
        } as unknown as FileSystemDirectoryHandle;
        const sut = new BrowserFileSystem(root);

        // Act
        const [result, expected] = await Promise.all([
          sut.tryReadUtf8('present.txt'),
          sut.readUtf8('present.txt'),
        ]);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a directory', () => {
    describe('When tryLstat is called', () => {
      it('Then it equals lstat', async () => {
        // Arrange
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        const root = directory({ dir: directory({}) });
        const sut = new BrowserFileSystem(root);

        // Act
        let result: Awaited<ReturnType<BrowserFileSystem['tryLstat']>>;
        let expected: Awaited<ReturnType<BrowserFileSystem['lstat']>>;
        try {
          result = await sut.tryLstat('dir');
          expected = await sut.lstat('dir');
        } finally {
          nowSpy.mockRestore();
        }

        // Assert
        expect(result).toEqual(expected);
      });
    });

    describe('When tryReadUtf8 is called', () => {
      it('Then it resolves undefined — readUtf8 refuses FILE_NOT_FOUND on a directory on this adapter', async () => {
        // Arrange
        const root = directory({ dir: directory({}) });
        const sut = new BrowserFileSystem(root);

        // Act
        const result = await sut.tryReadUtf8('dir');

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});

describe('BrowserFileSystem directory-handle cache', () => {
  describe('Given a file resolved under one cached parent directory, When reading it twice', () => {
    it('Then a second read under the same parent walks zero directory handles', async () => {
      // Arrange
      const sub = directory({ 'file.txt': 'file' });
      const root = directory({ sub });
      const sut = new BrowserFileSystem(root);

      // Act
      await sut.read('sub/file.txt');
      await sut.read('sub/file.txt');

      // Assert
      expect(root.getDirectoryHandle).toHaveBeenCalledTimes(1);
    });
  });

  describe('Given a file resolved two directory levels deep, When reading it twice', () => {
    it('Then a second read under the same parent walks zero directory handles at either level', async () => {
      // Arrange
      const nested = directory({ 'file.txt': 'file' });
      const sub = directory({ nested });
      const root = directory({ sub });
      const sut = new BrowserFileSystem(root);

      // Act
      await sut.read('sub/nested/file.txt');
      await sut.read('sub/nested/file.txt');

      // Assert
      expect(root.getDirectoryHandle).toHaveBeenCalledTimes(1);
      expect(sub.getDirectoryHandle).toHaveBeenCalledTimes(1);
    });
  });

  const withRemoveEntry = (
    handle: FileSystemDirectoryHandle,
  ): FileSystemDirectoryHandle & { removeEntry: ReturnType<typeof vi.fn> } => {
    const removable = handle as FileSystemDirectoryHandle & {
      removeEntry: ReturnType<typeof vi.fn>;
    };
    removable.removeEntry = vi.fn(async () => {});
    return removable;
  };

  describe('Given a cached parent directory removed by rm, When reading under it again', () => {
    it('Then the next read under it walks the directory handle again', async () => {
      // Arrange
      const sub = directory({ 'file.txt': 'file' });
      const root = withRemoveEntry(directory({ sub }));
      const sut = new BrowserFileSystem(root);
      await sut.read('sub/file.txt');

      // Act
      await sut.rm('sub');
      await sut.read('sub/file.txt');

      // Assert
      expect(root.getDirectoryHandle).toHaveBeenCalledTimes(2);
    });
  });

  describe('Given a cached parent directory nested under an ancestor removed by rm, When reading under the nested parent again', () => {
    it('Then the next read under the nested parent walks every directory handle again', async () => {
      // Arrange
      const nested = directory({ 'file.txt': 'file' });
      const sub = directory({ nested });
      const root = withRemoveEntry(directory({ sub }));
      const sut = new BrowserFileSystem(root);
      await sut.read('sub/nested/file.txt');

      // Act
      await sut.rm('sub');
      await sut.read('sub/nested/file.txt');

      // Assert
      expect(root.getDirectoryHandle).toHaveBeenCalledTimes(2);
      expect(sub.getDirectoryHandle).toHaveBeenCalledTimes(2);
    });
  });

  describe('Given a cached parent directory nested under an ancestor removed by rmRecursive, When reading under the nested parent again', () => {
    it('Then the next read under the nested parent walks every directory handle again', async () => {
      // Arrange
      const nested = directory({ 'file.txt': 'file' });
      const sub = directory({ nested });
      const root = withRemoveEntry(directory({ sub }));
      const sut = new BrowserFileSystem(root);
      await sut.read('sub/nested/file.txt');

      // Act
      await sut.rmRecursive('sub');
      await sut.read('sub/nested/file.txt');

      // Assert
      expect(root.getDirectoryHandle).toHaveBeenCalledTimes(2);
      expect(sub.getDirectoryHandle).toHaveBeenCalledTimes(2);
    });
  });

  describe('Given a rename of a file inside a cached parent directory, When reading the renamed-from path again', () => {
    it('Then the sibling parent cache is left intact — invalidation is scoped, not a blanket clear', async () => {
      // Arrange
      const sub = directory({ 'a.txt': 'file', 'b.txt': 'file' });
      const root = withRemoveEntry(directory({ sub }));
      const permissiveSub = sub as FileSystemDirectoryHandle & {
        getFileHandle: ReturnType<typeof vi.fn>;
        removeEntry: ReturnType<typeof vi.fn>;
      };
      const writableFile = {
        getFile: async () => new Blob([new Uint8Array([1])]),
        createWritable: async () => ({ write: async () => {}, close: async () => {} }),
      } as unknown as FileSystemFileHandle;
      permissiveSub.getFileHandle = vi.fn(async () => writableFile);
      permissiveSub.removeEntry = vi.fn(async () => {});
      const sut = new BrowserFileSystem(root);
      await sut.read('sub/a.txt');

      // Act
      await sut.rename('sub/a.txt', 'sub/b.txt');
      await sut.read('sub/a.txt');

      // Assert — 'sub' itself was never a rename target, so its cache entry
      // survives: the walk to it happens exactly once, not once per read.
      expect(root.getDirectoryHandle).toHaveBeenCalledTimes(1);
    });
  });

  const CACHED_PARENT_COUNT = 600;

  describe('Given more distinct parent directories cached than the handle-cache LRU holds', () => {
    describe('When every one of them has been read at least once', () => {
      it("Then the tracked key set never outgrows the LRU's own resident entries", async () => {
        // Arrange — one empty subdirectory per distinct parent, so each read
        // caches its own parent key without ever hitting another one's.
        const children: Record<string, FileSystemDirectoryHandle> = {};
        for (let index = 0; index < CACHED_PARENT_COUNT; index += 1) {
          children[`d${index}`] = directory({});
        }
        const root = directory(children);
        const sut = new BrowserFileSystem(root);

        // Act
        for (let index = 0; index < CACHED_PARENT_COUNT; index += 1) {
          await sut.exists(`d${index}/file.txt`);
        }

        // Assert — `createLruCache` exposes no key enumeration, so reaching
        // through the private fields is the only seam available; the tracked
        // Set must never sit above the LRU's own live entry count, which is
        // itself capped well below the 600 distinct parents cached above.
        const internals = sut as unknown as {
          readonly directoryHandleCacheKeys: ReadonlySet<string>;
          readonly directoryHandleCache: { readonly entryCount: number };
        };
        expect(internals.directoryHandleCacheKeys.size).toBe(
          internals.directoryHandleCache.entryCount,
        );
        expect(internals.directoryHandleCacheKeys.size).toBeLessThan(CACHED_PARENT_COUNT);
      });
    });
  });
});
