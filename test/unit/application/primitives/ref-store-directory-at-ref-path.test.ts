import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { createNodeContext } from '../../../../src/adapters/node/node-adapter.js';
import {
  createRefStore,
  type RefUpdate,
} from '../../../../src/application/primitives/ref-store.js';
import {
  permissionDenied,
  type TsgitError,
  unsupportedOperation,
} from '../../../../src/domain/error.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const ID = 'a'.repeat(40) as ObjectId;
const OTHER_ID = 'b'.repeat(40) as ObjectId;
const REF = 'refs/heads/e' as RefName;

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const ADAPTERS = [
  { adapter: 'memory', build: async (): Promise<Context> => createMemoryContext() },
  {
    adapter: 'node',
    build: async (): Promise<Context> => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-ref-path-dir-'));
      tempRoots.push(root);
      return createNodeContext({ workDir: root });
    },
  },
] as const;

const gitPath = (ctx: Context, relative: string): string => `${ctx.layout.gitDir}/${relative}`;

const isDirectory = async (ctx: Context, relative: string): Promise<boolean> =>
  (await ctx.fs.exists(gitPath(ctx, relative))) &&
  (await ctx.fs.stat(gitPath(ctx, relative))).isDirectory;

const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (err) {
    return (err as TsgitError).data;
  }
  return undefined;
};

describe('ref-store — a directory at a ref or log path', () => {
  describe.each(ADAPTERS)('$adapter adapter', ({ build }) => {
    describe('Given a tree of only empty directories at the loose path', () => {
      describe.each([
        { label: 'a set', update: { kind: 'set', name: REF, id: ID }, content: `${ID}\n` },
        {
          label: 'a symbolic set',
          update: { kind: 'setSymbolic', name: REF, target: 'refs/heads/main' },
          content: 'ref: refs/heads/main\n',
        },
      ])('When $label writes the ref', ({ update, content }) => {
        it('Then the tree is removed and the ref written', async () => {
          // Arrange
          const ctx = await build();
          await ctx.fs.mkdir(gitPath(ctx, `${REF}/a/b`));
          await ctx.fs.mkdir(gitPath(ctx, `${REF}/c`));
          const sut = createRefStore(ctx);

          // Act
          await sut.applyRefUpdates([update as RefUpdate]);

          // Assert
          expect(await ctx.fs.readUtf8(gitPath(ctx, REF))).toBe(content);
          expect(await ctx.fs.exists(gitPath(ctx, `${REF}.lock`))).toBe(false);
        });
      });

      describe('When a delete of the absent ref runs', () => {
        it('Then the tree is removed', async () => {
          // Arrange
          const ctx = await build();
          await ctx.fs.mkdir(gitPath(ctx, `${REF}/a`));
          const sut = createRefStore(ctx);

          // Act
          await sut.applyRefUpdates([{ kind: 'delete', name: REF }]);

          // Assert
          expect(await ctx.fs.exists(gitPath(ctx, REF))).toBe(false);
        });
      });

      describe('When a set expects an existing value', () => {
        it('Then the compare-and-swap refuses and the tree stays', async () => {
          // Arrange
          const ctx = await build();
          await ctx.fs.mkdir(gitPath(ctx, REF));
          const sut = createRefStore(ctx);

          // Act
          const refusal = await refusalOf(() =>
            sut.applyRefUpdates([{ kind: 'set', name: REF, id: ID, expected: OTHER_ID }]),
          );

          // Assert
          expect(refusal).toEqual({
            code: 'REF_UPDATE_CONFLICT',
            name: REF,
            expected: OTHER_ID,
            actual: 'absent',
          });
          expect(await isDirectory(ctx, REF)).toBe(true);
        });
      });
    });

    describe('Given a directory at the loose path holding a file that is not a ref', () => {
      describe.each([
        { label: 'a set', update: { kind: 'set', name: REF, id: ID } },
        { label: 'a delete of the absent ref', update: { kind: 'delete', name: REF } },
      ])('When $label runs', ({ update }) => {
        it('Then it refuses DIRECTORY_NOT_EMPTY naming the directory and keeps the file', async () => {
          // Arrange
          const ctx = await build();
          await ctx.fs.writeUtf8(gitPath(ctx, `${REF}/x.lock`), '');
          const sut = createRefStore(ctx);

          // Act
          const refusal = await refusalOf(() => sut.applyRefUpdates([update as RefUpdate]));

          // Assert
          expect(refusal).toEqual({ code: 'DIRECTORY_NOT_EMPTY', path: gitPath(ctx, REF) });
          expect(await ctx.fs.exists(gitPath(ctx, `${REF}/x.lock`))).toBe(true);
          expect(await ctx.fs.exists(gitPath(ctx, `${REF}.lock`))).toBe(false);
        });
      });
    });

    describe('Given a directory at the loose path holding only a dangling symbolic link', () => {
      describe('When a set writes the ref', () => {
        it('Then it refuses DIRECTORY_NOT_EMPTY — the link is no ref', async () => {
          // Arrange
          const ctx = await build();
          await ctx.fs.mkdir(gitPath(ctx, REF));
          await ctx.fs.symlink('nowhere', gitPath(ctx, `${REF}/l`));
          const sut = createRefStore(ctx);

          // Act
          const refusal = await refusalOf(() =>
            sut.applyRefUpdates([{ kind: 'set', name: REF, id: ID }]),
          );

          // Assert
          expect(refusal).toEqual({ code: 'DIRECTORY_NOT_EMPTY', path: gitPath(ctx, REF) });
        });
      });
    });

    describe('Given a loose ref nested under an empty directory beside the loose path', () => {
      describe('When a delete of the absent ref runs', () => {
        it('Then it refuses FILE_EXISTS naming the ref under it and keeps it', async () => {
          // Arrange
          const ctx = await build();
          await ctx.fs.mkdir(gitPath(ctx, `${REF}/empty`));
          await ctx.fs.writeUtf8(gitPath(ctx, `${REF}/sub/r`), `${ID}\n`);
          const sut = createRefStore(ctx);

          // Act
          const refusal = await refusalOf(() =>
            sut.applyRefUpdates([{ kind: 'delete', name: REF }]),
          );

          // Assert
          expect(refusal).toEqual({ code: 'FILE_EXISTS', path: gitPath(ctx, `${REF}/sub/r`) });
          expect(await ctx.fs.readUtf8(gitPath(ctx, `${REF}/sub/r`))).toBe(`${ID}\n`);
        });
      });
    });

    describe('Given a tree of empty directories at the log path', () => {
      describe('When a logged set writes the ref', () => {
        it('Then the tree is removed and the log written', async () => {
          // Arrange
          const ctx = await build();
          await ctx.fs.mkdir(gitPath(ctx, `logs/${REF}/a`));
          const sut = createRefStore(ctx);

          // Act
          await sut.applyRefUpdates([
            {
              kind: 'set',
              name: REF,
              id: ID,
              reflog: { oldId: '0'.repeat(40) as ObjectId, newId: ID, message: 'w' },
            },
          ]);

          // Assert
          const log = await ctx.fs.readUtf8(gitPath(ctx, `logs/${REF}`));
          expect(log.startsWith(`${'0'.repeat(40)} ${ID} `)).toBe(true);
          expect(log.endsWith('\tw\n')).toBe(true);
        });
      });

      describe('When a set of a ref git does not log by default writes it', () => {
        it('Then no log is written and the directory stays', async () => {
          // Arrange
          const ctx = await build();
          const name = 'refs/misc/x' as RefName;
          await ctx.fs.mkdir(gitPath(ctx, `logs/${name}`));
          const sut = createRefStore(ctx);

          // Act
          await sut.applyRefUpdates([
            {
              kind: 'set',
              name,
              id: ID,
              reflog: { oldId: '0'.repeat(40) as ObjectId, newId: ID, message: 'w' },
            },
          ]);

          // Assert
          expect(await ctx.fs.readUtf8(gitPath(ctx, name))).toBe(`${ID}\n`);
          expect(await isDirectory(ctx, `logs/${name}`)).toBe(true);
        });
      });
    });

    describe('Given a ref nested under the loose path and a blocked log path', () => {
      describe('When a logged set writes the outer ref', () => {
        it('Then the ref path reports first, ahead of the log path that refused', async () => {
          // Arrange — git settles the ref path while it holds the lock and
          // only then sets the log up, so a tree of real refs at the ref path
          // is what the caller hears about, not the log that refused first.
          const ctx = await build();
          await ctx.fs.writeUtf8(gitPath(ctx, `${REF}/nested`), `${ID}\n`);
          await ctx.fs.writeUtf8(gitPath(ctx, `logs/${REF}/f`), 'kept\n');
          const sut = createRefStore(ctx);

          // Act
          const refusal = await refusalOf(() =>
            sut.applyRefUpdates([
              {
                kind: 'set',
                name: REF,
                id: ID,
                reflog: { oldId: '0'.repeat(40) as ObjectId, newId: ID, message: 'w' },
              },
            ]),
          );

          // Assert
          expect(refusal).toEqual({
            code: 'FILE_EXISTS',
            path: gitPath(ctx, `${REF}/nested`),
          });
          expect(await ctx.fs.readUtf8(gitPath(ctx, `${REF}/nested`))).toBe(`${ID}\n`);
        });
      });
    });

    describe('Given a directory holding a file at the log path', () => {
      describe('When a logged set would create the ref', () => {
        it('Then it refuses before the ref is written and nothing on disk changes', async () => {
          // Arrange
          const ctx = await build();
          await ctx.fs.writeUtf8(gitPath(ctx, `logs/${REF}/f`), 'kept\n');
          const sut = createRefStore(ctx);

          // Act
          const refusal = await refusalOf(() =>
            sut.applyRefUpdates([
              {
                kind: 'set',
                name: REF,
                id: ID,
                reflog: { oldId: '0'.repeat(40) as ObjectId, newId: ID, message: 'w' },
              },
            ]),
          );

          // Assert
          expect(refusal).toEqual({
            code: 'DIRECTORY_NOT_EMPTY',
            path: gitPath(ctx, `logs/${REF}`),
          });
          expect(await ctx.fs.exists(gitPath(ctx, REF))).toBe(false);
          expect(await ctx.fs.readUtf8(gitPath(ctx, `logs/${REF}/f`))).toBe('kept\n');
        });
      });

      describe('When a logged set would move a ref that already exists', () => {
        it('Then the ref keeps its bytes', async () => {
          // Arrange
          const ctx = await build();
          const sut = createRefStore(ctx);
          await sut.applyRefUpdates([{ kind: 'set', name: REF, id: ID }]);
          await ctx.fs.writeUtf8(gitPath(ctx, `logs/${REF}/f`), 'kept\n');

          // Act
          const refusal = await refusalOf(() =>
            sut.applyRefUpdates([
              {
                kind: 'set',
                name: REF,
                id: OTHER_ID,
                reflog: { oldId: ID, newId: OTHER_ID, message: 'w' },
              },
            ]),
          );

          // Assert
          expect((refusal as { code: string }).code).toBe('DIRECTORY_NOT_EMPTY');
          expect(await ctx.fs.readUtf8(gitPath(ctx, REF))).toBe(`${ID}\n`);
        });
      });

      describe('When a logged symbolic set would create the ref', () => {
        it('Then it refuses before the ref is written', async () => {
          // Arrange
          const ctx = await build();
          await ctx.fs.writeUtf8(gitPath(ctx, `logs/${REF}/f`), 'kept\n');
          const sut = createRefStore(ctx);

          // Act
          const refusal = await refusalOf(() =>
            sut.applyRefUpdates([
              {
                kind: 'setSymbolic',
                name: REF,
                target: 'refs/heads/main' as RefName,
                reflog: { oldId: '0'.repeat(40) as ObjectId, newId: ID, message: 's' },
              },
            ]),
          );

          // Assert
          expect((refusal as { code: string }).code).toBe('DIRECTORY_NOT_EMPTY');
          expect(await ctx.fs.exists(gitPath(ctx, REF))).toBe(false);
        });
      });

      describe('When a set of a ref git does not log by default writes it', () => {
        it('Then the ref is written and the blocked log directory is left alone', async () => {
          // Arrange
          const ctx = await build();
          const name = 'refs/misc/y' as RefName;
          await ctx.fs.writeUtf8(gitPath(ctx, `logs/${name}/f`), 'kept\n');
          const sut = createRefStore(ctx);

          // Act
          await sut.applyRefUpdates([
            {
              kind: 'set',
              name,
              id: ID,
              reflog: { oldId: '0'.repeat(40) as ObjectId, newId: ID, message: 'w' },
            },
          ]);

          // Assert
          expect(await ctx.fs.readUtf8(gitPath(ctx, name))).toBe(`${ID}\n`);
          expect(await ctx.fs.readUtf8(gitPath(ctx, `logs/${name}/f`))).toBe('kept\n');
        });
      });
    });
  });

  describe('Given a directory at the loose path whose first entry stops the removal', () => {
    describe.each([
      { label: 'a file listed before an empty directory', blocker: `${REF}/a.lock` },
      {
        label: 'a directory holding a file listed before an empty one',
        blocker: `${REF}/a/x.lock`,
      },
    ])('When a set meets $label', ({ blocker }) => {
      it('Then removal stops there and the later empty directory stays', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(gitPath(ctx, blocker), '');
        await ctx.fs.mkdir(gitPath(ctx, `${REF}/b`));
        const sut = createRefStore(ctx);

        // Act
        const refusal = await refusalOf(() =>
          sut.applyRefUpdates([{ kind: 'set', name: REF, id: ID }]),
        );

        // Assert
        expect(refusal).toEqual({ code: 'DIRECTORY_NOT_EMPTY', path: gitPath(ctx, REF) });
        expect(await isDirectory(ctx, `${REF}/b`)).toBe(true);
      });
    });
  });

  describe('Given the rename of a ref lock is refused', () => {
    describe.each([
      {
        label: 'for a reason other than a directory',
        refusal: (p: string) => unsupportedOperation('filesystem', `EIO ${p}`),
        expected: (p: string) => ({
          code: 'UNSUPPORTED_OPERATION',
          operation: 'filesystem',
          reason: `EIO ${p}`,
        }),
      },
      {
        label: 'with PERMISSION_DENIED and no directory at the path',
        refusal: (p: string) => permissionDenied(p),
        expected: (p: string) => ({ code: 'PERMISSION_DENIED', path: p }),
      },
    ])('When a set is refused $label', ({ refusal, expected }) => {
      it('Then that refusal propagates and no lock remains', async () => {
        // Arrange
        const base = createMemoryContext();
        const lockPath = gitPath(base, `${REF}.lock`);
        const ctx: Context = {
          ...base,
          fs: { ...base.fs, rename: async (src) => Promise.reject(refusal(src)) },
        };
        const sut = createRefStore(ctx);

        // Act
        const data = await refusalOf(() =>
          sut.applyRefUpdates([{ kind: 'set', name: REF, id: ID }]),
        );

        // Assert
        expect(data).toEqual(expected(lockPath));
        expect(await base.fs.exists(lockPath)).toBe(false);
      });
    });
  });

  describe('Given the reflog append is refused', () => {
    describe.each([
      {
        label: 'for a reason other than a directory',
        refusal: (p: string) => unsupportedOperation('filesystem', `EIO ${p}`),
        expected: (p: string) => ({
          code: 'UNSUPPORTED_OPERATION',
          operation: 'filesystem',
          reason: `EIO ${p}`,
        }),
      },
      {
        label: 'with PERMISSION_DENIED on a regular log file',
        refusal: (p: string) => permissionDenied(p),
        expected: (p: string) => ({ code: 'PERMISSION_DENIED', path: p }),
      },
    ])('When a logged set is refused $label', ({ refusal, expected }) => {
      it('Then that refusal propagates', async () => {
        // Arrange
        const base = createMemoryContext();
        const logPath = gitPath(base, `logs/${REF}`);
        await base.fs.writeUtf8(logPath, '');
        const ctx: Context = {
          ...base,
          fs: { ...base.fs, appendUtf8: async (p) => Promise.reject(refusal(p)) },
        };
        const sut = createRefStore(ctx);

        // Act
        const data = await refusalOf(() =>
          sut.applyRefUpdates([
            {
              kind: 'set',
              name: REF,
              id: ID,
              reflog: { oldId: '0'.repeat(40) as ObjectId, newId: ID, message: 'w' },
            },
          ]),
        );

        // Assert
        expect(data).toEqual(expected(logPath));
      });
    });
  });

  describe("Given the log path cannot be stat'ed for a reason other than absence", () => {
    describe('When a logged set probes whether the ref logs', () => {
      it('Then that refusal propagates', async () => {
        // Arrange
        const base = createMemoryContext();
        const logPath = gitPath(base, 'logs/refs/misc/x');
        const ctx: Context = {
          ...base,
          fs: {
            ...base.fs,
            stat: async (p) =>
              p === logPath ? Promise.reject(permissionDenied(p)) : base.fs.stat(p),
          },
        };
        const sut = createRefStore(ctx);

        // Act
        const data = await refusalOf(() =>
          sut.applyRefUpdates([
            {
              kind: 'set',
              name: 'refs/misc/x' as RefName,
              id: ID,
              reflog: { oldId: '0'.repeat(40) as ObjectId, newId: ID, message: 'w' },
            },
          ]),
        );

        // Assert
        expect(data).toEqual({ code: 'PERMISSION_DENIED', path: logPath });
      });
    });
  });
});
