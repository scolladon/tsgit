import { describe, expect, it, vi } from 'vitest';
import {
  removeWorkingTreeFile,
  writeRegularFile,
  writeRegularFileStream,
  writeWorkingTreeEntry,
  writeWorkingTreeEntryStream,
  writeWorkingTreeFile,
  writeWorkingTreeFileStream,
} from '../../../../../src/application/primitives/internal/write-working-tree-file.js';
import type { FilePath } from '../../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../../src/domain/objects/index.js';
import { buildSeededContext, instrumentedContext } from '../fixtures.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function* chunks(...parts: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const part of parts) {
    yield part;
  }
}

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
          const sut = writeWorkingTreeEntry(ctx, 'r.txt' as FilePath, content, FILE_MODE.REGULAR);

          // Assert
          await sut;
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
    describe('Given a multi-chunk source', () => {
      describe('When writeWorkingTreeFileStream writes the stream', () => {
        it('Then the working-tree file byte-equals the concatenated source', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const source = chunks(encode('hel'), encode('lo'));

          // Act
          await writeWorkingTreeFileStream(ctx, 'out.txt' as FilePath, source);

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
          const source = chunks(encode('x'));

          // Act
          await writeWorkingTreeFileStream(ctx, 'r.txt' as FilePath, source);

          // Assert
          expect(chmodSpy).not.toHaveBeenCalled();
        });
      });
    });
  });

  describe('writeRegularFileStream', () => {
    describe('Given an executable mode', () => {
      describe('When writeRegularFileStream writes the stream', () => {
        it('Then chmod is called with 0o755', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const fullPath = `${ctx.layout.workDir}/x.sh`;
          const chmodSpy = vi.spyOn(ctx.fs, 'chmod');
          const source = chunks(encode('exec'));

          // Act
          await writeRegularFileStream(ctx, fullPath, source, FILE_MODE.EXECUTABLE);

          // Assert
          expect(chmodSpy).toHaveBeenCalledWith(fullPath, 0o755);
        });
      });
    });

    describe('Given a regular mode', () => {
      describe('When writeRegularFileStream writes the stream', () => {
        it('Then chmod is called with 0o644', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const fullPath = `${ctx.layout.workDir}/r.txt`;
          const chmodSpy = vi.spyOn(ctx.fs, 'chmod');
          const source = chunks(encode('regular'));

          // Act
          await writeRegularFileStream(ctx, fullPath, source, FILE_MODE.REGULAR);

          // Assert
          expect(chmodSpy).toHaveBeenCalledWith(fullPath, 0o644);
        });
      });
    });

    describe('Given no mode argument', () => {
      describe('When writeRegularFileStream writes the stream', () => {
        it('Then chmod is never called', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const fullPath = `${ctx.layout.workDir}/r.txt`;
          const chmodSpy = vi.spyOn(ctx.fs, 'chmod');
          const source = chunks(encode('data'));

          // Act
          await writeRegularFileStream(ctx, fullPath, source);

          // Assert
          expect(chmodSpy).not.toHaveBeenCalled();
        });
      });
    });

    describe('Given a path currently occupied', () => {
      describe('When writeRegularFileStream runs', () => {
        it('Then rmIfExists runs before writeStream', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const fullPath = `${ctx.layout.workDir}/r.txt`;
          await ctx.fs.symlink('old-target', fullPath);
          const { ctx: instrumented, calls } = instrumentedContext(ctx);
          const source = chunks(encode('new'));

          // Act
          await writeRegularFileStream(instrumented, fullPath, source);

          // Assert
          const log = calls();
          const rmIndex = log.findIndex((c) => c.method === 'rm');
          const writeStreamIndex = log.findIndex((c) => c.method === 'writeStream');
          expect(rmIndex).toBeGreaterThanOrEqual(0);
          expect(writeStreamIndex).toBeGreaterThanOrEqual(0);
          expect(rmIndex).toBeLessThan(writeStreamIndex);
        });
      });
    });
  });

  describe('writeWorkingTreeEntryStream', () => {
    describe('Given a regular mode and a multi-chunk source', () => {
      describe('When writeWorkingTreeEntryStream writes the stream', () => {
        it('Then the file byte-equals the concatenated source and chmod is called with 0o644', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const chmodSpy = vi.spyOn(ctx.fs, 'chmod');
          const source = chunks(encode('hel'), encode('lo'));

          // Act
          await writeWorkingTreeEntryStream(ctx, 'r.txt' as FilePath, source, FILE_MODE.REGULAR);

          // Assert
          const result = await ctx.fs.read(`${ctx.layout.workDir}/r.txt`);
          expect(decode(result)).toBe('hello');
          expect(chmodSpy).toHaveBeenCalledWith(`${ctx.layout.workDir}/r.txt`, 0o644);
        });
      });
    });

    describe('Given an executable mode and a multi-chunk source', () => {
      describe('When writeWorkingTreeEntryStream writes the stream', () => {
        it('Then the file byte-equals the concatenated source and chmod is called with 0o755', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const chmodSpy = vi.spyOn(ctx.fs, 'chmod');
          const source = chunks(encode('ex'), encode('ec'));

          // Act
          await writeWorkingTreeEntryStream(ctx, 'x.sh' as FilePath, source, FILE_MODE.EXECUTABLE);

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
});
