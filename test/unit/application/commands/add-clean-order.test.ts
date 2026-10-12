import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import type { Context } from '../../../../src/ports/context.js';
import { seedRepo } from './fixtures.js';

const LOG_DRIVER = '[filter "log"]\n\tclean = log\n';
const SETTLE_MS = 20;

const dec = (bytes: Uint8Array | undefined): string =>
  new TextDecoder().decode(bytes ?? new Uint8Array());

interface Recorded {
  readonly ctx: Context;
  readonly cleaned: string[];
}

/** A repo whose `log` clean driver records the content of each file it hears, in call order. */
const repoUnderLogDriver = async (
  workingTree: Readonly<Record<string, string>>,
  attributes: string,
): Promise<Recorded> => {
  const base = createMemoryContext();
  await seedRepo(base, { workingTree });
  await base.fs.writeUtf8(`${base.layout.workDir}/.gitattributes`, attributes);
  await base.fs.writeUtf8(`${base.layout.gitDir}/config`, LOG_DRIVER);
  const cleaned: string[] = [];
  const command = {
    run: async (request: { readonly stdin?: Uint8Array }) => {
      cleaned.push(dec(request.stdin));
      return { exitCode: 0, stdout: request.stdin ?? new Uint8Array() };
    },
  };
  return { ctx: { ...base, command }, cleaned };
};

/** Delays the stat of `slowPath`, so its read settles after every other path's. */
const withSlowLstat = (ctx: Context, slowPath: string): Context => ({
  ...ctx,
  fs: new Proxy(ctx.fs, {
    get(target, prop, receiver) {
      if (prop !== 'lstat') return Reflect.get(target, prop, receiver);
      return async (path: string) => {
        if (path.endsWith(slowPath)) await new Promise((r) => setTimeout(r, SETTLE_MS));
        return target.lstat(path);
      };
    },
  }),
});

describe('Given literal paths named out of index order under a clean driver', () => {
  describe('When add stages them', () => {
    it('Then the driver hears them in index order', async () => {
      // Arrange
      const { ctx, cleaned } = await repoUnderLogDriver(
        { 'b.txt': 'B', 'a.txt': 'A' },
        '*.txt filter=log\n',
      );
      const sut = add;

      // Act
      await sut(ctx, ['b.txt', 'a.txt']);

      // Assert
      expect(cleaned).toEqual(['A', 'B']);
    });
  });
});

describe('Given a walked tree whose first path reads slowest under a clean driver', () => {
  describe('When add walks the work tree', () => {
    it('Then the driver hears the paths in walk order, not in read order', async () => {
      // Arrange
      const { ctx, cleaned } = await repoUnderLogDriver(
        { 'a.txt': 'A', 'b.txt': 'B' },
        '*.txt filter=log\n',
      );
      const sut = add;

      // Act
      await sut(withSlowLstat(ctx, '/a.txt'), [], { all: true });

      // Assert
      expect(cleaned).toEqual(['A', 'B']);
    });
  });
});

describe('Given a walked path ahead of a filtered one that needs no clean', () => {
  describe('When add walks the work tree', () => {
    it('Then the filtered path is cleaned once the earlier path is done', async () => {
      // Arrange
      const { ctx, cleaned } = await repoUnderLogDriver(
        { 'a.dat': 'A', 'b.txt': 'B' },
        '*.txt filter=log\n',
      );
      const sut = add;

      // Act
      const result = await sut(withSlowLstat(ctx, '/a.dat'), [], { all: true });

      // Assert
      expect(cleaned).toEqual(['B']);
      expect(result.added).toEqual(['.gitattributes', 'a.dat', 'b.txt']);
    });
  });
});
