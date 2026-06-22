import { describe, expect, it, vi } from 'vitest';

import { applyChangeset } from '../../../../src/application/primitives/apply-changeset.js';
import type {
  Changeset,
  ChangesetEntry,
} from '../../../../src/application/primitives/compute-changeset.js';
import * as writeFileMod from '../../../../src/application/primitives/internal/write-working-tree-file.js';
import * as streamBlobMod from '../../../../src/application/primitives/stream-blob.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FileMode, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from '../../../../src/ports/command-runner.js';
import type { Context } from '../../../../src/ports/context.js';
import type { FileStat } from '../../../../src/ports/file-system.js';
import { buildSeededContext } from './fixtures.js';

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

const makeAdd = (
  path: string,
  id: ObjectId,
  mode: FileMode = FILE_MODE.REGULAR,
): ChangesetEntry => ({
  kind: 'add',
  path: path as FilePath,
  mode,
  id,
  previousId: undefined,
  previousMode: undefined,
});

const makeDelete = (
  path: string,
  previousId: ObjectId,
  previousMode: FileMode = FILE_MODE.REGULAR,
): ChangesetEntry => ({
  kind: 'delete',
  path: path as FilePath,
  mode: previousMode,
  id: undefined,
  previousId,
  previousMode,
});

const makeUpdate = (
  path: string,
  previousId: ObjectId,
  newId: ObjectId,
  mode: FileMode = FILE_MODE.REGULAR,
): ChangesetEntry => ({
  kind: 'update',
  path: path as FilePath,
  mode,
  id: newId,
  previousId,
  previousMode: mode,
});

const writeBlob = async (
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  content: Uint8Array,
): Promise<ObjectId> => writeObject(ctx, { type: 'blob', content, id: '' as ObjectId });

describe('applyChangeset', () => {
  describe('Given an add entry for a regular file', () => {
    describe('When applyChangeset runs', () => {
      it('Then writes the file at workdir/path with content from the blob', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('hello world'));
        const sut = applyChangeset;

        // Act
        const result = await sut(ctx, {
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
        const sut = applyChangeset;

        // Act
        const result = await sut(ctx, {
          changeset: makeChangeset([makeAdd('run.sh', id, FILE_MODE.EXECUTABLE)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(result.writtenEntries[0]?.mode).toBe(FILE_MODE.EXECUTABLE);
      });
    });
  });

  describe('Given an add entry with symlink mode', () => {
    describe('When applyChangeset runs', () => {
      it('Then writes a symlink whose target is the blob content', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('../target.txt'));
        const sut = applyChangeset;

        // Act
        await sut(ctx, {
          changeset: makeChangeset([makeAdd('link', id, FILE_MODE.SYMLINK)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(await ctx.fs.readlink(`${WORKDIR}/link`)).toBe('../target.txt');
      });
    });
  });

  describe('Given an add entry with gitlink mode', () => {
    describe('When applyChangeset runs', () => {
      it('Then creates an empty directory placeholder', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = applyChangeset;

        // Act
        await sut(ctx, {
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
        const sut = applyChangeset;

        // Act
        const result = await sut(ctx, {
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

  describe('Given an update with modified working-tree content and force=false', () => {
    describe('When applyChangeset runs', () => {
      it('Then throws CHECKOUT_OVERWRITE_DIRTY with the offending path', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, new TextEncoder().encode('original'));
        const newId = await writeBlob(ctx, new TextEncoder().encode('updated'));
        // working tree has LOCAL MOD (not the original content)
        await ctx.fs.write(`${WORKDIR}/mod.txt`, new TextEncoder().encode('local-edit'));
        const sut = applyChangeset;

        // Act + Assert
        try {
          await sut(ctx, {
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
        const sut = applyChangeset;

        // Act
        await sut(ctx, {
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
        const sut = applyChangeset;

        // Act + Assert
        try {
          await sut(ctx, {
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
        const sut = applyChangeset;
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

        // Act + Assert
        try {
          await sut(wrappedCtx, {
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
        const sut = applyChangeset;

        // Act
        const result = await sut(ctx, {
          changeset: makeChangeset([noop]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(result.written).toBe(0);
        expect(result.deleted).toBe(0);
        expect(result.writtenEntries).toHaveLength(0);
      });
    });
  });

  describe('Given a workdir that ends with a slash', () => {
    describe('When applyChangeset runs an add', () => {
      it('Then joins the path without a doubled separator', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, new TextEncoder().encode('joined'));
        const sut = applyChangeset;

        // Act
        await sut(ctx, {
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
        // Arrange — file exists() reports present but read() throws FILE_NOT_FOUND (race-gone file)
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, new TextEncoder().encode('original'));
        const newId = await writeBlob(ctx, new TextEncoder().encode('updated'));
        const wrappedCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            exists: async (p: string): Promise<boolean> =>
              p === `${WORKDIR}/gone.txt` ? true : ctx.fs.exists(p),
            read: async (p: string): Promise<Uint8Array> => {
              if (p === `${WORKDIR}/gone.txt`) {
                throw new TsgitError({ code: 'FILE_NOT_FOUND', path: p });
              }
              return ctx.fs.read(p);
            },
          },
        };
        const sut = applyChangeset;

        // Act
        const result = await sut(wrappedCtx, {
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

  describe('Given an update whose target file is reported absent by exists() but readable', () => {
    describe('When applyChangeset runs without force', () => {
      it('Then treats it as non-dirty and does not throw', async () => {
        // Arrange — exists() says absent; blobMatches must NOT run for an absent file
        const ctx = await buildSeededContext();
        const oldId = await writeBlob(ctx, new TextEncoder().encode('original'));
        const newId = await writeBlob(ctx, new TextEncoder().encode('updated'));
        // Working tree holds content that does NOT match previousId.
        await ctx.fs.write(`${WORKDIR}/phantom.txt`, new TextEncoder().encode('mismatching-bytes'));
        const wrappedCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            exists: async (p: string): Promise<boolean> =>
              p === `${WORKDIR}/phantom.txt` ? false : ctx.fs.exists(p),
          },
        };
        const sut = applyChangeset;

        // Act + Assert — exists()=false short-circuits to non-dirty; no throw despite mismatching bytes
        const result = await sut(wrappedCtx, {
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
        const sut = applyChangeset;

        // Act + Assert
        try {
          await sut(ctx, {
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
        const sut = applyChangeset;

        // Act
        await sut(ctx, {
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
        const sut = applyChangeset;

        // Act
        await sut(wrappedCtx, {
          changeset: makeChangeset([makeAdd('plain.txt', id, FILE_MODE.REGULAR)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(chmodMode).toHaveBeenCalledWith(`${WORKDIR}/plain.txt`, 0o644);
      });
    });
  });

  describe('Given an add entry with executable mode', () => {
    describe('When applyChangeset runs', () => {
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
        const sut = applyChangeset;

        // Act
        await sut(wrappedCtx, {
          changeset: makeChangeset([makeAdd('run.sh', id, FILE_MODE.EXECUTABLE)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(chmodMode).toHaveBeenCalledWith(`${WORKDIR}/run.sh`, 0o755);
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
        const sut = applyChangeset;

        // Act
        const result = await sut(wrappedCtx, {
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
        const sut = applyChangeset;

        // Act
        const result = await sut(wrappedCtx, {
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
        const sut = applyChangeset;

        // Act
        const result = await sut(ctx, {
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
        const sut = applyChangeset;

        // Act
        const result = await sut(ctx, {
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
        const sut = applyChangeset;

        // Act
        const result = await sut(ctx, {
          changeset: makeChangeset([makeDelete('absent.txt', id)]),
          force: true,
          workdir: WORKDIR,
        });

        // Assert — rm on a missing path would throw FILE_NOT_FOUND; the guard prevents it
        expect(result.deleted).toBe(1);
      });
    });
  });

  describe('Given a noop entry', () => {
    describe('When applyChangeset runs', () => {
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
        const sut = applyChangeset;

        // Act
        await sut(wrappedCtx, {
          changeset: makeChangeset([noop]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(progressUpdate).not.toHaveBeenCalled();
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
        const sut = applyChangeset;

        // Act + Assert
        try {
          await sut(ctx, {
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
        const sut = applyChangeset;

        // Act + Assert
        try {
          await sut(ctx, {
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
        const sut = applyChangeset;

        // Act
        await sut(wrappedCtx, {
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

  describe('Given a regular (100644) add entry', () => {
    describe('When applyChangeset runs', () => {
      it('Then routes through streamBlob + writeWorkingTreeEntryStream and written file bytes match blob content', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('streamed content');
        const id = await writeBlob(ctx, content);
        const streamBlobSpy = vi.spyOn(streamBlobMod, 'streamBlob');
        const writeStreamSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeEntryStream');
        const sut = applyChangeset;

        // Act
        await sut(ctx, {
          changeset: makeChangeset([makeAdd('stream.txt', id, FILE_MODE.REGULAR)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(streamBlobSpy).toHaveBeenCalledOnce();
        expect(writeStreamSpy).toHaveBeenCalledOnce();
        const bytes = await ctx.fs.read(`${WORKDIR}/stream.txt`);
        expect(bytes).toEqual(content);

        streamBlobSpy.mockRestore();
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
        const streamBlobSpy = vi.spyOn(streamBlobMod, 'streamBlob');
        const writeStreamSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeEntryStream');
        const chmodSpy = vi.fn<(path: string, mode: number) => Promise<void>>(
          async () => undefined,
        );
        const wrappedCtx: Context = { ...ctx, fs: { ...ctx.fs, chmod: chmodSpy } };
        const sut = applyChangeset;

        // Act
        await sut(wrappedCtx, {
          changeset: makeChangeset([makeAdd('exec.sh', id, FILE_MODE.EXECUTABLE)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert
        expect(streamBlobSpy).toHaveBeenCalledOnce();
        expect(writeStreamSpy).toHaveBeenCalledOnce();
        expect(chmodSpy).toHaveBeenCalledWith(`${WORKDIR}/exec.sh`, 0o755);

        streamBlobSpy.mockRestore();
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
        const streamBlobSpy = vi.spyOn(streamBlobMod, 'streamBlob');
        const writeStreamSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeEntryStream');
        const sut = applyChangeset;

        // Act
        await sut(ctx, {
          changeset: makeChangeset([makeAdd('sym.link', id, FILE_MODE.SYMLINK)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert — buffered path, not stream path
        expect(streamBlobSpy).not.toHaveBeenCalled();
        expect(writeStreamSpy).not.toHaveBeenCalled();
        expect(await ctx.fs.readlink(`${WORKDIR}/sym.link`)).toBe(target);

        streamBlobSpy.mockRestore();
        writeStreamSpy.mockRestore();
      });
    });
  });

  describe('Given a gitlink (160000) add entry', () => {
    describe('When applyChangeset runs', () => {
      it('Then the gitlink arm is unchanged: creates directory, does not invoke streamBlob', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const streamBlobSpy = vi.spyOn(streamBlobMod, 'streamBlob');
        const writeStreamSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeEntryStream');
        const sut = applyChangeset;

        // Act
        await sut(ctx, {
          changeset: makeChangeset([makeAdd('sub', 'd'.repeat(40) as ObjectId, FILE_MODE.GITLINK)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert — gitlink arm: directory placeholder, no streaming
        const stat = await ctx.fs.lstat(`${WORKDIR}/sub`);
        expect(stat.isDirectory).toBe(true);
        expect(streamBlobSpy).not.toHaveBeenCalled();
        expect(writeStreamSpy).not.toHaveBeenCalled();

        streamBlobSpy.mockRestore();
        writeStreamSpy.mockRestore();
      });
    });
  });

  // ── Smudge filter (F2 identity + active smudge + fallback) ──────────────

  describe('Given a regular file add with an active smudge filter and a runner that lowercases', () => {
    describe('When applyChangeset runs', () => {
      it('Then the worktree file contains the smudged (lowercased) bytes, not the raw blob bytes', async () => {
        // Arrange — blob contains uppercase; smudge produces lowercase
        const ctx = await buildSeededContext();
        const blobContent = enc('HELLO WORLD');
        const id = await writeBlob(ctx, blobContent);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.y filter=myf\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[filter "myf"]\n\tsmudge = lowercase\n',
        );
        const runner = new FakeSmudgeRunner(0, lowercase);
        const enrichedCtx: Context = { ...ctx, command: runner };
        const sut = applyChangeset;

        // Act
        await sut(enrichedCtx, {
          changeset: makeChangeset([makeAdd('a.y', id)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert — worktree file must be lowercased (smudged), not the raw uppercase bytes
        const written = await ctx.fs.read(`${WORKDIR}/a.y`);
        expect(dec(written)).toBe('hello world');
        expect(runner.calls).toHaveLength(1);
      });
    });
  });

  describe('Given a regular file add with a clean-only filter (no smudge configured) and a runner', () => {
    describe('When applyChangeset runs (F2 identity smudge)', () => {
      it('Then the worktree file contains the verbatim blob bytes and streamBlob is used', async () => {
        // Arrange — clean-only filter: smudge is absent → identity (F2)
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
        const streamBlobSpy = vi.spyOn(streamBlobMod, 'streamBlob');
        const writeStreamSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeEntryStream');
        const sut = applyChangeset;

        // Act
        await sut(enrichedCtx, {
          changeset: makeChangeset([makeAdd('a.y', id)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert — identity: verbatim blob bytes; streaming path taken; runner not invoked
        const written = await ctx.fs.read(`${WORKDIR}/a.y`);
        expect(dec(written)).toBe('HELLO WORLD');
        expect(streamBlobSpy).toHaveBeenCalledOnce();
        expect(writeStreamSpy).toHaveBeenCalledOnce();
        expect(runner.calls).toHaveLength(0);

        streamBlobSpy.mockRestore();
        writeStreamSpy.mockRestore();
      });
    });
  });

  describe('Given a regular file add with an active smudge filter (required=false) but smudge exits non-zero', () => {
    describe('When applyChangeset runs (smudge failure fallback)', () => {
      it('Then the worktree file contains the raw blob bytes and runner was invoked', async () => {
        // Arrange — smudge fails (non-zero exit); required absent → graceful fallback
        const ctx = await buildSeededContext();
        const blobContent = enc('HELLO WORLD');
        const id = await writeBlob(ctx, blobContent);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.y filter=myf\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[filter "myf"]\n\tsmudge = fail-cmd\n',
        );
        const runner = new FakeSmudgeRunner(1);
        const enrichedCtx: Context = { ...ctx, command: runner };
        const sut = applyChangeset;

        // Act — must NOT throw
        await sut(enrichedCtx, {
          changeset: makeChangeset([makeAdd('a.y', id)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert — raw blob bytes written (graceful fallback); runner WAS invoked
        // (distinguishes this from the F2 identity path where runner.calls === 0)
        const written = await ctx.fs.read(`${WORKDIR}/a.y`);
        expect(dec(written)).toBe('HELLO WORLD');
        expect(runner.calls).toHaveLength(1);
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
        const sut = applyChangeset;

        // Act + Assert — must throw
        let caught: unknown;
        try {
          await sut(enrichedCtx, {
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

  describe('Given a regular file add with an active smudge filter (required=true) and smudge exits zero', () => {
    describe('When applyChangeset runs', () => {
      it('Then writes smudged bytes without throwing (required=true does not throw on success)', async () => {
        // Arrange — smudge required=true; runner succeeds (exit 0, lowercases)
        const ctx = await buildSeededContext();
        const blobContent = enc('HELLO WORLD');
        const id = await writeBlob(ctx, blobContent);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.y filter=myf\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[filter "myf"]\n\tsmudge = lowercase\n\trequired = true\n',
        );
        const runner = new FakeSmudgeRunner(0, lowercase);
        const enrichedCtx: Context = { ...ctx, command: runner };
        const sut = applyChangeset;

        // Act — must NOT throw
        await sut(enrichedCtx, {
          changeset: makeChangeset([makeAdd('a.y', id)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert — smudged bytes written; runner invoked
        const written = await ctx.fs.read(`${WORKDIR}/a.y`);
        expect(dec(written)).toBe('hello world');
        expect(runner.calls).toHaveLength(1);
      });
    });
  });

  describe('Given a regular file add with a filter attribute but no ctx.command (R11 fallback)', () => {
    describe('When applyChangeset runs', () => {
      it('Then the worktree file contains the verbatim blob bytes and streamBlob is used', async () => {
        // Arrange — no command in ctx (ADR-408 inert fallback)
        const ctx = await buildSeededContext();
        const blobContent = enc('HELLO WORLD');
        const id = await writeBlob(ctx, blobContent);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '*.y filter=myf\n');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[filter "myf"]\n\tsmudge = lowercase\n',
        );
        const streamBlobSpy = vi.spyOn(streamBlobMod, 'streamBlob');
        const writeStreamSpy = vi.spyOn(writeFileMod, 'writeWorkingTreeEntryStream');
        const sut = applyChangeset;

        // Act — ctx has no command
        await sut(ctx, {
          changeset: makeChangeset([makeAdd('a.y', id)]),
          force: false,
          workdir: WORKDIR,
        });

        // Assert — identity (no runner): verbatim blob bytes; streaming path taken
        const written = await ctx.fs.read(`${WORKDIR}/a.y`);
        expect(dec(written)).toBe('HELLO WORLD');
        expect(streamBlobSpy).toHaveBeenCalledOnce();
        expect(writeStreamSpy).toHaveBeenCalledOnce();

        streamBlobSpy.mockRestore();
        writeStreamSpy.mockRestore();
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
        const sut = applyChangeset;

        // Act
        await sut(enrichedCtx, {
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
        const sut = applyChangeset;

        // Act
        await sut(enrichedCtx, {
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
});
