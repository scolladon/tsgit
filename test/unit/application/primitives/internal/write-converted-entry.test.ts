import { afterEach, describe, expect, it, vi } from 'vitest';
import { invalidateConfigCache } from '../../../../../src/application/primitives/config-read.js';
import { createConcurrencyLimiter } from '../../../../../src/application/primitives/internal/concurrency-limiter.js';
import * as convertBlobMod from '../../../../../src/application/primitives/internal/convert-blob.js';
import { buildAttributeProvider } from '../../../../../src/application/primitives/internal/read-gitattributes.js';
import {
  createWorkingTreeWriter,
  type WorkingTreeWriter,
} from '../../../../../src/application/primitives/internal/write-converted-entry.js';
import * as writeFileMod from '../../../../../src/application/primitives/internal/write-working-tree-file.js';
import { readEolSettings } from '../../../../../src/application/primitives/resolve-conversion.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildSeededContext } from '../fixtures.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

const PATH = 'a.txt' as FilePath;
const DIVERGENCE_BLOB = '$$Id$\n$Id:a b$\n$Id: a\tb $\n$Id$Id$\n';

interface Setup {
  readonly ctx: Context;
  readonly sut: WorkingTreeWriter;
  readonly worktree: (path?: string) => Promise<string>;
  readonly blob: (content: string) => Promise<ObjectId>;
}

const setup = async (options: { attributes?: string; config?: string } = {}): Promise<Setup> => {
  const ctx = await buildSeededContext();
  const { workDir, gitDir } = ctx.layout;
  if (options.attributes !== undefined) {
    await ctx.fs.writeUtf8(`${workDir}/.gitattributes`, options.attributes);
  }
  if (options.config !== undefined) await ctx.fs.writeUtf8(`${gitDir}/config`, options.config);
  invalidateConfigCache(ctx);
  const sut = createWorkingTreeWriter(ctx, {
    provider: () => buildAttributeProvider(ctx),
    settings: () => readEolSettings(ctx),
    limiter: createConcurrencyLimiter(1),
  });
  return {
    ctx,
    sut,
    worktree: async (path = PATH) => dec(await ctx.fs.read(`${workDir}/${path}`)),
    blob: (content) =>
      writeObject(ctx, { type: 'blob', content: enc(content), id: '' as ObjectId }),
  };
};

describe('createWorkingTreeWriter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Given '* eol=crlf' and an LF blob", () => {
    describe('When writeBlob runs', () => {
      it('Then the file holds CRLF and the stream writer received a transform', async () => {
        // Arrange
        const { sut, worktree, blob } = await setup({ attributes: '* eol=crlf\n' });
        const id = await blob('a\nb\n');
        const spy = vi.spyOn(writeFileMod, 'writeWorkingTreeEntryStream');

        // Act
        await sut.writeBlob(PATH, id, FILE_MODE.REGULAR);

        // Assert
        expect(await worktree()).toBe('a\r\nb\r\n');
        expect(spy.mock.calls[0]?.[5]).toBeDefined();
      });
    });
  });

  describe('Given no attributes and autocrlf false', () => {
    describe('When writeBlob runs', () => {
      it('Then the blob is written raw and no transform is passed', async () => {
        // Arrange
        const { sut, worktree, blob } = await setup();
        const id = await blob('a\nb\n');
        const spy = vi.spyOn(writeFileMod, 'writeWorkingTreeEntryStream');

        // Act
        await sut.writeBlob(PATH, id, FILE_MODE.REGULAR);

        // Assert
        expect(await worktree()).toBe('a\nb\n');
        expect(spy.mock.calls[0]?.[5]).toBeUndefined();
      });
    });
  });

  describe("Given '* text=auto' and core.autocrlf true", () => {
    describe('When writeBlob runs', () => {
      it('Then the blob is read in core and written converted', async () => {
        // Arrange
        const { sut, worktree, blob } = await setup({
          attributes: '* text=auto\n',
          config: '[core]\n\tautocrlf = true\n',
        });
        const id = await blob('a\nb\n');
        const stream = vi.spyOn(writeFileMod, 'writeWorkingTreeEntryStream');
        const buffered = vi.spyOn(writeFileMod, 'writeWorkingTreeEntry');

        // Act
        await sut.writeBlob(PATH, id, FILE_MODE.REGULAR);

        // Assert
        expect(await worktree()).toBe('a\r\nb\r\n');
        expect(buffered).toHaveBeenCalledTimes(1);
        expect(stream).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given the ident divergence blob', () => {
    describe("When writeBlob runs under 'ident text=auto'", () => {
      it('Then the in-core expander bytes land', async () => {
        // Arrange
        const { sut, worktree, blob } = await setup({ attributes: '* ident text=auto\n' });
        const id = await blob(DIVERGENCE_BLOB);

        // Act
        await sut.writeBlob(PATH, id, FILE_MODE.REGULAR);

        // Assert
        expect(await worktree()).toBe(`$$Id: ${id} $\n$Id:a b$\n$Id: ${id} $\n$Id: ${id} $Id$\n`);
      });
    });

    describe("When writeBlob runs under 'ident'", () => {
      it('Then the streamed expander bytes land', async () => {
        // Arrange
        const { sut, worktree, blob } = await setup({ attributes: '* ident\n' });
        const id = await blob(DIVERGENCE_BLOB);

        // Act
        await sut.writeBlob(PATH, id, FILE_MODE.REGULAR);

        // Assert
        expect(await worktree()).toBe(`$$Id$\n$Id: ${id} $\n$Id: a\tb $\n$Id: ${id} $Id$\n`);
      });
    });
  });

  describe("Given '* text=auto' and a missing blob", () => {
    describe('When writeBlob runs', () => {
      it('Then no file is left', async () => {
        // Arrange
        const { ctx, sut } = await setup({
          attributes: '* text=auto\n',
          config: '[core]\n\tautocrlf = true\n',
        });
        const id = '1'.repeat(40) as ObjectId;

        // Act
        const attempt = sut.writeBlob(PATH, id, FILE_MODE.REGULAR);

        // Assert
        await expect(attempt).rejects.toBeDefined();
        await expect(ctx.fs.exists(`${ctx.layout.workDir}/${PATH}`)).resolves.toBe(false);
      });
    });
  });

  describe('Given a smudge filter in core', () => {
    describe('When writeBlob runs', () => {
      it('Then the smudge runs under the limiter', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '* filter=f\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[filter "f"]\n\tsmudge = cat\n');
        invalidateConfigCache(ctx);
        const limiter = createConcurrencyLimiter(1);
        const run = vi.spyOn(limiter, 'run');
        const sut = createWorkingTreeWriter(ctx, {
          provider: () => buildAttributeProvider(ctx),
          settings: () => readEolSettings(ctx),
          limiter,
        });
        const id = await writeObject(ctx, { type: 'blob', content: enc('x'), id: '' as ObjectId });

        // Act
        await sut.writeBlob(PATH, id, FILE_MODE.REGULAR);

        // Assert
        expect(run).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a symlink or a gitlink entry', () => {
    describe('When writeBlob runs with a symlink mode', () => {
      it('Then the link target is the raw blob under any conversion', async () => {
        // Arrange
        const { ctx, sut, blob } = await setup({
          attributes: '* text=auto eol=crlf\n',
          config: '[core]\n\tautocrlf = true\n',
        });
        const id = await blob('target\n');

        // Act
        await sut.writeBlob(PATH, id, FILE_MODE.SYMLINK);

        // Assert
        await expect(ctx.fs.readlink(`${ctx.layout.workDir}/${PATH}`)).resolves.toBe('target\n');
      });
    });

    describe('When writeBlob runs with a gitlink mode', () => {
      it('Then an empty directory is created without reading the blob', async () => {
        // Arrange
        const { ctx, sut } = await setup();

        // Act
        await sut.writeBlob(PATH, '2'.repeat(40) as ObjectId, FILE_MODE.GITLINK);

        // Assert
        const stat = await ctx.fs.lstat(`${ctx.layout.workDir}/${PATH}`);
        expect(stat.isDirectory).toBe(true);
      });
    });
  });

  describe('Given in-memory bytes', () => {
    describe('When writeBytes runs without attributes', () => {
      it('Then the bytes are written as they are', async () => {
        // Arrange
        const { sut, worktree } = await setup();

        // Act
        await sut.writeBytes(PATH, enc('a\nb\n'), FILE_MODE.REGULAR);

        // Assert
        expect(await worktree()).toBe('a\nb\n');
      });
    });

    describe("When writeBytes runs under 'ident'", () => {
      it('Then the streamed expander applies over the bytes', async () => {
        // Arrange
        const { ctx, sut, worktree } = await setup({ attributes: '* ident\n' });
        const bytes = enc(DIVERGENCE_BLOB);
        const id = await writeObject(ctx, { type: 'blob', content: bytes, id: '' as ObjectId });

        // Act
        await sut.writeBytes(PATH, bytes, FILE_MODE.REGULAR);

        // Assert
        expect(await worktree()).toBe(`$$Id$\n$Id: ${id} $\n$Id: a\tb $\n$Id: ${id} $Id$\n`);
      });
    });

    describe("When writeBytes runs under '* eol=crlf'", () => {
      it('Then the streamed CRLF transform applies', async () => {
        // Arrange
        const { sut, worktree } = await setup({ attributes: '* eol=crlf\n' });

        // Act
        await sut.writeBytes(PATH, enc('a\nb\n'), FILE_MODE.REGULAR);

        // Assert
        expect(await worktree()).toBe('a\r\nb\r\n');
      });
    });

    describe("When writeBytes runs under '* text=auto' and autocrlf true", () => {
      it('Then the in-core conversion applies', async () => {
        // Arrange
        const { sut, worktree } = await setup({
          attributes: '* text=auto\n',
          config: '[core]\n\tautocrlf = true\n',
        });

        // Act
        await sut.writeBytes(PATH, enc('a\nb\n'), FILE_MODE.REGULAR);

        // Assert
        expect(await worktree()).toBe('a\r\nb\r\n');
      });
    });

    describe('When writeBytes runs with a symlink mode', () => {
      it('Then the bytes are the link target, unconverted', async () => {
        // Arrange
        const { ctx, sut } = await setup({ attributes: '* eol=crlf\n' });

        // Act
        await sut.writeBytes(PATH, enc('t\n'), FILE_MODE.SYMLINK);

        // Assert
        await expect(ctx.fs.readlink(`${ctx.layout.workDir}/${PATH}`)).resolves.toBe('t\n');
      });
    });
  });

  describe('Given checkout metadata', () => {
    describe('When writeBlob smudges in core', () => {
      it('Then the smudge target carries the metadata', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, '* filter=f\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[filter "f"]\n\tsmudge = cat\n');
        invalidateConfigCache(ctx);
        const treeish = '3'.repeat(40) as ObjectId;
        const sut = createWorkingTreeWriter(ctx, {
          provider: () => buildAttributeProvider(ctx),
          settings: () => readEolSettings(ctx),
          limiter: createConcurrencyLimiter(1),
          metadata: { ref: 'refs/heads/x', treeish },
        });
        const id = await writeObject(ctx, { type: 'blob', content: enc('x'), id: '' as ObjectId });
        const spy = vi.spyOn(convertBlobMod, 'convertToWorkingTree');

        // Act
        await sut.writeBlob(PATH, id, FILE_MODE.REGULAR);

        // Assert
        expect(spy.mock.calls[0]?.[1].target.metadata).toEqual({ ref: 'refs/heads/x', treeish });
      });
    });
  });
});
