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
  it('Given a path equal to cwd, When read runs, Then it delegates without throwing', async () => {
    const fs = stubFs();
    const sut = wrapFsValidator(fs, '/repo');

    await expect(sut.read('/repo')).resolves.toBeInstanceOf(Uint8Array);
    expect(fs.read).toHaveBeenCalledWith('/repo');
  });

  it('Given a path strictly under cwd, When read runs, Then it delegates with the same path', async () => {
    const fs = stubFs();
    const sut = wrapFsValidator(fs, '/repo');

    await sut.read('/repo/foo/bar');
    expect(fs.read).toHaveBeenCalledWith('/repo/foo/bar');
  });

  it('Given cwd that ends in a slash, When read runs with a sub-path, Then it delegates', async () => {
    const fs = stubFs();
    const sut = wrapFsValidator(fs, '/repo/');

    await sut.read('/repo/x');
    expect(fs.read).toHaveBeenCalled();
  });
});

describe('wrapFsValidator — Windows path separators', () => {
  it('Given a Windows-style cwd, When child path uses backslashes, Then it is accepted', async () => {
    const fs = stubFs();
    const sut = wrapFsValidator(fs, 'C:\\Users\\runner\\repo');

    await expect(sut.read('C:\\Users\\runner\\repo\\.git\\HEAD')).resolves.toBeInstanceOf(
      Uint8Array,
    );
  });

  it('Given a Windows-style cwd, When child path mixes backslash and forward-slash, Then it is accepted', async () => {
    const fs = stubFs();
    const sut = wrapFsValidator(fs, 'C:\\Users\\runner\\repo');

    await expect(sut.read('C:\\Users\\runner\\repo/.git/HEAD')).resolves.toBeInstanceOf(Uint8Array);
  });

  it('Given a Windows-style cwd, When a sibling Windows path is read, Then it is rejected', async () => {
    const fs = stubFs();
    const sut = wrapFsValidator(fs, 'C:\\Users\\runner\\repo');

    await expectOutside(() => sut.read('C:\\Users\\runner\\repo-evil\\steal'));
    expect(fs.read).not.toHaveBeenCalled();
  });
});

describe('wrapFsValidator — outside cwd rejected', () => {
  it('Given a sibling path, When read runs, Then throws PATHSPEC_OUTSIDE_REPO', async () => {
    const fs = stubFs();
    const sut = wrapFsValidator(fs, '/repo');

    await expectOutside(() => sut.read('/etc/passwd'));
    expect(fs.read).not.toHaveBeenCalled();
  });

  it('Given a path that is a string-prefix of cwd but not actually under it, When read runs, Then throws (e.g. /repo-evil)', async () => {
    const fs = stubFs();
    const sut = wrapFsValidator(fs, '/repo');

    await expectOutside(() => sut.read('/repo-evil/foo'));
  });

  it('Given write to a path outside cwd, When called, Then throws and the underlying fs is NOT touched', async () => {
    const fs = stubFs();
    const sut = wrapFsValidator(fs, '/repo');

    await expectOutside(() => sut.write('/elsewhere', new Uint8Array(0)));
    expect(fs.write).not.toHaveBeenCalled();
  });

  it('Given rename whose source is outside cwd, When called, Then throws', async () => {
    const fs = stubFs();
    const sut = wrapFsValidator(fs, '/repo');

    await expectOutside(() => sut.rename('/etc/x', '/repo/y'));
  });

  it('Given rename whose destination is outside cwd, When called, Then throws', async () => {
    const fs = stubFs();
    const sut = wrapFsValidator(fs, '/repo');

    await expectOutside(() => sut.rename('/repo/x', '/etc/y'));
  });

  it('Given symlink whose linkPath is outside cwd, When called, Then throws', async () => {
    const fs = stubFs();
    const sut = wrapFsValidator(fs, '/repo');

    await expectOutside(() => sut.symlink('arbitrary-target', '/etc/link'));
  });
});

describe('wrapFsValidator — coverage of every wrapped method', () => {
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
  ])('Given an in-cwd path, When %s is called, Then it delegates without throwing', async (_label, call) => {
    const fs = stubFs();
    const sut = wrapFsValidator(fs, '/repo');

    await expect(call(sut)).resolves.not.toThrow();
  });

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
  ])('Given an out-of-cwd path, When %s is called, Then throws PATHSPEC_OUTSIDE_REPO', async (_label, call) => {
    const fs = stubFs();
    const sut = wrapFsValidator(fs, '/repo');

    await expectOutside(() => call(sut) as Promise<unknown>);
  });
});
