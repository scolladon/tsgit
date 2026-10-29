import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  gitlinkHeadOf,
  probeGitlinkCheckout,
} from '../../../../../src/application/primitives/internal/gitlink-head.js';
import { permissionDenied, TsgitError } from '../../../../../src/domain/error.js';
import type { FilePath } from '../../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../../src/ports/context.js';
import type { FileStat, FileSystem } from '../../../../../src/ports/file-system.js';

const HEAD_COMMIT = 'c'.repeat(40);
const ADMIN_COMMIT = 'd'.repeat(40);
const SUB = 'sub' as FilePath;

const guarded = (fs: FileSystem, allows: (path: string) => boolean): FileSystem =>
  new Proxy(fs, {
    get(target, property) {
      const member = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        const [first] = args;
        if (typeof first === 'string' && !allows(first)) {
          return Promise.reject(permissionDenied(first));
        }
        return member.apply(target, args);
      };
    },
  });

/** As a confining adapter: the parent's filesystem cannot reach `outside`, only a worktree filesystem granted its roots can. */
const confiningOutside = (ctx: Context, outside: string): Context => {
  const rootsOf = (granted: string | ReadonlyArray<string>) => [granted].flat();
  return {
    ...ctx,
    fs: guarded(ctx.fs, (path) => !path.startsWith(outside)),
    worktreeFs: (granted) =>
      guarded(
        ctx.fs,
        (path) =>
          !path.startsWith(outside) || rootsOf(granted).some((root) => path.startsWith(root)),
      ),
  };
};

const layOutRepository = async (ctx: Context, gitDir: string, head: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.mkdir(`${gitDir}/objects`);
  await ctx.fs.mkdir(`${gitDir}/refs`);
  await ctx.fs.writeUtf8(`${gitDir}/refs/heads/main`, `${head}\n`);
};

const failingLstatOf = (base: Context, leaf: string, failure: unknown): Context => {
  const lstat = async (path: string) => {
    if (path.endsWith(leaf)) throw failure;
    return base.fs.lstat(path);
  };
  return { ...base, fs: Object.assign(Object.create(base.fs), { lstat }) } as Context;
};

const failingLstatOfDotGit = (failure: unknown): Context =>
  failingLstatOf(createMemoryContext(), '/sub/.git', failure);

const MIB = 1 << 20;
const DOT_GIT_OF_SUB = '/sub/.git';

const asDotGit = (stat: FileStat, overrides: Partial<FileStat>): FileStat => ({
  ...stat,
  ...overrides,
});

/** `sub/.git` as the kernel reports it, whatever the memory filesystem holds there; the file is never read when it is not a regular one. */
const reportingDotGit = (
  ctx: Context,
  reported: {
    readonly lstat?: Partial<FileStat>;
    readonly stat?: Partial<FileStat>;
    readonly forbidRead?: boolean;
  },
): Context => {
  const reporting =
    (method: 'lstat' | 'stat', overrides: Partial<FileStat> | undefined) =>
    async (path: string) => {
      const real = await ctx.fs[method](path);
      return path.endsWith(DOT_GIT_OF_SUB) && overrides !== undefined
        ? asDotGit(real, overrides)
        : real;
    };
  const readUtf8 = async (path: string) => {
    if (
      path.endsWith(DOT_GIT_OF_SUB) &&
      (reported.forbidRead === true ||
        (reported.lstat?.isFile !== true && reported.stat?.isFile !== true))
    ) {
      throw new Error(`read ${path}`);
    }
    return ctx.fs.readUtf8(path);
  };
  const fs = Object.assign(Object.create(ctx.fs), {
    lstat: reporting('lstat', reported.lstat),
    stat: reporting('stat', reported.stat),
    readUtf8,
  });
  return { ...ctx, fs } as Context;
};

const WHOLE_READS = ['read', 'readUtf8', 'tryReadUtf8', 'openWithNoFollow'] as const;

/** Reads of `leaf` that take the whole file are refused, so only a bounded slice can answer. */
const refusingWholeReadsOf = (ctx: Context, leaf: string): Context => {
  const refusing = Object.fromEntries(
    WHOLE_READS.map((method) => [
      method,
      async (path: string, ...rest: unknown[]) => {
        if (path.endsWith(leaf)) throw new Error(`whole read of ${path}`);
        return (ctx.fs[method] as (...args: unknown[]) => Promise<unknown>).call(
          ctx.fs,
          path,
          ...rest,
        );
      },
    ]),
  );
  return { ...ctx, fs: Object.assign(Object.create(ctx.fs), refusing) } as Context;
};

// The longest HEAD line that can name a ref: PATH_MAX for the name plus `ref: `.
const HEAD_READ_BOUND = 4096 + 'ref: '.length;

const NOT_A_REGULAR_FILE = { isFile: false, isDirectory: false, isSymbolicLink: false };

describe('gitlinkHeadOf', () => {
  describe('Given a context without a work tree', () => {
    describe('When a gitlink head is asked', () => {
      it('Then the work tree is required by add', async () => {
        // Arrange
        const base = createMemoryContext();
        const ctx = {
          ...base,
          layout: { ...base.layout, workDir: undefined },
        } as unknown as Context;
        const sut = gitlinkHeadOf;

        // Act
        const outcome = sut(ctx, SUB);

        // Assert
        const err = await outcome.catch((e: unknown) => e);
        expect(err).toBeInstanceOf(TsgitError);
        expect((err as TsgitError).data).toEqual({ code: 'WORK_TREE_REQUIRED', operation: 'add' });
      });
    });
  });

  describe('Given a gitfile leading to a repository the parent filesystem cannot reach', () => {
    describe('When the gitlink head is asked', () => {
      it('Then the head is read through the filesystem granted for that repository', async () => {
        // Arrange
        const base = createMemoryContext();
        const away = `${base.layout.workDir}/away`;
        await layOutRepository(base, `${away}/module`, HEAD_COMMIT);
        await base.fs.writeUtf8(`${base.layout.workDir}/sub/.git`, `gitdir: ${away}/module\n`);
        const ctx = confiningOutside(base, away);
        const sut = gitlinkHeadOf;

        // Act
        const head = await sut(ctx, SUB);

        // Assert
        expect(head).toBe(HEAD_COMMIT);
      });
    });
  });

  describe('Given a linked worktree whose common dir the parent filesystem cannot reach', () => {
    describe('When the gitlink head is asked', () => {
      it('Then the common dir is read through the filesystem granted for it', async () => {
        // Arrange
        const base = createMemoryContext();
        const { gitDir, workDir } = base.layout;
        await base.fs.writeUtf8(`${workDir}/sub/.git`, 'gitdir: ../.git/admin\n');
        await base.fs.writeUtf8(`${gitDir}/admin/HEAD`, 'ref: refs/heads/main\n');
        await base.fs.writeUtf8(`${gitDir}/admin/commondir`, '../common\n');
        await layOutRepository(base, `${gitDir}/common`, HEAD_COMMIT);
        const ctx = confiningOutside(base, `${gitDir}/common`);
        const sut = gitlinkHeadOf;

        // Act
        const head = await sut(ctx, SUB);

        // Assert
        expect(head).toBe(HEAD_COMMIT);
      });
    });
  });

  describe('Given a .git symlink to a gitfile', () => {
    describe('When the gitlink head is asked', () => {
      it('Then the gitfile is followed to its repository', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { gitDir, workDir } = ctx.layout;
        await layOutRepository(ctx, `${gitDir}/modules/sub`, HEAD_COMMIT);
        await ctx.fs.writeUtf8(`${workDir}/sub/gitfile`, 'gitdir: ../.git/modules/sub\n');
        await ctx.fs.symlink('gitfile', `${workDir}/sub/.git`);
        const sut = gitlinkHeadOf;

        // Act
        const head = await sut(ctx, SUB);

        // Assert
        expect(head).toBe(HEAD_COMMIT);
      });
    });
  });

  describe('Given the probe of .git ending in a refusal that is not a missing file', () => {
    describe('When the gitlink head is asked', () => {
      it('Then the refusal surfaces', async () => {
        // Arrange
        const ctx = failingLstatOfDotGit(permissionDenied('sub/.git'));
        const sut = gitlinkHeadOf;

        // Act
        const err = await sut(ctx, SUB).catch((e: unknown) => e);

        // Assert
        expect(err).toBeInstanceOf(TsgitError);
        expect((err as TsgitError).data).toEqual({ code: 'PERMISSION_DENIED', path: 'sub/.git' });
      });
    });
  });

  describe('Given the probe of .git ending in a failure that is no tsgit error', () => {
    describe('When the gitlink head is asked', () => {
      it('Then the failure surfaces', async () => {
        // Arrange
        const ctx = failingLstatOfDotGit(new Error('disk on fire'));
        const sut = gitlinkHeadOf;

        // Act
        const err = await sut(ctx, SUB).catch((e: unknown) => e);

        // Assert
        expect((err as Error).message).toBe('disk on fire');
      });
    });
  });

  describe('Given a commondir the filesystem refuses to read', () => {
    describe('When the gitlink head is asked', () => {
      it('Then the refusal surfaces', async () => {
        // Arrange
        const base = createMemoryContext();
        const { gitDir, workDir } = base.layout;
        await base.fs.writeUtf8(`${workDir}/sub/.git`, 'gitdir: ../.git/admin\n');
        await base.fs.writeUtf8(`${gitDir}/admin/HEAD`, 'ref: refs/heads/main\n');
        await base.fs.writeUtf8(`${gitDir}/admin/commondir`, '../common\n');
        await layOutRepository(base, `${gitDir}/common`, HEAD_COMMIT);
        const ctx = { ...base, fs: guarded(base.fs, (path) => !path.endsWith('/admin/commondir')) };
        const sut = gitlinkHeadOf;

        // Act
        const err = await sut(ctx, SUB).catch((e: unknown) => e);

        // Assert
        expect(err).toBeInstanceOf(TsgitError);
        expect((err as TsgitError).data).toEqual({
          code: 'PERMISSION_DENIED',
          path: `${gitDir}/admin/commondir`,
        });
      });
    });
  });

  describe('Given the probe of HEAD ending in a failure that is no tsgit error', () => {
    describe('When the gitlink head is asked', () => {
      it('Then the failure surfaces', async () => {
        // Arrange
        const base = createMemoryContext();
        await layOutRepository(base, `${base.layout.workDir}/sub/.git`, HEAD_COMMIT);
        const ctx = failingLstatOf(base, '/sub/.git/HEAD', new Error('disk on fire'));
        const sut = gitlinkHeadOf;

        // Act
        const err = await sut(ctx, SUB).catch((e: unknown) => e);

        // Assert
        expect((err as Error).message).toBe('disk on fire');
      });
    });
  });
});

describe('probeGitlinkCheckout', () => {
  describe('Given no .git at the path', () => {
    describe('When the checkout is probed', () => {
      it('Then it is none', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = probeGitlinkCheckout;

        // Act
        const checkout = await sut(ctx, SUB);

        // Assert
        expect(checkout).toEqual({ kind: 'none' });
      });
    });
  });

  describe('Given a dangling .git symlink', () => {
    describe('When the checkout is probed', () => {
      it('Then it is none', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.symlink('nowhere', `${ctx.layout.workDir}/sub/.git`);
        const sut = probeGitlinkCheckout;

        // Act
        const checkout = await sut(ctx, SUB);

        // Assert
        expect(checkout).toEqual({ kind: 'none' });
      });
    });
  });

  describe('Given a repository checked out at the path', () => {
    describe('When the checkout is probed', () => {
      it('Then it is a repository whose head is the branch id', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await layOutRepository(ctx, `${ctx.layout.workDir}/sub/.git`, HEAD_COMMIT);
        const sut = probeGitlinkCheckout;

        // Act
        const checkout = await sut(ctx, SUB);

        // Assert
        expect(checkout.kind).toBe('repository');
        const head = checkout.kind === 'repository' ? await checkout.head() : undefined;
        expect(head).toBe(HEAD_COMMIT);
      });
    });
  });

  describe('Given a gitfile that does not parse', () => {
    describe('When the checkout is probed', () => {
      it('Then it is broken, shown as the .git path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/.git`, 'garbage\n');
        const sut = probeGitlinkCheckout;

        // Act
        const checkout = await sut(ctx, SUB);

        // Assert
        expect(checkout).toEqual({ kind: 'broken', via: 'unparsed-gitfile', shown: 'sub/.git' });
      });
    });
  });

  describe('Given a .git directory whose HEAD is garbage', () => {
    describe('When the checkout is probed', () => {
      it('Then it is broken, shown as the .git path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const dotGit = `${ctx.layout.workDir}/sub/.git`;
        await layOutRepository(ctx, dotGit, HEAD_COMMIT);
        await ctx.fs.writeUtf8(`${dotGit}/HEAD`, 'garbage\n');
        const sut = probeGitlinkCheckout;

        // Act
        const checkout = await sut(ctx, SUB);

        // Assert
        expect(checkout).toEqual({ kind: 'broken', via: 'directory', shown: 'sub/.git' });
      });
    });
  });

  describe('Given a gitfile to an admin dir whose commondir holds zero bytes', () => {
    describe('When the checkout is probed', () => {
      it('Then it is broken, shown as the gitfile path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { gitDir, workDir } = ctx.layout;
        await layOutRepository(ctx, `${gitDir}/modules/sub`, HEAD_COMMIT);
        await ctx.fs.writeUtf8(`${gitDir}/modules/sub/commondir`, '');
        await ctx.fs.writeUtf8(`${workDir}/sub/.git`, 'gitdir: ../.git/modules/sub\n');
        const sut = probeGitlinkCheckout;

        // Act
        const checkout = await sut(ctx, SUB);

        // Assert
        expect(checkout).toEqual({ kind: 'broken', via: 'gitfile', shown: 'sub/.git' });
      });
    });
  });

  describe('Given a .git directory without objects', () => {
    describe('When the checkout is probed', () => {
      it('Then it is broken, shown as the .git path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const dotGit = `${ctx.layout.workDir}/sub/.git`;
        await ctx.fs.writeUtf8(`${dotGit}/HEAD`, 'ref: refs/heads/main\n');
        await ctx.fs.mkdir(`${dotGit}/refs`);
        const sut = probeGitlinkCheckout;

        // Act
        const checkout = await sut(ctx, SUB);

        // Assert
        expect(checkout).toEqual({ kind: 'broken', via: 'directory', shown: 'sub/.git' });
      });
    });
  });
});

describe('a .git that is neither a directory nor a regular file', () => {
  describe('Given a .git that is a FIFO', () => {
    describe('When the checkout is probed', () => {
      it('Then it is none and the file is never read', async () => {
        // Arrange
        const memory = createMemoryContext();
        await memory.fs.writeUtf8(`${memory.layout.workDir}/sub/.git`, 'gitdir: ../elsewhere\n');
        const ctx = reportingDotGit(memory, { lstat: NOT_A_REGULAR_FILE });
        const sut = probeGitlinkCheckout;

        // Act
        const checkout = await sut(ctx, SUB);

        // Assert
        expect(checkout).toEqual({ kind: 'none' });
      });
    });
  });

  describe('Given a .git symlink to a FIFO or a device', () => {
    describe('When the checkout is probed', () => {
      it('Then it is none and the target is never read', async () => {
        // Arrange
        const memory = createMemoryContext();
        await memory.fs.writeUtf8(`${memory.layout.workDir}/sub/target`, 'x\n');
        await memory.fs.symlink('target', `${memory.layout.workDir}/sub/.git`);
        const ctx = reportingDotGit(memory, { stat: NOT_A_REGULAR_FILE });
        const sut = probeGitlinkCheckout;

        // Act
        const checkout = await sut(ctx, SUB);

        // Assert
        expect(checkout).toEqual({ kind: 'none' });
      });
    });
  });

  describe('Given a tracked gitlink whose .git is a FIFO', () => {
    describe('When the gitlink head is asked', () => {
      it('Then nothing is checked out', async () => {
        // Arrange
        const memory = createMemoryContext();
        await memory.fs.writeUtf8(`${memory.layout.workDir}/sub/.git`, 'x\n');
        const ctx = reportingDotGit(memory, { lstat: NOT_A_REGULAR_FILE });
        const sut = gitlinkHeadOf;

        // Act
        const head = await sut(ctx, SUB);

        // Assert
        expect(head).toBeUndefined();
      });
    });
  });
});

describe('a .git file past the size git reads', () => {
  const layOutPointer = async (memory: Context): Promise<void> => {
    await layOutRepository(memory, `${memory.layout.gitDir}/modules/sub`, HEAD_COMMIT);
    await memory.fs.writeUtf8(`${memory.layout.workDir}/sub/.git`, 'gitdir: ../.git/modules/sub\n');
  };

  describe('Given a gitfile of exactly 1 MiB', () => {
    describe('When the checkout is probed', () => {
      it('Then it is still read as a gitfile', async () => {
        // Arrange
        const memory = createMemoryContext();
        await layOutPointer(memory);
        const ctx = reportingDotGit(memory, { lstat: { isFile: true, size: MIB } });
        const sut = probeGitlinkCheckout;

        // Act
        const checkout = await sut(ctx, SUB);

        // Assert
        expect(checkout.kind).toBe('repository');
      });
    });
  });

  describe('Given a gitfile of 1 MiB and a byte', () => {
    describe('When the checkout is probed', () => {
      it('Then it is oversized, shown as the .git path, and never read', async () => {
        // Arrange
        const memory = createMemoryContext();
        await layOutPointer(memory);
        const ctx = reportingDotGit(memory, {
          lstat: { isFile: true, size: MIB + 1 },
          forbidRead: true,
        });
        const sut = probeGitlinkCheckout;

        // Act
        const checkout = await sut(ctx, SUB);

        // Assert
        expect(checkout).toEqual({ kind: 'oversized', shown: 'sub/.git' });
      });
    });
  });

  describe('Given a .git symlink to a file of 1 MiB and a byte', () => {
    describe('When the checkout is probed', () => {
      it('Then it is oversized, shown as the .git path', async () => {
        // Arrange
        const memory = createMemoryContext();
        await memory.fs.writeUtf8(`${memory.layout.workDir}/sub/target`, 'x\n');
        await memory.fs.symlink('target', `${memory.layout.workDir}/sub/.git`);
        const ctx = reportingDotGit(memory, {
          stat: { isFile: true, size: MIB + 1 },
          forbidRead: true,
        });
        const sut = probeGitlinkCheckout;

        // Act
        const checkout = await sut(ctx, SUB);

        // Assert
        expect(checkout).toEqual({ kind: 'oversized', shown: 'sub/.git' });
      });
    });
  });

  describe('Given a tracked gitlink whose .git is 1 MiB and a byte', () => {
    describe('When the gitlink head is asked', () => {
      it('Then it refuses with GITFILE_TOO_LARGE at the .git path', async () => {
        // Arrange
        const memory = createMemoryContext();
        await layOutPointer(memory);
        const ctx = reportingDotGit(memory, {
          lstat: { isFile: true, size: MIB + 1 },
          forbidRead: true,
        });
        const sut = gitlinkHeadOf;

        // Act
        const err = await sut(ctx, SUB).catch((e: unknown) => e);

        // Assert
        expect((err as TsgitError).data).toEqual({ code: 'GITFILE_TOO_LARGE', path: 'sub/.git' });
      });
    });
  });
});

describe('a nested repository whose commondir and HEAD git reads in bounded buffers', () => {
  const MAX_PATH_BYTES = 4096;
  const encoder = new TextEncoder();

  const layOutLinked = async (
    ctx: Context,
    commondir: string,
  ): Promise<{ readonly gitDir: string }> => {
    const { gitDir, workDir } = ctx.layout;
    await ctx.fs.writeUtf8(`${workDir}/sub/.git`, 'gitdir: ../.git/admin\n');
    await ctx.fs.writeUtf8(`${gitDir}/admin/HEAD`, 'ref: refs/heads/main\n');
    await ctx.fs.write(`${gitDir}/admin/commondir`, encoder.encode(commondir));
    await layOutRepository(ctx, `${gitDir}/common`, HEAD_COMMIT);
    return { gitDir };
  };

  describe('Given a commondir naming the common dir then padded with NULs past any path length', () => {
    describe('When the gitlink head is asked', () => {
      it('Then the name stops at the first NUL and the file is never read whole', async () => {
        // Arrange
        const memory = createMemoryContext();
        await layOutLinked(memory, `../common\0${'\0'.repeat(MAX_PATH_BYTES * 2)}`);
        const ctx = refusingWholeReadsOf(memory, '/admin/commondir');
        const sut = gitlinkHeadOf;

        // Act
        const head = await sut(ctx, SUB);

        // Assert
        expect(head).toBe(HEAD_COMMIT);
      });
    });
  });

  describe('Given a commondir that opens with a NUL', () => {
    describe('When the gitlink head is asked', () => {
      it('Then the admin dir is the common dir', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { gitDir } = await layOutLinked(ctx, '\0../common');
        await layOutRepository(ctx, `${gitDir}/admin`, ADMIN_COMMIT);
        const sut = gitlinkHeadOf;

        // Act
        const head = await sut(ctx, SUB);

        // Assert
        expect(head).toBe(ADMIN_COMMIT);
      });
    });
  });

  describe('Given a commondir whose newline precedes a NUL', () => {
    describe('When the checkout is probed', () => {
      it('Then the newline stays part of the name and no repository is found', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await layOutLinked(ctx, '../common\n\0');
        const sut = probeGitlinkCheckout;

        // Act
        const checkout = await sut(ctx, SUB);

        // Assert
        expect(checkout).toEqual({ kind: 'broken', via: 'gitfile', shown: 'sub/.git' });
      });
    });
  });

  describe('Given a NUL-free commondir of exactly the path length bound', () => {
    describe('When the checkout is probed', () => {
      it('Then it names the common dir', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const name = `../common${'/.'.repeat((MAX_PATH_BYTES - 9 - 1) / 2)}/`;
        await layOutLinked(ctx, name);
        const sut = probeGitlinkCheckout;

        // Act
        const checkout = await sut(ctx, SUB);

        // Assert
        expect(name).toHaveLength(MAX_PATH_BYTES - 0);
        expect(checkout.kind).toBe('repository');
      });
    });
  });

  describe('Given a NUL-free commondir a byte past the path length bound', () => {
    describe('When the checkout is probed', () => {
      it('Then it names the common dir as git reads the file whole', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await layOutLinked(ctx, `../common${'/.'.repeat((MAX_PATH_BYTES - 10) / 2)}//`);
        const sut = probeGitlinkCheckout;

        // Act
        const checkout = await sut(ctx, SUB);

        // Assert
        expect(checkout.kind).toBe('repository');
      });
    });
  });

  describe('Given a NUL-free commondir of exactly the gitfile size cap', () => {
    describe('When the checkout is probed', () => {
      it('Then it names the common dir', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const prefix = '../common';
        await layOutLinked(ctx, `${prefix}${'/.'.repeat((MIB - prefix.length - 1) / 2)}/`);
        const sut = probeGitlinkCheckout;

        // Act
        const checkout = await sut(ctx, SUB);

        // Assert
        expect(checkout.kind).toBe('repository');
      });
    });
  });

  describe('Given a NUL-free commondir a byte past the gitfile size cap', () => {
    describe('When the checkout is probed', () => {
      it('Then it can name no repository and is broken', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const prefix = '../common';
        await layOutLinked(ctx, `${prefix}${'/.'.repeat((MIB - prefix.length - 1) / 2)}//`);
        const sut = probeGitlinkCheckout;

        // Act
        const checkout = await sut(ctx, SUB);

        // Assert
        expect(checkout).toEqual({ kind: 'broken', via: 'gitfile', shown: 'sub/.git' });
      });
    });
  });

  describe('Given a HEAD whose first 255 bytes are valid and whose rest is enormous', () => {
    describe('When the checkout is probed and its head asked', () => {
      it('Then the repository is accepted, HEAD is never read whole, and no commit resolves as in git', async () => {
        // Arrange
        const memory = createMemoryContext();
        const dotGit = `${memory.layout.workDir}/sub/.git`;
        await layOutRepository(memory, dotGit, HEAD_COMMIT);
        await memory.fs.write(
          `${dotGit}/HEAD`,
          encoder.encode(`ref: refs/heads/main\n${'\0'.repeat(MAX_PATH_BYTES * 2)}`),
        );
        const ctx = refusingWholeReadsOf(memory, '/sub/.git/HEAD');
        const sut = probeGitlinkCheckout;

        // Act
        const checkout = await sut(ctx, SUB);

        // Assert
        expect(checkout.kind).toBe('repository');
        expect(checkout.kind === 'repository' && (await checkout.head())).toBeUndefined();
      });
    });
  });

  describe('Given a HEAD naming a branch then running past the read bound', () => {
    describe('When the checkout is probed and its head asked', () => {
      it('Then no commit resolves, the name is not cut to the judged prefix', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const dotGit = `${ctx.layout.workDir}/sub/.git`;
        const branch = `refs/heads/${'a'.repeat(239)}`;
        await layOutRepository(ctx, dotGit, HEAD_COMMIT);
        await ctx.fs.writeUtf8(`${dotGit}/${branch}`, `${HEAD_COMMIT}\n`);
        await ctx.fs.writeUtf8(`${dotGit}/HEAD`, `ref: ${branch}${'b'.repeat(5000)}`);
        const sut = probeGitlinkCheckout;

        // Act
        const checkout = await sut(ctx, SUB);

        // Assert
        expect(checkout.kind).toBe('repository');
        expect(checkout.kind === 'repository' && (await checkout.head())).toBeUndefined();
      });
    });
  });

  describe('Given a HEAD that turns valid only after its 255th byte', () => {
    describe('When the checkout is probed', () => {
      it('Then it is broken as git reads no further', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const dotGit = `${ctx.layout.workDir}/sub/.git`;
        await layOutRepository(ctx, dotGit, HEAD_COMMIT);
        await ctx.fs.writeUtf8(`${dotGit}/HEAD`, `${' '.repeat(255)}ref: refs/heads/main\n`);
        const sut = probeGitlinkCheckout;

        // Act
        const checkout = await sut(ctx, SUB);

        // Assert
        expect(checkout).toEqual({ kind: 'broken', via: 'directory', shown: 'sub/.git' });
      });
    });
  });

  describe('Given a HEAD naming a branch whose line is past 255 bytes', () => {
    describe('When the checkout is probed and its head asked', () => {
      it('Then the commit of that branch resolves', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const dotGit = `${ctx.layout.workDir}/sub/.git`;
        const branch = `refs/heads/${'b'.repeat(120)}/${'c'.repeat(150)}`;
        await layOutRepository(ctx, dotGit, HEAD_COMMIT);
        await ctx.fs.mkdir(`${dotGit}/${branch.slice(0, branch.lastIndexOf('/'))}`);
        await ctx.fs.writeUtf8(`${dotGit}/${branch}`, `${HEAD_COMMIT}\n`);
        await ctx.fs.writeUtf8(`${dotGit}/HEAD`, `ref: ${branch}\n`);
        const sut = probeGitlinkCheckout;

        // Act
        const checkout = await sut(ctx, SUB);

        // Assert
        expect(checkout.kind === 'repository' && (await checkout.head())).toBe(HEAD_COMMIT);
      });
    });
  });

  describe('Given a HEAD whose branch name fills the read bound exactly', () => {
    describe('When the checkout is probed and its head asked', () => {
      it('Then no commit resolves, the line is too long to name a ref', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const dotGit = `${ctx.layout.workDir}/sub/.git`;
        const branch = `refs/heads/${'a'.repeat(HEAD_READ_BOUND - 'ref: refs/heads/'.length)}`;
        await layOutRepository(ctx, dotGit, HEAD_COMMIT);
        await ctx.fs.writeUtf8(`${dotGit}/${branch}`, `${HEAD_COMMIT}\n`);
        await ctx.fs.writeUtf8(`${dotGit}/HEAD`, `ref: ${branch}`);
        const sut = probeGitlinkCheckout;

        // Act
        const checkout = await sut(ctx, SUB);

        // Assert
        expect(checkout.kind).toBe('repository');
        expect(checkout.kind === 'repository' && (await checkout.head())).toBeUndefined();
      });
    });
  });
});

describe('a nested repository whose HEAD is a symlink', () => {
  const layOutLinkedHead = async (ctx: Context, target: string): Promise<void> => {
    const dotGit = `${ctx.layout.workDir}/sub/.git`;
    await ctx.fs.mkdir(`${dotGit}/objects`);
    await ctx.fs.mkdir(`${dotGit}/refs/heads`);
    await ctx.fs.writeUtf8(`${dotGit}/refs/heads/main`, `${HEAD_COMMIT}\n`);
    await ctx.fs.symlink(target, `${dotGit}/HEAD`);
  };

  describe('Given a link to a branch that does not exist', () => {
    describe('When the checkout is probed and its head asked', () => {
      it('Then it is a repository without a commit', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await layOutLinkedHead(ctx, 'refs/heads/gone');
        const sut = probeGitlinkCheckout;

        // Act
        const checkout = await sut(ctx, SUB);

        // Assert
        expect(checkout.kind).toBe('repository');
        expect(checkout.kind === 'repository' && (await checkout.head())).toBeUndefined();
      });
    });
  });

  describe('Given a link to a branch', () => {
    describe('When the checkout is probed and its head asked', () => {
      it('Then the commit of that branch resolves', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await layOutLinkedHead(ctx, 'refs/heads/main');
        const sut = probeGitlinkCheckout;

        // Act
        const checkout = await sut(ctx, SUB);

        // Assert
        expect(checkout.kind === 'repository' && (await checkout.head())).toBe(HEAD_COMMIT);
      });
    });
  });
});

describe('a gitlink whose .git leads to no valid repository', () => {
  const MAX_PATH_BYTES = 4096;
  const GITFILE_REFUSAL = { code: 'GITFILE_NOT_A_REPOSITORY', path: 'sub/.git' };
  const DIRECTORY_REFUSAL = { code: 'NOT_A_REPOSITORY', path: 'sub/.git' };

  const refusalOf = async (ctx: Context): Promise<unknown> => {
    const sut = gitlinkHeadOf;
    const err = await sut(ctx, SUB).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TsgitError);
    return (err as TsgitError).data;
  };

  const pointAtModule = async (ctx: Context): Promise<string> => {
    const { gitDir, workDir } = ctx.layout;
    await ctx.fs.writeUtf8(`${workDir}/sub/.git`, 'gitdir: ../.git/modules/sub\n');
    return `${gitDir}/modules/sub`;
  };

  describe('Given a gitfile whose target is missing', () => {
    describe('When the gitlink head is asked', () => {
      it('Then it refuses naming the gitfile', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await pointAtModule(ctx);

        // Act
        const data = await refusalOf(ctx);

        // Assert
        expect(data).toEqual(GITFILE_REFUSAL);
      });
    });
  });

  describe('Given a gitfile to a module whose HEAD is garbage', () => {
    describe('When the gitlink head is asked', () => {
      it('Then it refuses naming the gitfile', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const module = await pointAtModule(ctx);
        await layOutRepository(ctx, module, HEAD_COMMIT);
        await ctx.fs.writeUtf8(`${module}/HEAD`, 'garbage\n');

        // Act
        const data = await refusalOf(ctx);

        // Assert
        expect(data).toEqual(GITFILE_REFUSAL);
      });
    });
  });

  describe('Given a gitfile to a module without an objects directory', () => {
    describe('When the gitlink head is asked', () => {
      it('Then it refuses naming the gitfile', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const module = await pointAtModule(ctx);
        await ctx.fs.writeUtf8(`${module}/HEAD`, 'ref: refs/heads/main\n');
        await ctx.fs.mkdir(`${module}/refs`);

        // Act
        const data = await refusalOf(ctx);

        // Assert
        expect(data).toEqual(GITFILE_REFUSAL);
      });
    });
  });

  describe('Given a gitfile to a module whose commondir holds zero bytes', () => {
    describe('When the gitlink head is asked', () => {
      it('Then it refuses naming the gitfile', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const module = await pointAtModule(ctx);
        await layOutRepository(ctx, module, HEAD_COMMIT);
        await ctx.fs.writeUtf8(`${module}/commondir`, '');

        // Act
        const data = await refusalOf(ctx);

        // Assert
        expect(data).toEqual(GITFILE_REFUSAL);
      });
    });
  });

  describe('Given a gitfile to a module whose commondir is too long to name a path', () => {
    describe('When the gitlink head is asked', () => {
      it('Then it refuses naming the gitfile', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const module = await pointAtModule(ctx);
        await layOutRepository(ctx, module, HEAD_COMMIT);
        await ctx.fs.writeUtf8(`${module}/commondir`, 'x'.repeat(MAX_PATH_BYTES + 1));

        // Act
        const data = await refusalOf(ctx);

        // Assert
        expect(data).toEqual(GITFILE_REFUSAL);
      });
    });
  });

  describe('Given a .git directory whose HEAD is garbage', () => {
    describe('When the gitlink head is asked', () => {
      it('Then it refuses as no repository, naming the directory', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const dotGit = `${ctx.layout.workDir}/sub/.git`;
        await layOutRepository(ctx, dotGit, HEAD_COMMIT);
        await ctx.fs.writeUtf8(`${dotGit}/HEAD`, 'garbage\n');

        // Act
        const data = await refusalOf(ctx);

        // Assert
        expect(data).toEqual(DIRECTORY_REFUSAL);
      });
    });
  });

  describe('Given a gitfile that does not parse', () => {
    describe('When the gitlink head is asked', () => {
      it('Then it refuses as no repository, naming the gitfile', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/.git`, 'garbage\n');

        // Act
        const data = await refusalOf(ctx);

        // Assert
        expect(data).toEqual(DIRECTORY_REFUSAL);
      });
    });
  });
});
