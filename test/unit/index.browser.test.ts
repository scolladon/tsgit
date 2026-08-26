import { describe, expect, it } from 'vitest';
import { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.browser.js';
import type { FileSystem } from '../../src/ports/file-system.js';
import { resolveFixedEntryLayout } from '../../src/repository/fixed-entry-layout.js';

// The stub handle makes every OPFS call reject; `fileSystemLayoutProbe`
// maps those rejections to "absent", so `openRepository`'s fixed-entry
// probe falls through to the literal layout. These tests therefore ALSO
// pin the absent-`/.git` (pre-`init`) branch of `resolveFixedEntryLayout`
// — including the `entry?.isFile` optional chain — not just the ctx shape.
const fakeHandle = {} as unknown as FileSystemDirectoryHandle;

describe('browser shim — openRepository', () => {
  describe('Given only a rootHandle', () => {
    describe('When openRepository runs', () => {
      it('Then the layout workDir is "/"', async () => {
        // Arrange / Act
        const sut = await openRepository({ rootHandle: fakeHandle });

        // Assert — kills ROOT_WORK_DIR `'/'` → `""`.
        expect(sut.ctx.layout.workDir).toBe('/');
      });
      it('Then ctx.cwd is "/" (forwarded as the core cwd)', async () => {
        // Arrange / Act
        const sut = await openRepository({ rootHandle: fakeHandle });

        // Assert — kills the L69 ObjectLiteral `{ cwd, ...coreOpts }` → `{}`
        // mutant: with `{}` the core would fall back to `defaultCwd()`.
        expect(sut.ctx.cwd).toBe('/');
      });
    });
  });

  describe('Given no gitDirName', () => {
    describe('When openRepository runs', () => {
      it('Then gitDir is "/.git" (default name under the root)', async () => {
        // Arrange / Act
        const sut = await openRepository({ rootHandle: fakeHandle });

        // Assert — kills DEFAULT_GIT_DIR_NAME `'.git'` → `""` AND the L50
        // template-literal `` `${ROOT_WORK_DIR}${gitDirName}` `` → `` `` ``.
        expect(sut.ctx.layout.gitDir).toBe('/.git');
      });
    });
  });

  describe('Given an explicit gitDirName', () => {
    describe('When openRepository runs', () => {
      it('Then gitDir uses that name (the `??` keeps the supplied value)', async () => {
        // Arrange / Act — kills L41 LogicalOperator `??` → `&&`: with `&&`
        // a supplied gitDirName would be discarded for DEFAULT_GIT_DIR_NAME.
        const sut = await openRepository({ rootHandle: fakeHandle, gitDirName: 'dot-git' });

        // Assert
        expect(sut.ctx.layout.gitDir).toBe('/dot-git');
      });
    });
  });

  describe('Given an explicit relative gitDir', () => {
    describe('When openRepository runs', () => {
      it('Then it resolves against the fixed root, overriding the default gitDirName entry', async () => {
        // Arrange / Act
        const sut = await openRepository({ rootHandle: fakeHandle, gitDir: 'custom.git' });

        // Assert
        expect(sut.ctx.layout.gitDir).toBe('/custom.git');
      });
    });
  });

  describe('Given an explicit absolute gitDir', () => {
    describe('When openRepository runs', () => {
      it('Then it is used verbatim, not nested under the fixed root', async () => {
        // Arrange / Act
        const sut = await openRepository({ rootHandle: fakeHandle, gitDir: '/elsewhere.git' });

        // Assert
        expect(sut.ctx.layout.gitDir).toBe('/elsewhere.git');
      });
    });
  });

  describe('Given an explicit workDir', () => {
    describe('When openRepository runs', () => {
      it('Then repo.layout.workDir reflects it, overriding the fixed-entry default', async () => {
        // Arrange / Act
        const sut = await openRepository({ rootHandle: fakeHandle, workDir: '/custom-wt' });

        // Assert
        expect(sut.layout.workDir).toBe('/custom-wt');
      });
    });
  });

  describe('Given an explicit absolute commonDir and nothing at the fixed entry (bootstrap shape)', () => {
    describe('When openRepository runs', () => {
      it('Then the option is inert — no commonDir on the layout, matching the walk shims found-nothing doctrine', async () => {
        // Arrange / Act — nothing exists under fakeHandle, so this is the
        // bootstrap shape init/clone open; the override must not survive it,
        // or init would write the split layout git itself cannot reopen.
        const sut = await openRepository({ rootHandle: fakeHandle, commonDir: '/shared' });

        // Assert
        expect('commonDir' in sut.ctx.layout).toBe(false);
      });
    });
  });

  describe('Given a rootHandle whose /.git entry RESOLVES as a directory, and an explicit commonDir', () => {
    describe('When openRepository runs', () => {
      it('Then layout.commonDir carries the override — the shim forwards the option into the fixed-entry resolution', async () => {
        // Arrange — a minimal resolving handle: only `.git` exists (any
        // other access rejects, which the adapter maps to FILE_NOT_FOUND).
        // This is the populated-entry path the bootstrap tests below cannot
        // reach, and it is what keeps index.browser.ts's conditional spread
        // of opts.commonDir observable.
        const gitDirStub = {} as unknown as FileSystemDirectoryHandle;
        const resolvingHandle = {
          getFileHandle: async () => {
            throw new Error('absent');
          },
          getDirectoryHandle: async (name: string) => {
            if (name === '.git') return gitDirStub;
            throw new Error('absent');
          },
        } as unknown as FileSystemDirectoryHandle;

        // Act
        const sut = await openRepository({ rootHandle: resolvingHandle, commonDir: '/shared' });

        // Assert
        expect(sut.ctx.layout.commonDir).toBe('/shared');
      });
    });
  });

  describe('Given a relative commonDir and nothing at the fixed entry (bootstrap shape)', () => {
    describe('When openRepository runs', () => {
      it('Then the option is inert for a relative spelling too — resolution happens before the bootstrap check, dropping both alike', async () => {
        // Arrange / Act — forwarding and relative-vs-root resolution on a
        // POPULATED entry are pinned by the resolveFixedEntryLayout unit
        // rows; this pins only the bootstrap-inert half at the openRepository
        // surface.
        const sut = await openRepository({ rootHandle: fakeHandle, commonDir: 'shared' });

        // Assert
        expect('commonDir' in sut.ctx.layout).toBe(false);
      });
    });
  });

  describe('Given gitDir: "" (empty string)', () => {
    describe('When openRepository runs', () => {
      it('Then it throws INVALID_OPTION{option: "gitDir"} rather than resolving a layout', async () => {
        // Arrange / Act
        let caught: unknown;
        try {
          await openRepository({ rootHandle: fakeHandle, gitDir: '' });
        } catch (err) {
          caught = err;
        }

        // Assert — validateOptions runs BEFORE resolveFixedEntryLayout in
        // this shim.
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('INVALID_OPTION');
        if (data.code === 'INVALID_OPTION') {
          expect(data.option).toBe('gitDir');
        }
      });
    });
  });

  describe('Given no bare flag', () => {
    describe('When openRepository runs', () => {
      it('Then layout.bare defaults to false', async () => {
        // Arrange / Act
        const sut = await openRepository({ rootHandle: fakeHandle });

        // Assert — kills L51 BooleanLiteral `false` → `true`.
        expect(sut.ctx.layout.bare).toBe(false);
      });
    });
  });

  describe('Given bare:true', () => {
    describe('When openRepository runs', () => {
      it('Then layout.bare is true', async () => {
        // Arrange / Act
        const sut = await openRepository({ rootHandle: fakeHandle, bare: true });

        // Assert
        expect(sut.ctx.layout.bare).toBe(true);
      });
    });
  });

  describe('Given no deltaCacheMaxBytes', () => {
    describe('When openRepository runs', () => {
      it('Then the delta cache maxSize is 16 MiB', async () => {
        // Arrange / Act
        const sut = await openRepository({ rootHandle: fakeHandle });

        // Assert — kills the two L20 ArithmeticOperator mutants on
        // `16 * 1024 * 1024` (any `*` → `/` yields a tiny non-16 MiB value).
        expect(sut.ctx.deltaCache.maxSize).toBe(16 * 1024 * 1024);
      });
    });
  });

  describe('Given an explicit deltaCacheMaxEntries', () => {
    describe('When the cache exceeds it', () => {
      it('Then it evicts down to that cap (the `??` keeps the supplied value)', async () => {
        // Arrange — kills L56 LogicalOperator `??` → `&&`: with `&&` a
        // supplied entry cap would be discarded for DEFAULT_DELTA_CACHE_ENTRIES
        // (65 536), so a 4th tiny entry would NOT evict.
        const sut = await openRepository({ rootHandle: fakeHandle, deltaCacheMaxEntries: 3 });
        const one = new Uint8Array([1]);

        // Act — insert four single-byte entries (each well under maxSize).
        sut.ctx.deltaCache.set('a', one, 1);
        sut.ctx.deltaCache.set('b', one, 1);
        sut.ctx.deltaCache.set('c', one, 1);
        sut.ctx.deltaCache.set('d', one, 1);

        // Assert — the cap of 3 evicted the least-recently-used entry.
        expect(sut.ctx.deltaCache.entryCount).toBe(3);
      });
    });
  });

  describe('Given the browser runtime', () => {
    describe('When openRepository runs', () => {
      it('Then ctx.ssh and ctx.env stay undefined and ctx.runtime is browser', async () => {
        // Arrange / Act — the browser shim cannot spawn a process or read
        // real environment variables, so it wires neither `ssh` nor `env`.
        const sut = await openRepository({ rootHandle: fakeHandle });

        // Assert
        expect(sut.ctx.ssh).toBeUndefined();
        expect(sut.ctx.env).toBeUndefined();
        expect(sut.ctx.runtime).toBe('browser');
      });
    });
  });

  describe('Given the browser runtime (concurrency)', () => {
    describe('When openRepository runs', () => {
      it('Then ctx.concurrency carries a derived cpuBound and ioBound', async () => {
        // Arrange / Act
        const sut = await openRepository({ rootHandle: fakeHandle });

        // Assert — a real hardwareConcurrency reading populates the policy,
        // not left for every consumer to fall back to the floor.
        expect(sut.ctx.concurrency).toBeDefined();
        expect(sut.ctx.concurrency?.cpuBound).toBeGreaterThanOrEqual(1);
        expect(sut.ctx.concurrency?.ioBound).toBeGreaterThanOrEqual(1);
      });
    });
  });
});

type StubEntry = { readonly kind: 'file'; readonly content: string } | { readonly kind: 'dir' };

/** Minimal FS façade over a path map — only the probe surface is real. */
const stubFsOver = (entries: Readonly<Record<string, StubEntry>>): FileSystem =>
  ({
    stat: async (path: string) => {
      const entry = entries[path];
      if (entry === undefined) throw new Error(`absent: ${path}`);
      return {
        isFile: entry.kind === 'file',
        isDirectory: entry.kind === 'dir',
        size: entry.kind === 'file' ? entry.content.length : 0,
      };
    },
    readUtf8: async (path: string) => {
      const entry = entries[path];
      if (entry === undefined || entry.kind !== 'file') throw new Error(`absent: ${path}`);
      return entry.content;
    },
  }) as unknown as FileSystem;

describe('fixed-entry layout resolution (the browser shim path)', () => {
  describe('Given a /.git entry that is a gitfile pointing at an admin dir without commondir', () => {
    describe('When resolveFixedEntryLayout runs', () => {
      it('Then the layout resolves to the admin dir with no commonDir key', async () => {
        // Arrange
        const fs = stubFsOver({
          '/.git': { kind: 'file', content: 'gitdir: /admin\n' },
          '/admin/HEAD': { kind: 'file', content: 'ref: refs/heads/main\n' },
          '/admin/objects': { kind: 'dir' },
          '/admin/refs': { kind: 'dir' },
        });
        const sut = resolveFixedEntryLayout;

        // Act
        const result = await sut(fs, '/', '/.git', { bare: false });

        // Assert
        expect(result).toEqual({
          workDir: '/',
          gitDir: '/admin',
          bare: false,
          objectFormat: 'sha1',
          refStorage: 'files',
        });
      });
    });
  });

  describe('Given a /.git gitfile whose admin dir carries an absolute commondir', () => {
    describe('When resolveFixedEntryLayout runs', () => {
      it('Then the layout splits gitDir from commonDir', async () => {
        // Arrange
        const fs = stubFsOver({
          '/.git': { kind: 'file', content: 'gitdir: /admin\n' },
          '/admin/HEAD': { kind: 'file', content: 'ref: refs/heads/main\n' },
          '/admin/commondir': { kind: 'file', content: '/common\n' },
          '/common/objects': { kind: 'dir' },
          '/common/refs': { kind: 'dir' },
        });
        const sut = resolveFixedEntryLayout;

        // Act
        const result = await sut(fs, '/', '/.git', { bare: false });

        // Assert
        expect(result).toEqual({
          workDir: '/',
          gitDir: '/admin',
          commonDir: '/common',
          bare: false,
          objectFormat: 'sha1',
          refStorage: 'files',
        });
      });
    });
  });

  describe('Given a /.git gitfile whose admin dir carries a commondir, AND an override commonDir', () => {
    describe('When resolveFixedEntryLayout runs', () => {
      it('Then the override wins — the layout commonDir is the override, never the file-derived decoy', async () => {
        // Arrange
        const fs = stubFsOver({
          '/.git': { kind: 'file', content: 'gitdir: /admin\n' },
          '/admin/HEAD': { kind: 'file', content: 'ref: refs/heads/main\n' },
          '/admin/commondir': { kind: 'file', content: '/decoy\n' },
          '/shared/objects': { kind: 'dir' },
          '/shared/refs': { kind: 'dir' },
        });
        const sut = resolveFixedEntryLayout;

        // Act
        const result = await sut(fs, '/', '/.git', { commonDir: '/shared' });

        // Assert
        expect(result.commonDir).toBe('/shared');
      });
    });
  });

  describe('Given a plain /.git directory entry with a commondir DECOY file, AND an override commonDir', () => {
    describe('When resolveFixedEntryLayout runs', () => {
      it('Then the decoy commondir file is never read and the layout commonDir is the override', async () => {
        // Arrange — a decoy `/.git/commondir` naming another directory: if
        // the directory branch read it, the layout would carry the decoy.
        // Deliberately NO objects/refs entries under /shared: the directory
        // branch performs no structural validation (see the sibling below),
        // so seeding them would imply a check that does not happen.
        const fs = stubFsOver({
          '/.git': { kind: 'dir' },
          '/.git/commondir': { kind: 'file', content: '/decoy\n' },
        });
        const sut = resolveFixedEntryLayout;

        // Act
        const result = await sut(fs, '/', '/.git', { commonDir: '/shared' });

        // Assert
        expect(result.commonDir).toBe('/shared');
      });
    });
  });

  describe('Given a plain /.git directory entry, AND a relative override commonDir', () => {
    describe('When resolveFixedEntryLayout runs', () => {
      it('Then the override resolves against the fixed root work dir', async () => {
        // Arrange
        const fs = stubFsOver({ '/.git': { kind: 'dir' } });
        const sut = resolveFixedEntryLayout;

        // Act
        const result = await sut(fs, '/', '/.git', { commonDir: 'shared' });

        // Assert
        expect(result.commonDir).toBe('/shared');
      });
    });
  });

  describe('Given a non-root work dir, AND a relative override commonDir', () => {
    describe('When resolveFixedEntryLayout runs', () => {
      it('Then the override resolves against THAT work dir — the base is the parameter, not a hard-wired root', async () => {
        // Arrange
        const fs = stubFsOver({ '/w/.git': { kind: 'dir' } });
        const sut = resolveFixedEntryLayout;

        // Act
        const result = await sut(fs, '/w', '/w/.git', { commonDir: 'shared' });

        // Assert
        expect(result.commonDir).toBe('/w/shared');
      });
    });
  });

  describe('Given a plain /.git directory entry, AND an override naming a nonexistent directory', () => {
    describe('When resolveFixedEntryLayout runs', () => {
      it('Then the override still lands — the directory branch is deliberately unvalidated, refusals surface at first command', async () => {
        // Arrange — this shim mirrors the explicit-gitDir route's leniency:
        // no sharedDirsValid check on the directory branch.
        const fs = stubFsOver({ '/.git': { kind: 'dir' } });
        const sut = resolveFixedEntryLayout;

        // Act
        const result = await sut(fs, '/', '/.git', { commonDir: '/nowhere' });

        // Assert
        expect(result.commonDir).toBe('/nowhere');
      });
    });
  });

  describe('Given a plain /.git directory entry, AND an override commonDir equal to gitDir (degenerate)', () => {
    describe('When resolveFixedEntryLayout runs', () => {
      it('Then the layout carries no commonDir key', async () => {
        // Arrange
        const fs = stubFsOver({ '/.git': { kind: 'dir' } });
        const sut = resolveFixedEntryLayout;

        // Act
        const result = await sut(fs, '/', '/.git', { commonDir: '/.git' });

        // Assert
        expect('commonDir' in result).toBe(false);
      });
    });
  });

  describe('Given a /.git directory whose config says core.bare = true, AND a degenerate override commonDir equal to gitDir', () => {
    describe('When resolveFixedEntryLayout runs', () => {
      it('Then the marker-driven bypass still keeps the work tree — the degenerate VALUE carries no signal, only the caller-supplied marker does', async () => {
        // Arrange
        const fs = stubFsOver({
          '/.git': { kind: 'dir' },
          '/.git/config': { kind: 'file', content: '[core]\n\tbare = true\n' },
        });
        const sut = resolveFixedEntryLayout;

        // Act
        const result = await sut(fs, '/', '/.git', { commonDir: '/.git' });

        // Assert
        expect(result.bare).toBe(false);
        expect(result.workDir).toBe('/');
      });
    });
  });

  describe('Given a /.git gitfile and a bare:true option', () => {
    describe('When resolveFixedEntryLayout runs', () => {
      it('Then the caller-supplied bare overrides the resolver default', async () => {
        // Arrange — layoutFromGitfile always reports bare:false; the shim
        // must apply the caller flag on top of the resolved layout.
        const fs = stubFsOver({
          '/.git': { kind: 'file', content: 'gitdir: /admin\n' },
          '/admin/HEAD': { kind: 'file', content: 'ref: refs/heads/main\n' },
          '/admin/objects': { kind: 'dir' },
          '/admin/refs': { kind: 'dir' },
        });
        const sut = resolveFixedEntryLayout;

        // Act
        const result = await sut(fs, '/', '/.git', { bare: true });

        // Assert
        expect(result.bare).toBe(true);
        expect(result.gitDir).toBe('/admin');
      });
    });
  });

  describe('Given a /.git directory whose config says core.bare = true, AND an explicit workDir', () => {
    describe('When resolveFixedEntryLayout runs', () => {
      it('Then the explicit workDir wins outright over core.bare', async () => {
        // Arrange
        const fs = stubFsOver({
          '/.git': { kind: 'dir' },
          '/.git/config': { kind: 'file', content: '[core]\n\tbare = true\n' },
        });
        const sut = resolveFixedEntryLayout;

        // Act
        const result = await sut(fs, '/', '/.git', { workDir: '/custom-wt' });

        // Assert
        expect(result).toStrictEqual({
          gitDir: '/.git',
          workDir: '/custom-wt',
          bare: false,
          objectFormat: 'sha1',
          refStorage: 'files',
        });
      });
    });
  });

  describe('Given a /.git entry that is a directory', () => {
    describe('When resolveFixedEntryLayout runs', () => {
      it('Then the literal fixed layout is kept', async () => {
        // Arrange
        const fs = stubFsOver({ '/.git': { kind: 'dir' } });
        const sut = resolveFixedEntryLayout;

        // Act
        const result = await sut(fs, '/', '/.git', { bare: false });

        // Assert
        expect(result).toEqual({
          workDir: '/',
          gitDir: '/.git',
          bare: false,
          objectFormat: 'sha1',
          refStorage: 'files',
        });
      });
    });
  });

  describe('Given a /.git directory whose config says core.bare = true', () => {
    describe('When resolveFixedEntryLayout runs with no bare override', () => {
      it('Then the layout has no workDir key and bare is true', async () => {
        // Arrange — the memory/node-equivalent Stage 2/3 wiring now runs for
        // the browser shim too: config alone decides bareness.
        const fs = stubFsOver({
          '/.git': { kind: 'dir' },
          '/.git/config': { kind: 'file', content: '[core]\n\tbare = true\n' },
        });
        const sut = resolveFixedEntryLayout;

        // Act
        const result = await sut(fs, '/', '/.git', {});

        // Assert
        expect(result).toStrictEqual({
          gitDir: '/.git',
          bare: true,
          objectFormat: 'sha1',
          refStorage: 'files',
        });
      });
    });
  });

  describe('Given a /.git directory whose config sets an absolute core.worktree', () => {
    describe('When resolveFixedEntryLayout runs', () => {
      it('Then the resolved workDir is the configured value, not the fixed root', async () => {
        // Arrange
        const fs = stubFsOver({
          '/.git': { kind: 'dir' },
          '/.git/config': { kind: 'file', content: '[core]\n\tworktree = /custom-wt\n' },
        });
        const sut = resolveFixedEntryLayout;

        // Act
        const result = await sut(fs, '/', '/.git', {});

        // Assert
        expect(result).toStrictEqual({
          gitDir: '/.git',
          workDir: '/custom-wt',
          bare: false,
          objectFormat: 'sha1',
          refStorage: 'files',
        });
      });
    });
  });
});

describe('browser shim — object format before a repository exists', () => {
  describe('Given a root whose gitDir does not exist yet', () => {
    describe('When openRepository runs', () => {
      it('Then the layout declares no objectFormat', async () => {
        // Arrange / Act
        const sut = await openRepository({ rootHandle: fakeHandle });

        // Assert — a format nobody has written yet is UNKNOWN, not sha1.
        // Reporting sha1 here would make a defaulted value read as a
        // declaration; `resolveAlgorithm` would then treat an explicit
        // `algorithm` option as a contradiction.
        expect(sut.ctx.layout.objectFormat).toBeUndefined();
      });

      it('Then an explicit sha256 algorithm is accepted rather than refused as a conflict', async () => {
        // Arrange / Act — the walk-based shims accept this on an empty
        // directory (a found-nothing walk declares nothing); the fixed-entry
        // shim must not diverge just because it has no walk.
        const sut = await openRepository({ rootHandle: fakeHandle, algorithm: 'sha256' });

        // Assert
        expect(sut.ctx.hashConfig.algorithm).toBe('sha256');
        expect(sut.ctx.hashConfig.hexLength).toBe(64);
      });
    });
  });
});
