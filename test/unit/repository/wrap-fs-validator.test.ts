import { describe, expect, it, vi } from 'vitest';

import { TsgitError } from '../../../src/domain/error.js';
import type { FileSystem } from '../../../src/ports/file-system.js';
import { wrapFsValidator } from '../../../src/repository/wrap-fs-validator.js';

const stubFs = (): FileSystem =>
  ({
    read: vi.fn(async () => new Uint8Array(0)),
    readSlice: vi.fn(async () => new Uint8Array(0)),
    readUtf8: vi.fn(async () => ''),
    write: vi.fn(async () => {}),
    writeExclusive: vi.fn(async () => {}),
    writeUtf8: vi.fn(async () => {}),
    appendUtf8: vi.fn(async () => {}),
    exists: vi.fn(async () => true),
    stat: vi.fn(async () => ({})),
    lstat: vi.fn(async () => ({})),
    readdir: vi.fn(async () => []),
    mkdir: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    readlink: vi.fn(async () => ''),
    symlink: vi.fn(async () => {}),
    chmod: vi.fn(async () => {}),
    rmRecursive: vi.fn(async () => {}),
    openWithNoFollow: vi.fn(async () => ({})),
  }) as unknown as FileSystem;

const expectOutside = async (fn: () => Promise<unknown>): Promise<void> => {
  try {
    await fn();
    expect.unreachable();
  } catch (err) {
    expect(err).toBeInstanceOf(TsgitError);
    expect((err as TsgitError).data.code).toBe('PATHSPEC_OUTSIDE_REPO');
  }
};

describe('wrapFsValidator — happy path', () => {
  describe('Given a path equal to cwd', () => {
    describe('When read runs', () => {
      it('Then it delegates without throwing', async () => {
        // Arrange
        const fs = stubFs();
        const sut = wrapFsValidator(fs, '/repo');

        // Assert
        await expect(sut.read('/repo')).resolves.toBeInstanceOf(Uint8Array);
        expect(fs.read).toHaveBeenCalledWith('/repo');
      });
    });
  });

  describe('Given a path strictly under cwd', () => {
    describe('When read runs', () => {
      it('Then it delegates with the same path', async () => {
        // Arrange
        const fs = stubFs();
        const sut = wrapFsValidator(fs, '/repo');

        await sut.read('/repo/foo/bar');
        // Assert
        expect(fs.read).toHaveBeenCalledWith('/repo/foo/bar');
      });
    });
  });

  describe('Given cwd that ends in a slash', () => {
    describe('When read runs with a sub-path', () => {
      it('Then it delegates', async () => {
        // Arrange
        const fs = stubFs();
        const sut = wrapFsValidator(fs, '/repo/');

        await sut.read('/repo/x');
        // Assert
        expect(fs.read).toHaveBeenCalled();
      });
    });
  });
});

describe('wrapFsValidator — Windows path separators', () => {
  describe('Given a Windows-style cwd', () => {
    describe('When child path uses backslashes', () => {
      it('Then it is accepted', async () => {
        // Arrange
        const fs = stubFs();
        const sut = wrapFsValidator(fs, 'C:\\Users\\runner\\repo');

        // Assert
        await expect(sut.read('C:\\Users\\runner\\repo\\.git\\HEAD')).resolves.toBeInstanceOf(
          Uint8Array,
        );
      });
    });
    describe('When child path mixes backslash and forward-slash', () => {
      it('Then it is accepted', async () => {
        // Arrange
        const fs = stubFs();
        const sut = wrapFsValidator(fs, 'C:\\Users\\runner\\repo');

        // Assert
        await expect(sut.read('C:\\Users\\runner\\repo/.git/HEAD')).resolves.toBeInstanceOf(
          Uint8Array,
        );
      });
    });
    describe('When a sibling Windows path is read', () => {
      it('Then it is rejected', async () => {
        // Arrange
        const fs = stubFs();
        const sut = wrapFsValidator(fs, 'C:\\Users\\runner\\repo');

        // Assert
        await expectOutside(() => sut.read('C:\\Users\\runner\\repo-evil\\steal'));
        expect(fs.read).not.toHaveBeenCalled();
      });
    });
  });
});

describe('wrapFsValidator — outside cwd rejected', () => {
  describe('Given a sibling path', () => {
    describe('When read runs', () => {
      it('Then throws PATHSPEC_OUTSIDE_REPO', async () => {
        // Arrange
        const fs = stubFs();
        const sut = wrapFsValidator(fs, '/repo');

        // Assert
        await expectOutside(() => sut.read('/etc/passwd'));
        expect(fs.read).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a path that is a string-prefix of cwd but not actually under it', () => {
    describe('When read runs', () => {
      it('Then throws (e.g. /repo-evil)', async () => {
        // Arrange
        const fs = stubFs();
        const sut = wrapFsValidator(fs, '/repo');

        // Assert
        await expectOutside(() => sut.read('/repo-evil/foo'));
      });
    });
  });

  describe('Given write to a path outside cwd', () => {
    describe('When called', () => {
      it('Then throws and the underlying fs is NOT touched', async () => {
        // Arrange
        const fs = stubFs();
        const sut = wrapFsValidator(fs, '/repo');

        // Assert
        await expectOutside(() => sut.write('/elsewhere', new Uint8Array(0)));
        expect(fs.write).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given rename whose source is outside cwd', () => {
    describe('When called', () => {
      it('Then throws', async () => {
        // Arrange
        const fs = stubFs();
        const sut = wrapFsValidator(fs, '/repo');

        // Assert
        await expectOutside(() => sut.rename('/etc/x', '/repo/y'));
      });
    });
  });

  describe('Given rename whose destination is outside cwd', () => {
    describe('When called', () => {
      it('Then throws', async () => {
        // Arrange
        const fs = stubFs();
        const sut = wrapFsValidator(fs, '/repo');

        // Assert
        await expectOutside(() => sut.rename('/repo/x', '/etc/y'));
      });
    });
  });

  describe('Given symlink whose linkPath is outside cwd', () => {
    describe('When called', () => {
      it('Then throws', async () => {
        // Arrange
        const fs = stubFs();
        const sut = wrapFsValidator(fs, '/repo');

        // Assert
        await expectOutside(() => sut.symlink('arbitrary-target', '/etc/link'));
      });
    });
  });
});

describe('wrapFsValidator — coverage of every wrapped method', () => {
  describe('Given an in-cwd path', () => {
    describe('When %s is called', () => {
      it.each([
        ['readSlice', (s: FileSystem) => s.readSlice('/repo/x', 0, 1)],
        ['readUtf8', (s: FileSystem) => s.readUtf8('/repo/x')],
        ['writeExclusive', (s: FileSystem) => s.writeExclusive('/repo/x', new Uint8Array(0))],
        ['writeUtf8', (s: FileSystem) => s.writeUtf8('/repo/x', '')],
        ['appendUtf8', (s: FileSystem) => s.appendUtf8('/repo/x', '')],
        ['exists', (s: FileSystem) => s.exists('/repo/x')],
        ['stat', (s: FileSystem) => s.stat('/repo/x')],
        ['lstat', (s: FileSystem) => s.lstat('/repo/x')],
        ['readdir', (s: FileSystem) => s.readdir('/repo/x')],
        ['mkdir', (s: FileSystem) => s.mkdir('/repo/x')],
        ['rm', (s: FileSystem) => s.rm('/repo/x')],
        ['readlink', (s: FileSystem) => s.readlink('/repo/x')],
        ['chmod', (s: FileSystem) => s.chmod('/repo/x', 0o644)],
        ['rmRecursive', (s: FileSystem) => s.rmRecursive('/repo/x')],
        ['openWithNoFollow', (s: FileSystem) => s.openWithNoFollow('/repo/x', 'read')],
      ])('Then it delegates without throwing', async (_label, call) => {
        // Arrange
        const fs = stubFs();
        const sut = wrapFsValidator(fs, '/repo');

        // Assert
        await expect(call(sut)).resolves.not.toThrow();
      });
    });
  });

  describe('Given an out-of-cwd path', () => {
    describe('When %s is called', () => {
      it.each([
        ['readSlice', (s: FileSystem) => s.readSlice('/etc/x', 0, 1)],
        ['readUtf8', (s: FileSystem) => s.readUtf8('/etc/x')],
        ['writeExclusive', (s: FileSystem) => s.writeExclusive('/etc/x', new Uint8Array(0))],
        ['writeUtf8', (s: FileSystem) => s.writeUtf8('/etc/x', '')],
        ['appendUtf8', (s: FileSystem) => s.appendUtf8('/etc/x', '')],
        ['exists', (s: FileSystem) => s.exists('/etc/x')],
        ['stat', (s: FileSystem) => s.stat('/etc/x')],
        ['lstat', (s: FileSystem) => s.lstat('/etc/x')],
        ['readdir', (s: FileSystem) => s.readdir('/etc/x')],
        ['mkdir', (s: FileSystem) => s.mkdir('/etc/x')],
        ['rm', (s: FileSystem) => s.rm('/etc/x')],
        ['readlink', (s: FileSystem) => s.readlink('/etc/x')],
        ['chmod', (s: FileSystem) => s.chmod('/etc/x', 0o644)],
        ['rmRecursive', (s: FileSystem) => s.rmRecursive('/etc/x')],
        ['openWithNoFollow', (s: FileSystem) => s.openWithNoFollow('/etc/x', 'read')],
      ])('Then throws PATHSPEC_OUTSIDE_REPO', async (_label, call) => {
        // Arrange
        const fs = stubFs();
        const sut = wrapFsValidator(fs, '/repo');

        // Assert
        await expectOutside(() => call(sut) as Promise<unknown>);
      });
    });
  });
});
