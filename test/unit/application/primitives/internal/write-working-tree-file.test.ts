import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { createLeadingPathScanner } from '../../../../../src/application/primitives/internal/symlinked-leading-path.js';
import {
  removeWorkingTreeFile,
  writeRegularFile,
  writeStreamedBlob,
  writeWorkingTreeEntry,
  writeWorkingTreeEntryStream,
  writeWorkingTreeFile,
  writeWorkingTreeFileStream,
} from '../../../../../src/application/primitives/internal/write-working-tree-file.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildSeededContext, instrumentedContext, writeRawObjectBytes } from '../fixtures.js';
import { writeSyntheticPack } from '../pack-fixture.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('write-working-tree-file', () => {
  describe('writeWorkingTreeFile', () => {
    describe('Given a nested path whose parent does not exist', () => {
      describe('When the file is written', () => {
        it('Then the parent directory is created and the bytes land', async () => {
          // Arrange
          const ctx = await buildSeededContext();

          // Act
          await writeWorkingTreeFile(ctx, 'nested/deep/a.txt' as FilePath, new Uint8Array([7]));

          // Assert
          const bytes = await ctx.fs.read(`${ctx.layout.workDir}/nested/deep/a.txt`);
          expect([...bytes]).toEqual([7]);
        });
      });
    });

    describe('Given a symlink occupies the target path', () => {
      describe('When the file is written', () => {
        it('Then the symlink is replaced by a regular file holding the bytes', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const fullPath = `${ctx.layout.workDir}/r.txt`;
          await ctx.fs.symlink('old-target', fullPath);

          // Act
          await writeWorkingTreeFile(ctx, 'r.txt' as FilePath, encode('x'));

          // Assert
          expect((await ctx.fs.lstat(fullPath)).isSymbolicLink).toBe(false);
          expect(decode(await ctx.fs.read(fullPath))).toBe('x');
        });
      });
    });

    describe('Given the regular-only façade', () => {
      describe('When the file is written', () => {
        it('Then chmod is never called', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const chmodSpy = vi.spyOn(ctx.fs, 'chmod');

          // Act
          await writeWorkingTreeFile(ctx, 'r.txt' as FilePath, encode('x'));

          // Assert
          expect(chmodSpy).not.toHaveBeenCalled();
        });
      });
    });
  });

  describe('writeRegularFile', () => {
    describe('Given a symlink occupies the target path', () => {
      describe('When a regular file is written', () => {
        it('Then the symlink is removed and the path becomes a regular file with the bytes', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const fullPath = `${ctx.layout.workDir}/r.txt`;
          await ctx.fs.symlink('old-target', fullPath);

          // Act
          await writeRegularFile(ctx, fullPath, encode('new'), FILE_MODE.REGULAR);

          // Assert
          expect((await ctx.fs.lstat(fullPath)).isSymbolicLink).toBe(false);
          expect(decode(await ctx.fs.read(fullPath))).toBe('new');
        });
      });
    });

    describe('Given no entry exists at the target path', () => {
      describe('When a regular file is written', () => {
        it('Then the unlink is a no-op and the bytes land', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const fullPath = `${ctx.layout.workDir}/r.txt`;

          // Act
          await writeRegularFile(ctx, fullPath, encode('new'), FILE_MODE.REGULAR);

          // Assert
          expect(decode(await ctx.fs.read(fullPath))).toBe('new');
        });
      });
    });

    describe('Given a regular file already occupies the target path', () => {
      describe('When a regular file is written', () => {
        it('Then the content is rewritten to the new bytes', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const fullPath = `${ctx.layout.workDir}/r.txt`;
          await ctx.fs.write(fullPath, encode('old'));

          // Act
          await writeRegularFile(ctx, fullPath, encode('new'), FILE_MODE.REGULAR);

          // Assert
          expect(decode(await ctx.fs.read(fullPath))).toBe('new');
        });
      });
    });

    describe('Given an executable mode', () => {
      describe('When a regular file is written', () => {
        it('Then it chmods the file to 0o755', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const fullPath = `${ctx.layout.workDir}/x.sh`;
          const chmodSpy = vi.spyOn(ctx.fs, 'chmod');

          // Act
          await writeRegularFile(ctx, fullPath, encode('exec'), FILE_MODE.EXECUTABLE);

          // Assert
          expect(chmodSpy).toHaveBeenCalledWith(fullPath, 0o755);
        });
      });
    });

    describe('Given a regular mode', () => {
      describe('When a regular file is written', () => {
        it('Then it chmods the file to 0o644', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const fullPath = `${ctx.layout.workDir}/r.txt`;
          const chmodSpy = vi.spyOn(ctx.fs, 'chmod');

          // Act
          await writeRegularFile(ctx, fullPath, encode('regular'), FILE_MODE.REGULAR);

          // Assert
          expect(chmodSpy).toHaveBeenCalledWith(fullPath, 0o644);
        });
      });
    });

    describe('Given the mode argument is omitted', () => {
      describe('When a regular file is written', () => {
        it('Then chmod is never called', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const fullPath = `${ctx.layout.workDir}/r.txt`;
          const chmodSpy = vi.spyOn(ctx.fs, 'chmod');

          // Act
          await writeRegularFile(ctx, fullPath, encode('regular'));

          // Assert
          expect(chmodSpy).not.toHaveBeenCalled();
        });
      });
    });

    describe('Given a symlink occupies the path on the memory adapter', () => {
      describe('When a regular file is written over it', () => {
        it('Then lstat reports a regular file with no stale symlink entry surviving', async () => {
          // Arrange — the memory adapter `write` keeps a stale `symlinks` entry
          // unless the writer unlinks first, and `lstat` checks `symlinks` first.
          const ctx = await buildSeededContext();
          const fullPath = `${ctx.layout.workDir}/r.txt`;
          await ctx.fs.symlink('old-target', fullPath);

          // Act
          await writeRegularFile(ctx, fullPath, encode('new'), FILE_MODE.REGULAR);

          // Assert — the cross-adapter consistency the always-unlink rule closes.
          const stat = await ctx.fs.lstat(fullPath);
          expect(stat.isSymbolicLink).toBe(false);
          expect(stat.isFile).toBe(true);
        });
      });
    });
  });

  describe('writeWorkingTreeEntry', () => {
    describe('Given a regular-file mode', () => {
      describe('When the entry is written', () => {
        it('Then the bytes land on disk as a plain file', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const content = new TextEncoder().encode('regular-content');

          // Act
          const result = writeWorkingTreeEntry(
            ctx,
            'r.txt' as FilePath,
            content,
            FILE_MODE.REGULAR,
          );

          // Assert
          await result;
          const bytes = await ctx.fs.read(`${ctx.layout.workDir}/r.txt`);
          expect(new TextDecoder().decode(bytes)).toBe('regular-content');
        });
      });
    });

    describe('Given a symlink mode', () => {
      describe('When the entry is written', () => {
        it('Then a symlink is created whose target is the decoded content', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const content = new TextEncoder().encode('target-path');

          // Act
          await writeWorkingTreeEntry(ctx, 'link' as FilePath, content, FILE_MODE.SYMLINK);

          // Assert
          const target = await ctx.fs.readlink(`${ctx.layout.workDir}/link`);
          expect(target).toBe('target-path');
        });
      });
    });

    describe('Given a symlink mode and an existing regular file at the path', () => {
      describe('When the entry is written', () => {
        it('Then the existing file is replaced by the symlink', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          await ctx.fs.write(`${ctx.layout.workDir}/link`, new TextEncoder().encode('old-file'));
          const content = new TextEncoder().encode('new-target');

          // Act
          await writeWorkingTreeEntry(ctx, 'link' as FilePath, content, FILE_MODE.SYMLINK);

          // Assert — old regular file gone, symlink created
          const target = await ctx.fs.readlink(`${ctx.layout.workDir}/link`);
          expect(target).toBe('new-target');
        });
      });
    });

    describe('Given a nested path whose parent does not exist', () => {
      describe('When the entry is written', () => {
        it('Then the parent directory is created', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const content = new TextEncoder().encode('nested');

          // Act
          await writeWorkingTreeEntry(ctx, 'sub/a.txt' as FilePath, content, FILE_MODE.REGULAR);

          // Assert
          const bytes = await ctx.fs.read(`${ctx.layout.workDir}/sub/a.txt`);
          expect(new TextDecoder().decode(bytes)).toBe('nested');
        });
      });
    });

    describe('Given a regular-file mode and a symlink occupying the path', () => {
      describe('When the entry is written', () => {
        it('Then the symlink is replaced by a regular file holding the bytes', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const fullPath = `${ctx.layout.workDir}/r.txt`;
          await ctx.fs.symlink('old-target', fullPath);

          // Act
          await writeWorkingTreeEntry(ctx, 'r.txt' as FilePath, encode('x'), FILE_MODE.REGULAR);

          // Assert
          expect((await ctx.fs.lstat(fullPath)).isSymbolicLink).toBe(false);
          expect(decode(await ctx.fs.read(fullPath))).toBe('x');
        });
      });
    });

    describe('Given a gitlink mode', () => {
      describe('When the entry is written', () => {
        it('Then a directory is created and no file write or chmod happens', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const fullPath = `${ctx.layout.workDir}/sub`;
          const writeSpy = vi.spyOn(ctx.fs, 'write');
          const chmodSpy = vi.spyOn(ctx.fs, 'chmod');

          // Act
          await writeWorkingTreeEntry(ctx, 'sub' as FilePath, new Uint8Array(), FILE_MODE.GITLINK);

          // Assert
          expect((await ctx.fs.lstat(fullPath)).isDirectory).toBe(true);
          expect(writeSpy).not.toHaveBeenCalled();
          expect(chmodSpy).not.toHaveBeenCalled();
        });
      });
    });
  });

  describe('unlink a symlinked leading component before a write lands beneath it', () => {
    describe('Given a symlinked leading directory pointing outside the repo', () => {
      describe('When a file is written beneath it', () => {
        it('Then the symlink is unlinked, a real directory is created, and the file lands inside the repo', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dirPath = `${ctx.layout.workDir}/dir`;
          await ctx.fs.symlink('/outside/secret', dirPath);

          // Act
          await writeWorkingTreeEntry(
            ctx,
            'dir/file.txt' as FilePath,
            encode('inside'),
            FILE_MODE.REGULAR,
          );

          // Assert
          const dirStat = await ctx.fs.lstat(dirPath);
          expect(dirStat.isSymbolicLink).toBe(false);
          expect(dirStat.isDirectory).toBe(true);
          expect(decode(await ctx.fs.read(`${dirPath}/file.txt`))).toBe('inside');
        });
      });
    });

    describe('Given a symlinked leading directory pointing at a sibling directory inside the repo', () => {
      describe('When a file is written beneath it', () => {
        it('Then the symlink is unlinked, a real directory is created, and the sibling directory is untouched', async () => {
          // Arrange — today this writes THROUGH the link into the sibling
          // directory instead of unlinking it and creating a real `dir`.
          const ctx = await buildSeededContext();
          const dirPath = `${ctx.layout.workDir}/dir`;
          const siblingKeepPath = `${ctx.layout.workDir}/inside/keep.txt`;
          await ctx.fs.write(siblingKeepPath, encode('keep'));
          await ctx.fs.symlink('inside', dirPath);

          // Act
          await writeWorkingTreeEntry(
            ctx,
            'dir/file.txt' as FilePath,
            encode('inside-write'),
            FILE_MODE.REGULAR,
          );

          // Assert
          const dirStat = await ctx.fs.lstat(dirPath);
          expect(dirStat.isSymbolicLink).toBe(false);
          expect(decode(await ctx.fs.read(`${dirPath}/file.txt`))).toBe('inside-write');
          expect(await ctx.fs.exists(`${dirPath}/keep.txt`)).toBe(false);
          expect(decode(await ctx.fs.read(siblingKeepPath))).toBe('keep');
        });
      });
    });
  });

  describe('writeWorkingTreeFile — unlink a symlinked leading component', () => {
    describe('Given a symlinked leading directory pointing outside the repo', () => {
      describe('When a file is written beneath it', () => {
        it('Then the symlink is unlinked and the file lands inside the repo', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dirPath = `${ctx.layout.workDir}/dir`;
          await ctx.fs.symlink('/outside/secret', dirPath);

          // Act
          await writeWorkingTreeFile(ctx, 'dir/file.txt' as FilePath, encode('inside'));

          // Assert
          const dirStat = await ctx.fs.lstat(dirPath);
          expect(dirStat.isSymbolicLink).toBe(false);
          expect(decode(await ctx.fs.read(`${dirPath}/file.txt`))).toBe('inside');
        });
      });
    });
  });

  describe('writeWorkingTreeFileStream — unlink a symlinked leading component', () => {
    describe('Given a symlinked leading directory pointing outside the repo', () => {
      describe('When a file is written beneath it', () => {
        it('Then the symlink is unlinked and the file lands inside the repo', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dirPath = `${ctx.layout.workDir}/dir`;
          await ctx.fs.symlink('/outside/secret', dirPath);
          const id = await writeRawObjectBytes(ctx, 'blob', encode('inside'));

          // Act
          await writeWorkingTreeFileStream(ctx, 'dir/file.txt' as FilePath, id);

          // Assert
          const dirStat = await ctx.fs.lstat(dirPath);
          expect(dirStat.isSymbolicLink).toBe(false);
          expect(decode(await ctx.fs.read(`${dirPath}/file.txt`))).toBe('inside');
        });
      });
    });
  });

  describe('writeWorkingTreeEntryStream — unlink a symlinked leading component', () => {
    describe('Given a symlinked leading directory pointing outside the repo', () => {
      describe('When a file is written beneath it', () => {
        it('Then the symlink is unlinked and the file lands inside the repo', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dirPath = `${ctx.layout.workDir}/dir`;
          await ctx.fs.symlink('/outside/secret', dirPath);
          const id = await writeRawObjectBytes(ctx, 'blob', encode('inside'));

          // Act
          await writeWorkingTreeEntryStream(ctx, 'dir/file.txt' as FilePath, id, FILE_MODE.REGULAR);

          // Assert
          const dirStat = await ctx.fs.lstat(dirPath);
          expect(dirStat.isSymbolicLink).toBe(false);
          expect(decode(await ctx.fs.read(`${dirPath}/file.txt`))).toBe('inside');
        });
      });
    });
  });

  describe('Given N files under the same deep prefix, written through one shared scanner', () => {
    describe('When each file is written via writeWorkingTreeEntry', () => {
      it('Then the shared prefix is lstat-ed once, not once per file (memo effectiveness)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.mkdir(`${ctx.layout.workDir}/dir/sub`);
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const scanner = createLeadingPathScanner(instrumented);

        // Act
        await writeWorkingTreeEntry(
          instrumented,
          'dir/sub/a.txt' as FilePath,
          encode('a'),
          FILE_MODE.REGULAR,
          scanner,
        );
        await writeWorkingTreeEntry(
          instrumented,
          'dir/sub/b.txt' as FilePath,
          encode('b'),
          FILE_MODE.REGULAR,
          scanner,
        );
        await writeWorkingTreeEntry(
          instrumented,
          'dir/sub/c.txt' as FilePath,
          encode('c'),
          FILE_MODE.REGULAR,
          scanner,
        );

        // Assert — the 2 distinct shared prefixes (`dir`, `dir/sub`) are each
        // lstat-ed exactly once across 3 writes, not once per write (6 total)
        // as an unmemoised scan would issue.
        const prefixLstats = calls().filter(
          (c) =>
            c.method === 'lstat' &&
            (c.path === `${ctx.layout.workDir}/dir` || c.path === `${ctx.layout.workDir}/dir/sub`),
        );
        expect(prefixLstats).toHaveLength(2);
      });
    });
  });

  describe('Given a symlinked leading directory already unlinked by an earlier write sharing a scanner', () => {
    describe('When a later write under the same prefix runs', () => {
      it('Then the stale symlink verdict is not reused — rm is not called again and the later file lands in the real directory', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const dirPath = `${ctx.layout.workDir}/dir`;
        await ctx.fs.symlink('/outside/secret', dirPath);
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const scanner = createLeadingPathScanner(instrumented);

        // Act
        await writeWorkingTreeEntry(
          instrumented,
          'dir/first.txt' as FilePath,
          encode('first'),
          FILE_MODE.REGULAR,
          scanner,
        );
        await writeWorkingTreeEntry(
          instrumented,
          'dir/second.txt' as FilePath,
          encode('second'),
          FILE_MODE.REGULAR,
          scanner,
        );

        // Assert — without invalidation, the memo would still answer 'symlink'
        // for `dir` on the second write and attempt to unlink it again.
        const rmCallsOnDir = calls().filter((c) => c.method === 'rm' && c.path === dirPath);
        expect(rmCallsOnDir).toHaveLength(1);
        expect(decode(await ctx.fs.read(`${dirPath}/first.txt`))).toBe('first');
        expect(decode(await ctx.fs.read(`${dirPath}/second.txt`))).toBe('second');
      });
    });
  });

  describe('writeWorkingTreeEntry — chmod', () => {
    describe('Given an executable mode', () => {
      describe('When writeWorkingTreeEntry writes a regular payload', () => {
        it('Then it chmods the file to 0o755', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const chmodSpy = vi.spyOn(ctx.fs, 'chmod');
          const content = new TextEncoder().encode('exec-content');

          // Act
          await writeWorkingTreeEntry(ctx, 'x.sh' as FilePath, content, FILE_MODE.EXECUTABLE);

          // Assert
          expect(chmodSpy).toHaveBeenCalledWith(`${ctx.layout.workDir}/x.sh`, 0o755);
        });
      });
    });

    describe('Given a regular mode', () => {
      describe('When writeWorkingTreeEntry writes a regular payload', () => {
        it('Then it chmods the file to 0o644', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const chmodSpy = vi.spyOn(ctx.fs, 'chmod');
          const content = new TextEncoder().encode('regular-content');

          // Act
          await writeWorkingTreeEntry(ctx, 'r.txt' as FilePath, content, FILE_MODE.REGULAR);

          // Assert
          expect(chmodSpy).toHaveBeenCalledWith(`${ctx.layout.workDir}/r.txt`, 0o644);
        });
      });
    });

    describe('Given a symlink mode', () => {
      describe('When writeWorkingTreeEntry writes a symlink', () => {
        it('Then chmod is never called', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const chmodSpy = vi.spyOn(ctx.fs, 'chmod');
          const content = new TextEncoder().encode('target-path');

          // Act
          await writeWorkingTreeEntry(ctx, 'link' as FilePath, content, FILE_MODE.SYMLINK);

          // Assert
          expect(chmodSpy).not.toHaveBeenCalled();
        });
      });
    });
  });

  describe('writeWorkingTreeFileStream', () => {
    describe('Given a loose blob', () => {
      describe('When writeWorkingTreeFileStream writes the stream', () => {
        it('Then the working-tree file byte-equals the concatenated source', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const id = await writeRawObjectBytes(ctx, 'blob', encode('hello'));

          // Act
          await writeWorkingTreeFileStream(ctx, 'out.txt' as FilePath, id);

          // Assert
          const result = await ctx.fs.read(`${ctx.layout.workDir}/out.txt`);
          expect(decode(result)).toBe('hello');
        });
      });
    });

    describe('Given the regular-only façade', () => {
      describe('When writeWorkingTreeFileStream writes the stream', () => {
        it('Then chmod is never called', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const chmodSpy = vi.spyOn(ctx.fs, 'chmod');
          const id = await writeRawObjectBytes(ctx, 'blob', encode('x'));

          // Act
          await writeWorkingTreeFileStream(ctx, 'r.txt' as FilePath, id);

          // Assert
          expect(chmodSpy).not.toHaveBeenCalled();
        });
      });
    });
    describe('Given a path currently occupied by a symlink', () => {
      describe('When writeWorkingTreeFileStream runs', () => {
        it('Then the occupant is removed before the stream is written', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const fullPath = `${ctx.layout.workDir}/r.txt`;
          await ctx.fs.symlink('old-target', fullPath);
          const { ctx: instrumented, calls } = instrumentedContext(ctx);
          const id = await writeRawObjectBytes(ctx, 'blob', encode('new'));

          // Act
          await writeWorkingTreeFileStream(instrumented, 'r.txt' as FilePath, id);

          // Assert
          const log = calls();
          const rmIndex = log.findIndex((c) => c.method === 'rm');
          const writeStreamIndex = log.findIndex((c) => c.method === 'writeStream');
          expect(rmIndex).toBeGreaterThanOrEqual(0);
          expect(rmIndex).toBeLessThan(writeStreamIndex);
        });
      });
    });
  });

  describe('writeWorkingTreeEntryStream', () => {
    describe('Given a regular mode and a loose blob', () => {
      describe('When writeWorkingTreeEntryStream writes the blob', () => {
        it('Then the file byte-equals the blob and chmod is called with 0o644', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const chmodSpy = vi.spyOn(ctx.fs, 'chmod');
          const id = await writeRawObjectBytes(ctx, 'blob', encode('hello'));

          // Act
          await writeWorkingTreeEntryStream(ctx, 'r.txt' as FilePath, id, FILE_MODE.REGULAR);

          // Assert
          const result = await ctx.fs.read(`${ctx.layout.workDir}/r.txt`);
          expect(decode(result)).toBe('hello');
          expect(chmodSpy).toHaveBeenCalledWith(`${ctx.layout.workDir}/r.txt`, 0o644);
        });
      });
    });

    describe('Given an executable mode and a loose blob', () => {
      describe('When writeWorkingTreeEntryStream writes the blob', () => {
        it('Then the file byte-equals the blob and chmod is called with 0o755', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const chmodSpy = vi.spyOn(ctx.fs, 'chmod');
          const id = await writeRawObjectBytes(ctx, 'blob', encode('exec'));

          // Act
          await writeWorkingTreeEntryStream(ctx, 'x.sh' as FilePath, id, FILE_MODE.EXECUTABLE);

          // Assert
          const result = await ctx.fs.read(`${ctx.layout.workDir}/x.sh`);
          expect(decode(result)).toBe('exec');
          expect(chmodSpy).toHaveBeenCalledWith(`${ctx.layout.workDir}/x.sh`, 0o755);
        });
      });
    });
  });

  describe('removeWorkingTreeFile', () => {
    describe('Given an existing working file', () => {
      describe('When it is removed', () => {
        it('Then the file is gone', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          await ctx.fs.write(`${ctx.layout.workDir}/a.txt`, new Uint8Array([1]));

          // Act
          await removeWorkingTreeFile(ctx, 'a.txt' as FilePath);

          // Assert
          expect(await ctx.fs.exists(`${ctx.layout.workDir}/a.txt`)).toBe(false);
        });
      });
    });

    describe('Given an absent working file', () => {
      describe('When it is removed', () => {
        it('Then it is a no-op (no throw)', async () => {
          // Arrange
          const ctx = await buildSeededContext();

          // Act + Assert — must not throw on a missing file.
          await expect(
            removeWorkingTreeFile(ctx, 'missing.txt' as FilePath),
          ).resolves.toBeUndefined();
        });
      });
    });
  });

  describe('writeStreamedBlob', () => {
    const PRIMARY_OBJECTS = '/repo/.git/objects';
    const ALT_OBJECTS = '/repo/alt/objects';
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
    const MISSING_ID = 'a'.repeat(40) as ObjectId;
    const REFUSAL = { code: 'INVALID_MULTI_PACK_INDEX' };

    const unreadableAlternateContext = async (signal?: AbortSignal): Promise<Context> => {
      const ctx = createMemoryContext({
        ...(signal !== undefined ? { signal } : {}),
        files: { [`${PRIMARY_OBJECTS}/info/alternates`]: encode(`${ALT_OBJECTS}\n`) },
      });
      await ctx.fs.mkdir(ALT_OBJECTS);
      await ctx.fs.write(`${ALT_OBJECTS}/pack/multi-pack-index`, FLIPPED_SIGNATURE_MIDX);
      return ctx;
    };

    const rejection = async (attempt: Promise<unknown>): Promise<unknown> => {
      try {
        await attempt;
      } catch (error) {
        return error;
      }
      return undefined;
    };

    describe('Given the locate is refused by an unreadable alternate and an executable mode', () => {
      describe('When the blob is written', () => {
        it('Then an empty 0o755 file is left and the refusal is thrown', async () => {
          // Arrange
          const ctx = await unreadableAlternateContext();
          const fullPath = `${ctx.layout.workDir}/x.sh`;
          const chmod = vi.spyOn(ctx.fs, 'chmod');

          // Act
          const failure = await rejection(
            writeStreamedBlob(ctx, fullPath, MISSING_ID, FILE_MODE.EXECUTABLE),
          );

          // Assert
          expect((failure as TsgitError).data).toMatchObject(REFUSAL);
          expect((await ctx.fs.read(fullPath)).length).toBe(0);
          expect(chmod).toHaveBeenCalledWith(fullPath, 0o755);
        });
      });
    });

    describe('Given the locate is refused and a regular mode', () => {
      describe('When the blob is written', () => {
        it('Then an empty 0o644 file is left', async () => {
          // Arrange
          const ctx = await unreadableAlternateContext();
          const fullPath = `${ctx.layout.workDir}/r.txt`;
          const chmod = vi.spyOn(ctx.fs, 'chmod');

          // Act
          await rejection(writeStreamedBlob(ctx, fullPath, MISSING_ID, FILE_MODE.REGULAR));

          // Assert
          expect((await ctx.fs.read(fullPath)).length).toBe(0);
          expect(chmod).toHaveBeenCalledWith(fullPath, 0o644);
        });
      });
    });

    describe('Given the locate is refused and no mode', () => {
      describe('When the blob is written', () => {
        it('Then the empty file is left and chmod is never called', async () => {
          // Arrange
          const ctx = await unreadableAlternateContext();
          const fullPath = `${ctx.layout.workDir}/m.txt`;
          const chmod = vi.spyOn(ctx.fs, 'chmod');

          // Act
          await rejection(writeStreamedBlob(ctx, fullPath, MISSING_ID));

          // Assert
          expect((await ctx.fs.read(fullPath)).length).toBe(0);
          expect(chmod).not.toHaveBeenCalled();
        });
      });
    });

    describe('Given the locate is refused and a modified file occupies the path', () => {
      describe('When the blob is written', () => {
        it('Then the occupant is replaced by the empty file', async () => {
          // Arrange
          const ctx = await unreadableAlternateContext();
          const fullPath = `${ctx.layout.workDir}/o.txt`;
          await ctx.fs.write(fullPath, encode('local edits'));

          // Act
          await rejection(writeStreamedBlob(ctx, fullPath, MISSING_ID, FILE_MODE.REGULAR));

          // Assert
          expect((await ctx.fs.read(fullPath)).length).toBe(0);
        });
      });
    });

    describe('Given a blob absent from every source and an occupant', () => {
      describe('When the blob is written', () => {
        it('Then no file is left and objectNotFound is thrown', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const fullPath = `${ctx.layout.workDir}/gone.txt`;
          await ctx.fs.write(fullPath, encode('occupant'));

          // Act
          const failure = await rejection(
            writeStreamedBlob(ctx, fullPath, MISSING_ID, FILE_MODE.REGULAR),
          );

          // Assert
          expect((failure as TsgitError).data).toMatchObject({
            code: 'OBJECT_NOT_FOUND',
            id: MISSING_ID,
          });
          expect(await ctx.fs.exists(fullPath)).toBe(false);
        });
      });
    });

    describe('Given the signal aborts during the locate', () => {
      describe('When the blob is written', () => {
        it('Then operationAborted is thrown and no file is created', async () => {
          // Arrange
          const controller = new AbortController();
          const ctx = await unreadableAlternateContext(controller.signal);
          controller.abort();
          const fullPath = `${ctx.layout.workDir}/a.txt`;

          // Act
          const failure = await rejection(
            writeStreamedBlob(ctx, fullPath, MISSING_ID, FILE_MODE.REGULAR),
          );

          // Assert
          expect((failure as TsgitError).data.code).toBe('OPERATION_ABORTED');
          expect(await ctx.fs.exists(fullPath)).toBe(false);
        });
      });
    });

    describe('Given a blob whose loose body is corrupt', () => {
      describe('When the blob is written', () => {
        it("Then the refused open leaves git's empty file and reports the inflate failure", async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const id = await writeRawObjectBytes(ctx, 'blob', encode('honest'));
          await ctx.fs.write(
            `${ctx.layout.gitDir}/objects/${id.slice(0, 2)}/${id.slice(2)}`,
            new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
          );
          const fullPath = `${ctx.layout.workDir}/c.txt`;

          // Act
          const failure = await rejection(writeStreamedBlob(ctx, fullPath, id, FILE_MODE.REGULAR));

          // Assert
          expect((failure as TsgitError).data).toMatchObject({ code: 'DECOMPRESS_FAILED' });
          expect((await ctx.fs.read(fullPath)).length).toBe(0);
        });
      });
    });

    describe('Given a packed delta blob whose base is in no store', () => {
      describe('When the blob is written', () => {
        it("Then the refused open leaves no file, as git's in-core fallback does", async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const base = encode('the absent base');
          const [id] = await writeSyntheticPack(ctx, 'orphan', [
            {
              kind: 'ref-delta',
              baseId: MISSING_ID,
              baseUncompressed: base,
              targetContent: encode('the delta target'),
            },
          ]);
          const fullPath = `${ctx.layout.workDir}/d.txt`;

          // Act
          const failure = await rejection(
            writeStreamedBlob(ctx, fullPath, id as ObjectId, FILE_MODE.REGULAR),
          );

          // Assert
          expect((failure as TsgitError).data).toMatchObject({ code: 'OBJECT_NOT_FOUND' });
          expect(await ctx.fs.exists(fullPath)).toBe(false);
        });
      });
    });

    describe('Given a signal aborted after the loose blob was located', () => {
      describe('When the blob is written', () => {
        it('Then the abort is thrown and no empty file is left', async () => {
          // Arrange
          const controller = new AbortController();
          const base = await buildSeededContext({ signal: controller.signal });
          const id = await writeRawObjectBytes(base, 'blob', encode('located then aborted'));
          const loosePath = `${base.layout.gitDir}/objects/${id.slice(0, 2)}/${id.slice(2)}`;
          const ctx: Context = {
            ...base,
            fs: {
              ...base.fs,
              read: async (path: string) => {
                const bytes = await base.fs.read(path);
                if (path === loosePath) controller.abort();
                return bytes;
              },
            },
          };
          const fullPath = `${ctx.layout.workDir}/a.txt`;

          // Act
          const failure = await rejection(writeStreamedBlob(ctx, fullPath, id, FILE_MODE.REGULAR));

          // Assert
          expect((failure as TsgitError).data).toMatchObject({ code: 'OPERATION_ABORTED' });
          expect(await ctx.fs.exists(fullPath)).toBe(false);
        });
      });
    });

    describe('Given the id names a commit', () => {
      describe('When the blob is written', () => {
        it('Then unexpectedObjectType is thrown and no file is left', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const id = await writeRawObjectBytes(ctx, 'commit', encode('not a blob'));
          const fullPath = `${ctx.layout.workDir}/t.txt`;
          await ctx.fs.write(fullPath, encode('occupant'));

          // Act
          const failure = await rejection(writeStreamedBlob(ctx, fullPath, id, FILE_MODE.REGULAR));

          // Assert
          expect((failure as TsgitError).data).toMatchObject({
            code: 'UNEXPECTED_OBJECT_TYPE',
            expected: 'blob',
            actual: 'commit',
          });
          expect(await ctx.fs.exists(fullPath)).toBe(false);
        });
      });
    });

    describe('Given the locate is refused and creating the empty file fails', () => {
      describe('When the blob is written', () => {
        it('Then the create failure is thrown with the refusal as its cause', async () => {
          // Arrange
          const ctx = await unreadableAlternateContext();
          const createFailure = new Error('disk full');
          vi.spyOn(ctx.fs, 'write').mockRejectedValue(createFailure);

          // Act
          const failure = await rejection(
            writeStreamedBlob(ctx, `${ctx.layout.workDir}/f.txt`, MISSING_ID, FILE_MODE.REGULAR),
          );

          // Assert
          expect(failure).toBe(createFailure);
          expect(((failure as Error).cause as TsgitError).data).toMatchObject(REFUSAL);
        });
      });
    });

    describe('Given the locate is refused and creating the empty file throws a non-Error', () => {
      describe('When the blob is written', () => {
        it('Then it is wrapped in an Error whose cause is the refusal', async () => {
          // Arrange
          const ctx = await unreadableAlternateContext();
          vi.spyOn(ctx.fs, 'write').mockRejectedValue('nope');

          // Act
          const failure = await rejection(
            writeStreamedBlob(ctx, `${ctx.layout.workDir}/n.txt`, MISSING_ID, FILE_MODE.REGULAR),
          );

          // Assert
          expect((failure as Error).message).toBe('nope');
          expect(((failure as Error).cause as TsgitError).data).toMatchObject(REFUSAL);
        });
      });
    });

    describe('Given a packed delta blob', () => {
      describe('When the blob is written', () => {
        it('Then the file holds the reconstructed content', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const [, id] = await writeSyntheticPack(ctx, 'delta', [
            { kind: 'base', type: 'blob', content: encode('the delta base') },
            { kind: 'ofs-delta', baseIndex: 0, targetContent: encode('the delta target') },
          ]);
          const fullPath = `${ctx.layout.workDir}/d.txt`;
          const sut = writeStreamedBlob;

          // Act
          await sut(ctx, fullPath, id as ObjectId, FILE_MODE.REGULAR);

          // Assert
          expect(await ctx.fs.readUtf8(fullPath)).toBe('the delta target');
        });
      });
    });

    describe('Given a packed delta blob that reconstructs to nothing', () => {
      describe('When the blob is written', () => {
        it('Then the file is empty and no empty chunk is handed to the file system', async () => {
          // Arrange
          const seeded = await buildSeededContext();
          const [, id] = await writeSyntheticPack(seeded, 'empty', [
            { kind: 'base', type: 'blob', content: encode('the delta base') },
            { kind: 'ofs-delta', baseIndex: 0, targetContent: new Uint8Array(0) },
          ]);
          const chunks: Uint8Array[] = [];
          const ctx: Context = {
            ...seeded,
            fs: {
              ...seeded.fs,
              writeStream: async (path, source) => {
                const collected: Uint8Array[] = [];
                for await (const chunk of source) collected.push(chunk);
                chunks.push(...collected);
                await seeded.fs.write(path, new Uint8Array(0));
              },
            },
          };
          const fullPath = `${ctx.layout.workDir}/e.txt`;
          const sut = writeStreamedBlob;

          // Act
          await sut(ctx, fullPath, id as ObjectId, FILE_MODE.REGULAR);

          // Assert
          expect(chunks).toEqual([]);
          expect((await ctx.fs.read(fullPath)).byteLength).toBe(0);
        });
      });
    });

    describe('Given a small loose blob and an executable mode', () => {
      describe('When the blob is written', () => {
        it('Then the bytes land with 0o755', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const id = await writeRawObjectBytes(ctx, 'blob', encode('#!/bin/sh'));
          const fullPath = `${ctx.layout.workDir}/ok.sh`;
          const chmod = vi.spyOn(ctx.fs, 'chmod');

          // Act
          await writeStreamedBlob(ctx, fullPath, id, FILE_MODE.EXECUTABLE);

          // Assert
          expect(decode(await ctx.fs.read(fullPath))).toBe('#!/bin/sh');
          expect(chmod).toHaveBeenCalledWith(fullPath, 0o755);
        });
      });
    });
  });
});
