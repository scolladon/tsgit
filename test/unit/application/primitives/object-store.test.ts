import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import * as configReadMod from '../../../../src/application/primitives/config-read.js';
import {
  assertEverySourceLoadable,
  everySourceLoadable,
  getObjectStore,
  narrowObjectSourceAccess,
  objectSources,
  peekObjectStore,
} from '../../../../src/application/primitives/object-store.js';
import {
  disposePackRegistry,
  getPackRegistry,
} from '../../../../src/application/primitives/read-object.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { Context } from '../../../../src/ports/context.js';
import type { FileSystem } from '../../../../src/ports/file-system.js';
import type { AlternatePathProbe } from '../../../../src/ports/object-source-access.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const PRIMARY = '/repo/.git/objects';
const LIST = `${PRIMARY}/info/alternates`;

const contextWithAlternates = (text?: string): Context =>
  createMemoryContext({ files: text === undefined ? {} : { [LIST]: encode(text) } });

describe('getObjectStore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Given no alternates file', () => {
    describe('When getObjectStore', () => {
      it('Then the sources are the primary alone, read through ctx.fs, with one list read', async () => {
        // Arrange
        const ctx = contextWithAlternates();
        const read = vi.spyOn(ctx.fs, 'read');

        // Act
        const sut = getObjectStore;
        const result = await sut(ctx);

        // Assert
        expect(result.sources).toHaveLength(1);
        expect(result.primary).toBe(result.sources[0]);
        expect(result.primary.objectsDir).toBe(PRIMARY);
        expect(result.primary.local).toBe(true);
        expect(result.primary.fs).toBe(ctx.fs);
        expect(result.diagnostics).toEqual([]);
        expect(read.mock.calls.filter(([path]) => path === LIST)).toHaveLength(1);
      });
    });
  });

  describe('Given one alternate', () => {
    describe('When getObjectStore', () => {
      it('Then the alternate follows the primary and is not local', async () => {
        // Arrange
        const ctx = contextWithAlternates('/repo/alt/objects\n');
        await ctx.fs.mkdir('/repo/alt/objects');

        // Act
        const sut = getObjectStore;
        const result = await sut(ctx);

        // Assert
        expect(result.sources.map((s) => [s.objectsDir, s.local])).toEqual([
          [PRIMARY, true],
          ['/repo/alt/objects', false],
        ]);
        expect(result.sources[1]?.registry).toBeDefined();
      });
    });
  });

  describe('Given the same session', () => {
    describe('When getObjectStore is called twice', () => {
      it('Then the same instance is returned', async () => {
        // Arrange
        const ctx = contextWithAlternates();
        const first = await getObjectStore(ctx);

        // Act
        const sut = getObjectStore;
        const result = await sut(ctx);

        // Assert
        expect(result).toBe(first);
      });
    });
  });

  describe('Given a store not yet resolved', () => {
    describe('When peekObjectStore', () => {
      it('Then undefined before resolution and the instance after', async () => {
        // Arrange
        const ctx = contextWithAlternates();
        const before = peekObjectStore(ctx);

        // Act
        const store = await getObjectStore(ctx);
        const sut = peekObjectStore;
        const result = sut(ctx);

        // Assert
        expect(before).toBeUndefined();
        expect(result).toBe(store);
      });
    });
  });

  describe('Given a resolved store', () => {
    describe('When getPackRegistry', () => {
      it('Then it is the primary registry', async () => {
        // Arrange
        const ctx = contextWithAlternates();
        const store = await getObjectStore(ctx);

        // Act
        const result = await getPackRegistry(ctx);

        // Assert
        expect(result).toBe(store.primary.registry);
      });
    });
  });

  describe('Given a store with an alternate', () => {
    describe('When disposePackRegistry', () => {
      it('Then every registry is disposed', async () => {
        // Arrange
        const ctx = contextWithAlternates('/repo/alt/objects\n');
        await ctx.fs.mkdir('/repo/alt/objects');
        const store = await getObjectStore(ctx);
        const spies = store.sources.map((s) => vi.spyOn(s.registry, 'dispose'));

        // Act
        await disposePackRegistry(ctx);

        // Assert
        expect(spies).toHaveLength(2);
        for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given an alternate added after the first resolution', () => {
    describe('When refresh then getObjectStore', () => {
      it('Then it is appended and the first alternate registry survives', async () => {
        // Arrange
        const ctx = contextWithAlternates('/repo/a/objects\n');
        await ctx.fs.mkdir('/repo/a/objects');
        await ctx.fs.mkdir('/repo/b/objects');
        const sut = getObjectStore;
        const store = await sut(ctx);
        const firstRegistry = store.sources[1]?.registry;
        await ctx.fs.writeUtf8(LIST, '/repo/a/objects\n/repo/b/objects\n');

        // Act
        store.refresh();
        const result = await sut(ctx);

        // Assert
        expect(result.sources.map((s) => s.objectsDir)).toEqual([
          PRIMARY,
          '/repo/a/objects',
          '/repo/b/objects',
        ]);
        expect(result.sources[1]?.registry).toBe(firstRegistry);
      });
    });
  });

  describe('Given an alternate removed after the first resolution', () => {
    describe('When refresh then getObjectStore', () => {
      it('Then the source stays', async () => {
        // Arrange
        const ctx = contextWithAlternates('/repo/a/objects\n');
        await ctx.fs.mkdir('/repo/a/objects');
        const sut = getObjectStore;
        const store = await sut(ctx);
        await ctx.fs.writeUtf8(LIST, '');

        // Act
        store.refresh();
        const result = await sut(ctx);

        // Assert
        expect(result.sources.map((s) => s.objectsDir)).toEqual([PRIMARY, '/repo/a/objects']);
      });
    });
  });

  describe('Given a refresh and no list change', () => {
    describe('When getObjectStore twice', () => {
      it('Then the list is resolved once per refresh', async () => {
        // Arrange
        const ctx = contextWithAlternates();
        const sut = getObjectStore;
        const store = await sut(ctx);
        const read = vi.spyOn(ctx.fs, 'read');

        // Act
        store.refresh();
        await sut(ctx);
        await sut(ctx);

        // Assert
        expect(read.mock.calls.filter(([path]) => path === LIST)).toHaveLength(1);
      });
    });
  });

  describe('Given a refreshed store pending re-resolution', () => {
    describe('When peekObjectStore', () => {
      it('Then it declines so the caller re-resolves', async () => {
        // Arrange
        const ctx = contextWithAlternates();
        const store = await getObjectStore(ctx);
        store.refresh();

        // Act
        const sut = peekObjectStore;
        const result = sut(ctx);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given no core.bigFileThreshold', () => {
    describe('When getObjectStore', () => {
      it('Then the threshold is git default of 512 MiB', async () => {
        // Arrange
        const ctx = contextWithAlternates();

        // Act
        const sut = getObjectStore;
        const result = await sut(ctx);

        // Assert
        expect(result.bigFileThreshold).toBe(512 * 1024 * 1024);
      });
    });
  });

  describe('Given core.bigFileThreshold configured', () => {
    describe('When getObjectStore', () => {
      it('Then the configured value is held', async () => {
        // Arrange
        const ctx = createMemoryContext({
          files: { '/repo/.git/config': encode('[core]\n\tbigFileThreshold = 1k\n') },
        });

        // Act
        const sut = getObjectStore;
        const result = await sut(ctx);

        // Assert
        expect(result.bigFileThreshold).toBe(1024);
      });
    });
  });

  describe('Given a resolved store', () => {
    describe('When refresh then getObjectStore', () => {
      it('Then the threshold is not read again', async () => {
        // Arrange
        const ctx = contextWithAlternates();
        const sut = getObjectStore;
        const store = await sut(ctx);
        const readConfig = vi.spyOn(configReadMod, 'readConfig');

        // Act
        store.refresh();
        await sut(ctx);

        // Assert
        expect(readConfig).not.toHaveBeenCalled();
      });
    });
  });
});

const MEMBERS = [
  'exists',
  'lstat',
  'openWithNoFollow',
  'read',
  'readSlice',
  'readUtf8',
  'readdir',
  'readlink',
  'stat',
  'utimeNow',
];

const denial = async (run: () => Promise<unknown>): Promise<TsgitError['data']> => {
  try {
    await run();
  } catch (error) {
    return (error as TsgitError).data;
  }
  throw new Error('expected a refusal');
};

describe('objectSources', () => {
  describe('Given a primary and an unusable alternate', () => {
    describe('When objectSources', () => {
      it('Then the view lists directories and locality, plus the unusable entries', async () => {
        // Arrange
        const ctx = contextWithAlternates('/repo/alt/objects\n/repo/missing/objects\n');
        await ctx.fs.mkdir('/repo/alt/objects');
        const store = await getObjectStore(ctx);

        // Act
        const sut = objectSources;
        const result = await sut(ctx);

        // Assert
        expect(result.sources).toEqual([
          { objectsDir: PRIMARY, local: true },
          { objectsDir: '/repo/alt/objects', local: false },
        ]);
        expect(result.unusable).toBe(store.diagnostics);
        expect(result.unusable).toHaveLength(1);
      });
    });
  });
});

describe('narrowObjectSourceAccess', () => {
  describe('Given a filesystem with utimeNow', () => {
    describe('When narrowObjectSourceAccess', () => {
      it('Then exactly the access members are carried', () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const sut = narrowObjectSourceAccess;
        const result = sut(ctx.fs, PRIMARY);

        // Assert
        expect(Object.keys(result).sort()).toEqual(MEMBERS);
      });
    });
  });

  describe('Given a filesystem without utimeNow', () => {
    describe('When narrowObjectSourceAccess', () => {
      it('Then utimeNow is absent', () => {
        // Arrange
        const { utimeNow: _omitted, ...rest } = createMemoryContext().fs;
        const fs = rest as FileSystem;

        // Act
        const sut = narrowObjectSourceAccess;
        const result = sut(fs, PRIMARY);

        // Assert
        expect(Object.keys(result).sort()).toEqual(MEMBERS.filter((m) => m !== 'utimeNow'));
      });
    });
  });

  describe('Given a write-mode open', () => {
    describe('When openWithNoFollow', () => {
      it('Then PERMISSION_DENIED with the path and the inner open untouched', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const inner = vi.spyOn(ctx.fs, 'openWithNoFollow');
        const sut = narrowObjectSourceAccess;
        const result = sut(ctx.fs, PRIMARY);

        // Act
        const data = await denial(() => result.openWithNoFollow(`${PRIMARY}/x`, 'write'));

        // Assert
        expect(data).toEqual({ code: 'PERMISSION_DENIED', path: `${PRIMARY}/x` });
        expect(inner).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a read-mode open', () => {
    describe('When openWithNoFollow', () => {
      it('Then the inner filesystem serves it', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${PRIMARY}/x`, 'a');
        const sut = narrowObjectSourceAccess;
        const result = sut(ctx.fs, PRIMARY);

        // Act
        const handle = await result.openWithNoFollow(`${PRIMARY}/x`, 'read');

        // Assert
        expect(handle).toBeDefined();
        await handle.close();
      });
    });
  });

  describe('Given a utimeNow path with a dot-dot segment under the directory', () => {
    describe('When utimeNow', () => {
      it('Then PERMISSION_DENIED and the inner call untouched', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const inner = vi.spyOn(ctx.fs, 'utimeNow');
        const sut = narrowObjectSourceAccess;
        const result = sut(ctx.fs, PRIMARY);

        // Act
        const data = await denial(() => result.utimeNow?.(`${PRIMARY}/../x`) as Promise<void>);

        // Assert
        expect(data).toEqual({ code: 'PERMISSION_DENIED', path: `${PRIMARY}/../x` });
        expect(inner).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a utimeNow path outside the directory', () => {
    describe('When utimeNow', () => {
      it('Then PERMISSION_DENIED and the inner call untouched', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const inner = vi.spyOn(ctx.fs, 'utimeNow');
        const sut = narrowObjectSourceAccess;
        const result = sut(ctx.fs, PRIMARY);

        // Act
        const data = await denial(
          () => result.utimeNow?.('/repo/.git/objects-other/x') as Promise<void>,
        );

        // Assert
        expect(data).toEqual({ code: 'PERMISSION_DENIED', path: '/repo/.git/objects-other/x' });
        expect(inner).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a utimeNow path inside the directory', () => {
    describe('When utimeNow', () => {
      it('Then the inner filesystem serves it', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${PRIMARY}/x`, 'a');
        const inner = vi.spyOn(ctx.fs, 'utimeNow');
        const sut = narrowObjectSourceAccess;
        const result = sut(ctx.fs, PRIMARY);

        // Act
        await result.utimeNow?.(`${PRIMARY}/x`);

        // Assert
        expect(inner).toHaveBeenCalledWith(`${PRIMARY}/x`);
      });
    });
  });
});

const ALTERNATE = '/repo/alt/objects';
const FLIPPED_SIGNATURE_MIDX = Uint8Array.from([
  0x00,
  0x49,
  0x44,
  0x58,
  1,
  1,
  1,
  0,
  ...new Array(8).fill(0),
]);

const contextWithCorruptAlternate = async (): Promise<Context> => {
  const ctx = contextWithAlternates(`${ALTERNATE}\n`);
  await ctx.fs.mkdir(ALTERNATE);
  await ctx.fs.write(`${ALTERNATE}/pack/multi-pack-index`, FLIPPED_SIGNATURE_MIDX);
  return ctx;
};

const requireAlternate = (store: Awaited<ReturnType<typeof getObjectStore>>) => {
  const alternate = store.sources[1];
  if (alternate === undefined) throw new Error('expected an alternate source');
  return alternate;
};

const rejectionData = async (attempt: Promise<unknown>): Promise<unknown> => {
  try {
    await attempt;
  } catch (error) {
    return (error as TsgitError).data;
  }
  return undefined;
};

describe('assertEverySourceLoadable', () => {
  describe('Given a primary and an corrupt alternate', () => {
    describe('When asserting every source', () => {
      it('Then it rejects with the alternate error after the primary was checked', async () => {
        // Arrange
        const ctx = await contextWithCorruptAlternate();
        const store = await getObjectStore(ctx);
        const calls: string[] = [];
        const primary = store.primary.registry.assertLoadable.bind(store.primary.registry);
        vi.spyOn(store.primary.registry, 'assertLoadable').mockImplementation(async () => {
          calls.push('primary');
          await primary();
        });

        // Act
        const sut = assertEverySourceLoadable;
        const data = await rejectionData(sut(ctx));

        // Assert
        expect(data).toMatchObject({ code: 'INVALID_MULTI_PACK_INDEX' });
        expect(calls).toEqual(['primary']);
      });
    });
  });

  describe('Given an corrupt primary and an alternate', () => {
    describe('When asserting every source', () => {
      it('Then the primary rejection wins and the alternate is never asked', async () => {
        // Arrange
        const ctx = await contextWithCorruptAlternate();
        const store = await getObjectStore(ctx);
        const primaryError = new Error('primary first');
        vi.spyOn(store.primary.registry, 'assertLoadable').mockRejectedValue(primaryError);
        const alternate = vi.spyOn(requireAlternate(store).registry, 'assertLoadable');

        // Act
        const sut = assertEverySourceLoadable;
        const attempt = sut(ctx);

        // Assert
        await expect(attempt).rejects.toBe(primaryError);
        expect(alternate).not.toHaveBeenCalled();
      });
    });
  });
});

describe('everySourceLoadable', () => {
  describe('Given an corrupt alternate', () => {
    describe('When asking', () => {
      it('Then it resolves false', async () => {
        // Arrange
        const ctx = await contextWithCorruptAlternate();

        // Act
        const sut = everySourceLoadable;
        const result = await sut(ctx);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given every source loads', () => {
    describe('When asking', () => {
      it('Then it resolves true', async () => {
        // Arrange
        const ctx = contextWithAlternates(`${ALTERNATE}\n`);
        await ctx.fs.mkdir(ALTERNATE);

        // Act
        const sut = everySourceLoadable;
        const result = await sut(ctx);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a source whose gate rejects with a non-tsgit error', () => {
    describe('When asking', () => {
      it('Then the error propagates', async () => {
        // Arrange
        const ctx = contextWithAlternates();
        const store = await getObjectStore(ctx);
        const boom = new Error('boom');
        vi.spyOn(store.primary.registry, 'assertLoadable').mockRejectedValue(boom);

        // Act
        const sut = everySourceLoadable;
        const attempt = sut(ctx);

        // Assert
        await expect(attempt).rejects.toBe(boom);
      });
    });
  });
});

describe('getObjectStore on a Windows filesystem', () => {
  describe('Given a context whose filesystem reads paths the Windows way', () => {
    describe('When getObjectStore', () => {
      it('Then a drive-letter alternate is absolute and resolved in forward-slash form', async () => {
        // Arrange
        const base = contextWithAlternates('D:\\donor\\objects\n');
        const directory = await base.fs.stat(PRIMARY);
        const probe: AlternatePathProbe = {
          lstat: async () => directory,
          stat: async () => directory,
          readlink: async (path) => path,
        };
        const ctx: Context = {
          ...base,
          windowsPathSyntax: true,
          alternatePathProbe: () => probe,
          objectSourceAccess: () => narrowObjectSourceAccess(base.fs, PRIMARY),
        };

        // Act
        const sut = getObjectStore;
        const result = await sut(ctx);

        // Assert
        expect(result.sources.map((s) => s.objectsDir)).toEqual([PRIMARY, 'D:/donor/objects']);
      });
    });
  });
});
