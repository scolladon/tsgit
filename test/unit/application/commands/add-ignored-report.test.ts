import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { pathspecNoMatch, TsgitError } from '../../../../src/domain/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';
import { seedIndex } from './add-index-fixtures.js';
import { seedRepo } from './fixtures.js';

type Ctx = ReturnType<typeof createMemoryContext>;
type Files = Readonly<Record<string, string>>;

const IGNORING_LOGS_AND_D = '*.log\nd/\n';

/** `.gitignore` hides every log and the directory d; nothing is tracked. */
const untrackedRepo = async (): Promise<Ctx> => {
  const ctx = createMemoryContext();
  await seedRepo(ctx, {
    workingTree: {
      '.gitignore': IGNORING_LOGS_AND_D,
      'x.log': 'x\n',
      'y.log': 'y\n',
      'real.txt': 'r\n',
      'd/q.txt': 'q\n',
    },
  });
  return ctx;
};

const write = (ctx: Ctx, files: Files): Promise<unknown[]> =>
  Promise.all(
    Object.entries(files).map(([name, body]) =>
      ctx.fs.writeUtf8(`${ctx.layout.workDir}/${name}`, body),
    ),
  );

/** Tracks d/x.txt and k, then hides d and rewrites d/x.txt beside an untracked d/new.txt. */
const trackedUnderIgnoredDirectory = async (): Promise<Ctx> => {
  const ctx = createMemoryContext();
  await seedRepo(ctx, { workingTree: { 'd/x.txt': 'a\n', k: 'k\n' } });
  await add(ctx, ['d/x.txt', 'k']);
  await write(ctx, { '.gitignore': 'd/\n', 'd/x.txt': 'bb\n', 'd/new.txt': 'n\n' });
  return ctx;
};

/** Tracks t.log and k, then hides every log, rewrites t.log and adds an untracked u.log. */
const trackedUnderIgnoredLog = async (): Promise<Ctx> => {
  const ctx = createMemoryContext();
  await seedRepo(ctx, { workingTree: { 't.log': 'a\n', k: 'k\n' } });
  await add(ctx, ['t.log', 'k']);
  await write(ctx, { '.gitignore': '*.log\n', 't.log': 'bb\n', 'u.log': 'u\n' });
  return ctx;
};

const indexPaths = async (ctx: Ctx): Promise<string[]> =>
  (await readIndex(ctx)).entries.map((entry) => entry.path);

const looseObjectCount = async (ctx: Ctx): Promise<number> => {
  const objects = `${ctx.layout.gitDir}/objects`;
  if (!(await ctx.fs.exists(objects))) return 0;
  const prefixes = await ctx.fs.readdir(objects);
  const counts = await Promise.all(
    prefixes.map(async ({ name }) => (await ctx.fs.readdir(`${objects}/${name}`)).length),
  );
  return counts.reduce((sum, count) => sum + count, 0);
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

describe('add reporting the ignored entries a pathspec reaches', () => {
  describe('Given an ignored log and an unignored text file', () => {
    describe('When an ignored literal and a wildcard reaching the text file are added', () => {
      it('Then the wildcard stages and the literal is not refused', async () => {
        // Arrange
        const ctx = await untrackedRepo();
        const sut = add;

        // Act
        const result = await sut(ctx, ['x.log', '*.txt']);

        // Assert
        expect(result.added).toEqual(['real.txt']);
        expect(await indexPaths(ctx)).toEqual(['real.txt']);
      });
    });
  });

  describe.each([
    { label: 'a wildcard that matches nothing', spec: 'nomatch*' },
    { label: 'a literal that is missing', spec: 'missing' },
    { label: 'a wildcard reaching only an ignored log', spec: 'x.lo?' },
  ])('Given an ignored log and $label', ({ spec }) => {
    describe('When it is added beside a wildcard reaching the text file', () => {
      it('Then the refusal names it and nothing is written', async () => {
        // Arrange
        const ctx = await untrackedRepo();
        const sut = add;

        // Act
        const data = await refusalOf(() => sut(ctx, [spec, '*.txt']));

        // Assert
        expect(data).toEqual(pathspecNoMatch(spec).data);
        expect(await indexPaths(ctx)).toEqual([]);
        expect(await looseObjectCount(ctx)).toBe(0);
      });
    });
  });

  describe('Given a tracked file beneath an ignored directory and an untracked sibling', () => {
    describe('When a wildcard reaching neither is added', () => {
      it('Then the refusal names it and nothing is written', async () => {
        // Arrange
        const ctx = await trackedUnderIgnoredDirectory();
        const before = await looseObjectCount(ctx);
        const sut = add;

        // Act
        const data = await refusalOf(() => sut(ctx, ['d/n*']));

        // Assert
        expect(data).toEqual(pathspecNoMatch('d/n*').data);
        expect(await looseObjectCount(ctx)).toBe(before);
      });
    });
  });

  describe('Given an ignored directory holding an untracked file', () => {
    describe('When the directory is added', () => {
      it('Then it is reported and nothing is staged', async () => {
        // Arrange
        const ctx = await untrackedRepo();
        const sut = add;

        // Act
        const result = await sut(ctx, ['d']);

        // Assert
        expect(result.ignored).toEqual(['d']);
        expect(result.added).toEqual([]);
        expect(await indexPaths(ctx)).toEqual([]);
      });
    });
  });

  describe.each([
    { label: 'a directory-only spelling of the ignored directory', spec: ['d/'], ignored: ['d'] },
    { label: 'an ignored literal beside a wildcard', spec: ['x.log', '*.txt'], ignored: ['x.log'] },
    {
      label: 'repeated and unsorted ignored literals',
      spec: ['y.log', 'x.log', 'y.log', 'd/q.txt', 'd'],
      ignored: ['d', 'x.log', 'y.log'],
    },
  ])('Given nothing tracked and $label', ({ spec, ignored }) => {
    describe('When it is added', () => {
      it('Then the ignored entries are reported sorted and deduplicated', async () => {
        // Arrange
        const ctx = await untrackedRepo();
        const sut = add;

        // Act
        const result = await sut(ctx, spec);

        // Assert
        expect(result.ignored).toEqual(ignored);
      });
    });
  });

  describe('Given an ignored log', () => {
    describe('When the log is added as the only literal', () => {
      it('Then it is reported and nothing is staged', async () => {
        // Arrange
        const ctx = await untrackedRepo();
        const sut = add;

        // Act
        const result = await sut(ctx, ['x.log']);

        // Assert
        expect(result.added).toEqual([]);
        expect(result.ignored).toEqual(['x.log']);
        expect(await indexPaths(ctx)).toEqual([]);
        expect(await looseObjectCount(ctx)).toBe(0);
      });
    });
  });

  describe.each([
    { label: 'an ignored log then a text file', spec: ['x.log', 'real.txt'], ignored: ['x.log'] },
    { label: 'a text file then an ignored log', spec: ['real.txt', 'x.log'], ignored: ['x.log'] },
    { label: 'two ignored logs, unsorted', spec: ['y.log', 'x.log'], ignored: ['x.log', 'y.log'] },
    { label: 'a file beneath the ignored directory', spec: ['d/q.txt'], ignored: ['d'] },
  ])('Given nothing tracked and the literals $label', ({ spec, ignored }) => {
    describe('When they are added', () => {
      it('Then only the unignored literal is staged and the ignored ones are reported sorted', async () => {
        // Arrange
        const ctx = await untrackedRepo();
        const sut = add;

        // Act
        const result = await sut(ctx, spec);

        // Assert
        expect(result.ignored).toEqual(ignored);
        expect(await indexPaths(ctx)).toEqual(spec.includes('real.txt') ? ['real.txt'] : []);
      });
    });
  });

  describe('Given an ignored log', () => {
    describe('When the log is added as the only literal with force', () => {
      it('Then it is staged and nothing is reported', async () => {
        // Arrange
        const ctx = await untrackedRepo();
        const sut = add;

        // Act
        const result = await sut(ctx, ['x.log'], { force: true });

        // Assert
        expect(result.added).toEqual(['x.log']);
        expect(result.ignored).toEqual([]);
      });
    });
  });

  describe('Given a tracked file beneath an ignored directory and an untracked sibling', () => {
    describe('When the tracked file is added as the only literal', () => {
      it('Then the directory is reported and the tracked file is restaged', async () => {
        // Arrange
        const ctx = await trackedUnderIgnoredDirectory();
        const sut = add;

        // Act
        const result = await sut(ctx, ['d/x.txt']);

        // Assert
        expect(result.ignored).toEqual(['d']);
        expect(result.modified).toEqual(['d/x.txt']);
        expect(result.added).toEqual([]);
      });
    });

    describe('When the untracked sibling is added as the only literal', () => {
      it('Then the directory is reported and nothing is staged', async () => {
        // Arrange
        const ctx = await trackedUnderIgnoredDirectory();
        const sut = add;

        // Act
        const result = await sut(ctx, ['d/new.txt']);

        // Assert
        expect(result.ignored).toEqual(['d']);
        expect(result.added).toEqual([]);
        expect(result.modified).toEqual([]);
      });
    });

    describe('When both are added', () => {
      it('Then the directory is reported once and only the tracked file is restaged', async () => {
        // Arrange
        const ctx = await trackedUnderIgnoredDirectory();
        const sut = add;

        // Act
        const result = await sut(ctx, ['d/x.txt', 'd/new.txt']);

        // Assert
        expect(result.ignored).toEqual(['d']);
        expect(result.modified).toEqual(['d/x.txt']);
        expect(result.added).toEqual([]);
      });
    });
  });

  describe('Given a tracked log and an untracked log that a rule hides', () => {
    describe('When both are added as literals', () => {
      it('Then the untracked one is reported and the tracked one is restaged', async () => {
        // Arrange
        const ctx = await trackedUnderIgnoredLog();
        const sut = add;

        // Act
        const result = await sut(ctx, ['t.log', 'u.log']);

        // Assert
        expect(result.ignored).toEqual(['u.log']);
        expect(result.modified).toEqual(['t.log']);
        expect(result.added).toEqual([]);
      });
    });

    describe('When only the tracked one is added as a literal', () => {
      it('Then it is restaged and nothing is reported', async () => {
        // Arrange
        const ctx = await trackedUnderIgnoredLog();
        const sut = add;

        // Act
        const result = await sut(ctx, ['t.log']);

        // Assert
        expect(result.ignored).toEqual([]);
        expect(result.modified).toEqual(['t.log']);
      });
    });
  });

  describe('Given a tracked file beneath an ignored directory', () => {
    describe('When a single-character wildcard reaching only the directory and a clean file is added', () => {
      it('Then nothing is reported and nothing is staged', async () => {
        // Arrange
        const ctx = await trackedUnderIgnoredDirectory();
        const sut = add;

        // Act
        const result = await sut(ctx, ['?']);

        // Assert
        expect(result.ignored).toEqual([]);
        expect(result.added).toEqual([]);
        expect(result.modified).toEqual([]);
      });
    });
  });

  describe.each([
    { label: 'the directory', spec: 'd' },
    { label: 'a wildcard inside the directory', spec: 'd/*.txt' },
    { label: 'a wildcard naming the directory', spec: 'd*' },
    { label: 'a wildcard on the tracked file inside the directory', spec: 'd/x*' },
  ])('Given a tracked file beneath an ignored directory and $label', ({ spec }) => {
    describe('When it is added', () => {
      it('Then the directory is reported and the tracked file is restaged', async () => {
        // Arrange
        const ctx = await trackedUnderIgnoredDirectory();
        const sut = add;

        // Act
        const result = await sut(ctx, [spec]);

        // Assert
        expect(result.ignored).toEqual(['d']);
        expect(result.modified).toEqual(['d/x.txt']);
        expect(result.added).toEqual([]);
      });
    });
  });

  describe('Given a tracked file beneath an ignored directory', () => {
    describe('When a wildcard reaching every top-level name is added', () => {
      it('Then nothing is reported and the ignore file and tracked file are staged', async () => {
        // Arrange
        const ctx = await trackedUnderIgnoredDirectory();
        const sut = add;

        // Act
        const result = await sut(ctx, ['*']);

        // Assert
        expect(result.ignored).toEqual([]);
        expect(result.added).toEqual(['.gitignore']);
        expect(result.modified).toEqual(['d/x.txt']);
      });
    });
  });

  describe.each([
    { label: 'a wildcard on the ignored suffix', spec: '*.log' },
    { label: 'the whole tree', spec: '.' },
    { label: 'a single-character wildcard on the ignored suffix', spec: '?.log' },
  ])('Given a tracked log that a rule hides and $label', ({ spec }) => {
    describe('When it is added', () => {
      it('Then the tracked log is restaged and nothing is reported', async () => {
        // Arrange
        const ctx = await trackedUnderIgnoredLog();
        const sut = add;

        // Act
        const result = await sut(ctx, [spec]);

        // Assert
        expect(result.ignored).toEqual([]);
        expect(result.modified).toEqual(['t.log']);
        expect(result.added).not.toContain('u.log');
      });
    });
  });

  describe('Given a tracked gitlink named by an ignore rule', () => {
    describe('When the gitlink is added', () => {
      it('Then nothing is reported', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, { workingTree: { '.gitignore': 'sub\n', 'sub/f': 'f\n' } });
        await seedIndex(ctx, [{ path: 'sub', text: 'g\n', mode: FILE_MODE.GITLINK }]);
        const sut = add;

        // Act
        const result = await sut(ctx, ['sub']);

        // Assert
        expect(result.ignored).toEqual([]);
      });
    });
  });

  describe('Given every log is ignored', () => {
    describe('When a wildcard on the ignored suffix is added with force', () => {
      it('Then the logs are staged and nothing is reported', async () => {
        // Arrange
        const ctx = await untrackedRepo();
        const sut = add;

        // Act
        const result = await sut(ctx, ['*.log'], { force: true });

        // Assert
        expect(result.added).toEqual(['x.log', 'y.log']);
        expect(result.ignored).toEqual([]);
      });
    });
  });

  describe.each([
    {
      label: 'the whole tree',
      spec: ['.'],
      added: ['.gitignore', 'd/q.txt', 'real.txt', 'x.log', 'y.log'],
    },
    { label: 'the ignored directory', spec: ['d'], added: ['d/q.txt'] },
  ])('Given every log and a directory are ignored and $label', ({ spec, added }) => {
    describe('When it is added with force', () => {
      it('Then the ignored files are staged and nothing is reported', async () => {
        // Arrange
        const ctx = await untrackedRepo();
        const sut = add;

        // Act
        const result = await sut(ctx, spec, { force: true });

        // Assert
        expect(result.added).toEqual(added);
        expect(result.ignored).toEqual([]);
      });
    });
  });

  describe('Given every log and a directory are ignored', () => {
    describe('When the whole tree is added with all and force', () => {
      it('Then the ignored files are staged and nothing is reported', async () => {
        // Arrange
        const ctx = await untrackedRepo();
        const sut = add;

        // Act
        const result = await sut(ctx, [], { all: true, force: true });

        // Assert
        expect(result.added).toEqual(['.gitignore', 'd/q.txt', 'real.txt', 'x.log', 'y.log']);
        expect(result.ignored).toEqual([]);
      });
    });
  });
});
