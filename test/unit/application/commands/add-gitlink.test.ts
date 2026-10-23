import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { serializeAndHash } from '../../../../src/application/primitives/internal/serialize-and-hash.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { FILE_MODE, type ObjectId } from '../../../../src/domain/objects/index.js';
import {
  buildRefBlock,
  buildReftable,
  buildReftableHeader,
} from '../../../fixtures/refs/reftable-writers.js';
import { seedIndex } from './add-index-fixtures.js';
import { seedRepo } from './fixtures.js';

type Ctx = ReturnType<typeof createMemoryContext>;

const MOVED_HEAD = 'b'.repeat(40);
const MODULE_HEAD = 'ref: refs/heads/main\n';

type Checkout =
  | 'absorbed'
  | 'embedded'
  | 'deinitialised'
  | 'file'
  | 'symlink'
  | 'linked'
  | 'pointed-away'
  | 'worktree-admin'
  | 'worktree-admin-absolute'
  | 'worktree-admin-reftable'
  | 'dangling'
  | 'self-looping';

interface Superproject {
  /** What `sub` holds in the working tree. */
  readonly checkout?: Checkout;
  /** The absorbed module's directory name under `.git/modules`. */
  readonly module?: string;
  /** The module's `HEAD` file content; `null` leaves the gitdir without one. */
  readonly head?: string | null;
  /** The body of `sub/.git` when it is a gitfile; the module is then not laid out. */
  readonly gitfile?: string;
  /** The commit `refs/heads/main` holds in the module; absent leaves the branch unborn. */
  readonly branch?: string | null;
  /** Files laid in the module's gitdir, by path under it. */
  readonly moduleFiles?: Readonly<Record<string, string>>;
  /** Files laid in a linked worktree's common dir, by path under it. */
  readonly commonFiles?: Readonly<Record<string, string>>;
  /** Where a symlink standing for `refs/heads/main` leads, instead of a commit. */
  readonly branchSymlink?: string;
  readonly skipWorktree?: boolean;
  /** Extra working-tree files laid over `k`. */
  readonly tree?: Readonly<Record<string, string>>;
}

/** What git's `is_git_directory` requires beside `HEAD`. */
const layOutRepositoryDirs = async (ctx: Ctx, gitDir: string): Promise<void> => {
  await ctx.fs.mkdir(`${gitDir}/objects`);
  await ctx.fs.mkdir(`${gitDir}/refs`);
};

const layOutModule = async (
  ctx: Ctx,
  gitDir: string,
  { head = MODULE_HEAD, branch = MOVED_HEAD, moduleFiles = {}, branchSymlink }: Superproject,
): Promise<void> => {
  if (head === null) await ctx.fs.mkdir(gitDir);
  else {
    await ctx.fs.writeUtf8(`${gitDir}/HEAD`, head);
    await layOutRepositoryDirs(ctx, gitDir);
  }
  if (branch !== null) await ctx.fs.writeUtf8(`${gitDir}/refs/heads/main`, `${branch}\n`);
  for (const [name, body] of Object.entries(moduleFiles)) {
    await ctx.fs.writeUtf8(`${gitDir}/${name}`, body);
  }
  if (branchSymlink !== undefined) {
    await ctx.fs.mkdir(`${gitDir}/refs/heads`);
    await ctx.fs.symlink(branchSymlink, `${gitDir}/refs/heads/main`);
  }
};

const REFTABLE_CONFIG =
  '[core]\n\trepositoryformatversion = 1\n[extensions]\n\trefStorage = reftable\n';
const REFTABLE_HEAD = 'ref: refs/heads/.invalid\n';
const TABLE_NAME = '0x000000000001-0x000000000001-66a63dbb.ref';

type ReftableRecord = Parameters<typeof buildRefBlock>[0]['records'][number];

const reftableHolding = (...records: ReadonlyArray<ReftableRecord>): Uint8Array => {
  const spec = { version: 1 as const, minUpdateIndex: 1n, maxUpdateIndex: 1n };
  const block = buildRefBlock({
    records,
    restartIndices: [0],
    isFirstBlock: true,
    headerLength: buildReftableHeader(spec).length,
  });
  return buildReftable({ ...spec, blocks: [block] });
};

const layOutStack = async (ctx: Ctx, dir: string, table: Uint8Array): Promise<void> => {
  await ctx.fs.writeUtf8(`${dir}/tables.list`, `${TABLE_NAME}\n`);
  await ctx.fs.write(`${dir}/${TABLE_NAME}`, table);
};

/**
 * As a real linked worktree on reftable: the admin dir holds `HEAD`, `commondir`,
 * `gitdir` and its own stack for the per-worktree `HEAD`, but no config; the
 * common dir holds the config and the stack of the shared branches.
 */
const layOutReftableWorktreeAdmin = async (ctx: Ctx): Promise<void> => {
  const admin = `${ctx.layout.gitDir}/admin`;
  const common = `${ctx.layout.gitDir}/common`;
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/.git`, 'gitdir: ../.git/admin\n');
  await ctx.fs.writeUtf8(`${admin}/HEAD`, REFTABLE_HEAD);
  await ctx.fs.writeUtf8(`${admin}/commondir`, '../common\n');
  await ctx.fs.writeUtf8(`${admin}/gitdir`, `${ctx.layout.workDir}/sub/.git\n`);
  await layOutStack(
    ctx,
    `${admin}/reftable`,
    reftableHolding({ name: 'HEAD', value: { kind: 'symbolic', target: 'refs/heads/main' } }),
  );
  await layOutRepositoryDirs(ctx, common);
  await ctx.fs.writeUtf8(`${common}/config`, REFTABLE_CONFIG);
  await layOutStack(
    ctx,
    `${common}/reftable`,
    reftableHolding({
      name: 'refs/heads/main',
      value: { kind: 'direct', id: new Uint8Array(20).fill(0xbb) },
    }),
  );
};

const layOutCheckout = async (ctx: Ctx, setup: Superproject): Promise<void> => {
  const { checkout = 'absorbed', module = 'sub' } = setup;
  const sub = `${ctx.layout.workDir}/sub`;
  if (checkout === 'absorbed') {
    await ctx.fs.writeUtf8(`${sub}/.git`, setup.gitfile ?? `gitdir: ../.git/modules/${module}\n`);
    if (setup.gitfile === undefined) {
      await layOutModule(ctx, `${ctx.layout.gitDir}/modules/${module}`, setup);
    }
  }
  if (checkout === 'embedded') await layOutModule(ctx, `${sub}/.git`, setup);
  if (checkout === 'linked') {
    await layOutModule(ctx, `${ctx.layout.gitDir}/store`, setup);
    await ctx.fs.symlink('../.git/store', `${sub}/.git`);
  }
  if (checkout === 'pointed-away') {
    const awayGitDir = `${ctx.layout.workDir}/away/module`;
    await layOutModule(ctx, awayGitDir, setup);
    await ctx.fs.writeUtf8(`${sub}/.git`, `gitdir: ${awayGitDir}\n`);
  }
  if (checkout === 'worktree-admin' || checkout === 'worktree-admin-absolute') {
    const admin = `${ctx.layout.gitDir}/admin`;
    const common = `${ctx.layout.gitDir}/common`;
    await ctx.fs.writeUtf8(`${sub}/.git`, `gitdir: ../.git/admin\n`);
    await ctx.fs.writeUtf8(`${admin}/HEAD`, MODULE_HEAD);
    await ctx.fs.writeUtf8(
      `${admin}/commondir`,
      checkout === 'worktree-admin' ? '../common\n' : `${common}\n`,
    );
    await layOutRepositoryDirs(ctx, common);
    await ctx.fs.writeUtf8(`${common}/refs/heads/main`, `${setup.branch ?? MOVED_HEAD}\n`);
    for (const [name, body] of Object.entries(setup.commonFiles ?? {})) {
      await ctx.fs.writeUtf8(`${common}/${name}`, body);
    }
  }
  if (checkout === 'worktree-admin-reftable') await layOutReftableWorktreeAdmin(ctx);
  if (checkout === 'dangling') {
    await ctx.fs.mkdir(sub);
    await ctx.fs.symlink(`${ctx.layout.workDir}/nowhere`, `${sub}/.git`);
  }
  if (checkout === 'self-looping') {
    await ctx.fs.mkdir(sub);
    await ctx.fs.symlink('.git', `${sub}/.git`);
  }
  if (checkout === 'deinitialised') await ctx.fs.mkdir(sub);
  if (checkout === 'file') await ctx.fs.writeUtf8(sub, 'plain\n');
  if (checkout === 'symlink') await ctx.fs.symlink('k', sub);
};

/** Tracked `k` and a gitlink `sub` recorded at another commit than the checkout holds. */
const superproject = async (setup: Superproject = {}): Promise<Ctx> => {
  const ctx = createMemoryContext();
  await seedRepo(ctx, { workingTree: { k: 'k\n', ...setup.tree } });
  await layOutCheckout(ctx, setup);
  await seedIndex(ctx, [
    { path: 'k', text: 'k\n' },
    {
      path: 'sub',
      text: 'recorded\n',
      mode: FILE_MODE.GITLINK,
      skipWorktree: setup.skipWorktree ?? false,
    },
  ]);
  return ctx;
};

const entryOf = async (ctx: Ctx, path: string) =>
  (await readIndex(ctx)).entries.find((entry) => entry.path === path);

describe('add over a gitlink whose submodule checkout moved', () => {
  describe('Given a gitlink recorded at one commit and a module HEAD at another', () => {
    describe('When the whole tree is added', () => {
      it('Then the gitlink is staged at the module HEAD', async () => {
        // Arrange
        const ctx = await superproject();
        const sut = add;

        // Act
        const result = await sut(ctx, ['.']);

        // Assert
        const staged = await entryOf(ctx, 'sub');
        expect(result.modified).toEqual(['sub']);
        expect(staged?.id).toBe(MOVED_HEAD);
        expect(staged?.mode).toBe(FILE_MODE.GITLINK);
      });
    });
  });
});

/** Points the module's branch at the commit the index records for `sub`. */
const checkoutAtRecordedCommit = async (ctx: Ctx): Promise<void> => {
  const recorded = (await entryOf(ctx, 'sub'))?.id;
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/modules/sub/refs/heads/main`, `${recorded}\n`);
};

describe('add over a moved gitlink, whatever the pathspec', () => {
  describe.each([
    { label: 'a directory literal', spec: ['sub'] },
    { label: 'a directory literal with a trailing slash', spec: ['sub/'] },
    { label: 'a wildcard', spec: ['s*'] },
    { label: 'the gitlink beside a file', spec: ['sub', 'k'] },
  ])('Given a moved gitlink and $label', ({ spec }) => {
    describe('When it is added', () => {
      it('Then the gitlink is staged at the module HEAD', async () => {
        // Arrange
        const ctx = await superproject();
        const sut = add;

        // Act
        const result = await sut(ctx, spec);

        // Assert
        expect(result.modified).toEqual(['sub']);
        expect((await entryOf(ctx, 'sub'))?.id).toBe(MOVED_HEAD);
      });
    });
  });

  describe('Given a moved gitlink', () => {
    describe('When everything is added', () => {
      it('Then the gitlink is staged at the module HEAD', async () => {
        // Arrange
        const ctx = await superproject();
        const sut = add;

        // Act
        const result = await sut(ctx, [], { all: true });

        // Assert
        expect(result.modified).toEqual(['sub']);
        expect((await entryOf(ctx, 'sub'))?.id).toBe(MOVED_HEAD);
      });
    });
  });

  describe('Given a moved gitlink hidden by an ignore rule', () => {
    describe('When everything is added', () => {
      it('Then the gitlink is staged', async () => {
        // Arrange
        const ctx = await superproject({ tree: { '.gitignore': 'sub\n' } });
        const sut = add;

        // Act
        const result = await sut(ctx, [], { all: true });

        // Assert
        expect(result.modified).toEqual(['sub']);
      });
    });
  });

  describe('Given a moved gitlink and a modified file', () => {
    describe('When both are added by their names', () => {
      it('Then both are staged', async () => {
        // Arrange
        const ctx = await superproject({ tree: { k: 'k2\n' } });
        const sut = add;

        // Act
        const result = await sut(ctx, ['sub', 'k']);

        // Assert
        expect(result.modified).toEqual(['k', 'sub']);
      });
    });
  });

  describe.each([
    { label: 'a directory literal', spec: ['sub'] },
    { label: 'a wildcard', spec: ['s*'] },
    { label: 'the whole tree', spec: ['.'] },
  ])('Given a moved gitlink hidden by an ignore rule and $label', ({ spec }) => {
    describe('When it is added', () => {
      it('Then the gitlink is staged and nothing is reported ignored', async () => {
        // Arrange
        const ctx = await superproject({ tree: { '.gitignore': 'sub\n' } });
        const sut = add;

        // Act
        const result = await sut(ctx, spec);

        // Assert
        expect(result.modified).toEqual(['sub']);
        expect(result.ignored).toEqual([]);
      });
    });
  });
});

describe('add over a gitlink whose checkout is elsewhere', () => {
  describe.each([
    { label: 'an embedded repository', setup: { checkout: 'embedded' as const } },
    { label: 'a module absorbed under another name', setup: { module: 'other' } },
  ])('Given $label at another commit than recorded', ({ setup }) => {
    describe('When the whole tree is added', () => {
      it('Then the gitlink is staged at that repository HEAD', async () => {
        // Arrange
        const ctx = await superproject(setup);
        const sut = add;

        // Act
        const result = await sut(ctx, ['.']);

        // Assert
        expect(result.modified).toEqual(['sub']);
        expect((await entryOf(ctx, 'sub'))?.id).toBe(MOVED_HEAD);
      });
    });
  });
});

describe('add over a gitlink whose .git leads out of the superproject or through a link', () => {
  describe.each([
    {
      label: 'a gitfile with an absolute pointer to another directory',
      checkout: 'pointed-away' as const,
    },
    { label: 'a .git that is a symlink to a repository directory', checkout: 'linked' as const },
  ])('Given $label at another commit than recorded', ({ checkout }) => {
    describe('When the whole tree is added', () => {
      it('Then the gitlink is staged at that repository HEAD', async () => {
        // Arrange
        const ctx = await superproject({ checkout });
        const sut = add;

        // Act
        const result = await sut(ctx, ['.']);

        // Assert
        expect(result.modified).toEqual(['sub']);
        expect((await entryOf(ctx, 'sub'))?.id).toBe(MOVED_HEAD);
      });
    });
  });
});

describe('add over a gitlink whose .git is a dangling symlink', () => {
  describe('Given a gitlink with nothing checked out behind a dangling .git and an edited file', () => {
    describe('When the whole tree is added', () => {
      it('Then the file is staged and the gitlink is left as recorded', async () => {
        // Arrange
        const ctx = await superproject({ checkout: 'dangling', tree: { k: 'k2\n' } });
        const recorded = (await entryOf(ctx, 'sub'))?.id;
        const sut = add;

        // Act
        const result = await sut(ctx, ['.']);

        // Assert
        expect(result.modified).toEqual(['k']);
        expect((await entryOf(ctx, 'sub'))?.id).toBe(recorded);
        expect((await entryOf(ctx, 'sub'))?.mode).toBe(FILE_MODE.GITLINK);
      });
    });
  });
});

describe('add over a gitlink whose .git is a symlink that loops', () => {
  describe('Given a gitlink with nothing checked out behind a self-looping .git and an edited file', () => {
    describe('When the whole tree is added', () => {
      it('Then the file is staged and the gitlink is left as recorded', async () => {
        // Arrange
        const ctx = await superproject({ checkout: 'self-looping', tree: { k: 'k2\n' } });
        const recorded = (await entryOf(ctx, 'sub'))?.id;
        const sut = add;

        // Act
        const result = await sut(ctx, ['.']);

        // Assert
        expect(result.modified).toEqual(['k']);
        expect((await entryOf(ctx, 'sub'))?.id).toBe(recorded);
        expect((await entryOf(ctx, 'sub'))?.mode).toBe(FILE_MODE.GITLINK);
      });
    });
  });
});

describe('add over a gitlink whose HEAD cannot be resolved', () => {
  describe.each([
    {
      label: 'a reftable stack naming a table that is missing',
      setup: {
        head: REFTABLE_HEAD,
        branch: null,
        moduleFiles: { config: REFTABLE_CONFIG, 'reftable/tables.list': `${TABLE_NAME}\n` },
      },
    },
    {
      label: 'a reftable stack list that is garbage',
      setup: {
        head: REFTABLE_HEAD,
        branch: null,
        moduleFiles: { config: REFTABLE_CONFIG, 'reftable/tables.list': 'garbage\n' },
      },
    },
    {
      label: 'a reftable table of four bytes',
      setup: {
        head: REFTABLE_HEAD,
        branch: null,
        moduleFiles: {
          config: REFTABLE_CONFIG,
          'reftable/tables.list': `${TABLE_NAME}\n`,
          [`reftable/${TABLE_NAME}`]: 'REFT',
        },
      },
    },
    {
      label: 'a loose ref that is a symlink to something that is not a ref',
      setup: {
        branch: null,
        moduleFiles: { 'not-a-ref': 'plain text\n' },
        branchSymlink: '../../not-a-ref',
      },
    },
  ])('Given $label and an edited file', ({ setup }) => {
    describe('When the whole tree is added', () => {
      it('Then the file is staged and the gitlink is left as recorded', async () => {
        // Arrange
        const ctx = await superproject({ ...setup, checkout: 'embedded', tree: { k: 'k2\n' } });
        const recorded = (await entryOf(ctx, 'sub'))?.id;
        const sut = add;

        // Act
        const result = await sut(ctx, ['.']);

        // Assert
        expect(result.modified).toEqual(['k']);
        expect((await entryOf(ctx, 'sub'))?.id).toBe(recorded);
        expect((await entryOf(ctx, 'sub'))?.mode).toBe(FILE_MODE.GITLINK);
      });
    });
  });
});

describe('add over a gitlink whose .git is a linked worktree admin directory', () => {
  describe.each([
    { label: 'a relative commondir', checkout: 'worktree-admin' as const },
    { label: 'an absolute commondir', checkout: 'worktree-admin-absolute' as const },
    {
      label: 'a reftable stack and config in the common dir alone',
      checkout: 'worktree-admin-reftable' as const,
    },
  ])('Given $label holding the branch at another commit than recorded', ({ checkout }) => {
    describe('When the whole tree is added', () => {
      it('Then the gitlink is staged at the commit the common dir holds', async () => {
        // Arrange
        const ctx = await superproject({ checkout });
        const sut = add;

        // Act
        const result = await sut(ctx, ['.']);

        // Assert
        expect(result.modified).toEqual(['sub']);
        expect((await entryOf(ctx, 'sub'))?.id).toBe(MOVED_HEAD);
      });
    });
  });
});

/** Gitlink `d/sub` recorded, `d` a symlink to `out`, and `out/sub` a repository at another commit. */
const gitlinkBehindSymlinkedParent = async (): Promise<Ctx> => {
  const ctx = createMemoryContext();
  await seedRepo(ctx, { workingTree: { k: 'k\n' } });
  const work = ctx.layout.workDir;
  await layOutModule(ctx, `${work}/out/sub/.git`, {});
  await ctx.fs.symlink('out', `${work}/d`);
  await seedIndex(ctx, [
    { path: 'd/sub', text: 'recorded\n', mode: FILE_MODE.GITLINK },
    { path: 'k', text: 'k\n' },
  ]);
  return ctx;
};

describe('add over a gitlink whose parent directory became a symlink', () => {
  describe.each([{ spec: ['*sub'] }, { spec: ['.'] }])(
    'Given the parent replaced by a symlink to a repository and $spec',
    ({ spec }) => {
      describe('When it is added', () => {
        it('Then the gitlink is staged as removed and never as modified', async () => {
          // Arrange
          const ctx = await gitlinkBehindSymlinkedParent();
          const sut = add;

          // Act
          const result = await sut(ctx, spec);

          // Assert
          expect(result.modified).not.toContain('d/sub');
          expect(result.removed.filter((path) => path === 'd/sub')).toEqual(['d/sub']);
          expect(await entryOf(ctx, 'd/sub')).toBeUndefined();
        });
      });
    },
  );
});

describe('add over a gitlink that did not move', () => {
  describe.each([
    { label: 'the whole tree', spec: ['.'], options: {} },
    { label: 'a directory literal', spec: ['sub'], options: {} },
    { label: 'a wildcard', spec: ['s*'], options: {} },
    { label: 'the whole tree under renormalize', spec: ['.'], options: { renormalize: true } },
  ])('Given a checkout at the recorded commit and $label', ({ spec, options }) => {
    describe('When it is added', () => {
      it('Then the gitlink is left as recorded', async () => {
        // Arrange
        const ctx = await superproject();
        await checkoutAtRecordedCommit(ctx);
        const sut = add;

        // Act
        const result = await sut(ctx, spec, options);

        // Assert
        expect(result.modified).toEqual([]);
        expect((await entryOf(ctx, 'sub'))?.mode).toBe(FILE_MODE.GITLINK);
      });
    });
  });

  describe.each([
    { label: 'a deinitialised submodule', setup: { checkout: 'deinitialised' as const } },
    { label: 'a repository with no commit', setup: { branch: null } },
  ])('Given $label', ({ setup }) => {
    describe('When the whole tree is added', () => {
      it('Then the gitlink is left as recorded', async () => {
        // Arrange
        const ctx = await superproject(setup);
        const recorded = (await entryOf(ctx, 'sub'))?.id;
        const sut = add;

        // Act
        const result = await sut(ctx, ['.']);

        // Assert
        expect(result.modified).toEqual([]);
        expect((await entryOf(ctx, 'sub'))?.id).toBe(recorded);
      });
    });
  });

  describe('Given a moved checkout whose gitlink is marked skip-worktree', () => {
    describe('When the whole tree is added', () => {
      it('Then the gitlink keeps its commit and its bit', async () => {
        // Arrange
        const ctx = await superproject({ skipWorktree: true });
        const recorded = (await entryOf(ctx, 'sub'))?.id;
        const sut = add;

        // Act
        const result = await sut(ctx, ['.']);

        // Assert
        const kept = await entryOf(ctx, 'sub');
        expect(result.modified).toEqual([]);
        expect(kept?.id).toBe(recorded);
        expect(kept?.flags.skipWorktree).toBe(true);
      });
    });
  });
});

describe('add over a moved gitlink that a pathspec excludes', () => {
  describe.each([
    { label: 'the whole tree minus the gitlink', spec: ['.', '!sub'] },
    { label: 'the gitlink minus itself', spec: ['sub', '!sub'] },
  ])('Given a moved gitlink and $label', ({ spec }) => {
    describe('When it is added', () => {
      it('Then the gitlink is left as recorded', async () => {
        // Arrange
        const ctx = await superproject();
        const recorded = (await entryOf(ctx, 'sub'))?.id;
        const sut = add;

        // Act
        const result = await sut(ctx, spec);

        // Assert
        expect(result.modified).toEqual([]);
        expect((await entryOf(ctx, 'sub'))?.id).toBe(recorded);
      });
    });
  });

  describe('Given a moved gitlink', () => {
    describe('When the whole tree is renormalized', () => {
      it('Then the gitlink keeps the recorded commit', async () => {
        // Arrange
        const ctx = await superproject();
        const recorded = (await entryOf(ctx, 'sub'))?.id;
        const sut = add;

        // Act
        const result = await sut(ctx, ['.'], { renormalize: true });

        // Assert
        expect(result.modified).toEqual([]);
        expect((await entryOf(ctx, 'sub'))?.id).toBe(recorded);
      });
    });
  });
});

describe('add over a gitlink replaced in the working tree', () => {
  describe.each([
    { label: 'a file', checkout: 'file' as const, mode: FILE_MODE.REGULAR },
    { label: 'a symlink', checkout: 'symlink' as const, mode: FILE_MODE.SYMLINK },
  ])('Given the submodule replaced by $label', ({ checkout, mode }) => {
    describe('When the whole tree is added', () => {
      it('Then the path is staged as that file type', async () => {
        // Arrange
        const ctx = await superproject({ checkout });
        const sut = add;

        // Act
        const result = await sut(ctx, ['.']);

        // Assert
        expect(result.modified).toEqual(['sub']);
        expect((await entryOf(ctx, 'sub'))?.mode).toBe(mode);
      });
    });
  });
});

describe('add of a path the broken gitlink is not part of', () => {
  describe.each([
    { label: 'a file literal', spec: ['k'] },
    { label: 'a file wildcard', spec: ['k*'] },
  ])('Given a gitlink whose module HEAD is garbage and $label', ({ spec }) => {
    describe('When it is added', () => {
      it('Then the file is staged', async () => {
        // Arrange
        const ctx = await superproject({ head: 'garbage\n', tree: { k: 'k2\n' } });
        const sut = add;

        // Act
        const result = await sut(ctx, spec);

        // Assert
        expect(result.modified).toEqual(['k']);
      });
    });
  });
});

const blobExists = async (ctx: Ctx, content: string) => {
  const { id } = await serializeAndHash(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: new TextEncoder().encode(content),
  });
  return ctx.fs.exists(`${ctx.layout.gitDir}/objects/${id.slice(0, 2)}/${id.slice(2)}`);
};

const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (err) {
    if (err instanceof TsgitError) return err.data;
    throw err;
  }
  return undefined;
};

describe('add over a gitlink whose checkout leads to no repository', () => {
  describe('Given a pointer to a gitdir that does not exist and an untracked file', () => {
    describe('When the whole tree is added', () => {
      it('Then it refuses with the pointer as typed and writes no blob', async () => {
        // Arrange
        const ctx = await superproject({
          gitfile: 'gitdir: ../.git/modules/nowhere\n',
          tree: { n: 'untracked\n' },
        });
        const before = (await readIndex(ctx)).entries.map(({ path, id }) => `${path}:${id}`);
        const sut = add;

        // Act
        const refusal = await refusalOf(() => sut(ctx, ['.']));

        // Assert
        expect(refusal).toEqual({
          code: 'NOT_A_REPOSITORY',
          path: 'sub/../.git/modules/nowhere',
        });
        expect((await readIndex(ctx)).entries.map(({ path, id }) => `${path}:${id}`)).toEqual(
          before,
        );
        expect(await blobExists(ctx, 'untracked\n')).toBe(false);
      });
    });
  });
});

describe('add over a gitlink whose checkout is broken', () => {
  describe.each([
    {
      label: 'a module whose HEAD is garbage',
      setup: { head: 'garbage\n' },
      path: 'sub/../.git/modules/sub',
    },
    { label: 'a gitfile that does not parse', setup: { gitfile: 'garbage\n' }, path: 'sub/.git' },
    {
      label: 'an empty .git directory',
      setup: { checkout: 'embedded' as const, head: null },
      path: 'sub/.git',
    },
    {
      label: 'a .git directory whose HEAD is garbage',
      setup: { checkout: 'embedded' as const, head: 'garbage\n' },
      path: 'sub/.git',
    },
    {
      label: 'a .git symlink to a directory holding no HEAD',
      setup: { checkout: 'linked' as const, head: null },
      path: 'sub/.git',
    },
    {
      label: 'an absolute pointer to nothing',
      setup: { gitfile: 'gitdir: /nowhere/at/all\n' },
      path: '/nowhere/at/all',
    },
  ])('Given $label and an untracked file', ({ setup, path }) => {
    describe('When the whole tree is added', () => {
      it('Then it refuses with the path git names and stages nothing', async () => {
        // Arrange
        const ctx = await superproject({ ...setup, tree: { n: 'untracked\n' } });
        const before = (await readIndex(ctx)).entries.map(({ id }) => id);
        const sut = add;

        // Act
        const refusal = await refusalOf(() => sut(ctx, ['.']));

        // Assert
        expect(refusal).toEqual({ code: 'NOT_A_REPOSITORY', path });
        expect((await readIndex(ctx)).entries.map(({ id }) => id)).toEqual(before);
        expect(await blobExists(ctx, 'untracked\n')).toBe(false);
      });
    });
  });
});

describe('add over a gitlink whose repository fails the format gate', () => {
  describe.each([
    {
      label: 'an unknown extension at format version 1',
      config: '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tbogus = x\n',
      refusal: { code: 'REPOSITORY_EXTENSIONS_UNSUPPORTED', version: 1, extensions: ['bogus'] },
    },
    {
      label: 'a format version above 1',
      config: '[core]\n\trepositoryformatversion = 2\n',
      refusal: { code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED', version: 2 },
    },
    {
      label: 'a v1-only extension at format version 0',
      config: '[core]\n\trepositoryformatversion = 0\n[extensions]\n\trefStorage = reftable\n',
      refusal: {
        code: 'REPOSITORY_EXTENSIONS_UNSUPPORTED',
        version: 0,
        extensions: ['refstorage'],
      },
    },
  ])('Given $label', ({ config, refusal }) => {
    describe.each([
      {
        layout: 'an embedded repository',
        setup: { checkout: 'embedded' as const, moduleFiles: { config } },
      },
      {
        layout: 'a linked worktree admin directory',
        setup: { checkout: 'worktree-admin' as const, commonFiles: { config } },
      },
    ])('And $layout behind a moved gitlink with an untracked file', ({ setup }) => {
      describe('When the whole tree is added', () => {
        it('Then it refuses the format, as git dies on it, and stages nothing', async () => {
          // Arrange
          const ctx = await superproject({ ...setup, tree: { n: 'untracked\n' } });
          const before = (await readIndex(ctx)).entries.map(({ id }) => id);
          const sut = add;

          // Act
          const thrown = await refusalOf(() => sut(ctx, ['.']));

          // Assert
          expect(thrown).toEqual(refusal);
          expect((await readIndex(ctx)).entries.map(({ id }) => id)).toEqual(before);
          expect(await blobExists(ctx, 'untracked\n')).toBe(false);
        });
      });
    });
  });
});

describe('add over a gitlink whose repository lacks objects or refs', () => {
  const ADMIN_POINTER = 'sub/../.git/admin';

  describe.each([
    {
      label: 'a commondir naming nothing',
      arrange: (ctx: Ctx) => ctx.fs.writeUtf8(`${ctx.layout.gitDir}/admin/commondir`, '/nowhere\n'),
    },
    {
      label: 'a commondir naming the filesystem root',
      arrange: (ctx: Ctx) => ctx.fs.writeUtf8(`${ctx.layout.gitDir}/admin/commondir`, '/\n'),
    },
    {
      label: 'a commondir naming an empty directory',
      arrange: async (ctx: Ctx) => {
        await ctx.fs.mkdir(`${ctx.layout.gitDir}/bare`);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/admin/commondir`, '../bare\n');
      },
    },
    {
      label: 'a commondir naming a directory with refs and no objects',
      arrange: async (ctx: Ctx) => {
        await ctx.fs.mkdir(`${ctx.layout.gitDir}/bare/refs`);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/admin/commondir`, '../bare\n');
      },
    },
    {
      label: 'a commondir naming a directory with objects and no refs',
      arrange: async (ctx: Ctx) => {
        await ctx.fs.mkdir(`${ctx.layout.gitDir}/bare/objects`);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/admin/commondir`, '../bare\n');
      },
    },
    {
      label: 'a commondir naming a regular file',
      arrange: async (ctx: Ctx) => {
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/plain`, 'plain\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/admin/commondir`, '../plain\n');
      },
    },
    {
      label: 'a commondir file of zero bytes',
      arrange: async (ctx: Ctx) => {
        await layOutRepositoryDirs(ctx, `${ctx.layout.gitDir}/admin`);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/admin/commondir`, '');
      },
    },

    {
      label: 'a common dir whose objects directory is missing',
      arrange: (ctx: Ctx) => ctx.fs.rm(`${ctx.layout.gitDir}/common/objects`),
    },
    {
      label: 'a common dir whose refs path is a regular file',
      arrange: async (ctx: Ctx) => {
        await ctx.fs.rmRecursive(`${ctx.layout.gitDir}/common/refs`);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/common/refs`, 'plain\n');
      },
    },
  ])('Given $label and an untracked file', ({ arrange }) => {
    describe('When the whole tree is added', () => {
      it('Then it refuses with the pointer as typed and stages nothing', async () => {
        // Arrange
        const ctx = await superproject({ checkout: 'worktree-admin', tree: { n: 'untracked\n' } });
        await arrange(ctx);
        const before = (await readIndex(ctx)).entries.map(({ id }) => id);
        const sut = add;

        // Act
        const refusal = await refusalOf(() => sut(ctx, ['.']));

        // Assert
        expect(refusal).toEqual({ code: 'NOT_A_REPOSITORY', path: ADMIN_POINTER });
        expect((await readIndex(ctx)).entries.map(({ id }) => id)).toEqual(before);
        expect(await blobExists(ctx, 'untracked\n')).toBe(false);
      });
    });
  });

  describe('Given a failure of the filesystem while the common dir is probed', () => {
    describe('When the whole tree is added', () => {
      it('Then the failure surfaces as it is and stages nothing', async () => {
        // Arrange
        const ctx = await superproject({ checkout: 'worktree-admin' });
        const failure = new Error('disk gone');
        const stat = ctx.fs.stat.bind(ctx.fs);
        vi.spyOn(ctx.fs, 'stat').mockImplementation((target) =>
          target.endsWith('/common/objects') ? Promise.reject(failure) : stat(target),
        );
        const before = (await readIndex(ctx)).entries.map(({ id }) => id);
        const sut = add;

        // Act
        const outcome = sut(ctx, ['.']);

        // Assert
        await expect(outcome).rejects.toBe(failure);
        expect((await readIndex(ctx)).entries.map(({ id }) => id)).toEqual(before);
      });
    });
  });

  describe('Given a commondir file holding a bare newline', () => {
    describe('When the whole tree is added', () => {
      it('Then the admin dir is its own common dir and the gitlink is staged', async () => {
        // Arrange
        const ctx = await superproject({ checkout: 'worktree-admin' });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/admin/commondir`, '\n');
        await layOutRepositoryDirs(ctx, `${ctx.layout.gitDir}/admin`);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/admin/refs/heads/main`, `${MOVED_HEAD}\n`);
        const sut = add;

        // Act
        await sut(ctx, ['.']);

        // Assert
        expect((await entryOf(ctx, 'sub'))?.id).toBe(MOVED_HEAD);
      });
    });
  });
});
