import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { serializeAndHash } from '../../../../src/application/primitives/internal/serialize-and-hash.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { FILE_MODE, type ObjectId } from '../../../../src/domain/objects/index.js';
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
  | 'pointed-away';

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
  readonly skipWorktree?: boolean;
  /** Extra working-tree files laid over `k`. */
  readonly tree?: Readonly<Record<string, string>>;
}

const layOutModule = async (
  ctx: Ctx,
  gitDir: string,
  { head = MODULE_HEAD, branch = MOVED_HEAD }: Superproject,
): Promise<void> => {
  if (head === null) await ctx.fs.mkdir(gitDir);
  else await ctx.fs.writeUtf8(`${gitDir}/HEAD`, head);
  if (branch !== null) await ctx.fs.writeUtf8(`${gitDir}/refs/heads/main`, `${branch}\n`);
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
