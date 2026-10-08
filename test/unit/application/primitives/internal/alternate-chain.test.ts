import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  type AlternateChainIo,
  realpathAllowingMissingLeaf,
  resolveObjectSources,
} from '../../../../../src/application/primitives/internal/alternate-chain.js';
import {
  posixGitPathSyntax,
  windowsGitPathSyntax,
} from '../../../../../src/application/primitives/internal/git-path-syntax.js';
import { fileNotFound, permissionDenied } from '../../../../../src/domain/error.js';
import type { Context } from '../../../../../src/ports/context.js';
import type { FileStat } from '../../../../../src/ports/file-system.js';
import type { AlternatePathProbe } from '../../../../../src/ports/object-source-access.js';

const PRIMARY = '/repo/.git/objects';
const CWD = '/repo';
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const listFile = (dir: string): string => `${dir}/info/alternates`;

const ioOf = (ctx: Context): AlternateChainIo => ({
  probe: () => ctx.fs,
  reader: () => ctx.fs,
  pathSyntax: posixGitPathSyntax,
});

const contextWith = (lists: Readonly<Record<string, string>>): Context =>
  createMemoryContext({
    files: Object.fromEntries(
      Object.entries(lists).map(([dir, text]) => [listFile(dir), encode(text)]),
    ),
  });

const dirsOf = async (ctx: Context) =>
  (await resolveObjectSources(ctx, ioOf(ctx))).sources.map((s) => s.objectsDir);

describe('realpathAllowingMissingLeaf', () => {
  describe('Given a path through a symlinked directory', () => {
    describe('When realpathAllowingMissingLeaf', () => {
      it('Then the resolved path is returned', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.mkdir('/repo/real/objects');
        await ctx.fs.symlink('/repo/real', '/repo/link');

        // Act
        const result = await realpathAllowingMissingLeaf(
          posixGitPathSyntax,
          ctx.fs,
          '/repo/link/objects',
          CWD,
        );

        // Assert
        expect(result).toBe('/repo/real/objects');
      });
    });
  });

  describe('Given a path whose last component is missing', () => {
    describe('When realpathAllowingMissingLeaf', () => {
      it('Then the missing leaf is kept', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.mkdir('/repo/real');
        await ctx.fs.symlink('/repo/real', '/repo/link');

        // Act
        const result = await realpathAllowingMissingLeaf(
          posixGitPathSyntax,
          ctx.fs,
          '/repo/link/absent',
          CWD,
        );

        // Assert
        expect(result).toBe('/repo/real/absent');
      });
    });
  });

  describe('Given a path whose middle component is missing', () => {
    describe('When realpathAllowingMissingLeaf', () => {
      it('Then it is undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const result = await realpathAllowingMissingLeaf(
          posixGitPathSyntax,
          ctx.fs,
          '/repo/absent/objects',
          CWD,
        );

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a path whose middle component is a regular file', () => {
    describe('When realpathAllowingMissingLeaf', () => {
      it('Then it is undefined', async () => {
        // Arrange
        const ctx = createMemoryContext({ files: { '/repo/file': new Uint8Array() } });

        // Act
        const result = await realpathAllowingMissingLeaf(
          posixGitPathSyntax,
          ctx.fs,
          '/repo/file/objects',
          CWD,
        );

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a path walking back out of a regular file with ..', () => {
    describe('When realpathAllowingMissingLeaf', () => {
      it('Then the file is walked through lexically, as git does', async () => {
        // Arrange
        const ctx = createMemoryContext({ files: { '/repo/d/HEAD': new Uint8Array() } });

        // Act
        const result = await realpathAllowingMissingLeaf(
          posixGitPathSyntax,
          ctx.fs,
          '/repo/d/HEAD/../objects',
          CWD,
        );

        // Assert
        expect(result).toBe('/repo/d/objects');
      });
    });
  });

  describe('Given a separator after a missing last component', () => {
    describe('When realpathAllowingMissingLeaf', () => {
      it('Then it is undefined', async () => {
        // Arrange
        const ctx = createMemoryContext({ files: { '/repo/d/HEAD': new Uint8Array() } });

        // Act
        const result = await realpathAllowingMissingLeaf(
          posixGitPathSyntax,
          ctx.fs,
          '/repo/d/missing/',
          CWD,
        );

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a separator after an existing last component', () => {
    describe('When realpathAllowingMissingLeaf', () => {
      it('Then the separator is dropped', async () => {
        // Arrange
        const ctx = createMemoryContext({ files: { '/repo/d/HEAD': new Uint8Array() } });

        // Act
        const result = await realpathAllowingMissingLeaf(
          posixGitPathSyntax,
          ctx.fs,
          '/repo/d/HEAD//',
          CWD,
        );

        // Assert
        expect(result).toBe('/repo/d/HEAD');
      });
    });
  });

  describe('Given a symlink loop', () => {
    describe('When realpathAllowingMissingLeaf', () => {
      it('Then it is undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.symlink('/repo/b', '/repo/a');
        await ctx.fs.symlink('/repo/a', '/repo/b');

        // Act
        const result = await realpathAllowingMissingLeaf(
          posixGitPathSyntax,
          ctx.fs,
          '/repo/a/objects',
          CWD,
        );

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe.each([
    { links: 33, expected: '/repo/real/objects' },
    { links: 34, expected: undefined },
  ])('Given a chain of $links symlinks to the directory', ({ links, expected }) => {
    describe('When realpathAllowingMissingLeaf', () => {
      it('Then git follows at most 33 links before giving up', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.mkdir('/repo/real/objects');
        await ctx.fs.mkdir('/repo/chain');
        let previous = '/repo/real/objects';
        for (let link = 1; link <= links; link++) {
          await ctx.fs.symlink(previous, `/repo/chain/l${link}`);
          previous = `/repo/chain/l${link}`;
        }

        // Act
        const result = await realpathAllowingMissingLeaf(posixGitPathSyntax, ctx.fs, previous, CWD);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a rootless path', () => {
    describe('When realpathAllowingMissingLeaf from a rooted cwd', () => {
      it('Then it resolves under the cwd', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.mkdir('/repo/real');
        await ctx.fs.symlink('/repo/real', '/repo/link');

        // Act
        const result = await realpathAllowingMissingLeaf(
          windowsGitPathSyntax,
          ctx.fs,
          '\\\\server',
          '/repo/link',
        );

        // Assert
        expect(result).toBe('/repo/real/server');
      });
    });

    describe('When realpathAllowingMissingLeaf from a rootless cwd', () => {
      it('Then it is undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const result = await realpathAllowingMissingLeaf(
          windowsGitPathSyntax,
          ctx.fs,
          '\\\\server',
          'repo',
        );

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a relative symlink and dot-dot components', () => {
    describe('When realpathAllowingMissingLeaf', () => {
      it('Then they resolve against the link holder', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.mkdir('/repo/x/y');
        await ctx.fs.mkdir('/repo/z');
        await ctx.fs.symlink('../../z', '/repo/x/y/link');

        // Act
        const result = await realpathAllowingMissingLeaf(
          posixGitPathSyntax,
          ctx.fs,
          '/repo/x/y/link/./../x',
          CWD,
        );

        // Assert
        expect(result).toBe('/repo/x');
      });
    });
  });
});

describe('resolveObjectSources', () => {
  describe('Given a primary without an alternates file', () => {
    describe('When the chain is resolved', () => {
      it('Then only the local primary at depth -1 is a source and nothing is reported', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const result = await resolveObjectSources(ctx, ioOf(ctx));

        // Assert
        expect(result).toEqual({
          sources: [{ objectsDir: PRIMARY, local: true, depth: -1 }],
          diagnostics: [],
          reports: new Map(),
        });
      });
    });
  });

  describe("Given a probe refusing an ancestor of the primary's path", () => {
    const refusingAncestor =
      (ctx: Context, fault: unknown): AlternateChainIo['probe'] =>
      (path) =>
        path === PRIMARY
          ? {
              stat: ctx.fs.stat.bind(ctx.fs),
              readlink: ctx.fs.readlink.bind(ctx.fs),
              lstat: (probed) => (probed === CWD ? Promise.reject(fault) : ctx.fs.lstat(probed)),
            }
          : ctx.fs;

    describe('When the chain is resolved and the refusal is coded', () => {
      it('Then the raw primary is kept and its list still resolves', async () => {
        // Arrange
        const ctx = contextWith({ [PRIMARY]: '/repo/store/a\n', '/repo/store/a': '' });
        const io = { ...ioOf(ctx), probe: refusingAncestor(ctx, permissionDenied(CWD)) };

        // Act
        const result = await resolveObjectSources(ctx, io);

        // Assert
        expect(result.sources.map((source) => source.objectsDir)).toEqual([
          PRIMARY,
          '/repo/store/a',
        ]);
        expect(result.diagnostics).toEqual([]);
      });
    });

    describe('When the chain is resolved and the refusal carries no code', () => {
      it('Then the refusal propagates', async () => {
        // Arrange
        const ctx = contextWith({});
        const defect = new Error('probe defect');
        const io = { ...ioOf(ctx), probe: refusingAncestor(ctx, defect) };

        // Act
        const result = await resolveObjectSources(ctx, io).catch((error: unknown) => error);

        // Assert
        expect(result).toBe(defect);
      });
    });
  });

  describe('Given an absolute entry', () => {
    describe('When the chain is resolved', () => {
      it('Then it is a non-local source at depth 0 with its trailing slash trimmed', async () => {
        // Arrange
        const ctx = contextWith({ [PRIMARY]: '/repo/store/a/\n', '/repo/store/a': '' });

        // Act
        const result = await resolveObjectSources(ctx, ioOf(ctx));

        // Assert
        expect(result.sources[1]).toEqual({ objectsDir: '/repo/store/a', local: false, depth: 0 });
      });
    });
  });

  describe('Given a relative entry', () => {
    describe('When the chain is resolved', () => {
      it('Then it is joined to the realpath of the holder', async () => {
        // Arrange
        const ctx = contextWith({
          [PRIMARY]: '/repo/link\n',
          '/repo/real': '../sibling\n',
          '/repo/sibling': '',
        });
        await ctx.fs.symlink('/repo/real', '/repo/link');

        // Act
        const result = await dirsOf(ctx);

        // Assert
        expect(result).toEqual([PRIMARY, '/repo/real', '/repo/sibling']);
      });
    });
  });

  describe('Given a chain of seven stores below the primary', () => {
    const chain = (): Context =>
      contextWith({
        [PRIMARY]: '/repo/s/n1\n',
        '/repo/s/n1': '/repo/s/n2\n',
        '/repo/s/n2': '/repo/s/n3\n',
        '/repo/s/n3': '/repo/s/n4\n',
        '/repo/s/n4': '/repo/s/n5\n',
        '/repo/s/n5': '/repo/s/n6\n',
        '/repo/s/n6': '/repo/s/n7\n',
        '/repo/s/n7': '',
      });

    describe('When the chain is resolved', () => {
      it('Then six levels are reachable and the seventh is cut', async () => {
        // Arrange
        const ctx = chain();

        // Act
        const result = await dirsOf(ctx);

        // Assert
        expect(result).toEqual([
          PRIMARY,
          '/repo/s/n1',
          '/repo/s/n2',
          '/repo/s/n3',
          '/repo/s/n4',
          '/repo/s/n5',
          '/repo/s/n6',
        ]);
      });

      it('Then nesting-too-deep is reported once on the sixth holder', async () => {
        // Arrange
        const ctx = chain();

        // Act
        const result = await resolveObjectSources(ctx, ioOf(ctx));

        // Assert
        expect(result.diagnostics).toEqual([
          { reason: 'nesting-too-deep', path: '/repo/s/n6', listedIn: '/repo/s/n6' },
        ]);
      });
    });
  });

  describe('Given a sixth-level store whose list holds no usable entry', () => {
    describe('When the chain is resolved', () => {
      it('Then nesting-too-deep is not reported', async () => {
        // Arrange
        const ctx = contextWith({
          [PRIMARY]: '/repo/s/n1\n',
          '/repo/s/n1': '/repo/s/n2\n',
          '/repo/s/n2': '/repo/s/n3\n',
          '/repo/s/n3': '/repo/s/n4\n',
          '/repo/s/n4': '/repo/s/n5\n',
          '/repo/s/n5': '/repo/s/n6\n',
          '/repo/s/n6': '# only a comment\n',
        });

        // Act
        const result = await resolveObjectSources(ctx, ioOf(ctx));

        // Assert
        expect(result.diagnostics).toEqual([]);
      });
    });
  });

  describe('Given a list naming the primary itself and a store twice', () => {
    describe('When the chain is resolved', () => {
      it('Then the self entry and the duplicate are silent', async () => {
        // Arrange
        const ctx = contextWith({
          [PRIMARY]: `${PRIMARY}\n/repo/s/a\n/repo/s/a/\n`,
          '/repo/s/a': '',
        });

        // Act
        const result = await resolveObjectSources(ctx, ioOf(ctx));

        // Assert
        expect(result.sources.map((s) => s.objectsDir)).toEqual([PRIMARY, '/repo/s/a']);
        expect(result.diagnostics).toEqual([]);
      });
    });
  });

  describe('Given a cycle between two alternates and the primary', () => {
    describe('When the chain is resolved', () => {
      it('Then it terminates with each store once', async () => {
        // Arrange
        const ctx = contextWith({
          [PRIMARY]: '/repo/s/a\n',
          '/repo/s/a': '/repo/s/b\n',
          '/repo/s/b': `/repo/s/a\n${PRIMARY}\n`,
        });

        // Act
        const result = await dirsOf(ctx);

        // Assert
        expect(result).toEqual([PRIMARY, '/repo/s/a', '/repo/s/b']);
      });
    });
  });

  describe('Given a branching tree of alternates', () => {
    describe('When the chain is resolved', () => {
      it('Then stores come in depth-first pre-order with their depths', async () => {
        // Arrange
        const ctx = contextWith({
          [PRIMARY]: '/repo/s/a\n/repo/s/c\n',
          '/repo/s/a': '/repo/s/b\n',
          '/repo/s/b': '',
          '/repo/s/c': '',
        });

        // Act
        const result = await resolveObjectSources(ctx, ioOf(ctx));

        // Assert
        expect(result.sources.map((s) => [s.objectsDir, s.depth])).toEqual([
          [PRIMARY, -1],
          ['/repo/s/a', 0],
          ['/repo/s/b', 1],
          ['/repo/s/c', 0],
        ]);
      });
    });
  });

  describe('Given two entries differing only by case', () => {
    const arrange = (ignoreCase: string): Context =>
      createMemoryContext({
        files: {
          [listFile(PRIMARY)]: encode('/repo/A/objects\n/repo/a/objects\n'),
          '/repo/A/objects/keep': new Uint8Array(),
          '/repo/a/objects/keep': new Uint8Array(),
          '/repo/.git/config': encode(`[core]\n\tignorecase = ${ignoreCase}\n`),
        },
      });

    describe('When core.ignoreCase is true', () => {
      it('Then they are one store', async () => {
        // Arrange
        const ctx = arrange('true');

        // Act
        const result = await dirsOf(ctx);

        // Assert
        expect(result).toEqual([PRIMARY, '/repo/A/objects']);
      });
    });

    describe('When core.ignoreCase is false', () => {
      it('Then they stay two stores', async () => {
        // Arrange
        const ctx = arrange('false');

        // Act
        const result = await dirsOf(ctx);

        // Assert
        expect(result).toEqual([PRIMARY, '/repo/A/objects', '/repo/a/objects']);
      });
    });
  });

  describe('Given a runtime that denies access to the home directory', () => {
    describe('When the chain is resolved', () => {
      it('Then the alternate resolves and the local core.ignoreCase still applies', async () => {
        // Arrange
        const ctx = createMemoryContext({
          files: {
            [listFile(PRIMARY)]: encode('/repo/A/objects\n/repo/a/objects\n'),
            '/repo/A/objects/keep': new Uint8Array(),
            '/repo/a/objects/keep': new Uint8Array(),
            '/repo/.git/config': encode('[core]\n\tignorecase = true\n'),
          },
        });
        const notCapable = Object.assign(new Error('Requires sys access to "homedir"'), {
          name: 'NotCapable',
        });
        vi.spyOn(ctx.fs, 'homedir').mockImplementation(() => {
          throw notCapable;
        });
        vi.spyOn(ctx.fs, 'xdgConfigHome').mockImplementation(() => {
          throw notCapable;
        });

        // Act
        const result = await dirsOf(ctx);

        // Assert
        expect(result).toEqual([PRIMARY, '/repo/A/objects']);
      });
    });
  });

  describe('Given an entry whose parent directory does not exist', () => {
    describe('When the chain is resolved', () => {
      it('Then it is unresolvable, warned once, and the other entries still resolve', async () => {
        // Arrange
        const warn = vi.fn();
        const ctx = {
          ...contextWith({ [PRIMARY]: '/repo/absent/x\n/repo/s/a\n', '/repo/s/a': '' }),
          logger: { warn },
        };

        // Act
        const result = await resolveObjectSources(ctx, ioOf(ctx));

        // Assert
        expect(result.diagnostics).toEqual([
          { reason: 'unresolvable', path: '/repo/absent/x', listedIn: PRIMARY },
        ]);
        expect(result.sources.map((s) => s.objectsDir)).toEqual([PRIMARY, '/repo/s/a']);
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith('objectStore: unusable alternate', {
          reason: 'unresolvable',
          path: '/repo/absent/x',
          listedIn: PRIMARY,
        });
      });
    });
  });

  describe('Given a quoted entry whose path carries a newline', () => {
    describe('When the chain is resolved', () => {
      it('Then the warning text stays constant and the path travels only in the context', async () => {
        // Arrange
        const warn = vi.fn();
        const ctx = {
          ...contextWith({ [PRIMARY]: '"/repo/absent/x\\nforged: line"\n' }),
          logger: { warn },
        };

        // Act
        await resolveObjectSources(ctx, ioOf(ctx));

        // Assert
        expect(warn).toHaveBeenCalledWith('objectStore: unusable alternate', {
          reason: 'unresolvable',
          path: '/repo/absent/x\nforged: line',
          listedIn: PRIMARY,
        });
      });
    });
  });

  describe('Given an entry that is a regular file', () => {
    describe('When the chain is resolved', () => {
      it('Then it is not-a-directory and warned', async () => {
        // Arrange
        const warn = vi.fn();
        const ctx = {
          ...contextWith({ [PRIMARY]: '/repo/file\n' }),
          logger: { warn },
        };
        await ctx.fs.write('/repo/file', encode('x'));

        // Act
        const result = await resolveObjectSources(ctx, ioOf(ctx));

        // Assert
        expect(result.diagnostics).toEqual([
          { reason: 'not-a-directory', path: '/repo/file', listedIn: PRIMARY },
        ]);
        expect(warn).toHaveBeenCalledOnce();
      });
    });
  });

  describe.each(['/', '//', '/.'])('Given the filesystem root listed as %j', (entry) => {
    describe('When the chain is resolved', () => {
      it('Then its trailing slash is trimmed to an empty path that is not a directory', async () => {
        // Arrange
        const ctx = contextWith({ [PRIMARY]: `${entry}\n` });

        // Act
        const result = await resolveObjectSources(ctx, ioOf(ctx));

        // Assert
        expect(result.sources.map((s) => s.objectsDir)).toEqual([PRIMARY]);
        expect(result.diagnostics).toEqual([
          { reason: 'not-a-directory', path: '', listedIn: PRIMARY },
        ]);
      });
    });
  });

  describe('Given a regular file listed twice', () => {
    describe('When the chain is resolved', () => {
      it('Then each listing reports not-a-directory because the directory check precedes the duplicate check', async () => {
        // Arrange
        const ctx = contextWith({ [PRIMARY]: '/repo/file\n/repo/file\n' });
        await ctx.fs.write('/repo/file', encode('x'));

        // Act
        const result = await resolveObjectSources(ctx, ioOf(ctx));

        // Assert
        expect(result.diagnostics.map((d) => d.reason)).toEqual([
          'not-a-directory',
          'not-a-directory',
        ]);
      });
    });
  });

  describe('Given a missing directory entry whose parent exists', () => {
    describe('When the chain is resolved', () => {
      it('Then it is not-a-directory', async () => {
        // Arrange
        const ctx = contextWith({ [PRIMARY]: '/repo/missing\n' });

        // Act
        const result = await resolveObjectSources(ctx, ioOf(ctx));

        // Assert
        expect(result.diagnostics).toEqual([
          { reason: 'not-a-directory', path: '/repo/missing', listedIn: PRIMARY },
        ]);
      });
    });
  });

  describe('Given an alternates list that cannot be read', () => {
    describe('When the chain is resolved', () => {
      it('Then it is unreadable-list with the adapter code and warned', async () => {
        // Arrange
        const warn = vi.fn();
        const base = contextWith({});
        const denied = permissionDenied(listFile(PRIMARY));
        const reader = { ...base.fs, read: async () => Promise.reject(denied) };
        const ctx = { ...base, logger: { warn } };

        // Act
        const result = await resolveObjectSources(ctx, {
          probe: () => base.fs,
          reader: () => reader,
          pathSyntax: posixGitPathSyntax,
        });

        // Assert
        expect(result.diagnostics).toEqual([
          {
            reason: 'unreadable-list',
            path: listFile(PRIMARY),
            listedIn: PRIMARY,
            code: 'PERMISSION_DENIED',
          },
        ]);
        expect(warn).toHaveBeenCalledOnce();
      });
    });
  });

  describe('Given an entry outside the adapter root', () => {
    describe('When the chain is resolved', () => {
      it('Then it is unreachable with the adapter code', async () => {
        // Arrange
        const ctx = contextWith({ [PRIMARY]: '/elsewhere/objects\n' });

        // Act
        const result = await resolveObjectSources(ctx, ioOf(ctx));

        // Assert
        expect(result.diagnostics).toEqual([
          {
            reason: 'unreachable',
            path: '/elsewhere/objects',
            listedIn: PRIMARY,
            code: 'PERMISSION_DENIED',
          },
        ]);
      });
    });
  });

  describe('Given an entry that is not valid UTF-8', () => {
    describe('When the chain is resolved', () => {
      it('Then it is unresolvable', async () => {
        // Arrange
        const ctx = createMemoryContext({
          files: { [listFile(PRIMARY)]: new Uint8Array([0x2f, 0x72, 0xff, 0x0a]) },
        });

        // Act
        const result = await resolveObjectSources(ctx, ioOf(ctx));

        // Assert
        expect(result.diagnostics.map((d) => d.reason)).toEqual(['unresolvable']);
        expect(result.sources).toHaveLength(1);
      });
    });
  });

  describe('Given a POSIX entry naming a backslash or a drive-like name', () => {
    describe('When the chain is resolved', () => {
      it('Then the backslash is part of a name and the drive-like entry is relative', async () => {
        // Arrange
        const ctx = contextWith({ [PRIMARY]: '/repo/a\\b/objects\nC:/objects\n' });
        await ctx.fs.mkdir('/repo/a\\b/objects');
        await ctx.fs.mkdir(`${PRIMARY}/C:/objects`);

        // Act
        const result = await dirsOf(ctx);

        // Assert
        expect(result).toEqual([PRIMARY, '/repo/a\\b/objects', `${PRIMARY}/C:/objects`]);
      });
    });
  });
});

const WINDOWS_GIT_DIR = 'C:\\repo\\.git';
const WINDOWS_PRIMARY = 'C:/repo/.git/objects';

interface WindowsVolume {
  readonly directories: ReadonlyArray<string>;
  readonly links?: Readonly<Record<string, string>>;
  readonly lists: Readonly<Record<string, string>>;
}

const statOf = (isSymbolicLink: boolean): FileStat => ({
  ctimeMs: 0,
  mtimeMs: 0,
  dev: 0,
  ino: 0,
  mode: 0,
  uid: 0,
  gid: 0,
  size: 0,
  isFile: false,
  isDirectory: !isSymbolicLink,
  isSymbolicLink,
});

const windowsProbe = (volume: WindowsVolume): AlternatePathProbe => {
  const links = volume.links ?? {};
  const lstat = async (path: string): Promise<FileStat> => {
    if (path in links) return statOf(true);
    if (volume.directories.includes(path)) return statOf(false);
    throw fileNotFound(path);
  };
  return { lstat, stat: lstat, readlink: async (path) => links[path] as string };
};

interface WindowsOpening {
  readonly layout?: Partial<Context['layout']>;
  readonly cwd?: string;
}

const resolveOnWindows = (volume: WindowsVolume, opening: WindowsOpening = {}) => {
  const base = createMemoryContext();
  const ctx: Context = {
    ...base,
    cwd: opening.cwd ?? base.cwd,
    layout: { bare: false, refStorage: 'files', ...opening.layout, gitDir: WINDOWS_GIT_DIR },
  };
  const reader = createMemoryContext().fs;
  vi.spyOn(reader, 'read').mockImplementation(async (path) => {
    const list = volume.lists[path];
    if (list === undefined) throw fileNotFound(path);
    return encode(list);
  });
  const probe = windowsProbe(volume);
  return resolveObjectSources(ctx, {
    probe: () => probe,
    reader: () => reader,
    pathSyntax: windowsGitPathSyntax,
  });
};

const WINDOWS_ROOTS = ['C:/repo', 'C:/repo/.git', WINDOWS_PRIMARY];

describe('resolveObjectSources on a Windows filesystem', () => {
  describe('Given entries in drive, backslash, relative and UNC forms', () => {
    describe('When the chain is resolved', () => {
      it('Then each resolves to git for Windows forward-slash form', async () => {
        // Arrange
        const volume: WindowsVolume = {
          directories: [
            ...WINDOWS_ROOTS,
            'D:/donor',
            'D:/donor/objects',
            'C:/shared',
            'C:/shared/objects',
            '//server/share/objects',
            'E:/plain',
            'E:/plain/objects',
          ],
          lists: {
            [listFile(WINDOWS_PRIMARY)]:
              'D:\\donor\\objects\n..\\..\\..\\shared\\objects\n\\\\server\\share\\objects\nE:/plain/objects\n',
          },
        };

        // Act
        const result = await resolveOnWindows(volume);

        // Assert
        expect(result.diagnostics).toEqual([]);
        expect(result.sources.map((s) => s.objectsDir)).toEqual([
          WINDOWS_PRIMARY,
          'D:/donor/objects',
          'C:/shared/objects',
          '//server/share/objects',
          'E:/plain/objects',
        ]);
      });
    });
  });

  describe('Given an entry through a link to another drive', () => {
    describe('When the chain is resolved', () => {
      it('Then the link target replaces the root', async () => {
        // Arrange
        const volume: WindowsVolume = {
          directories: [...WINDOWS_ROOTS, 'D:/real', 'D:/real/objects'],
          links: { 'C:/link': 'D:\\real' },
          lists: { [listFile(WINDOWS_PRIMARY)]: 'C:\\link\\objects\n' },
        };

        // Act
        const result = await resolveOnWindows(volume);

        // Assert
        expect(result.sources.map((s) => s.objectsDir)).toEqual([
          WINDOWS_PRIMARY,
          'D:/real/objects',
        ]);
      });
    });
  });

  describe('Given an entry through a relative backslash link', () => {
    describe('When the chain is resolved', () => {
      it('Then the link resolves beside itself', async () => {
        // Arrange
        const volume: WindowsVolume = {
          directories: [...WINDOWS_ROOTS, 'C:/real', 'C:/real/objects'],
          links: { 'C:/repo/link': '..\\real' },
          lists: { [listFile(WINDOWS_PRIMARY)]: 'C:\\repo\\link\\objects\n' },
        };

        // Act
        const result = await resolveOnWindows(volume);

        // Assert
        expect(result.sources.map((s) => s.objectsDir)).toEqual([
          WINDOWS_PRIMARY,
          'C:/real/objects',
        ]);
      });
    });
  });

  describe.each([
    {
      title: 'a work tree',
      layout: { workDir: 'C:\\repo', bare: false },
      cwd: 'C:\\repo\\sub',
      expected: 'C:/repo/server',
    },
    {
      title: 'no work tree',
      layout: { bare: true },
      cwd: 'C:\\elsewhere',
      expected: 'C:/elsewhere/server',
    },
  ])('Given a share-less UNC entry in a repository with $title', ({ layout, cwd, expected }) => {
    describe('When the chain is resolved and that directory is absent', () => {
      it("Then it resolves against git's cwd and is not a directory", async () => {
        // Arrange
        const volume: WindowsVolume = {
          directories: [...WINDOWS_ROOTS, 'C:/elsewhere'],
          lists: { [listFile(WINDOWS_PRIMARY)]: '\\\\server\n' },
        };

        // Act
        const result = await resolveOnWindows(volume, { layout, cwd });

        // Assert
        expect(result.diagnostics).toEqual([
          { reason: 'not-a-directory', path: expected, listedIn: WINDOWS_PRIMARY },
        ]);
      });
    });

    describe('When the chain is resolved and that directory exists', () => {
      it("Then the directory under git's cwd is an alternate", async () => {
        // Arrange
        const volume: WindowsVolume = {
          directories: [...WINDOWS_ROOTS, 'C:/elsewhere', expected],
          lists: { [listFile(WINDOWS_PRIMARY)]: '\\\\server\n' },
        };

        // Act
        const result = await resolveOnWindows(volume, { layout, cwd });

        // Assert
        expect(result.sources.map((s) => s.objectsDir)).toEqual([WINDOWS_PRIMARY, expected]);
      });
    });
  });

  describe('Given an entry through a link to a share-less UNC path', () => {
    describe('When the chain is resolved', () => {
      it('Then it is unresolvable', async () => {
        // Arrange
        const volume: WindowsVolume = {
          directories: WINDOWS_ROOTS,
          links: { 'C:/link': '\\\\server' },
          lists: { [listFile(WINDOWS_PRIMARY)]: 'C:/link/objects\n' },
        };

        // Act
        const result = await resolveOnWindows(volume);

        // Assert
        expect(result.diagnostics.map((d) => d.reason)).toEqual(['unresolvable']);
      });
    });
  });
});
