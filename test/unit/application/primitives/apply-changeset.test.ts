import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  applyChangeset,
  isWorkingTreeDirty,
} from '../../../../src/application/primitives/apply-changeset.js';
import type {
  Changeset,
  ChangesetEntry,
} from '../../../../src/application/primitives/compute-changeset.js';
import { invalidateConfigCache } from '../../../../src/application/primitives/config-read.js';
import * as blobSourceMod from '../../../../src/application/primitives/internal/blob-source.js';
import * as concurrencyMod from '../../../../src/application/primitives/internal/concurrency.js';
import * as ignoreEvaluatorMod from '../../../../src/application/primitives/internal/ignore-evaluator.js';
import * as readGitattributesMod from '../../../../src/application/primitives/internal/read-gitattributes.js';
import * as writeFileMod from '../../../../src/application/primitives/internal/write-working-tree-file.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FileMode, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from '../../../../src/ports/command-runner.js';
import { type Context, createSession } from '../../../../src/ports/context.js';
import type { FileStat } from '../../../../src/ports/file-system.js';
import { scriptedCommandRunner } from '../../../fixtures/scripted-command-runner.js';
import { buildSeededContext } from './fixtures.js';
import { createInterleavingFs } from './support/interleaving-fs.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/** Fake runner: applies a transform to stdin and returns it as stdout. */
class FakeSmudgeRunner implements CommandRunner {
  private readonly exitCode: number;
  private readonly transform: (input: Uint8Array) => Uint8Array;
  readonly calls: CommandRequest[] = [];

  constructor(exitCode = 0, transform: (input: Uint8Array) => Uint8Array = (b) => b) {
    this.exitCode = exitCode;
    this.transform = transform;
  }

  async run(request: CommandRequest): Promise<CommandResult> {
    this.calls.push(request);
    if (this.exitCode !== 0) return { exitCode: this.exitCode };
    return { exitCode: 0, stdout: this.transform(request.stdin ?? new Uint8Array(0)) };
  }
}

const lowercase = (b: Uint8Array): Uint8Array => enc(dec(b).toLowerCase());

const WORKDIR = '/repo';

const makeChangeset = (entries: ChangesetEntry[]): Changeset => {
  const stats = { add: 0, update: 0, delete: 0, noop: 0 };
  for (const e of entries) {
    if (e.kind === 'delete') stats.delete += 1;
    else stats[e.kind] += 1;
  }
  return { entries, stats };
};

interface EntryOptions {
  readonly pathBytes?: Uint8Array;
}

const bytesOf = (opts: EntryOptions): EntryOptions =>
  opts.pathBytes === undefined ? {} : { pathBytes: opts.pathBytes };

const makeAdd = (
  path: string,
  id: ObjectId,
  mode: FileMode = FILE_MODE.REGULAR,
  opts: EntryOptions = {},
): ChangesetEntry => ({
  kind: 'add',
  path: path as FilePath,
  mode,
  id,
  previousId: undefined,
  previousMode: undefined,
  ...bytesOf(opts),
});

const makeDelete = (
  path: string,
  previousId: ObjectId,
  previousMode: FileMode = FILE_MODE.REGULAR,
  opts: EntryOptions = {},
): ChangesetEntry => ({
  kind: 'delete',
  path: path as FilePath,
  mode: previousMode,
  id: undefined,
  previousId,
  previousMode,
  ...bytesOf(opts),
});

const makeUpdate = (
  path: string,
  previousId: ObjectId,
  newId: ObjectId,
  mode: FileMode = FILE_MODE.REGULAR,
  opts: EntryOptions = {},
): ChangesetEntry => ({
  kind: 'update',
  path: path as FilePath,
  mode,
  id: newId,
  previousId,
  previousMode: mode,
  ...bytesOf(opts),
});

const writeBlob = async (
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  content: Uint8Array,
): Promise<ObjectId> => writeObject(ctx, { type: 'blob', content, id: '' as ObjectId });

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

const contextWithAlternate = async (): Promise<Context> => {
  const ctx = createMemoryContext({
    files: { '/repo/.git/objects/info/alternates': enc(`${ALTERNATE}\n`) },
  });
  await ctx.fs.mkdir(ALTERNATE);
  return ctx;
};

/** A write through an alternate that cannot load is refused, so the fault is planted after the writes. */
const withCorruptAlternate = async (ctx: Context): Promise<Context> => {
  await ctx.fs.write(`${ALTERNATE}/pack/multi-pack-index`, FLIPPED_SIGNATURE_MIDX);
  return { ...ctx, session: createSession() };
};

const outcomeOf = async (attempt: Promise<unknown>): Promise<unknown> => {
  try {
    await attempt;
  } catch (error) {
    return (error as TsgitError).data;
  }
  return undefined;
};

describe('applyChangeset write wave and an object source', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Given an alternate that cannot load and entries a, base, f in that order', () => {
    describe('When applyChangeset runs', () => {
      it('Then a is written, base is left empty and f is never touched, every time', async () => {
        // Arrange
        const attempts = Array.from({ length: 20 }, (_, i) => i);
        const seen = new Set<string>();

        for (const _attempt of attempts) {
          const seeded = await contextWithAlternate();
          const a = await writeBlob(seeded, enc('aaa\n'));
          const ctx = await withCorruptAlternate(seeded);
          const missing = 'b'.repeat(40) as ObjectId;
          const changeset = makeChangeset([
            makeAdd('f', missing),
            makeAdd('base', missing),
            makeAdd('a', a),
          ]);

          // Act
          const sut = applyChangeset;
          const data = await outcomeOf(sut(ctx, { changeset, force: false, workdir: WORKDIR }));

          // Assert
          seen.add(
            JSON.stringify([
              (data as { code: string }).code,
              await ctx.fs.exists(`${WORKDIR}/a`),
              (await ctx.fs.exists(`${WORKDIR}/base`)) &&
                (await ctx.fs.read(`${WORKDIR}/base`)).length,
              await ctx.fs.exists(`${WORKDIR}/f`),
            ]),
          );
        }
        expect([...seen]).toEqual([JSON.stringify(['INVALID_MULTI_PACK_INDEX', true, 0, false])]);
      });
    });
  });

  describe('Given every source loads', () => {
    describe('When applyChangeset writes several entries', () => {
      it('Then the writes go through the ioBound pool', async () => {
        // Arrange
        const ctx = await contextWithAlternate();
        const ids = [
          await writeBlob(ctx, enc('one')),
          await writeBlob(ctx, enc('two')),
          await writeBlob(ctx, enc('three')),
        ];
        const runs: ReturnType<typeof vi.spyOn>[] = [];
        const realLimiterFor = concurrencyMod.limiterFor;
        vi.spyOn(concurrencyMod, 'limiterFor').mockImplementation((...args) => {
          const limiter = realLimiterFor(...args);
          runs.push(vi.spyOn(limiter, 'run'));
          return limiter;
        });
        const changeset = makeChangeset(ids.map((id, i) => makeAdd(`f${i}`, id)));

        // Act
        const sut = applyChangeset;
        await sut(ctx, { changeset, force: false, workdir: WORKDIR });

        // Assert
        expect(runs.reduce((total, run) => total + run.mock.calls.length, 0)).toBe(ids.length);
      });
    });
  });

  describe('Given an alternate that cannot load', () => {
    describe('When applyChangeset writes entries given out of path order', () => {
      it('Then they are written in byte order of the path, one at a time', async () => {
        // Arrange
        const seeded = await contextWithAlternate();
        const ids = [await writeBlob(seeded, enc('zz')), await writeBlob(seeded, enc('mm'))];
        const ctx = await withCorruptAlternate(seeded);
        const order: string[] = [];
        const realWrite = ctx.fs.writeStream.bind(ctx.fs);
        vi.spyOn(ctx.fs, 'writeStream').mockImplementation(async (path, chunks) => {
          order.push(path);
          await realWrite(path, chunks);
        });
        const changeset = makeChangeset([
          makeAdd('z', ids[0] as ObjectId),
          makeAdd('m', ids[1] as ObjectId),
        ]);

        // Act
        const sut = applyChangeset;
        await sut(ctx, { changeset, force: false, workdir: WORKDIR });

        // Assert
        expect(order).toEqual([`${WORKDIR}/m`, `${WORKDIR}/z`]);
      });
    });
  });
});

describe('applyChangeset', () => {
  describe('Given an add entry for a regular file', () => {
    describe('When applyChangeset runs', () => {
      it('Then writes the file at workdir/path with content from the blob', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('hello world'));
        // Act
        const result = await applyChangeset(ctx, {
          changeset: makeChangeset([makeAdd('foo.txt', id)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(result.written).toBe(1);
        expect(result.deleted).toBe(0);
        const bytes = await ctx.fs.read(`${WORKDIR}/foo.txt`);
        expect(new TextDecoder().decode(bytes)).toBe('hello world');
        expect(result.writtenEntries).toHaveLength(1);
        expect(result.writtenEntries[0]?.path).toBe('foo.txt');
        expect(result.writtenEntries[0]?.id).toBe(id);
        expect(result.writtenEntries[0]?.flags.stage).toBe(0);
      });
    });
  });

  describe('Given an add entry with executable mode', () => {
    describe('When applyChangeset runs', () => {
      it('Then chmods to 0o755 and records the EXECUTABLE mode', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('#!/bin/sh\n'));
        // Act
        const result = await applyChangeset(ctx, {
          changeset: makeChangeset([makeAdd('run.sh', id, FILE_MODE.EXECUTABLE)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(result.writtenEntries[0]?.mode).toBe(FILE_MODE.EXECUTABLE);
      });

      it('Then chmods the file to 0o755', async () => {
        // Arrange — capture the mode argument passed to chmod
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('#!/bin/sh\n'));
        const chmodMode = vi.fn<(path: string, mode: number) => Promise<void>>(
          async () => undefined,
        );
        const wrappedCtx: Context = {
          ...ctx,
          fs: { ...ctx.fs, chmod: chmodMode },
        };

        // Act
        await applyChangeset(wrappedCtx, {
          changeset: makeChangeset([makeAdd('run.sh', id, FILE_MODE.EXECUTABLE)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(chmodMode).toHaveBeenCalledWith(`${WORKDIR}/run.sh`, 0o755);
      });
    });
  });

  describe('Given an add entry with symlink mode', () => {
    describe('When applyChangeset runs', () => {
      it('Then writes a symlink whose target is the blob content', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('../target.txt'));
        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([makeAdd('link', id, FILE_MODE.SYMLINK)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(await ctx.fs.readlink(`${WORKDIR}/link`)).toBe('../target.txt');
      });
    });
  });

  describe('Given an add entry without an id next to a symlink add', () => {
    describe('When applyChangeset runs', () => {
      it('Then no directory is made for the entry without an id', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('target'));

        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([
            makeAdd('p/q', undefined as unknown as ObjectId),
            makeAdd('link', id, FILE_MODE.SYMLINK),
          ]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(await ctx.fs.exists(`${WORKDIR}/p`)).toBe(false);
        expect(await ctx.fs.readlink(`${WORKDIR}/link`)).toBe('target');
      });
    });
  });

  describe('Given an add entry with gitlink mode', () => {
    describe('When applyChangeset runs', () => {
      it('Then creates an empty directory placeholder', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([makeAdd('sub', 'd'.repeat(40) as ObjectId, FILE_MODE.GITLINK)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        const stat = await ctx.fs.lstat(`${WORKDIR}/sub`);
        expect(stat.isDirectory).toBe(true);
      });
    });
  });

  describe('Given a delete entry and the file exists in the working tree', () => {
    describe('When applyChangeset runs with force', () => {
      it('Then removes the file', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('soon-gone'));
        await ctx.fs.write(`${WORKDIR}/doomed.txt`, new TextEncoder().encode('soon-gone'));
        // Act
        const result = await applyChangeset(ctx, {
          changeset: makeChangeset([makeDelete('doomed.txt', id)]),
          force: true,
          workdir: WORKDIR,
        });

        // Assert
        expect(result.deleted).toBe(1);
        expect(await ctx.fs.exists(`${WORKDIR}/doomed.txt`)).toBe(false);
      });
    });
  });

  describe('Given a delete entry that empties its leading directories', () => {
    describe('When applyChangeset runs with force', () => {
      it('Then every emptied directory is removed and the work tree root stays', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('q'));
        await ctx.fs.write(`${WORKDIR}/d/e/q`, enc('q'));
        await ctx.fs.write(`${WORKDIR}/keep`, enc('k'));

        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([makeDelete('d/e/q', id)]),
          force: true,
          workdir: WORKDIR,
        });

        // Assert
        expect(await ctx.fs.exists(`${WORKDIR}/d`)).toBe(false);
        expect(await ctx.fs.exists(`${WORKDIR}/keep`)).toBe(true);
      });
    });
  });

  describe('Given a delete entry whose directory the target writes a file in', () => {
    describe('When applyChangeset runs with force', () => {
      it('Then the directory is not probed for removal', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('q'));
        await ctx.fs.write(`${WORKDIR}/d/e/q`, enc('q'));
        const rm = vi.spyOn(ctx.fs, 'rm');
        const rmdir = vi.spyOn(ctx.fs, 'rmdir');

        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([makeDelete('d/e/q', id), makeAdd('d/e/kept', id)]),
          force: true,
          workdir: WORKDIR,
        });

        // Assert
        expect(rm.mock.calls.map(([path]) => path)).toEqual([`${WORKDIR}/d/e/q`]);
        expect(rmdir).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a delete entry whose directory the target updates a file in', () => {
    describe('When applyChangeset runs with force', () => {
      it('Then the directory is not probed for removal', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, enc('old'));
        const newId = await writeBlob(ctx, enc('new'));
        await ctx.fs.write(`${WORKDIR}/d/q`, enc('old'));
        await ctx.fs.write(`${WORKDIR}/d/u`, enc('old'));
        const rmdir = vi.spyOn(ctx.fs, 'rmdir');

        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([makeDelete('d/q', oldId), makeUpdate('d/u', oldId, newId)]),
          force: true,
          workdir: WORKDIR,
        });

        // Assert
        expect(rmdir).not.toHaveBeenCalled();
        expect(dec(await ctx.fs.read(`${WORKDIR}/d/u`))).toBe('new');
      });
    });
  });

  describe('Given a delete entry whose directory keeps a noop entry absent from disk', () => {
    describe('When applyChangeset runs with force', () => {
      it('Then the emptied directory is removed', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('q'));
        await ctx.fs.write(`${WORKDIR}/d/e/q`, enc('q'));
        const absent: ChangesetEntry = {
          kind: 'noop',
          path: 'd/e/absent' as FilePath,
          mode: FILE_MODE.REGULAR,
          id,
          previousId: id,
          previousMode: FILE_MODE.REGULAR,
        };

        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([makeDelete('d/e/q', id), absent]),
          force: true,
          workdir: WORKDIR,
        });

        // Assert
        expect(await ctx.fs.exists(`${WORKDIR}/d`)).toBe(false);
      });
    });
  });

  describe('Given a delete entry whose directory still holds an untracked file', () => {
    describe('When applyChangeset runs with force', () => {
      it('Then the directory chain holding it is kept', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('q'));
        await ctx.fs.write(`${WORKDIR}/d/e/q`, enc('q'));
        await ctx.fs.write(`${WORKDIR}/d/e/untracked`, enc('u'));

        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([makeDelete('d/e/q', id)]),
          force: true,
          workdir: WORKDIR,
        });

        // Assert
        expect(await ctx.fs.exists(`${WORKDIR}/d/e/untracked`)).toBe(true);
      });
    });
  });

  describe('Given a nested directory f/g/x replaced by a file f', () => {
    describe('When applyChangeset runs with force', () => {
      it('Then the file f is written', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, enc('x'));
        const newId = await writeBlob(ctx, enc('file'));
        await ctx.fs.write(`${WORKDIR}/f/g/x`, enc('x'));

        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([makeDelete('f/g/x', oldId), makeAdd('f', newId)]),
          force: true,
          workdir: WORKDIR,
        });

        // Assert
        expect(dec(await ctx.fs.read(`${WORKDIR}/f`))).toBe('file');
      });
    });
  });

  describe('Given a directory f holding only a nested directory f/sub with a deleted tracked file, replaced by a file f', () => {
    describe('When applyChangeset runs without force', () => {
      it('Then no untracked clash is reported and f is written', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, enc('x'));
        const newId = await writeBlob(ctx, enc('file'));
        await ctx.fs.write(`${WORKDIR}/f/sub/x`, enc('x'));

        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([makeDelete('f/sub/x', oldId), makeAdd('f', newId)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(dec(await ctx.fs.read(`${WORKDIR}/f`))).toBe('file');
      });
    });
  });

  describe('Given a directory f holding a nested f/sub with a deleted tracked file and an untracked f/z beside it', () => {
    describe('When applyChangeset runs without force', () => {
      it('Then it refuses listing f and keeps the untracked file', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, enc('x'));
        const newId = await writeBlob(ctx, enc('file'));
        await ctx.fs.write(`${WORKDIR}/f/sub/x`, enc('x'));
        await ctx.fs.write(`${WORKDIR}/f/z`, enc('z'));

        // Act
        const outcome = await outcomeOf(
          applyChangeset(ctx, {
            changeset: makeChangeset([makeDelete('f/sub/x', oldId), makeAdd('f', newId)]),
            force: false,
            workdir: WORKDIR,
          }),
        );

        // Assert
        expect(outcome).toMatchObject({ code: 'CHECKOUT_OVERWRITE_DIRTY', untracked: ['f'] });
        expect(await ctx.fs.exists(`${WORKDIR}/f/z`)).toBe(true);
      });
    });
  });

  describe('Given a directory d holding only ignored files and a deleted tracked file, replaced by a file d', () => {
    describe('When applyChangeset runs without force', () => {
      it('Then the ignored files, nested ones included, give way and d is written', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, enc('x'));
        const newId = await writeBlob(ctx, enc('file'));
        await ctx.fs.write(`${WORKDIR}/.gitignore`, enc('*.o\nbuild/\n'));
        await ctx.fs.write(`${WORKDIR}/d/x`, enc('x'));
        await ctx.fs.write(`${WORKDIR}/d/junk.o`, enc('j'));
        await ctx.fs.write(`${WORKDIR}/d/n/deep.o`, enc('j'));
        await ctx.fs.write(`${WORKDIR}/d/build/out.txt`, enc('j'));

        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([makeDelete('d/x', oldId), makeAdd('d', newId)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(dec(await ctx.fs.read(`${WORKDIR}/d`))).toBe('file');
      });
    });
  });

  describe('Given a directory d holding an ignored file and an untracked file, replaced by a file d', () => {
    describe('When applyChangeset runs without force', () => {
      it('Then it refuses listing d and keeps both files', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, enc('x'));
        const newId = await writeBlob(ctx, enc('file'));
        await ctx.fs.write(`${WORKDIR}/.gitignore`, enc('*.o\n'));
        await ctx.fs.write(`${WORKDIR}/d/x`, enc('x'));
        await ctx.fs.write(`${WORKDIR}/d/junk.o`, enc('j'));
        await ctx.fs.write(`${WORKDIR}/d/keep.txt`, enc('k'));

        // Act
        const outcome = await outcomeOf(
          applyChangeset(ctx, {
            changeset: makeChangeset([makeDelete('d/x', oldId), makeAdd('d', newId)]),
            force: false,
            workdir: WORKDIR,
          }),
        );

        // Assert
        expect(outcome).toMatchObject({ code: 'CHECKOUT_OVERWRITE_DIRTY', untracked: ['d'] });
        expect(await ctx.fs.exists(`${WORKDIR}/d/junk.o`)).toBe(true);
      });
    });
  });

  describe('Given d/x, a directory-only ignore rule build/ and an untracked FILE d/build, replaced by a file d', () => {
    describe('When applyChangeset runs without force', () => {
      it('Then the file is not mistaken for the ignored directory: it refuses listing d and keeps it', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, enc('x'));
        const newId = await writeBlob(ctx, enc('file'));
        await ctx.fs.write(`${WORKDIR}/.gitignore`, enc('build/\n'));
        await ctx.fs.write(`${WORKDIR}/d/x`, enc('x'));
        await ctx.fs.write(`${WORKDIR}/d/build`, enc('b'));

        // Act
        const outcome = await outcomeOf(
          applyChangeset(ctx, {
            changeset: makeChangeset([makeDelete('d/x', oldId), makeAdd('d', newId)]),
            force: false,
            workdir: WORKDIR,
          }),
        );

        // Assert
        expect(outcome).toMatchObject({ code: 'CHECKOUT_OVERWRITE_DIRTY', untracked: ['d'] });
        expect(dec(await ctx.fs.read(`${WORKDIR}/d/build`))).toBe('b');
      });
    });
  });

  describe('Given directories whose every file the changeset deletes, replaced by files', () => {
    describe('When applyChangeset runs without force', () => {
      it('Then the ignore rules are never read for the deleted files', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, enc('x'));
        const newId = await writeBlob(ctx, enc('file'));
        await ctx.fs.write(`${WORKDIR}/d1/x`, enc('x'));
        await ctx.fs.write(`${WORKDIR}/d2/x`, enc('x'));
        const buildSpy = vi.spyOn(ignoreEvaluatorMod, 'buildRepoIgnorePredicate');

        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([
            makeDelete('d1/x', oldId),
            makeDelete('d2/x', oldId),
            makeAdd('d1', newId),
            makeAdd('d2', newId),
          ]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(buildSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given several directories each holding a deleted file and an ignored file, replaced by files', () => {
    describe('When applyChangeset runs without force', () => {
      it('Then the ignore rules are built once for the clash check and once for the clearing', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, enc('x'));
        const newId = await writeBlob(ctx, enc('file'));
        await ctx.fs.write(`${WORKDIR}/.gitignore`, enc('*.o\n'));
        for (const dir of ['d1', 'd2', 'd3']) {
          await ctx.fs.write(`${WORKDIR}/${dir}/x`, enc('x'));
          await ctx.fs.write(`${WORKDIR}/${dir}/junk.o`, enc('j'));
        }
        const buildSpy = vi.spyOn(ignoreEvaluatorMod, 'buildRepoIgnorePredicate');
        const dirs = ['d1', 'd2', 'd3'];

        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([
            ...dirs.map((dir) => makeDelete(`${dir}/x`, oldId)),
            ...dirs.map((dir) => makeAdd(dir, newId)),
          ]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(buildSpy).toHaveBeenCalledTimes(2);
        expect(dec(await ctx.fs.read(`${WORKDIR}/d3`))).toBe('file');
      });
    });
  });

  describe('Given a directory holding an untracked file at a gitlink path, and a forced add of the gitlink', () => {
    describe('When applyChangeset runs', () => {
      it('Then the directory and its file are left alone, as git leaves a gitlink directory', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('0123456789012345678901234567890123456789'));
        await ctx.fs.write(`${WORKDIR}/sub/keep.txt`, enc('k'));
        const changeset = makeChangeset([makeAdd('sub', id, FILE_MODE.GITLINK)]);
        const sut = applyChangeset;

        // Act
        await sut(ctx, { changeset, force: true, workdir: WORKDIR });

        // Assert
        expect(dec(await ctx.fs.read(`${WORKDIR}/sub/keep.txt`))).toBe('k');
      });
    });
  });

  describe('Given an untracked symlink L to a directory holding an ignored file, and an add of L/x', () => {
    describe('When applyChangeset runs without force', () => {
      it('Then it refuses naming L, and the ignored file behind the link and the link stay', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const newId = await writeBlob(ctx, enc('x'));
        await ctx.fs.write(`${WORKDIR}/.gitignore`, enc('*.log\n'));
        await ctx.fs.write(`${WORKDIR}/inner/x/keep.log`, enc('k'));
        await ctx.fs.symlink('inner', `${WORKDIR}/L`);

        // Act
        const outcome = await outcomeOf(
          applyChangeset(ctx, {
            changeset: makeChangeset([makeAdd('L/x', newId)]),
            force: false,
            workdir: WORKDIR,
          }),
        );

        // Assert
        expect(outcome).toMatchObject({ code: 'CHECKOUT_OVERWRITE_DIRTY', untracked: ['L'] });
        expect(await ctx.fs.exists(`${WORKDIR}/inner/x/keep.log`)).toBe(true);
        expect((await ctx.fs.lstat(`${WORKDIR}/L`)).isSymbolicLink).toBe(true);
      });
    });
  });

  describe('Given an untracked symlink a/L and an add of a/L/x', () => {
    describe('When applyChangeset runs without force', () => {
      it('Then it refuses naming the symlinked component a/L', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const newId = await writeBlob(ctx, enc('x'));
        await ctx.fs.write(`${WORKDIR}/a/keep`, enc('k'));
        await ctx.fs.symlink('../inner', `${WORKDIR}/a/L`);

        // Act
        const outcome = await outcomeOf(
          applyChangeset(ctx, {
            changeset: makeChangeset([makeAdd('a/L/x', newId)]),
            force: false,
            workdir: WORKDIR,
          }),
        );

        // Assert
        expect(outcome).toMatchObject({ code: 'CHECKOUT_OVERWRITE_DIRTY', untracked: ['a/L'] });
      });
    });
  });

  describe('Given an untracked symlink L, a directory-only ignore rule L/, and an add of L/x', () => {
    describe('When applyChangeset runs without force', () => {
      it('Then it refuses naming L, as a directory-only rule never matches a link', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const newId = await writeBlob(ctx, enc('x'));
        await ctx.fs.write(`${WORKDIR}/.gitignore`, enc('L/\n'));
        await ctx.fs.mkdir(`${WORKDIR}/inner`);
        await ctx.fs.symlink('inner', `${WORKDIR}/L`);

        // Act
        const outcome = await outcomeOf(
          applyChangeset(ctx, {
            changeset: makeChangeset([makeAdd('L/x', newId)]),
            force: false,
            workdir: WORKDIR,
          }),
        );

        // Assert
        expect(outcome).toMatchObject({ code: 'CHECKOUT_OVERWRITE_DIRTY', untracked: ['L'] });
      });
    });
  });

  describe('Given an ignored symlink L to a directory holding an ignored file, and an add of L/x', () => {
    describe('When applyChangeset runs without force', () => {
      it('Then L becomes a directory holding x and the file behind the old link stays', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const newId = await writeBlob(ctx, enc('x'));
        await ctx.fs.write(`${WORKDIR}/.gitignore`, enc('*.log\nL\n'));
        await ctx.fs.write(`${WORKDIR}/inner/x/keep.log`, enc('k'));
        await ctx.fs.symlink('inner', `${WORKDIR}/L`);

        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([makeAdd('L/x', newId)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(dec(await ctx.fs.read(`${WORKDIR}/L/x`))).toBe('x');
        expect((await ctx.fs.lstat(`${WORKDIR}/L`)).isSymbolicLink).toBe(false);
        expect(dec(await ctx.fs.read(`${WORKDIR}/inner/x/keep.log`))).toBe('k');
      });
    });
  });

  describe('Given a tracked symlink L that the changeset deletes, and an add of L/x', () => {
    describe('When applyChangeset runs without force', () => {
      it('Then L becomes a directory holding x and the file behind the old link stays', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const linkId = await writeBlob(ctx, enc('inner'));
        const newId = await writeBlob(ctx, enc('x'));
        await ctx.fs.write(`${WORKDIR}/.gitignore`, enc('*.log\n'));
        await ctx.fs.write(`${WORKDIR}/inner/x/keep.log`, enc('k'));
        await ctx.fs.symlink('inner', `${WORKDIR}/L`);

        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([
            makeDelete('L', linkId, FILE_MODE.SYMLINK),
            makeAdd('L/x', newId),
          ]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(dec(await ctx.fs.read(`${WORKDIR}/L/x`))).toBe('x');
        expect(dec(await ctx.fs.read(`${WORKDIR}/inner/x/keep.log`))).toBe('k');
      });
    });
  });

  describe('Given an untracked symlink L to a directory holding an ignored file, and an add of L/x', () => {
    describe('When applyChangeset runs with force', () => {
      it('Then L becomes a directory holding x and the file behind the old link stays', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const newId = await writeBlob(ctx, enc('x'));
        await ctx.fs.write(`${WORKDIR}/.gitignore`, enc('*.log\n'));
        await ctx.fs.write(`${WORKDIR}/inner/x/keep.log`, enc('k'));
        await ctx.fs.symlink('inner', `${WORKDIR}/L`);

        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([makeAdd('L/x', newId)]),
          force: true,
          workdir: WORKDIR,
        });

        // Assert
        expect(dec(await ctx.fs.read(`${WORKDIR}/L/x`))).toBe('x');
        expect(dec(await ctx.fs.read(`${WORKDIR}/inner/x/keep.log`))).toBe('k');
      });
    });
  });

  describe('Given a directory d holding an ignored file and an untracked file, replaced by a file d', () => {
    describe('When applyChangeset runs with force', () => {
      it('Then every occupant gives way and d is written', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, enc('x'));
        const newId = await writeBlob(ctx, enc('file'));
        await ctx.fs.write(`${WORKDIR}/.gitignore`, enc('*.o\n'));
        await ctx.fs.write(`${WORKDIR}/d/x`, enc('x'));
        await ctx.fs.write(`${WORKDIR}/d/junk.o`, enc('j'));
        await ctx.fs.write(`${WORKDIR}/d/keep.txt`, enc('k'));

        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([makeDelete('d/x', oldId), makeAdd('d', newId)]),
          force: true,
          workdir: WORKDIR,
        });

        // Assert
        expect(dec(await ctx.fs.read(`${WORKDIR}/d`))).toBe('file');
      });
    });
  });

  describe('Given a directory d holding only an ignored file, replaced by a file d', () => {
    describe('When applyChangeset runs with force', () => {
      it('Then the ignored file gives way and d is written', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, enc('x'));
        const newId = await writeBlob(ctx, enc('file'));
        await ctx.fs.write(`${WORKDIR}/.gitignore`, enc('*.o\n'));
        await ctx.fs.write(`${WORKDIR}/d/x`, enc('x'));
        await ctx.fs.write(`${WORKDIR}/d/junk.o`, enc('j'));

        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([makeDelete('d/x', oldId), makeAdd('d', newId)]),
          force: true,
          workdir: WORKDIR,
        });

        // Assert
        expect(dec(await ctx.fs.read(`${WORKDIR}/d`))).toBe('file');
      });
    });
  });

  describe('Given an update with modified working-tree content and force=false', () => {
    describe('When applyChangeset runs', () => {
      it('Then throws CHECKOUT_OVERWRITE_DIRTY with the offending path', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, new TextEncoder().encode('original'));
        const newId = await writeBlob(ctx, new TextEncoder().encode('updated'));
        // working tree has LOCAL MOD (not the original content)
        await ctx.fs.write(`${WORKDIR}/mod.txt`, new TextEncoder().encode('local-edit'));
        // Act
        try {
          await applyChangeset(ctx, {
            changeset: makeChangeset([makeUpdate('mod.txt', oldId, newId)]),
            force: false,
            workdir: WORKDIR,
          });
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CHECKOUT_OVERWRITE_DIRTY');
          expect(err.data.code === 'CHECKOUT_OVERWRITE_DIRTY' && err.data.localChanges).toEqual([
            'mod.txt',
          ]);
        }
      });
    });
  });

  describe('Given an update with modified working-tree content but force=true', () => {
    describe('When applyChangeset runs', () => {
      it('Then overwrites the file', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, new TextEncoder().encode('original'));
        const newId = await writeBlob(ctx, new TextEncoder().encode('updated'));
        await ctx.fs.write(`${WORKDIR}/mod.txt`, new TextEncoder().encode('local-edit'));
        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([makeUpdate('mod.txt', oldId, newId)]),
          force: true,
          workdir: WORKDIR,
        });

        // Assert
        expect(new TextDecoder().decode(await ctx.fs.read(`${WORKDIR}/mod.txt`))).toBe('updated');
      });
    });
  });

  describe('Given an add entry whose target path is occupied by an untracked file and force=false', () => {
    describe('When applyChangeset runs', () => {
      it('Then throws CHECKOUT_OVERWRITE_DIRTY', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('new'));
        await ctx.fs.write(`${WORKDIR}/clash.txt`, new TextEncoder().encode('local'));
        // Act
        try {
          await applyChangeset(ctx, {
            changeset: makeChangeset([makeAdd('clash.txt', id)]),
            force: false,
            workdir: WORKDIR,
          });
          throw new Error('expected throw');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          // Assert
          expect(err.data.code).toBe('CHECKOUT_OVERWRITE_DIRTY');
        }
      });
    });
  });

  describe('Given a tracked-file read fails with PERMISSION_DENIED', () => {
    describe('When applyChangeset runs without force', () => {
      it('Then re-throws instead of silently overwriting', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('original'));
        await ctx.fs.write(`${WORKDIR}/secret.txt`, new TextEncoder().encode('original'));
        const wrappedCtx = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async (p: string): Promise<Uint8Array> => {
              if (p === `${WORKDIR}/secret.txt`) {
                throw new TsgitError({ code: 'PERMISSION_DENIED', path: p });
              }
              return ctx.fs.read(p);
            },
          },
        };

        // Act
        try {
          await applyChangeset(wrappedCtx, {
            changeset: makeChangeset([
              {
                kind: 'update',
                path: 'secret.txt' as FilePath,
                mode: FILE_MODE.REGULAR,
                id,
                previousId: id,
                previousMode: FILE_MODE.REGULAR,
              },
            ]),
            force: false,
            workdir: WORKDIR,
          });
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          expect((err as TsgitError).data.code).toBe('PERMISSION_DENIED');
        }
      });
    });
  });

  // no-dereference audit — this file covers site 1 (blobMatches) and the delete-skip.
  // Sites 2-6 are covered by their own isolated tests in
  // compare-working-tree-entry.test.ts, snapshot/workdir-entry.test.ts,
  // commands/blame.test.ts, commands/grep.test.ts and commands/stash.test.ts.
  // Two adjacent call sites were audited and are already correct, so they
  // carry no isolated test of their own: commands/add.ts's `readContent`
  // (if/else form) and commands/internal/working-tree.ts's `readFile` (a
  // bare `ctx.fs.read`, reachable only from add's own symlink-guarded path).
  describe('Given a 120000 (symlink) entry whose working-tree link target differs from the stored blob', () => {
    describe('When applyChangeset runs without force', () => {
      it('Then the entry is dirty and CHECKOUT_OVERWRITE_DIRTY is thrown, without reading the link target', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('/stored/target'));
        await ctx.fs.symlink('/different/target', `${WORKDIR}/link`);
        const readSpy = vi.spyOn(ctx.fs, 'read');

        // Act
        try {
          await applyChangeset(ctx, {
            changeset: makeChangeset([makeUpdate('link', id, id, FILE_MODE.SYMLINK)]),
            force: false,
            workdir: WORKDIR,
          });
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('CHECKOUT_OVERWRITE_DIRTY');
        }
        expect(readSpy).not.toHaveBeenCalledWith(`${WORKDIR}/link`);
      });
    });
  });

  describe('Given a 120000 (symlink) entry whose working-tree link target matches the stored blob', () => {
    describe('When applyChangeset runs without force', () => {
      it('Then the entry is not dirty and the checkout proceeds', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('/same/target'));
        await ctx.fs.symlink('/same/target', `${WORKDIR}/link`);

        // Act
        const result = await applyChangeset(ctx, {
          changeset: makeChangeset([makeUpdate('link', id, id, FILE_MODE.SYMLINK)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(result.written).toBe(1);
      });
    });
  });

  describe('Given a delete entry whose leading directory component is a symlink, and lstat on the resolved leaf would (on a real filesystem) succeed by following the link', () => {
    describe('When applyChangeset runs with force', () => {
      it('Then the removal is skipped without calling rm, and the symlink is left intact', async () => {
        // Arrange — dir is a symlink; simulate a real filesystem where lstat on
        // dir/file.txt would succeed by following the symlinked leading
        // component (git's exact hazard the delete-skip fix closes).
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('gone'));
        await ctx.fs.symlink('/outside/target', `${WORKDIR}/dir`);
        const leafPath = `${WORKDIR}/dir/file.txt`;
        const rmCalls: string[] = [];
        const wrappedCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            lstat: async (p: string) =>
              p === leafPath
                ? { ...(await ctx.fs.lstat(`${WORKDIR}/dir`)), isSymbolicLink: false }
                : ctx.fs.lstat(p),
            rm: async (p: string): Promise<void> => {
              rmCalls.push(p);
              return ctx.fs.rm(p);
            },
          },
        };

        // Act
        const result = await applyChangeset(wrappedCtx, {
          changeset: makeChangeset([makeDelete('dir/file.txt', id)]),
          force: true,
          workdir: WORKDIR,
        });

        // Assert
        expect(result.deleted).toBe(1);
        expect(rmCalls).toHaveLength(0);
        expect((await ctx.fs.lstat(`${WORKDIR}/dir`)).isSymbolicLink).toBe(true);
      });
    });
  });

  describe('Given the delete target lstat fails with PERMISSION_DENIED (not FILE_NOT_FOUND)', () => {
    describe('When applyChangeset runs with force', () => {
      it('Then the error propagates instead of being silently swallowed', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('doomed'));
        await ctx.fs.write(`${WORKDIR}/doomed.txt`, enc('doomed'));
        const wrappedCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            lstat: async (p: string) => {
              if (p === `${WORKDIR}/doomed.txt`) {
                throw new TsgitError({ code: 'PERMISSION_DENIED', path: p });
              }
              return ctx.fs.lstat(p);
            },
          },
        };

        // Act
        try {
          await applyChangeset(wrappedCtx, {
            changeset: makeChangeset([makeDelete('doomed.txt', id)]),
            force: true,
            workdir: WORKDIR,
          });
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('PERMISSION_DENIED');
        }
      });
    });
  });

  describe('Given a noop entry', () => {
    describe('When applyChangeset runs', () => {
      it('Then leaves the working tree unchanged and does not include the entry in writtenEntries', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('static'));
        await ctx.fs.write(`${WORKDIR}/keep.txt`, new TextEncoder().encode('static'));
        const noop: ChangesetEntry = {
          kind: 'noop',
          path: 'keep.txt' as FilePath,
          mode: FILE_MODE.REGULAR,
          id,
          previousId: id,
          previousMode: FILE_MODE.REGULAR,
        };
        // Act
        const result = await applyChangeset(ctx, {
          changeset: makeChangeset([noop]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(result.written).toBe(0);
        expect(result.deleted).toBe(0);
        expect(result.writtenEntries).toHaveLength(0);
      });

      it('Then does not report progress for it', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('untouched'));
        await ctx.fs.write(`${WORKDIR}/keep.txt`, new TextEncoder().encode('untouched'));
        const progressUpdate = vi.fn();
        const wrappedCtx: Context = {
          ...ctx,
          progress: { ...ctx.progress, update: progressUpdate },
        };
        const noop: ChangesetEntry = {
          kind: 'noop',
          path: 'keep.txt' as FilePath,
          mode: FILE_MODE.REGULAR,
          id,
          previousId: id,
          previousMode: FILE_MODE.REGULAR,
        };

        // Act
        await applyChangeset(wrappedCtx, {
          changeset: makeChangeset([noop]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(progressUpdate).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a workdir that ends with a slash', () => {
    describe('When applyChangeset runs an add', () => {
      it('Then joins the path without a doubled separator', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('joined'));
        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([makeAdd('nested.txt', id)]),
          force: false,
          workdir: '/repo/',
        });

        // Assert — exactly one separator: file lives at /repo/nested.txt, not /repo//nested.txt
        expect(await ctx.fs.exists('/repo/nested.txt')).toBe(true);
        expect(new TextDecoder().decode(await ctx.fs.read('/repo/nested.txt'))).toBe('joined');
      });
    });
  });

  describe('Given an update whose target file is missing (FILE_NOT_FOUND on read) and force=false', () => {
    describe('When applyChangeset runs', () => {
      it('Then treats it as non-dirty and applies without throwing', async () => {
        // Arrange — the no-follow presence probe reports the path occupied, but the
        // read that follows finds it gone (race-gone file)
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, new TextEncoder().encode('original'));
        const newId = await writeBlob(ctx, new TextEncoder().encode('updated'));
        const wrappedCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            lexists: async (p: string): Promise<boolean> =>
              p === `${WORKDIR}/gone.txt` ? true : (ctx.fs.lexists ?? ctx.fs.exists)(p),
            read: async (p: string): Promise<Uint8Array> => {
              if (p === `${WORKDIR}/gone.txt`) {
                throw new TsgitError({ code: 'FILE_NOT_FOUND', path: p });
              }
              return ctx.fs.read(p);
            },
          },
        };
        // Act
        const result = await applyChangeset(wrappedCtx, {
          changeset: makeChangeset([makeUpdate('gone.txt', oldId, newId)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert — no CHECKOUT_OVERWRITE_DIRTY, the update is applied
        expect(result.written).toBe(1);
        expect(new TextDecoder().decode(await ctx.fs.read(`${WORKDIR}/gone.txt`))).toBe('updated');
      });
    });
  });

  describe('Given an update whose target file is reported absent by the presence probe but readable', () => {
    describe('When applyChangeset runs without force', () => {
      it('Then treats it as non-dirty and does not throw', async () => {
        // Arrange — the presence probe says absent; blobMatches must NOT run for an absent file
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, new TextEncoder().encode('original'));
        const newId = await writeBlob(ctx, new TextEncoder().encode('updated'));
        // Working tree holds content that does NOT match previousId.
        const phantomPath = `${WORKDIR}/phantom.txt`;
        await ctx.fs.write(phantomPath, new TextEncoder().encode('mismatching-bytes'));
        // Only the pre-write dirty probe asks for presence — the post-write index-entry
        // lstat still sees the file applyChangeset itself just wrote.
        const wrappedCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            lexists: async (p: string): Promise<boolean> => p !== phantomPath,
          },
        };
        // Act — probe=absent short-circuits to non-dirty; no throw despite mismatching bytes
        const result = await applyChangeset(wrappedCtx, {
          changeset: makeChangeset([makeUpdate('phantom.txt', oldId, newId)]),
          force: false,
          workdir: WORKDIR,
        });
        // Assert
        expect(result.written).toBe(1);
      });
    });
  });

  describe('Given a delete entry with modified working-tree content and force=false', () => {
    describe('When applyChangeset runs', () => {
      it('Then throws CHECKOUT_OVERWRITE_DIRTY with the offending path', async () => {
        // Arrange — working tree holds local edits, not the recorded previousId content
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, new TextEncoder().encode('committed'));
        await ctx.fs.write(`${WORKDIR}/del.txt`, new TextEncoder().encode('local-edit'));
        // Act
        try {
          await applyChangeset(ctx, {
            changeset: makeChangeset([makeDelete('del.txt', oldId)]),
            force: false,
            workdir: WORKDIR,
          });
          throw new Error('expected throw');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          // Assert
          expect(err.data.code).toBe('CHECKOUT_OVERWRITE_DIRTY');
          expect(err.data.code === 'CHECKOUT_OVERWRITE_DIRTY' && err.data.localChanges).toEqual([
            'del.txt',
          ]);
        }
      });
    });
  });

  describe('Given a symlink add whose target path is occupied by an existing file', () => {
    describe('When applyChangeset runs with force', () => {
      it('Then removes the old file before creating the symlink', async () => {
        // Arrange — a regular file already occupies the symlink's path
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('./elsewhere'));
        await ctx.fs.write(`${WORKDIR}/lnk`, new TextEncoder().encode('stale-regular-file'));
        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([makeAdd('lnk', id, FILE_MODE.SYMLINK)]),
          force: true,
          workdir: WORKDIR,
        });

        // Assert — path is now a symlink (rm ran first, otherwise symlink would fail)
        expect(await ctx.fs.readlink(`${WORKDIR}/lnk`)).toBe('./elsewhere');
      });
    });
  });

  describe('Given an add entry with regular mode', () => {
    describe('When applyChangeset runs', () => {
      it('Then chmods the file to 0o644', async () => {
        // Arrange — capture the mode argument passed to chmod
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('plain'));
        const chmodMode = vi.fn<(path: string, mode: number) => Promise<void>>(
          async () => undefined,
        );
        const wrappedCtx: Context = {
          ...ctx,
          fs: { ...ctx.fs, chmod: chmodMode },
        };
        // Act
        await applyChangeset(wrappedCtx, {
          changeset: makeChangeset([makeAdd('plain.txt', id, FILE_MODE.REGULAR)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(chmodMode).toHaveBeenCalledWith(`${WORKDIR}/plain.txt`, 0o644);
      });
    });
  });

  describe('Given an lstat with sub-second ctime/mtime nanoseconds', () => {
    describe('When applyChangeset builds the index entry', () => {
      it('Then records seconds floored from ms and nanoseconds taken modulo one billion', async () => {
        // Arrange — controlled lstat values that distinguish * vs / vs % mutations
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('timed'));
        const fakeStat = (base: FileStat): FileStat => ({
          ...base,
          ctimeMs: 5000.9, // floor(/1000) => 5 ; *1000 would be 5_000_900
          mtimeMs: 9000.4, // floor(/1000) => 9
          ctimeNs: 7_000_000_123n, // % 1e9 => 123 ; * 1e9 would be huge
          mtimeNs: 4_000_000_456n, // % 1e9 => 456
        });
        const wrappedCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            lstat: async (p: string): Promise<FileStat> => fakeStat(await ctx.fs.lstat(p)),
          },
        };
        // Act
        const result = await applyChangeset(wrappedCtx, {
          changeset: makeChangeset([makeAdd('timed.txt', id)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        const entry = result.writtenEntries[0];
        expect(entry?.ctimeSeconds).toBe(5);
        expect(entry?.mtimeSeconds).toBe(9);
        expect(entry?.ctimeNanoseconds).toBe(123);
        expect(entry?.mtimeNanoseconds).toBe(456);
      });
    });
  });

  describe('Given an lstat without nanosecond precision', () => {
    describe('When applyChangeset builds the index entry', () => {
      it('Then defaults ctime/mtime nanoseconds to zero', async () => {
        // Arrange — ctimeNs/mtimeNs undefined exercises the `?? 0n` fallback
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('no-ns'));
        const wrappedCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            lstat: async (p: string): Promise<FileStat> => {
              const { ctimeNs: _ctimeNs, mtimeNs: _mtimeNs, ...rest } = await ctx.fs.lstat(p);
              return rest;
            },
          },
        };
        // Act
        const result = await applyChangeset(wrappedCtx, {
          changeset: makeChangeset([makeAdd('no-ns.txt', id)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert — `?? 0n` yields 0n; `&&` would yield undefined => NaN
        const entry = result.writtenEntries[0];
        expect(entry?.ctimeNanoseconds).toBe(0);
        expect(entry?.mtimeNanoseconds).toBe(0);
      });
    });
  });

  describe('Given a freshly written index entry', () => {
    describe('When applyChangeset builds it', () => {
      it('Then assumeValid is false', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('flagged'));
        // Act
        const result = await applyChangeset(ctx, {
          changeset: makeChangeset([makeAdd('flagged.txt', id)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(result.writtenEntries[0]?.flags.assumeValid).toBe(false);
      });
      it('Then skipWorktree and intentToAdd are false', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('extflag'));
        // Act
        const result = await applyChangeset(ctx, {
          changeset: makeChangeset([makeAdd('extflag.txt', id)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert — a fresh entry never carries extended flags
        expect(result.writtenEntries[0]?.flags.skipWorktree).toBe(false);
        expect(result.writtenEntries[0]?.flags.intentToAdd).toBe(false);
      });
    });
  });

  describe('Given a delete entry whose target file does not exist', () => {
    describe('When applyChangeset runs with force', () => {
      it('Then does not call rm and completes without throwing', async () => {
        // Arrange — no file on disk for the delete target
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('phantom'));
        // Act
        const result = await applyChangeset(ctx, {
          changeset: makeChangeset([makeDelete('absent.txt', id)]),
          force: true,
          workdir: WORKDIR,
        });

        // Assert — rm on a missing path would throw FILE_NOT_FOUND; the guard prevents it
        expect(result.deleted).toBe(1);
      });
    });
  });

  describe('Given multiple non-ASCII tracked paths whose byte order differs from UTF-16 order are all dirty and force=false', () => {
    describe('When applyChangeset runs', () => {
      it('Then localChanges is sorted by raw path bytes, not the changeset entry order', async () => {
        // Arrange — three names where the supplementary-plane emoji (UTF-8 lead
        // 0xF0) sorts AFTER the high-BMP private-use char (UTF-8 lead 0xEF) by
        // bytes, but BEFORE it by UTF-16 code units (its lead surrogate < 0xF8FF).
        // Entries are supplied in UTF-16 ascending order so a byte sort is observable.
        const cjk = 'f-\u{4E2D}.txt';
        const emoji = 'f-\u{1F600}.txt';
        const bmp = 'f-\u{F8FF}.txt';
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, new TextEncoder().encode('original'));
        const newId = await writeBlob(ctx, new TextEncoder().encode('updated'));
        for (const name of [cjk, emoji, bmp]) {
          await ctx.fs.write(`${WORKDIR}/${name}`, new TextEncoder().encode('local-edit'));
        }
        // Act
        try {
          await applyChangeset(ctx, {
            // Entry order = UTF-16 ascending (cjk, emoji, bmp).
            changeset: makeChangeset([
              makeUpdate(cjk, oldId, newId),
              makeUpdate(emoji, oldId, newId),
              makeUpdate(bmp, oldId, newId),
            ]),
            force: false,
            workdir: WORKDIR,
          });
          throw new Error('expected throw');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          // Assert — byte order swaps emoji and bmp relative to the UTF-16 entry order.
          expect(err.data.code).toBe('CHECKOUT_OVERWRITE_DIRTY');
          expect(err.data.code === 'CHECKOUT_OVERWRITE_DIRTY' && err.data.localChanges).toEqual([
            cjk,
            bmp,
            emoji,
          ]);
        }
      });
    });
  });

  describe('Given multiple non-ASCII untracked clash paths whose byte order differs from UTF-16 order and force=false', () => {
    describe('When applyChangeset runs', () => {
      it('Then untracked is sorted by raw path bytes, not the changeset entry order', async () => {
        // Arrange — same three names occupied by untracked files an add would clobber.
        const cjk = 'f-\u{4E2D}.txt';
        const emoji = 'f-\u{1F600}.txt';
        const bmp = 'f-\u{F8FF}.txt';
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('new'));
        for (const name of [cjk, emoji, bmp]) {
          await ctx.fs.write(`${WORKDIR}/${name}`, new TextEncoder().encode('squatter'));
        }
        // Act
        try {
          await applyChangeset(ctx, {
            changeset: makeChangeset([makeAdd(cjk, id), makeAdd(emoji, id), makeAdd(bmp, id)]),
            force: false,
            workdir: WORKDIR,
          });
          throw new Error('expected throw');
        } catch (err) {
          if (!(err instanceof TsgitError)) throw err;
          // Assert — byte order, not entry order.
          expect(err.data.code).toBe('CHECKOUT_OVERWRITE_DIRTY');
          expect(err.data.code === 'CHECKOUT_OVERWRITE_DIRTY' && err.data.untracked).toEqual([
            cjk,
            bmp,
            emoji,
          ]);
        }
      });
    });
  });

  describe('Given a mix of add and delete entries', () => {
    describe('When applyChangeset reports progress', () => {
      it('Then current counts written plus deleted and total sums add, update and delete stats', async () => {
        // Arrange — 1 add + 1 delete => after both, current must be 2 (written+deleted), total 2
        const ctx = await buildSeededContext();
        const addId = await writeBlob(ctx, new TextEncoder().encode('fresh'));
        const delId = await writeBlob(ctx, new TextEncoder().encode('stale'));
        await ctx.fs.write(`${WORKDIR}/old.txt`, new TextEncoder().encode('stale'));
        const progressUpdate =
          vi.fn<(op: string, current: number, total?: number, text?: string) => void>();
        const wrappedCtx: Context = {
          ...ctx,
          progress: { ...ctx.progress, update: progressUpdate },
        };
        // Act
        await applyChangeset(wrappedCtx, {
          changeset: makeChangeset([makeAdd('new.txt', addId), makeDelete('old.txt', delId)]),
          force: true,
          workdir: WORKDIR,
        });

        // Assert — last call: current = written(1) + deleted(1) = 2 ; total = add(1)+update(0)+delete(1) = 2
        const lastCall = progressUpdate.mock.calls.at(-1);
        expect(lastCall?.[1]).toBe(2);
        expect(lastCall?.[2]).toBe(2);
      });
    });
  });

  describe('Given an add entry that ticks progress', () => {
    describe('When applyChangeset reports progress', () => {
      it("Then the progress operation identifier is 'checkout:materialize'", async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('ticked'));
        const progressUpdate =
          vi.fn<(op: string, current: number, total?: number, text?: string) => void>();
        const wrappedCtx: Context = {
          ...ctx,
          progress: { ...ctx.progress, update: progressUpdate },
        };
        // Act
        await applyChangeset(wrappedCtx, {
          changeset: makeChangeset([makeAdd('ticked.txt', id)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert — op is the literal checkout materialize identifier, not an empty string
        const lastCall = progressUpdate.mock.calls.at(-1);
        expect(lastCall?.[0]).toBe('checkout:materialize');
      });
    });
  });

  describe('Given a regular (100644) add entry', () => {
    describe('When applyChangeset runs', () => {
      it('Then routes through locateBlob + writeWorkingTreeEntryStream and written file bytes match blob content', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('streamed content');
        const id = await writeBlob(ctx, content);
        const locateBlobSpy = vi.spyOn(blobSourceMod, 'locateBlob');
        const writeStreamSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeEntryStream');
        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([makeAdd('stream.txt', id, FILE_MODE.REGULAR)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(locateBlobSpy).toHaveBeenCalledOnce();
        expect(writeStreamSpy).toHaveBeenCalledOnce();
        const bytes = await ctx.fs.read(`${WORKDIR}/stream.txt`);
        expect(bytes).toEqual(content);

        locateBlobSpy.mockRestore();
        writeStreamSpy.mockRestore();
      });
    });
  });

  describe('Given an executable (100755) add entry', () => {
    describe('When applyChangeset runs', () => {
      it('Then routes through stream path and applies 0o755 mode', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('#!/bin/sh\n'));
        const locateBlobSpy = vi.spyOn(blobSourceMod, 'locateBlob');
        const writeStreamSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeEntryStream');
        const chmodSpy = vi.fn<(path: string, mode: number) => Promise<void>>(
          async () => undefined,
        );
        const wrappedCtx: Context = { ...ctx, fs: { ...ctx.fs, chmod: chmodSpy } };
        // Act
        await applyChangeset(wrappedCtx, {
          changeset: makeChangeset([makeAdd('exec.sh', id, FILE_MODE.EXECUTABLE)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(locateBlobSpy).toHaveBeenCalledOnce();
        expect(writeStreamSpy).toHaveBeenCalledOnce();
        expect(chmodSpy).toHaveBeenCalledWith(`${WORKDIR}/exec.sh`, 0o755);

        locateBlobSpy.mockRestore();
        writeStreamSpy.mockRestore();
      });
    });
  });

  describe('Given a symlink (120000) add entry', () => {
    describe('When applyChangeset runs', () => {
      it('Then routes through buffered readBlob + writeWorkingTreeEntry, not the stream path', async () => {
        // Arrange — mutant collapsing symlink into stream path must die here
        const ctx = await buildSeededContext();
        const target = '../target.txt';
        const id = await writeBlob(ctx, new TextEncoder().encode(target));
        const locateBlobSpy = vi.spyOn(blobSourceMod, 'locateBlob');
        const writeStreamSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeEntryStream');
        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([makeAdd('sym.link', id, FILE_MODE.SYMLINK)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert — buffered path, not stream path
        expect(locateBlobSpy).not.toHaveBeenCalled();
        expect(writeStreamSpy).not.toHaveBeenCalled();
        expect(await ctx.fs.readlink(`${WORKDIR}/sym.link`)).toBe(target);

        locateBlobSpy.mockRestore();
        writeStreamSpy.mockRestore();
      });
    });
  });

  describe('Given a gitlink (160000) add entry', () => {
    describe('When applyChangeset runs', () => {
      it('Then the gitlink arm is unchanged: creates directory, does not invoke locateBlob', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const locateBlobSpy = vi.spyOn(blobSourceMod, 'locateBlob');
        const writeStreamSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeEntryStream');
        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([makeAdd('sub', 'd'.repeat(40) as ObjectId, FILE_MODE.GITLINK)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert — gitlink arm: directory placeholder, no streaming
        const stat = await ctx.fs.lstat(`${WORKDIR}/sub`);
        expect(stat.isDirectory).toBe(true);
        expect(locateBlobSpy).not.toHaveBeenCalled();
        expect(writeStreamSpy).not.toHaveBeenCalled();

        locateBlobSpy.mockRestore();
        writeStreamSpy.mockRestore();
      });
    });
  });

  // ── Smudge filter (identity + active smudge + fallback) ─────────────────

  describe('Given a regular file add whose smudge runner is invoked exactly once', () => {
    describe('When applyChangeset runs', () => {
      it.each([
        {
          label: 'an active smudge filter succeeds, the smudged bytes are written',
          filterConfig: '[filter "myf"]\n\tsmudge = lowercase\n',
          exitCode: 0,
          expectedWritten: 'hello world',
        },
        {
          label:
            'an active smudge filter (required=false) fails, the raw blob bytes are written (fallback)',
          filterConfig: '[filter "myf"]\n\tsmudge = fail-cmd\n',
          exitCode: 1,
          expectedWritten: 'HELLO WORLD',
        },
        {
          label:
            'an active smudge filter (required=true) succeeds, the smudged bytes are written without throwing',
          filterConfig: '[filter "myf"]\n\tsmudge = lowercase\n\trequired = true\n',
          exitCode: 0,
          expectedWritten: 'hello world',
        },
      ])('Then $label', async ({ filterConfig, exitCode, expectedWritten }) => {
        // Arrange — blob contains uppercase; a successful smudge produces lowercase
        const ctx = await buildSeededContext();
        const blobContent = enc('HELLO WORLD');
        const id = await writeBlob(ctx, blobContent);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.y filter=myf\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, filterConfig);
        const runner = new FakeSmudgeRunner(exitCode, lowercase);
        const enrichedCtx: Context = { ...ctx, command: runner };
        // Act
        await applyChangeset(enrichedCtx, {
          changeset: makeChangeset([makeAdd('a.y', id)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        const written = await ctx.fs.read(`${WORKDIR}/a.y`);
        expect(dec(written)).toBe(expectedWritten);
        expect(runner.calls).toHaveLength(1);
      });
    });
  });

  describe('Given a regular file add with a clean-only filter (no smudge configured) and a runner', () => {
    describe('When applyChangeset runs with an identity smudge', () => {
      it('Then the worktree file contains the verbatim blob bytes and no command runs', async () => {
        // Arrange — clean-only filter: smudge is absent → identity
        const ctx = await buildSeededContext();
        const blobContent = enc('HELLO WORLD');
        const id = await writeBlob(ctx, blobContent);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.y filter=myf\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[filter "myf"]\n\tclean = uppercase\n',
        );
        const runner = new FakeSmudgeRunner(0, lowercase);
        const enrichedCtx: Context = { ...ctx, command: runner };
        // Act
        await applyChangeset(enrichedCtx, {
          changeset: makeChangeset([makeAdd('a.y', id)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        const written = await ctx.fs.read(`${WORKDIR}/a.y`);
        expect(dec(written)).toBe('HELLO WORLD');
        expect(runner.calls).toHaveLength(0);
      });
    });
  });

  describe('Given a required filter driver that smudges nothing', () => {
    describe.each([
      { label: 'only a clean command', config: '\tclean = uppercase\n' },
      {
        label: 'an empty process and a smudge command',
        config: '\tprocess =\n\tsmudge = lowercase\n',
      },
    ])('When applyChangeset checks out a file whose driver names $label', ({ config }) => {
      it('Then it dies SMUDGE_FILTER_FAILED as convert_to_working_tree does', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('HELLO WORLD'));
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.y filter=myf\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          `[filter "myf"]\n${config}\trequired = true\n`,
        );
        const enrichedCtx: Context = { ...ctx, command: new FakeSmudgeRunner(0, lowercase) };

        // Act
        const result = await applyChangeset(enrichedCtx, {
          changeset: makeChangeset([makeAdd('a.y', id)]),
          force: false,
          workdir: WORKDIR,
        }).catch((err: unknown) => err);

        // Assert
        expect((result as TsgitError).data).toEqual({
          code: 'SMUDGE_FILTER_FAILED',
          path: 'a.y',
          filter: 'myf',
        });
      });
    });
  });

  describe('Given a required filter driver configuring no command at all', () => {
    describe('When applyChangeset checks out a file', () => {
      it('Then the blob streams out untouched, as git never converts it in core', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('HELLO WORLD'));
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.y filter=myf\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[filter "myf"]\n\trequired = true\n',
        );
        const runner = new FakeSmudgeRunner(0, lowercase);

        // Act
        await applyChangeset(
          { ...ctx, command: runner },
          { changeset: makeChangeset([makeAdd('a.y', id)]), force: false, workdir: WORKDIR },
        );

        // Assert
        expect(dec(await ctx.fs.read(`${WORKDIR}/a.y`))).toBe('HELLO WORLD');
        expect(runner.calls).toHaveLength(0);
      });
    });
  });

  describe('Given a filter driver with a process advertising smudge', () => {
    describe('When applyChangeset checks out a file', () => {
      it('Then the process smudges it, asked with the path and blob id', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('HELLO WORLD'));
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.y filter=myf\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[filter "myf"]\n\tprocess = proc\n');
        const pkt = (text: string): string =>
          `${(text.length + 4).toString(16).padStart(4, '0')}${text}`;
        const response = enc(
          `${pkt('git-filter-server\n')}${pkt('version=2\n')}0000${pkt('capability=smudge\n')}0000` +
            `${pkt('status=success\n')}0000${pkt('hello world')}00000000`,
        );
        const { runner, requests } = scriptedCommandRunner(response);

        // Act
        await applyChangeset(
          { ...ctx, command: runner },
          { changeset: makeChangeset([makeAdd('a.y', id)]), force: false, workdir: WORKDIR },
        );

        // Assert
        expect(dec(await ctx.fs.read(`${WORKDIR}/a.y`))).toBe('hello world');
        expect(requests.map((r) => r.command)).toEqual(['proc']);
        expect(dec(requests[0]?.stdin ?? new Uint8Array(0))).toContain(
          `${pkt('command=smudge\n')}${pkt('pathname=a.y\n')}${pkt(`blob=${id}\n`)}0000`,
        );
      });
    });
  });

  describe('Given a process driver and checkout metadata', () => {
    describe('When applyChangeset smudges a file', () => {
      it('Then the process is told the ref and commit the checkout moves to', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('HELLO'));
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.y filter=myf\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[filter "myf"]\n\tprocess = proc\n');
        const pkt = (text: string): string =>
          `${(text.length + 4).toString(16).padStart(4, '0')}${text}`;
        const response = enc(
          `${pkt('git-filter-server\n')}${pkt('version=2\n')}0000${pkt('capability=smudge\n')}0000` +
            `${pkt('status=success\n')}0000${pkt('hello')}00000000`,
        );
        const { runner, requests } = scriptedCommandRunner(response);
        const treeish = 'c'.repeat(40) as ObjectId;
        const sut = applyChangeset;

        // Act
        await sut(
          { ...ctx, command: runner },
          {
            changeset: makeChangeset([makeAdd('a.y', id)]),
            force: false,
            workdir: WORKDIR,
            checkoutMetadata: { ref: 'refs/heads/main', treeish },
          },
        );

        // Assert
        expect(dec(requests[0]?.stdin ?? new Uint8Array(0))).toContain(
          `${pkt('pathname=a.y\n')}${pkt('ref=refs/heads/main\n')}${pkt(`treeish=${treeish}\n`)}`,
        );
      });
    });
  });

  describe('Given a context that cannot run commands', () => {
    describe('When applyChangeset checks out a file through a required smudge driver', () => {
      it('Then it refuses as git does when the driver cannot start, writing nothing', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('HELLO'));
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.t filter=d\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[filter "d"]\n\tsmudge = x\n\trequired = true\n',
        );
        const sut = applyChangeset;

        // Act
        const result = await outcomeOf(
          sut(ctx, {
            changeset: makeChangeset([makeAdd('a.t', id)]),
            force: false,
            workdir: WORKDIR,
          }),
        );

        // Assert
        expect(result).toEqual({ code: 'SMUDGE_FILTER_FAILED', path: 'a.t', filter: 'd' });
        expect(await ctx.fs.exists(`${WORKDIR}/a.t`)).toBe(false);
      });
    });

    describe('When applyChangeset checks out a file through an optional smudge driver', () => {
      it('Then the blob is written as stored', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('HELLO'));
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.t filter=d\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[filter "d"]\n\tsmudge = x\n');
        const sut = applyChangeset;

        // Act
        await sut(ctx, {
          changeset: makeChangeset([makeAdd('a.t', id)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(dec(await ctx.fs.read(`${WORKDIR}/a.t`))).toBe('HELLO');
      });
    });
  });

  describe('Given a process driver serving one of three files', () => {
    describe('When applyChangeset writes them', () => {
      it('Then it writes them one at a time in index order, as git does', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const filtered = await writeBlob(ctx, enc('HELLO'));
        const plain = await writeBlob(ctx, enc('plain'));
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.y filter=myf\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[filter "myf"]\n\tprocess = proc\n');
        const pkt = (text: string): string =>
          `${(text.length + 4).toString(16).padStart(4, '0')}${text}`;
        const response = enc(
          `${pkt('git-filter-server\n')}${pkt('version=2\n')}0000${pkt('capability=smudge\n')}0000` +
            `${pkt('status=success\n')}0000${pkt('hello')}00000000`,
        );
        const { runner } = scriptedCommandRunner(response);
        const sut = applyChangeset;

        // Act
        const result = await sut(
          { ...ctx, command: runner, concurrency: { cpuBound: 4, ioBound: 4 } },
          {
            changeset: makeChangeset([
              makeAdd('a.txt', plain),
              makeAdd('b.txt', plain),
              makeAdd('c.y', filtered),
            ]),
            force: false,
            workdir: WORKDIR,
          },
        );

        // Assert
        expect(result.writtenEntries.map((entry) => entry.path)).toEqual(['a.txt', 'b.txt', 'c.y']);
        expect(dec(await ctx.fs.read(`${WORKDIR}/c.y`))).toBe('hello');
      });
    });
  });

  describe.each([
    { label: 'no filter at all', config: '' },
    { label: 'only an empty process', config: '[filter "myf"]\n\tprocess =\n' },
  ])('Given a runner able to keep a process open and $label', ({ config }) => {
    describe('When applyChangeset writes two files', () => {
      it('Then both land with their stored bytes', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const first = await writeBlob(ctx, enc('first'));
        const second = await writeBlob(ctx, enc('second'));
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
        const { runner, requests } = scriptedCommandRunner(enc(''));
        const sut = applyChangeset;

        // Act
        const result = await sut(
          { ...ctx, command: runner },
          {
            changeset: makeChangeset([makeAdd('a.y', first), makeAdd('b.y', second)]),
            force: false,
            workdir: WORKDIR,
          },
        );

        // Assert
        expect(result.written).toBe(2);
        expect(dec(await ctx.fs.read(`${WORKDIR}/b.y`))).toBe('second');
        expect(requests).toEqual([]);
      });
    });
  });

  describe('Given a regular file add with an active smudge filter (required=true) and smudge exits non-zero', () => {
    describe('When applyChangeset runs', () => {
      it('Then throws SMUDGE_FILTER_FAILED with structured data and the worktree file is not written', async () => {
        // Arrange — smudge required=true; runner fails with exit 1
        const ctx = await buildSeededContext();
        const blobContent = enc('HELLO WORLD');
        const id = await writeBlob(ctx, blobContent);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.y filter=myf\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[filter "myf"]\n\tsmudge = fail-cmd\n\trequired = true\n',
        );
        const runner = new FakeSmudgeRunner(1);
        const enrichedCtx: Context = { ...ctx, command: runner };
        // Act — must throw
        let caught: unknown;
        try {
          await applyChangeset(enrichedCtx, {
            changeset: makeChangeset([makeAdd('a.y', id)]),
            force: false,
            workdir: WORKDIR,
          });
        } catch (err) {
          caught = err;
        }

        // Assert structured error
        expect(caught).toBeInstanceOf(TsgitError);
        const err = caught as TsgitError;
        expect(err.data.code).toBe('SMUDGE_FILTER_FAILED');
        expect((err.data as { exitCode: number }).exitCode).toBe(1);
        expect((err.data as { filter: string }).filter).toBe('myf');
        expect((err.data as { path: string }).path).toBe('a.y');

        // Worktree file must NOT be written
        const fileExists = await ctx.fs.exists(`${WORKDIR}/a.y`);
        expect(fileExists).toBe(false);
      });
    });
  });

  describe('Given an add whose path has NO matching .gitattributes but [filter "zed"].required holds a value git refuses', () => {
    describe('When applyChangeset runs with a command runner wired', () => {
      it('Then throws CONFIG_BAD_BOOLEAN_VALUE naming filter.zed.required — eager conversion validates every driver section', async () => {
        // Arrange — no .gitattributes at all; no attribute ever selects "zed".
        // A dropped eagerSectionValidation flag would let this resolve a
        // verdict instead of refusing.
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('content'));
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[filter "zed"]\n\trequired = maybe\n',
        );
        const runner = new FakeSmudgeRunner();
        const enrichedCtx: Context = { ...ctx, command: runner };

        // Act
        let caught: unknown;
        try {
          await applyChangeset(enrichedCtx, {
            changeset: makeChangeset([makeAdd('a.txt', id)]),
            force: false,
            workdir: WORKDIR,
          });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; key: string };
        expect(data.code).toBe('CONFIG_BAD_BOOLEAN_VALUE');
        expect(data.key).toBe('filter.zed.required');
      });
    });
  });

  describe('Given the subsectionless [filter] required holds a value git refuses (no attributes)', () => {
    describe('When applyChangeset runs with a command runner wired', () => {
      it('Then does NOT refuse — the subsectionless form stays inert even under eager validation', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('content'));
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[filter]\n\trequired = maybe\n');
        const runner = new FakeSmudgeRunner();
        const enrichedCtx: Context = { ...ctx, command: runner };

        // Act
        const result = await applyChangeset(enrichedCtx, {
          changeset: makeChangeset([makeAdd('a.txt', id)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(result.written).toBe(1);
      });
    });
  });

  describe('Given a regular file add with a filter attribute, an optional driver and no ctx.command', () => {
    describe('When applyChangeset runs', () => {
      it('Then the worktree file contains the verbatim blob bytes, the attribute provider now being built without a runner', async () => {
        // Arrange — no command in ctx
        const ctx = await buildSeededContext();
        const blobContent = enc('HELLO WORLD');
        const id = await writeBlob(ctx, blobContent);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.y filter=myf\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[filter "myf"]\n\tsmudge = lowercase\n',
        );
        // Act — ctx has no command
        await applyChangeset(ctx, {
          changeset: makeChangeset([makeAdd('a.y', id)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert — an optional driver that cannot start leaves the stored bytes
        const written = await ctx.fs.read(`${WORKDIR}/a.y`);
        expect(dec(written)).toBe('HELLO WORLD');
      });
    });
  });

  describe('Given a regular file add and no ctx.command wired (inert filter fallback)', () => {
    describe('When applyChangeset runs', () => {
      it('Then the attribute provider is never built', async () => {
        // Arrange — no filter runner: the per-entry provider must be skipped, not built
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('unfiltered'));
        const buildProviderSpy = vi.spyOn(readGitattributesMod, 'buildAttributeProvider');
        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([makeAdd('plain.txt', id)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert — with no command the guard skips provider construction entirely
        expect(buildProviderSpy).not.toHaveBeenCalled();

        buildProviderSpy.mockRestore();
      });
    });
  });

  describe('Given a gitlink add with an active smudge filter and a runner', () => {
    describe('When applyChangeset runs', () => {
      it('Then the gitlink arm is unchanged (not smudged): creates directory', async () => {
        // Arrange — gitlink mode must not be smudged (git smudges regular file content only)
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, 'sub filter=myf\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[filter "myf"]\n\tsmudge = lowercase\n',
        );
        const runner = new FakeSmudgeRunner(0, lowercase);
        const enrichedCtx: Context = { ...ctx, command: runner };
        // Act
        await applyChangeset(enrichedCtx, {
          changeset: makeChangeset([makeAdd('sub', 'd'.repeat(40) as ObjectId, FILE_MODE.GITLINK)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert — directory placeholder created; runner not invoked
        const stat = await ctx.fs.lstat(`${WORKDIR}/sub`);
        expect(stat.isDirectory).toBe(true);
        expect(runner.calls).toHaveLength(0);
      });
    });
  });

  describe('Given a symlink add with an active smudge filter and a runner', () => {
    describe('When applyChangeset runs', () => {
      it('Then the symlink arm is unchanged (not smudged): symlink target written verbatim', async () => {
        // Arrange — symlink mode must not be smudged (git filters file content, not link targets)
        const ctx = await buildSeededContext();
        const target = '../target.txt';
        const id = await writeBlob(ctx, enc(target));
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.link filter=myf\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[filter "myf"]\n\tsmudge = lowercase\n',
        );
        const runner = new FakeSmudgeRunner(0, lowercase);
        const enrichedCtx: Context = { ...ctx, command: runner };
        // Act
        await applyChangeset(enrichedCtx, {
          changeset: makeChangeset([makeAdd('a.link', id, FILE_MODE.SYMLINK)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert — symlink target is verbatim (not lowercased); runner not invoked
        expect(await ctx.fs.readlink(`${WORKDIR}/a.link`)).toBe(target);
        expect(runner.calls).toHaveLength(0);
      });
    });
  });

  describe('Given an add entry named `.GIT` (a `.git`-alias hostile name)', () => {
    describe('When applyChangeset runs', () => {
      it('Then throws INVALID_INDEX_ENTRY and writes nothing to the working tree', async () => {
        // Arrange — the checkout path mints IndexEntry records here; a
        // hostile target-tree entry must be refused before any write, the
        // same index-write boundary `build-index-from-tree.ts` enforces for
        // `reset --mixed`. `.GIT` (not the lowercase `.git` the seeded repo
        // already owns) keeps this a clean no-write witness.
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('hostile'));

        // Act
        let caught: unknown;
        try {
          await applyChangeset(ctx, {
            changeset: makeChangeset([makeAdd('.GIT', id)]),
            force: false,
            workdir: WORKDIR,
          });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('INVALID_INDEX_ENTRY');
        expect(await ctx.fs.exists(`${WORKDIR}/.GIT`)).toBe(false);
      });
    });
  });

  describe('Given an add entry x\\y', () => {
    const BACKSLASH_REASON = 'backslash rejected under Windows path syntax';

    describe('When applyChangeset runs under Windows path syntax', () => {
      it('Then throws INVALID_INDEX_ENTRY with the backslash reason and writes nothing', async () => {
        // Arrange
        const seeded = await buildSeededContext();
        const ctx = { ...seeded, windowsPathSyntax: true };
        const id = await writeBlob(ctx, new TextEncoder().encode('hostile'));

        // Act
        let caught: unknown;
        try {
          await applyChangeset(ctx, {
            changeset: makeChangeset([makeAdd('x\\y', id)]),
            force: false,
            workdir: WORKDIR,
          });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data).toStrictEqual({
          code: 'INVALID_INDEX_ENTRY',
          offset: -1,
          reason: BACKSLASH_REASON,
        });
        expect(await ctx.fs.exists(`${WORKDIR}/x\\y`)).toBe(false);
      });
    });

    describe('When applyChangeset runs under POSIX path syntax', () => {
      it('Then writes the file', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('plain'));

        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([makeAdd('x\\y', id)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(await ctx.fs.exists(`${WORKDIR}/x\\y`)).toBe(true);
      });
    });
  });

  describe('Given a delete entry x\\y from a parsed index', () => {
    describe('When applyChangeset runs under Windows path syntax', () => {
      it('Then it removes the file without verifying the path', async () => {
        // Arrange
        const seeded = await buildSeededContext();
        const ctx = { ...seeded, windowsPathSyntax: true };
        const bytes = new TextEncoder().encode('tracked');
        const id = await writeBlob(ctx, bytes);
        await ctx.fs.write(`${WORKDIR}/x\\y`, bytes);

        // Act
        await applyChangeset(ctx, {
          changeset: makeChangeset([makeDelete('x\\y', id)]),
          force: true,
          workdir: WORKDIR,
        });

        // Assert
        expect(await ctx.fs.exists(`${WORKDIR}/x\\y`)).toBe(false);
      });
    });
  });

  describe('Given a changeset whose LAST entry is hostile and earlier entries are safe', () => {
    describe('When applyChangeset runs', () => {
      it('Then refuses before writing any entry (checks nothing out)', async () => {
        // Arrange — mirrors git's unpack_trees: the whole target is
        // validated before the first file is written, so one hostile
        // tree entry anywhere in a clone/checkout leaves the working tree
        // untouched rather than partially populated.
        const ctx = await buildSeededContext();
        const safeId = await writeBlob(ctx, new TextEncoder().encode('safe'));
        const hostileId = await writeBlob(ctx, new TextEncoder().encode('hostile'));

        // Act
        let caught: unknown;
        try {
          await applyChangeset(ctx, {
            changeset: makeChangeset([makeAdd('safe.txt', safeId), makeAdd('git~1', hostileId)]),
            force: false,
            workdir: WORKDIR,
          });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('INVALID_INDEX_ENTRY');
        expect(await ctx.fs.exists(`${WORKDIR}/safe.txt`)).toBe(false);
      });
    });
  });

  describe('Given an update entry whose new path is a `.gitmodules` symlink', () => {
    describe('When applyChangeset runs', () => {
      it('Then throws INVALID_INDEX_ENTRY with the gitmodules-not-regular reason', async () => {
        // Arrange — CVE-2018-11235 hardening on the checkout write path.
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, new TextEncoder().encode('[submodule]'));
        const newId = await writeBlob(ctx, new TextEncoder().encode('../outside'));

        // Act
        let caught: unknown;
        try {
          await applyChangeset(ctx, {
            changeset: makeChangeset([makeUpdate('.gitmodules', oldId, newId, FILE_MODE.SYMLINK)]),
            force: false,
            workdir: WORKDIR,
          });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data).toEqual({
          code: 'INVALID_INDEX_ENTRY',
          offset: -1,
          reason: "'.gitmodules' must not be a symlink",
        });
      });
    });
  });

  describe('Given more add entries than the ioBound limit', () => {
    describe('When applyChangeset writes them', () => {
      it('Then at most ioBound writes are in flight at once', async () => {
        // Arrange — an explicit ioBound distinct from cpuBound so a
        // bucket-swap regression (deriving the write pool from the wrong
        // bucket) fails loudly.
        const ioBound = 3;
        const width = ioBound + 4;
        const base = await buildSeededContext();
        const entries: ChangesetEntry[] = [];
        for (let i = 0; i < width; i += 1) {
          const id = await writeBlob(base, new TextEncoder().encode(`content-${i}`));
          entries.push(makeAdd(`f${i}.txt`, id));
        }
        const ctx: Context = { ...base, concurrency: { cpuBound: 1, ioBound } };
        // The pool's genuine per-entry concurrency window spans reading the
        // blob through writing it — `locateBlob`'s loose stream arm now
        // pulls real (natively-scheduled) inflate output before it resolves,
        // so a window that starts only at the write call can land entirely
        // inside one entry's already-finished read and under-count.
        let inFlight = 0;
        let maxInFlight = 0;
        const realStream = blobSourceMod.locateBlob;
        const streamSpy = vi
          .spyOn(blobSourceMod, 'locateBlob')
          .mockImplementation(async (...args) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            return realStream(...args);
          });
        const realWrite = writeFileMod.writeWorkingTreeEntryStream;
        const writeSpy = vi
          .spyOn(writeFileMod, 'writeWorkingTreeEntryStream')
          .mockImplementation(async (...args) => {
            const result = await realWrite(...args);
            inFlight -= 1;
            return result;
          });

        // Act
        try {
          await applyChangeset(ctx, {
            changeset: makeChangeset(entries),
            force: false,
            workdir: WORKDIR,
          });

          // Assert
          expect(maxInFlight).toBe(ioBound);
        } finally {
          streamSpy.mockRestore();
          writeSpy.mockRestore();
        }
      });
    });
  });

  describe('Given entries whose writes complete out of changeset order under a pool', () => {
    describe('When applyChangeset reports progress', () => {
      it('Then current is strictly monotone', async () => {
        // Arrange — the FIRST entry's write resolves slower than every other
        // one, so it finishes LAST even though it is first in changeset
        // order. A `current` derived from an entry's position (rather than a
        // shared completion counter) would report it out of sequence here.
        const ioBound = 3;
        const width = ioBound + 4;
        const base = await buildSeededContext();
        const entries: ChangesetEntry[] = [];
        for (let i = 0; i < width; i += 1) {
          const id = await writeBlob(base, new TextEncoder().encode(`content-${i}`));
          entries.push(makeAdd(`f${i}.txt`, id));
        }
        const ctx: Context = { ...base, concurrency: { cpuBound: 1, ioBound } };
        const realWrite = writeFileMod.writeWorkingTreeEntryStream;
        // Gated, not timed: f0.txt's write is held open until every OTHER
        // entry has already landed, so it is deterministically last — a
        // fixed setTimeout race could flake if scheduling ever let f0.txt's
        // own write win the race instead.
        let othersCompleted = 0;
        let releaseF0: (() => void) | undefined;
        const f0Gate = new Promise<void>((resolve) => {
          releaseF0 = resolve;
        });
        const spy = vi
          .spyOn(writeFileMod, 'writeWorkingTreeEntryStream')
          .mockImplementation(async (...args) => {
            const targetPath = args[1];
            if (targetPath === 'f0.txt') {
              await f0Gate;
              return realWrite(...args);
            }
            const result = await realWrite(...args);
            othersCompleted += 1;
            if (othersCompleted === width - 1) releaseF0?.();
            return result;
          });
        const progressUpdate =
          vi.fn<(op: string, current: number, total?: number, text?: string) => void>();
        const wrappedCtx: Context = {
          ...ctx,
          progress: { ...ctx.progress, update: progressUpdate },
        };

        // Act
        try {
          await applyChangeset(wrappedCtx, {
            changeset: makeChangeset(entries),
            force: false,
            workdir: WORKDIR,
          });
        } finally {
          spy.mockRestore();
        }

        // Assert — strictly increasing 1..width, with no gaps or repeats,
        // and the deliberately-delayed entry lands last.
        const currents = progressUpdate.mock.calls.map((call) => call[1]);
        expect(currents).toEqual(Array.from({ length: width }, (_unused, i) => i + 1));
        expect(progressUpdate.mock.calls.at(-1)?.[3]).toBe('f0.txt');
      });
    });
  });

  describe('Given an entry whose write is still pending in a pooled changeset', () => {
    describe('When applyChangeset reports progress for the entries that already finished', () => {
      it("Then the pending entry's path is not yet reported in progress text", async () => {
        // Arrange — three entries share one pool; two resolve immediately,
        // the third is held open by a manual gate so its write is still
        // pending when progress is inspected.
        const ioBound = 3;
        const base = await buildSeededContext();
        const idA = await writeBlob(base, new TextEncoder().encode('a'));
        const idB = await writeBlob(base, new TextEncoder().encode('b'));
        const idPending = await writeBlob(base, new TextEncoder().encode('pending'));
        const ctx: Context = { ...base, concurrency: { cpuBound: 1, ioBound } };
        let releasePending: (() => void) | undefined;
        const realWrite = writeFileMod.writeWorkingTreeEntryStream;
        const spy = vi
          .spyOn(writeFileMod, 'writeWorkingTreeEntryStream')
          .mockImplementation(async (...args) => {
            const targetPath = args[1];
            if (targetPath === 'pending.txt') {
              await new Promise<void>((resolve) => {
                releasePending = resolve;
              });
            }
            return realWrite(...args);
          });
        const progressUpdate =
          vi.fn<(op: string, current: number, total?: number, text?: string) => void>();
        const wrappedCtx: Context = {
          ...ctx,
          progress: { ...ctx.progress, update: progressUpdate },
        };
        // Polls rather than a fixed delay: the memory adapter's decompress
        // chain (Web `DecompressionStream`) crosses real event-loop ticks,
        // so a single microtask flush is not always enough for a.txt/b.txt
        // to land — but they must land well inside this bound while
        // pending.txt's gate stays shut.
        const waitUntilBothLanded = async (): Promise<void> => {
          const deadline = Date.now() + 2000;
          while (progressUpdate.mock.calls.length < 2) {
            if (Date.now() > deadline) throw new Error('timed out waiting for a.txt/b.txt');
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        };

        // Act
        const pending = applyChangeset(wrappedCtx, {
          changeset: makeChangeset([
            makeAdd('a.txt', idA),
            makeAdd('b.txt', idB),
            makeAdd('pending.txt', idPending),
          ]),
          force: false,
          workdir: WORKDIR,
        });
        await waitUntilBothLanded();

        // Assert — a.txt/b.txt already landed and reported; pending.txt's
        // write has started but not finished, so it must not appear yet.
        const textsBeforeRelease = progressUpdate.mock.calls.map((call) => call[3]);
        expect(textsBeforeRelease).toHaveLength(2);
        expect(textsBeforeRelease).not.toContain('pending.txt');

        // Cleanup — release the gate and let the call settle.
        releasePending?.();
        await pending;
        spy.mockRestore();
        expect(progressUpdate.mock.calls.map((call) => call[3])).toContain('pending.txt');
      });
    });
  });

  describe('Given a delete entry for a plain file and an add entry for a path beneath its former location', () => {
    describe('When applyChangeset runs', () => {
      it('Then the delete completes before the add write starts', async () => {
        // Arrange — the target tree drops the tracked file at 'dir' and adds
        // 'dir/child.txt' beneath it. Writing the child before the delete
        // lands throws: the working-tree write auto-creates 'dir' as a
        // directory, which fails while 'dir' still exists as a file.
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(`${WORKDIR}/dir`, 'old file content');
        const delId = await writeBlob(ctx, new TextEncoder().encode('old file content'));
        const addId = await writeBlob(ctx, new TextEncoder().encode('child content'));

        // Act
        const result = await applyChangeset(ctx, {
          changeset: makeChangeset([makeDelete('dir', delId), makeAdd('dir/child.txt', addId)]),
          force: true,
          workdir: WORKDIR,
        });

        // Assert — no thrown NOT_A_DIRECTORY: the delete wave fully drained
        // before the write wave started.
        expect(result.deleted).toBe(1);
        expect(result.written).toBe(1);
        const bytes = await ctx.fs.read(`${WORKDIR}/dir/child.txt`);
        expect(new TextDecoder().decode(bytes)).toBe('child content');
      });
    });
  });

  describe('Given a changeset whose entries are not in path-sorted order', () => {
    describe('When applyChangeset refuses the checkout', () => {
      it('Then the refusal array is byte-sorted, not changeset-entry order', async () => {
        // Arrange — entries are dispatched and collected in THIS order by a
        // pool that preserves input order (boundedMap); feeding
        // already-sorted input would make the trailing `.sort(comparePaths)`
        // a no-op and never actually exercise it. `c.txt` first, `a.txt`
        // last proves the sort — not input order — decides the result.
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, new TextEncoder().encode('original'));
        const newId = await writeBlob(ctx, new TextEncoder().encode('updated'));
        await ctx.fs.write(`${WORKDIR}/a.txt`, new TextEncoder().encode('local-edit'));
        await ctx.fs.write(`${WORKDIR}/b.txt`, new TextEncoder().encode('local-edit'));
        await ctx.fs.write(`${WORKDIR}/c.txt`, new TextEncoder().encode('local-edit'));

        // Act
        let caught: unknown;
        try {
          await applyChangeset(ctx, {
            changeset: makeChangeset([
              makeUpdate('c.txt', oldId, newId),
              makeUpdate('a.txt', oldId, newId),
              makeUpdate('b.txt', oldId, newId),
            ]),
            force: false,
            workdir: WORKDIR,
          });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code === 'CHECKOUT_OVERWRITE_DIRTY' && data.localChanges).toEqual([
          'a.txt',
          'b.txt',
          'c.txt',
        ]);
      });
    });
  });

  describe('Given a required smudge filter that fails while a sibling write is still pending in the same pool', () => {
    describe('When applyChangeset runs', () => {
      it('Then the sibling write lands before the rejection is observed — the pool is drained, not raced', async () => {
        // Arrange — a.y's smudge fails immediately (required=true, exit 1);
        // sibling.txt's write is held open by a manual gate. Draining the
        // pool before rethrowing (the fix) means applyChangeset's returned
        // promise cannot settle until the gate is released and sibling.txt
        // has actually landed; racing (the bug) lets the smudge rejection
        // propagate immediately, while sibling.txt — still in flight in a
        // sibling pool slot — has not completed.
        const ctx = await buildSeededContext();
        const failId = await writeBlob(ctx, enc('HELLO WORLD'));
        const okId = await writeBlob(ctx, enc('sibling content'));
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.y filter=myf\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[filter "myf"]\n\tsmudge = fail-cmd\n\trequired = true\n',
        );
        const runner = new FakeSmudgeRunner(1);
        const enrichedCtx: Context = {
          ...ctx,
          command: runner,
          concurrency: { cpuBound: 1, ioBound: 2 },
        };
        let releaseSibling: (() => void) | undefined;
        const siblingGate = new Promise<void>((resolve) => {
          releaseSibling = resolve;
        });
        const realWrite = writeFileMod.writeWorkingTreeEntryStream;
        const spy = vi
          .spyOn(writeFileMod, 'writeWorkingTreeEntryStream')
          .mockImplementation(async (...args) => {
            const targetPath = args[1];
            if (targetPath === 'sibling.txt') await siblingGate;
            return realWrite(...args);
          });

        // Act
        let settled = false;
        const pending = applyChangeset(enrichedCtx, {
          changeset: makeChangeset([makeAdd('a.y', failId), makeAdd('sibling.txt', okId)]),
          force: false,
          workdir: WORKDIR,
        });
        pending.catch(() => {
          settled = true;
        });
        const waitUntilSmudgeAttempted = async (): Promise<void> => {
          const deadline = Date.now() + 2000;
          while (runner.calls.length < 1) {
            if (Date.now() > deadline) throw new Error('timed out waiting for the smudge attempt');
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        };
        await waitUntilSmudgeAttempted();
        // A few more microtask turns for the rejection to propagate through
        // resolveFilterDriver/runFilterDriver/applyWriteEntry — still short
        // of anything that could let the deliberately-gated sibling resolve.
        await Promise.resolve();
        await Promise.resolve();

        // Assert — pre-release: the smudge already failed but the sibling's
        // write is still gated, so a draining implementation must not have
        // settled the overall promise yet.
        expect(settled).toBe(false);
        expect(await ctx.fs.exists(`${WORKDIR}/sibling.txt`)).toBe(false);

        // Cleanup — release the gate and let the call settle.
        releaseSibling?.();
        let caught: unknown;
        try {
          await pending;
        } catch (err) {
          caught = err;
        }
        spy.mockRestore();

        // Assert — the sibling write landed before the rejection surfaced.
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('SMUDGE_FILTER_FAILED');
        expect(await ctx.fs.exists(`${WORKDIR}/sibling.txt`)).toBe(true);
      });
    });
  });

  describe('Given two changeset add entries whose paths differ only by case', () => {
    describe('When applyChangeset writes them', () => {
      it('Then the case-colliding writes never run concurrently with each other', async () => {
        // Arrange — 'Colliding.txt' and 'colliding.txt' are legal, distinct
        // target-tree entries that collide to the SAME name on a
        // case-insensitive filesystem; a pool that dispatches every entry
        // independently could interleave both writes against the one
        // underlying path.
        const ctx = await buildSeededContext();
        const idUpper = await writeBlob(ctx, enc('upper'));
        const idLower = await writeBlob(ctx, enc('lower'));
        const wrappedCtx: Context = {
          ...ctx,
          concurrency: { cpuBound: 1, ioBound: 2 },
        };
        let active = 0;
        let sawOverlap = false;
        let firstHeld = false;
        let releaseFirst: (() => void) | undefined;
        const firstGate = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        const realWrite = writeFileMod.writeWorkingTreeEntryStream;
        const spy = vi
          .spyOn(writeFileMod, 'writeWorkingTreeEntryStream')
          .mockImplementation(async (...args) => {
            const targetPath = args[1] as string;
            if (targetPath.toLowerCase() !== 'colliding.txt') return realWrite(...args);
            active += 1;
            if (active > 1) sawOverlap = true;
            // Only the FIRST colliding write is held open — grouping must
            // not let the SECOND one start while this is still outstanding.
            if (!firstHeld) {
              firstHeld = true;
              await firstGate;
            }
            active -= 1;
            return realWrite(...args);
          });

        // Act
        const pending = applyChangeset(wrappedCtx, {
          changeset: makeChangeset([
            makeAdd('Colliding.txt', idUpper),
            makeAdd('colliding.txt', idLower),
          ]),
          force: true,
          workdir: WORKDIR,
        });
        // Bounded, real-time window for an (ungrouped) pool to also dispatch
        // the second colliding write while the first is still held open —
        // the gate is always released after this, so the test cannot hang.
        await new Promise((resolve) => setTimeout(resolve, 50));
        releaseFirst?.();
        try {
          await pending;
        } finally {
          spy.mockRestore();
        }

        // Assert
        expect(sawOverlap).toBe(false);
      });
    });
  });

  describe('Given several add entries whose paths all match an active smudge filter', () => {
    describe('When applyChangeset writes them under a wide ioBound but a narrow cpuBound', () => {
      it('Then the smudge subprocess never runs more than cpuBound at once', async () => {
        // Arrange — P10: a smudge filter spawns a subprocess (CPU/process
        // bound), so it must be gated behind cpuBound rather than
        // inheriting the write wave's wider ioBound budget.
        const ctx = await buildSeededContext();
        const ids = await Promise.all(
          Array.from({ length: 4 }, (_unused, i) => writeBlob(ctx, enc(`content-${i}`))),
        );
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.y filter=myf\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[filter "myf"]\n\tsmudge = lowercase\n',
        );
        let active = 0;
        let maxActive = 0;
        class TrackingRunner implements CommandRunner {
          async run(request: CommandRequest): Promise<CommandResult> {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;
            return { exitCode: 0, stdout: request.stdin ?? new Uint8Array(0) };
          }
        }
        const runner = new TrackingRunner();
        const enrichedCtx: Context = {
          ...ctx,
          command: runner,
          concurrency: { cpuBound: 1, ioBound: 4 },
        };
        const entries = ids.map((id, i) => makeAdd(`f${i}.y`, id));

        // Act
        await applyChangeset(enrichedCtx, {
          changeset: makeChangeset(entries),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(maxActive).toBe(1);
      });
    });
  });

  describe('Given an unreadable alternate and a single small packed blob entry', () => {
    describe('When applyChangeset', () => {
      it('Then the file exists with size 0 and the call rejects with the alternate error', async () => {
        // Arrange
        const ctx = createMemoryContext({
          files: {
            '/repo/.git/objects/info/alternates': new TextEncoder().encode('/repo/alt/objects\n'),
          },
        });
        await ctx.fs.mkdir('/repo/alt/objects');
        await ctx.fs.write(
          '/repo/alt/objects/pack/multi-pack-index',
          Uint8Array.from([0x00, 0x49, 0x44, 0x58, 1, 1, 1, 0, ...new Array(8).fill(0)]),
        );
        const id = 'b'.repeat(40) as ObjectId;
        const path = `${WORKDIR}/small.txt`;

        // Act
        const attempt = applyChangeset(ctx, {
          changeset: makeChangeset([makeAdd('small.txt', id, FILE_MODE.REGULAR)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        await expect(attempt).rejects.toMatchObject({ data: { code: 'INVALID_MULTI_PACK_INDEX' } });
        expect((await ctx.fs.read(path)).length).toBe(0);
      });
    });
  });
});

describe('applyChangeset write order under a long-running filter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  interface WriteTrace {
    readonly phases: ReadonlyArray<'start' | 'write'>;
    readonly written: ReadonlyArray<string>;
  }

  // Phases rather than paths: a concurrent wave writes in completion order,
  // but every entry has started before the first one writes.
  const traceWritesUnder = async (config: string, spawns: boolean): Promise<WriteTrace> => {
    const base = createMemoryContext({ files: { '/repo/.git/config': enc(config) } });
    const ctx = spawns
      ? { ...base, command: scriptedCommandRunner(new Uint8Array(0)).runner }
      : base;
    const ids = [await writeBlob(ctx, enc('zz')), await writeBlob(ctx, enc('mm'))];
    const phases: Array<'start' | 'write'> = [];
    const written: string[] = [];
    const realStart = writeFileMod.writeWorkingTreeEntryStream;
    vi.spyOn(writeFileMod, 'writeWorkingTreeEntryStream').mockImplementation((...args) => {
      phases.push('start');
      return realStart(...args);
    });
    const realWrite = ctx.fs.writeStream.bind(ctx.fs);
    vi.spyOn(ctx.fs, 'writeStream').mockImplementation(async (path, chunks) => {
      phases.push('write');
      written.push(path);
      await realWrite(path, chunks);
    });
    const changeset = makeChangeset([
      makeAdd('z', ids[0] as ObjectId),
      makeAdd('m', ids[1] as ObjectId),
    ]);
    const sut = applyChangeset;
    await sut(ctx, { changeset, force: false, workdir: WORKDIR });
    return { phases, written };
  };

  const SERIAL: WriteTrace = {
    phases: ['start', 'write', 'start', 'write'],
    written: [`${WORKDIR}/m`, `${WORKDIR}/z`],
  };
  const CONCURRENT = {
    phases: ['start', 'start', 'write', 'write'],
    written: expect.arrayContaining([`${WORKDIR}/m`, `${WORKDIR}/z`]),
  };

  describe.each([
    {
      name: 'one driver with a process on a runner that can spawn',
      config: '[filter "a"]\n\tprocess = proc\n',
      spawns: true,
      expected: SERIAL,
    },
    {
      name: 'a driver without a process beside one with a process',
      config: '[filter "a"]\n\tclean = cat\n[filter "b"]\n\tprocess = proc\n',
      spawns: true,
      expected: SERIAL,
    },
    {
      name: 'a driver with a process on a runner that cannot spawn',
      config: '[filter "a"]\n\tprocess = proc\n',
      spawns: false,
      expected: CONCURRENT,
    },
    {
      name: 'only a driver without a process',
      config: '[filter "a"]\n\tclean = cat\n',
      spawns: true,
      expected: CONCURRENT,
    },
    {
      name: 'only a driver whose process is empty',
      config: '[filter "a"]\n\tprocess =\n',
      spawns: true,
      expected: CONCURRENT,
    },
  ])('Given $name', ({ config, spawns, expected }) => {
    describe('When applyChangeset writes entries given out of path order', () => {
      it('Then the writes are ordered as git checks the entries out', async () => {
        // Arrange
        const sut = traceWritesUnder;

        // Act
        const result = await sut(config, spawns);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });
});

describe('applyChangeset dirty probe under line-ending conversion', () => {
  const autocrlfContext = async (): Promise<Context> => {
    const ctx = await buildSeededContext();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tautocrlf = true\n');
    invalidateConfigCache(ctx);
    return ctx;
  };

  describe('Given core.autocrlf true, an LF blob checked out as CRLF and a switch that rewrites the path', () => {
    describe('When applyChangeset runs not forced', () => {
      it('Then there is no would-overwrite refusal and the new blob lands as CRLF', async () => {
        // Arrange
        const ctx = await autocrlfContext();
        const oldId = await writeBlob(ctx, enc('a\nb\n'));
        const newId = await writeBlob(ctx, enc('c\nd\n'));
        await ctx.fs.write(`${WORKDIR}/f.txt`, enc('a\r\nb\r\n'));
        const changeset = makeChangeset([makeUpdate('f.txt', oldId, newId)]);

        // Act
        await applyChangeset(ctx, { changeset, force: false, workdir: WORKDIR });

        // Assert
        expect(dec(await ctx.fs.read(`${WORKDIR}/f.txt`))).toBe('c\r\nd\r\n');
      });
    });
  });

  describe('Given core.autocrlf true and a CRLF file edited after checkout', () => {
    describe('When applyChangeset runs not forced', () => {
      it('Then the path is refused as a local change', async () => {
        // Arrange
        const ctx = await autocrlfContext();
        const oldId = await writeBlob(ctx, enc('a\nb\n'));
        const newId = await writeBlob(ctx, enc('c\nd\n'));
        await ctx.fs.write(`${WORKDIR}/f.txt`, enc('a\r\nedited\r\n'));
        const changeset = makeChangeset([makeUpdate('f.txt', oldId, newId)]);

        // Act
        const outcome = await outcomeOf(
          applyChangeset(ctx, { changeset, force: false, workdir: WORKDIR }),
        );

        // Assert
        expect(outcome).toMatchObject({
          code: 'CHECKOUT_OVERWRITE_DIRTY',
          localChanges: ['f.txt'],
        });
      });
    });
  });

  describe('Given core.autocrlf true and a symlink whose target holds a CR', () => {
    describe('When isWorkingTreeDirty compares it against the stored target', () => {
      it('Then the link target is compared raw', async () => {
        // Arrange
        const ctx = await autocrlfContext();
        const target = 'a\r\nb';
        const id = await writeBlob(ctx, enc(target));
        await ctx.fs.symlink(target, `${WORKDIR}/link`);

        // Act
        const result = await isWorkingTreeDirty(ctx, `${WORKDIR}/link`, id);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given text for every path and a symlink whose target holds a CR', () => {
    describe('When isWorkingTreeDirty compares it against the stored target', () => {
      it('Then the link target is compared raw', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const target = 'a\r\nb';
        const id = await writeBlob(ctx, enc(target));
        await ctx.fs.write(`${WORKDIR}/.gitattributes`, enc('* text\n'));
        await ctx.fs.symlink(target, `${WORKDIR}/link`);
        const sut = isWorkingTreeDirty;

        // Act
        const result = await sut(ctx, `${WORKDIR}/link`, id);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given an attribute anchored on the repo-relative path and a CRLF file of an LF blob', () => {
    describe('When isWorkingTreeDirty compares the nested file', () => {
      it('Then the anchored text attribute applies and the file is clean', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('a\nb\n'));
        await ctx.fs.write(`${WORKDIR}/.gitattributes`, enc('/sub/f.txt text\n'));
        await ctx.fs.write(`${WORKDIR}/sub/f.txt`, enc('a\r\nb\r\n'));
        const sut = isWorkingTreeDirty;

        // Act
        const result = await sut(ctx, `${WORKDIR}/sub/f.txt`, id);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given text=auto and a CRLF file whose index blob already holds CRLF', () => {
    describe('When isWorkingTreeDirty compares it against that blob', () => {
      it('Then the file is clean', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('a\r\nb\r\n'));
        await ctx.fs.write(`${WORKDIR}/.gitattributes`, enc('* text=auto\n'));
        await ctx.fs.write(`${WORKDIR}/f.txt`, enc('a\r\nb\r\n'));
        const sut = isWorkingTreeDirty;

        // Act
        const result = await sut(ctx, `${WORKDIR}/f.txt`, id);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a filter section whose required value git refuses', () => {
    describe('When isWorkingTreeDirty compares a file', () => {
      it('Then it refuses CONFIG_BAD_BOOLEAN_VALUE naming filter.x.required', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[filter "x"]\n\trequired = foo\n');
        invalidateConfigCache(ctx);
        const id = await writeBlob(ctx, enc('a\n'));
        await ctx.fs.write(`${WORKDIR}/f.txt`, enc('a\n'));
        const sut = isWorkingTreeDirty;
        let caught: unknown;

        // Act
        try {
          await sut(ctx, `${WORKDIR}/f.txt`, id);
        } catch (error) {
          caught = error;
        }

        // Assert
        if (!(caught instanceof TsgitError)) throw new Error('expected a TsgitError');
        expect(caught.data).toMatchObject({
          code: 'CONFIG_BAD_BOOLEAN_VALUE',
          key: 'filter.x.required',
          value: 'foo',
        });
      });
    });
  });

  describe('Given core.autocrlf true and a CRLF file of an LF blob', () => {
    describe('When isWorkingTreeDirty is called with its three public arguments', () => {
      it('Then the file is clean', async () => {
        // Arrange
        const ctx = await autocrlfContext();
        const id = await writeBlob(ctx, enc('a\nb\n'));
        await ctx.fs.write(`${WORKDIR}/f.txt`, enc('a\r\nb\r\n'));

        // Act
        const result = await isWorkingTreeDirty(ctx, `${WORKDIR}/f.txt`, id);

        // Assert
        expect(result).toBe(false);
        expect(isWorkingTreeDirty.length).toBe(3);
      });
    });
  });
});

const LOSSY_BYTES = Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74);
const LOSSY_VIEW_PATH = '\uFFFD.txt';
const LOSSY_OPTS: EntryOptions = { pathBytes: LOSSY_BYTES };

describe('applyChangeset and an entry whose name bytes are not UTF-8', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Given a changeset adding a lossy L and a well-formed U on an empty work tree', () => {
    describe('When applyChangeset runs', () => {
      it('Then only U is written and L is recorded with a zero stat and its bytes', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const lossyId = await writeBlob(ctx, enc('l\n'));
        const wellFormedId = await writeBlob(ctx, enc('u\n'));
        const writeSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeEntryStream');
        const changeset = makeChangeset([
          makeAdd(LOSSY_VIEW_PATH, lossyId, FILE_MODE.REGULAR, LOSSY_OPTS),
          makeAdd(LOSSY_VIEW_PATH, wellFormedId),
        ]);
        const sut = applyChangeset;

        // Act
        const result = await sut(ctx, { changeset, force: false, workdir: WORKDIR });

        // Assert
        expect(dec(await ctx.fs.read(`${WORKDIR}/${LOSSY_VIEW_PATH}`))).toBe('u\n');
        expect(writeSpy).toHaveBeenCalledOnce();
        expect(String(writeSpy.mock.calls[0]?.[1])).toMatch(/\uFFFD\.txt$/);
        const lossy = result.writtenEntries.find((e) => e.pathBytes !== undefined);
        expect(lossy?.pathBytes).toEqual(LOSSY_BYTES);
        expect(lossy?.mtimeSeconds).toBe(0);
        expect(lossy?.fileSize).toBe(0);
      });
    });
  });

  describe('Given the well-formed twin on disk and a changeset deleting the lossy entry', () => {
    describe('When applyChangeset runs', () => {
      it('Then the twin file is still there', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const lossyId = await writeBlob(ctx, enc('l\n'));
        await ctx.fs.write(`${WORKDIR}/${LOSSY_VIEW_PATH}`, enc('u\n'));
        const changeset = makeChangeset([
          makeDelete(LOSSY_VIEW_PATH, lossyId, FILE_MODE.REGULAR, LOSSY_OPTS),
        ]);
        const sut = applyChangeset;

        // Act
        await sut(ctx, { changeset, force: true, workdir: WORKDIR });

        // Assert
        expect(await ctx.fs.exists(`${WORKDIR}/${LOSSY_VIEW_PATH}`)).toBe(true);
      });
    });
  });

  describe('Given the twin file on disk and a non-forced update of the lossy entry', () => {
    describe('When applyChangeset runs', () => {
      it('Then it resolves and leaves the twin untouched', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const previousId = await writeBlob(ctx, enc('l\n'));
        const newId = await writeBlob(ctx, enc('l2\n'));
        await ctx.fs.write(`${WORKDIR}/${LOSSY_VIEW_PATH}`, enc('x\n'));
        const changeset = makeChangeset([
          makeUpdate(LOSSY_VIEW_PATH, previousId, newId, FILE_MODE.REGULAR, LOSSY_OPTS),
        ]);
        const sut = applyChangeset;

        // Act
        const attempt = sut(ctx, { changeset, force: false, workdir: WORKDIR });

        // Assert
        await expect(attempt).resolves.toBeDefined();
        expect(dec(await ctx.fs.read(`${WORKDIR}/${LOSSY_VIEW_PATH}`))).toBe('x\n');
      });
    });
  });

  describe('Given the twin file on disk and a non-forced add of the lossy entry', () => {
    describe('When applyChangeset runs', () => {
      it('Then it resolves with no untracked clash', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('l\n'));
        await ctx.fs.write(`${WORKDIR}/${LOSSY_VIEW_PATH}`, enc('x\n'));
        const changeset = makeChangeset([
          makeAdd(LOSSY_VIEW_PATH, id, FILE_MODE.REGULAR, LOSSY_OPTS),
        ]);
        const sut = applyChangeset;

        // Act
        const attempt = sut(ctx, { changeset, force: false, workdir: WORKDIR });

        // Assert
        await expect(attempt).resolves.toBeDefined();
        expect(dec(await ctx.fs.read(`${WORKDIR}/${LOSSY_VIEW_PATH}`))).toBe('x\n');
      });
    });
  });

  describe('Given a directory at the lossy view path holding an ignored file, and a non-forced add of the lossy entry', () => {
    describe('When applyChangeset runs', () => {
      it('Then the unrelated directory and its ignored file are left alone', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('l\n'));
        await ctx.fs.write(`${WORKDIR}/.gitignore`, enc('*.o\n'));
        await ctx.fs.write(`${WORKDIR}/${LOSSY_VIEW_PATH}/junk.o`, enc('j'));
        const changeset = makeChangeset([
          makeAdd(LOSSY_VIEW_PATH, id, FILE_MODE.REGULAR, LOSSY_OPTS),
        ]);
        const sut = applyChangeset;

        // Act
        await sut(ctx, { changeset, force: false, workdir: WORKDIR });

        // Assert
        expect(dec(await ctx.fs.read(`${WORKDIR}/${LOSSY_VIEW_PATH}/junk.o`))).toBe('j');
      });
    });
  });

  describe('Given an add entry whose raw bytes name a .git HFS alias', () => {
    describe('When applyChangeset runs', () => {
      it('Then it refuses with the HFS reason and writes nothing', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('x\n'));
        const writeSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeEntryStream');
        const changeset = makeChangeset([
          makeAdd('.git\uFFFD/x', id, FILE_MODE.REGULAR, {
            pathBytes: Uint8Array.of(0x2e, 0x67, 0x69, 0x74, 0xff, 0x2f, 0x78),
          }),
        ]);
        const sut = applyChangeset;
        let caught: unknown;

        // Act
        try {
          await sut(ctx, { changeset, force: false, workdir: WORKDIR });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as { data?: unknown }).data).toMatchObject({
          code: 'INVALID_INDEX_ENTRY',
          reason: "'.git' HFS+ ignorable-codepoint alias rejected",
        });
        expect(writeSpy).not.toHaveBeenCalled();
      });
    });
  });
});

describe('applyChangeset leading-symlink safety', () => {
  const OUTSIDE = '/repo/.git/outside';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const seedInterleaved = async (): Promise<{
    readonly ctx: Context;
    readonly inner: Context;
    readonly recorded: ReturnType<typeof createInterleavingFs>['recorded'];
  }> => {
    const inner = await buildSeededContext();
    await inner.fs.mkdir(OUTSIDE);
    const { fs, recorded } = createInterleavingFs(inner.fs, { foldUnder: WORKDIR });
    return { ctx: { ...inner, fs }, inner, recorded };
  };

  const expectPayloadInRealDirectory = async (
    inner: Context,
    recorded: ReturnType<typeof createInterleavingFs>['recorded'],
  ): Promise<void> => {
    expect(recorded).toEqual([]);
    expect((await inner.fs.lstat(`${WORKDIR}/a`)).isDirectory).toBe(true);
    expect(dec(await inner.fs.read(`${WORKDIR}/a/payload`))).toBe('payload');
    expect(await inner.fs.readdir(OUTSIDE)).toEqual([]);
  };

  describe('Given a symlink A and a file a/payload that one case-insensitive disk folds together', () => {
    describe('When applyChangeset runs with the interleaving that creates the link between the scan and the write', () => {
      it('Then payload never lands through the link', async () => {
        // Arrange
        const { ctx, inner, recorded } = await seedInterleaved();
        const link = await writeBlob(inner, enc(OUTSIDE));
        const payload = await writeBlob(inner, enc('payload'));
        const sut = applyChangeset;

        // Act
        await sut(ctx, {
          changeset: makeChangeset([
            makeAdd('A', link, FILE_MODE.SYMLINK),
            makeAdd('a/payload', payload),
          ]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        await expectPayloadInRealDirectory(inner, recorded);
      });
    });
  });

  describe('Given a symlink a and a file A/payload that one case-insensitive disk folds together', () => {
    describe('When applyChangeset runs, the directory A memoised before the link a replaces it', () => {
      it('Then payload never lands through the link, which only clearing the memo after the link write guarantees', async () => {
        // Arrange
        const { ctx, inner, recorded } = await seedInterleaved();
        const link = await writeBlob(inner, enc(OUTSIDE));
        const payload = await writeBlob(inner, enc('payload'));
        const sut = applyChangeset;

        // Act
        await sut(ctx, {
          changeset: makeChangeset([
            makeAdd('a', link, FILE_MODE.SYMLINK),
            makeAdd('A/payload', payload),
          ]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        await expectPayloadInRealDirectory(inner, recorded);
      });
    });
  });

  describe('Given a changeset listing a symlink a before a symlink A that one case-insensitive disk folds together', () => {
    describe('When applyChangeset writes the pooled wave', () => {
      it('Then the links land in byte order of the path, so a is the one left standing', async () => {
        // Arrange
        const inner = await buildSeededContext();
        const { fs } = createInterleavingFs(inner.fs, { foldUnder: WORKDIR });
        const ctx = { ...inner, fs };
        const lower = await writeBlob(inner, enc('lower-target'));
        const upper = await writeBlob(inner, enc('upper-target'));
        const regular = await writeBlob(inner, enc('regular'));
        const sut = applyChangeset;

        // Act
        await sut(ctx, {
          changeset: makeChangeset([
            makeAdd('a', lower, FILE_MODE.SYMLINK),
            makeAdd('A', upper, FILE_MODE.SYMLINK),
            makeAdd('z', regular),
          ]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(await inner.fs.readlink(`${WORKDIR}/a`)).toBe('lower-target');
      });
    });
  });

  describe('Given a symlink wave holding a gitlink and a regular file', () => {
    describe('When applyChangeset runs', () => {
      it('Then the gitlink directory exists before the first pooled regular write starts', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const regular = await writeBlob(ctx, enc('regular'));
        const link = await writeBlob(ctx, enc('target'));
        const events: string[] = [];
        const realMkdir = ctx.fs.mkdir.bind(ctx.fs);
        vi.spyOn(ctx.fs, 'mkdir').mockImplementation(async (dir) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          await realMkdir(dir);
          events.push(`mkdir ${dir}`);
        });
        const realWriteStream = ctx.fs.writeStream.bind(ctx.fs);
        vi.spyOn(ctx.fs, 'writeStream').mockImplementation(async (file, chunks) => {
          events.push(`write ${file}`);
          await realWriteStream(file, chunks);
        });
        const sut = applyChangeset;

        // Act
        await sut(ctx, {
          changeset: makeChangeset([
            makeAdd('a-file', regular),
            makeAdd('sub', 'd'.repeat(40) as ObjectId, FILE_MODE.GITLINK),
            makeAdd('link', link, FILE_MODE.SYMLINK),
          ]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(events.indexOf(`mkdir ${WORKDIR}/sub`)).toBeLessThan(
          events.indexOf(`write ${WORKDIR}/a-file`),
        );
      });
    });
  });

  describe.each([
    { label: 'pooled', config: '' },
    { label: 'one at a time', config: '[filter "a"]\n\tprocess = proc\n' },
  ])(
    'Given a file standing where a symlink wave needs a directory, written $label',
    ({ config }) => {
      describe('When applyChangeset writes d/x beside a symlink', () => {
        it('Then the file gives way to the directory holding x', async () => {
          // Arrange
          const base = await buildSeededContext();
          await base.fs.writeUtf8(`${base.layout.gitDir}/config`, config);
          await base.fs.write(`${WORKDIR}/d`, enc('file'));
          const ctx = { ...base, command: scriptedCommandRunner(new Uint8Array(0)).runner };
          const link = await writeBlob(ctx, enc('target'));
          const payload = await writeBlob(ctx, enc('payload'));
          const sut = applyChangeset;

          // Act
          await sut(ctx, {
            changeset: makeChangeset([
              makeAdd('l', link, FILE_MODE.SYMLINK),
              makeAdd('d/x', payload),
            ]),
            force: true,
            workdir: WORKDIR,
          });

          // Assert
          expect((await ctx.fs.lstat(`${WORKDIR}/d`)).isDirectory).toBe(true);
          expect(dec(await ctx.fs.read(`${WORKDIR}/d/x`))).toBe('payload');
        });
      });
    },
  );

  describe('Given a process filter driver and a symlink A beside a/payload on a folding disk (guard: no seeded defect fails it)', () => {
    describe('When applyChangeset writes the entries one at a time', () => {
      it('Then payload never lands through the link', async () => {
        // Arrange
        const { ctx, inner, recorded } = await seedInterleaved();
        await inner.fs.writeUtf8(
          `${inner.layout.gitDir}/config`,
          '[filter "a"]\n\tprocess = proc\n',
        );
        const withProcess = { ...ctx, command: scriptedCommandRunner(new Uint8Array(0)).runner };
        const link = await writeBlob(inner, enc(OUTSIDE));
        const payload = await writeBlob(inner, enc('payload'));
        const sut = applyChangeset;

        // Act
        await sut(withProcess, {
          changeset: makeChangeset([
            makeAdd('a/payload', payload),
            makeAdd('A', link, FILE_MODE.SYMLINK),
          ]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        await expectPayloadInRealDirectory(inner, recorded);
      });
    });
  });

  describe('Given a symlink wave holding a lossy d<0xff>/x and an untracked twin file d�', () => {
    describe('When applyChangeset runs', () => {
      it('Then the twin file survives and no directory is made for the view of the name', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('x'));
        const link = await writeBlob(ctx, enc('target'));
        await ctx.fs.write(`${WORKDIR}/d\uFFFD`, enc('twin'));
        const mkdirSpy = vi.spyOn(ctx.fs, 'mkdir');
        const sut = applyChangeset;

        // Act
        await outcomeOf(
          sut(ctx, {
            changeset: makeChangeset([
              makeAdd('link', link, FILE_MODE.SYMLINK),
              makeAdd('d\uFFFD/x', id, FILE_MODE.REGULAR, {
                pathBytes: Uint8Array.of(0x64, 0xff, 0x2f, 0x78),
              }),
            ]),
            force: true,
            workdir: WORKDIR,
          }),
        );

        // Assert
        expect(dec(await ctx.fs.read(`${WORKDIR}/d\uFFFD`))).toBe('twin');
        expect(mkdirSpy.mock.calls.map(([dir]) => dir)).not.toContain(`${WORKDIR}/d\uFFFD`);
      });
    });
  });

  describe('Given a changeset of regular files only', () => {
    describe('When applyChangeset runs', () => {
      it('Then the wave never calls mkdir itself', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, enc('x'));
        const mkdirSpy = vi.spyOn(ctx.fs, 'mkdir');
        const sut = applyChangeset;

        // Act
        await sut(ctx, {
          changeset: makeChangeset([makeAdd('d/one', id), makeAdd('d/two', id)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(mkdirSpy).not.toHaveBeenCalled();
      });
    });
  });
});

describe('applyChangeset replacing a directory whose tracked child has a non-UTF-8 name', () => {
  describe('Given a lossy delete d/<0xff>, an add of file d and an untracked d/� twin', () => {
    describe('When applyChangeset runs without force', () => {
      it('Then it refuses upfront listing d and writes nothing', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const lostId = await writeBlob(ctx, enc('x'));
        const fileId = await writeBlob(ctx, enc('file'));
        await ctx.fs.write(`${WORKDIR}/d/�`, enc('u'));
        const changeset = makeChangeset([
          makeDelete('d/�', lostId, FILE_MODE.REGULAR, {
            pathBytes: Uint8Array.of(0x64, 0x2f, 0xff),
          }),
          makeAdd('d', fileId),
        ]);
        const sut = applyChangeset;

        // Act
        const outcome = await outcomeOf(sut(ctx, { changeset, force: false, workdir: WORKDIR }));

        // Assert
        expect(outcome).toMatchObject({ code: 'CHECKOUT_OVERWRITE_DIRTY', untracked: ['d'] });
        expect(dec(await ctx.fs.read(`${WORKDIR}/d/�`))).toBe('u');
      });
    });
  });
});
