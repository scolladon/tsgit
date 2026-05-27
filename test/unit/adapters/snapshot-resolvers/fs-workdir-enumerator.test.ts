import { describe, expect, it } from 'vitest';

import { createFsWorkdirEnumerator } from '../../../../src/adapters/snapshot-resolvers/fs-workdir-enumerator.js';
import { compilePathspec } from '../../../../src/domain/pathspec/index.js';
import type { Context } from '../../../../src/ports/context.js';
import type {
  WalkIgnorePredicate,
  WorkdirEnumOptions,
} from '../../../../src/ports/snapshot-resolvers.js';
import { buildSeededContext } from '../../application/primitives/fixtures.js';

const seedFile = async (ctx: Context, relPath: string, content = 'x'): Promise<void> => {
  await ctx.fs.write(`${ctx.layout.workDir}/${relPath}`, new TextEncoder().encode(content));
};

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe('createFsWorkdirEnumerator', () => {
  describe('Given a workdir with a few files', () => {
    describe('When enumerate is called with no filters', () => {
      it('Then it yields one WorkdirEntryRow per file with source="workdir" and kind="file"', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedFile(ctx, 'a.txt');
        await seedFile(ctx, 'b.txt');
        const sut = createFsWorkdirEnumerator();

        // Act
        const rows = await collect(sut.enumerate(ctx, {}));

        // Assert
        const paths = rows.map((r) => r.path).sort();
        expect(paths).toEqual(['a.txt', 'b.txt']);
        for (const row of rows) {
          expect(row.source).toBe('workdir');
          expect(row.kind).toBe('file');
        }
      });

      it('Then each row carries a WorkdirStat with non-zero size and a recognised mode', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedFile(ctx, 'hello.txt', 'hi');
        const sut = createFsWorkdirEnumerator();

        // Act
        const [row] = await collect(sut.enumerate(ctx, {}));

        // Assert
        expect(row?.stat.size).toBeGreaterThan(0);
        expect(['100644', '100755']).toContain(row?.mode);
      });
    });
  });

  describe('Given a workdir with files in nested directories', () => {
    describe('When enumerate is called', () => {
      it('Then it yields nested files using forward-slash relative paths', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedFile(ctx, 'src/a.ts');
        await seedFile(ctx, 'src/lib/b.ts');
        const sut = createFsWorkdirEnumerator();

        // Act
        const paths = (await collect(sut.enumerate(ctx, {}))).map((r) => r.path).sort();

        // Assert
        expect(paths).toEqual(['src/a.ts', 'src/lib/b.ts']);
      });
    });
  });

  describe('Given a workdir with a `.git` directory at the root', () => {
    describe('When enumerate is called', () => {
      it('Then `.git` is skipped and no rows are emitted for it', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedFile(ctx, 'a.txt');
        // `.git` exists at workDir/.git from buildSeededContext layout — confirm it is skipped.
        const sut = createFsWorkdirEnumerator();

        // Act
        const paths = (await collect(sut.enumerate(ctx, {}))).map((r) => r.path);

        // Assert
        expect(paths).toEqual(['a.txt']);
      });
    });
  });

  describe('Given a workdir with a symlink', () => {
    describe('When enumerate is called', () => {
      it('Then the symlink yields a row with kind="symlink" and mode="120000"', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedFile(ctx, 'target.txt');
        await ctx.fs.symlink('target.txt', `${ctx.layout.workDir}/link`);
        const sut = createFsWorkdirEnumerator();

        // Act
        const rows = await collect(sut.enumerate(ctx, {}));
        const linkRow = rows.find((r) => r.path === 'link');

        // Assert
        expect(linkRow).toBeDefined();
        expect(linkRow?.kind).toBe('symlink');
        expect(linkRow?.mode).toBe('120000');
      });
    });
  });

  describe('Given excludes that drops every leaf', () => {
    describe('When enumerate is called', () => {
      it('Then no rows are yielded (excludes prunes all leaves)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedFile(ctx, 'a.txt');
        await seedFile(ctx, 'b.txt');
        const excludes: WalkIgnorePredicate = (_path, isDir) => !isDir; // drop every file
        const sut = createFsWorkdirEnumerator();

        // Act
        const rows = await collect(sut.enumerate(ctx, { excludes }));

        // Assert
        expect(rows).toEqual([]);
      });
    });
  });

  describe('Given a pathspec that matches only "*.ts"', () => {
    describe('When enumerate is called', () => {
      it('Then only files matching the pathspec are yielded', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedFile(ctx, 'a.ts');
        await seedFile(ctx, 'b.js');
        await seedFile(ctx, 'c.ts');
        const opts: WorkdirEnumOptions = { paths: compilePathspec(['*.ts']) };
        const sut = createFsWorkdirEnumerator();

        // Act
        const paths = (await collect(sut.enumerate(ctx, opts))).map((r) => r.path).sort();

        // Assert
        expect(paths).toEqual(['a.ts', 'c.ts']);
      });
    });
  });

  describe('Given a maxEntries cap below the actual file count', () => {
    describe('When enumerate is called', () => {
      it('Then a TREE_ENTRY_LIMIT_EXCEEDED error is thrown', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedFile(ctx, 'a.txt');
        await seedFile(ctx, 'b.txt');
        await seedFile(ctx, 'c.txt');
        const sut = createFsWorkdirEnumerator();

        // Act + Assert
        const iterate = async (): Promise<void> => {
          for await (const _row of sut.enumerate(ctx, { maxEntries: 2 })) {
            // consume
          }
        };
        await expect(iterate()).rejects.toMatchObject({
          data: { code: 'TREE_ENTRY_LIMIT_EXCEEDED' },
        });
      });
    });
  });

  describe('Given a pre-aborted signal in opts', () => {
    describe('When enumerate is called', () => {
      it('Then iteration throws OPERATION_ABORTED', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedFile(ctx, 'a.txt');
        const controller = new AbortController();
        controller.abort();
        const sut = createFsWorkdirEnumerator();

        // Act + Assert
        const iterate = async (): Promise<void> => {
          for await (const _row of sut.enumerate(ctx, { signal: controller.signal })) {
            // consume
          }
        };
        await expect(iterate()).rejects.toMatchObject({
          data: { code: 'OPERATION_ABORTED' },
        });
      });
    });
  });
});
