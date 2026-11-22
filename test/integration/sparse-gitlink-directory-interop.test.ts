/**
 * Cross-tool interop — a non-cone sparse pattern judges a gitlink by what stands at its path:
 * a directory-only rule applies to a gitlink whose work-tree directory exists and leaves one
 * with no directory alone, as git reads the kind of a path from the work tree.
 *
 * @proves
 *   surface:        sparseCheckout
 *   bucket:         cross-tool-interop
 *   unique:         a gitlink is judged as a directory when its work-tree directory exists, as git does
 *   interopSurface: sparseCheckout
 */
import { mkdir, mkdtemp, readdir, realpath, rm as removeTree, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { reset } from '../../src/application/commands/reset.js';
import { sparseCheckoutReapply } from '../../src/application/commands/sparse-checkout.js';
import { GIT_AVAILABLE, runGit, runGitEnv } from './interop-helpers.js';

const PINNED_DATE = '@1700000000 +0000';
const GITLINK_ID = '1111111111111111111111111111111111111111';

const gitIn = (repo: string, args: ReadonlyArray<string>): string =>
  runGit(['-C', repo, ...args], {
    env: { ...runGitEnv(), GIT_AUTHOR_DATE: PINNED_DATE, GIT_COMMITTER_DATE: PINNED_DATE },
  });

/** main = lib/f v2, top, gitlink sub; older = lib/f v1; the `before` patterns applied, then `patterns` written and the gitlink's directory made present or absent. */
const seed = async (repo: string, row: Row): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', repo]);
  gitIn(repo, ['config', 'user.name', 'A']);
  gitIn(repo, ['config', 'user.email', 'a@a']);
  await mkdir(path.join(repo, 'lib'));
  await writeFile(path.join(repo, 'lib/f'), 'v1\n');
  await writeFile(path.join(repo, 'top'), 'top\n');
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['update-index', '--add', '--cacheinfo', `160000,${GITLINK_ID},sub`]);
  gitIn(repo, ['commit', '-qm', 'older']);
  gitIn(repo, ['branch', 'older']);
  await writeFile(path.join(repo, 'lib/f'), 'v2\n');
  gitIn(repo, ['add', 'lib/f']);
  gitIn(repo, ['commit', '-qm', 'main']);
  gitIn(repo, ['config', 'core.sparseCheckout', 'true']);
  gitIn(repo, ['config', 'core.sparseCheckoutCone', 'false']);
  await writeFile(path.join(repo, '.git/info/sparse-checkout'), row.before);
  gitIn(repo, ['read-tree', '-mu', 'HEAD']);
  await writeFile(path.join(repo, '.git/info/sparse-checkout'), row.patterns);
  await removeTree(path.join(repo, 'sub'), { recursive: true, force: true });
  if (row.directory) await mkdir(path.join(repo, 'sub'));
};

/** older = lib/f, top, no gitlink; main adds the gitlink sub. The `/lib/` patterns are applied on older, then `patterns` written and the gitlink's directory made present or absent. */
const seedEntering = async (repo: string, patterns: string, directory: boolean): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', repo]);
  gitIn(repo, ['config', 'user.name', 'A']);
  gitIn(repo, ['config', 'user.email', 'a@a']);
  await mkdir(path.join(repo, 'lib'));
  await writeFile(path.join(repo, 'lib/f'), 'v1\n');
  await writeFile(path.join(repo, 'top'), 'top\n');
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['commit', '-qm', 'older']);
  gitIn(repo, ['branch', 'older']);
  gitIn(repo, ['update-index', '--add', '--cacheinfo', `160000,${GITLINK_ID},sub`]);
  gitIn(repo, ['commit', '-qm', 'main']);
  gitIn(repo, ['checkout', '-q', 'older']);
  gitIn(repo, ['config', 'core.sparseCheckout', 'true']);
  gitIn(repo, ['config', 'core.sparseCheckoutCone', 'false']);
  await writeFile(path.join(repo, '.git/info/sparse-checkout'), '/lib/\n');
  gitIn(repo, ['read-tree', '-mu', 'HEAD']);
  await writeFile(path.join(repo, '.git/info/sparse-checkout'), patterns);
  if (directory) await mkdir(path.join(repo, 'sub'));
};

interface EnteringOperation {
  readonly name: string;
  readonly git: ReadonlyArray<string>;
  readonly tsgit: (workDir: string) => Promise<unknown>;
}

const ENTERING_OPERATIONS: ReadonlyArray<EnteringOperation> = [
  {
    name: 'switching to the commit that adds it',
    git: ['checkout', '-q', 'main'],
    tsgit: (workDir) => checkout(createNodeContext({ workDir }), { rev: 'main' }),
  },
  {
    name: 'resetting hard to the commit that adds it',
    git: ['reset', '-q', '--hard', 'main'],
    tsgit: (workDir) => reset(createNodeContext({ workDir }), { mode: 'hard', rev: 'main' }),
  },
];

const coneFile = (directory: string): string => `/*\n!/*/\n/${directory}/\n`;

/** main and older hold a gitlink at the top and one under `deep`; the cone of `before` is applied, then the cone of `directory` written and the gitlinks' directories made present or absent. */
const seedCone = async (repo: string, row: ConeRow): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', repo]);
  gitIn(repo, ['config', 'user.name', 'A']);
  gitIn(repo, ['config', 'user.email', 'a@a']);
  for (const [file, content] of [
    ['lib/f', 'v1\n'],
    ['deep/x', 'x\n'],
    ['top', 'top\n'],
  ] as const) {
    await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await writeFile(path.join(repo, file), content);
  }
  gitIn(repo, ['add', '-A']);
  for (const gitlink of ['sub', 'deep/sub']) {
    gitIn(repo, ['update-index', '--add', '--cacheinfo', `160000,${GITLINK_ID},${gitlink}`]);
  }
  gitIn(repo, ['commit', '-qm', 'older']);
  gitIn(repo, ['branch', 'older']);
  await writeFile(path.join(repo, 'lib/f'), 'v2\n');
  gitIn(repo, ['add', 'lib/f']);
  gitIn(repo, ['commit', '-qm', 'main']);
  gitIn(repo, ['sparse-checkout', 'set', '--cone', row.before]);
  await writeFile(path.join(repo, '.git/info/sparse-checkout'), coneFile(row.after));
  for (const gitlink of ['sub', 'deep/sub']) {
    await removeTree(path.join(repo, gitlink), { recursive: true, force: true });
    if (row.directory) await mkdir(path.join(repo, gitlink), { recursive: true });
  }
};

interface ConeRow {
  readonly before: string;
  readonly after: string;
  readonly directory: boolean;
}

const CONE_ROWS: ReadonlyArray<ConeRow> = [
  { before: 'lib', after: 'lib', directory: true },
  { before: 'lib', after: 'lib', directory: false },
  { before: 'lib', after: 'deep', directory: true },
  { before: 'lib', after: 'deep', directory: false },
];

const tagsOf = (repo: string): string =>
  gitIn(repo, ['-c', 'sparse.expectFilesOutsideOfPatterns=true', 'ls-files', '-t']);

const listDisk = async (repo: string): Promise<ReadonlyArray<string>> =>
  (await readdir(repo, { recursive: true })).filter((name) => !name.startsWith('.git')).sort();

/** `before` leaves the gitlink with the skip-worktree bit when it excludes the gitlink, without it otherwise. */
interface Row {
  readonly before: string;
  readonly patterns: string;
  readonly directory: boolean;
}

const BEFORE = ['*\n', '/lib/\n'] as const;
const PATTERNS = ['sub/\n/lib/\n', '*\n!sub/\n'] as const;

const ROWS: ReadonlyArray<Row> = BEFORE.flatMap((before) =>
  PATTERNS.flatMap((patterns) => [
    { before, patterns, directory: true },
    { before, patterns, directory: false },
  ]),
);

const ENTERING_ROWS = PATTERNS.flatMap((patterns) => [
  { patterns, directory: true },
  { patterns, directory: false },
]);

interface Operation {
  readonly name: string;
  readonly git: ReadonlyArray<string>;
  /** `reapply` also writes an included file the work tree lacks, which `read-tree -mu` leaves absent. */
  readonly comparesFiles: boolean;
  readonly tsgit: (workDir: string) => Promise<unknown>;
}

const OPERATIONS: ReadonlyArray<Operation> = [
  {
    name: 'reapplying the patterns',
    git: ['read-tree', '-mu', 'HEAD'],
    comparesFiles: false,
    tsgit: (workDir) => sparseCheckoutReapply(createNodeContext({ workDir })),
  },
  {
    name: 'resetting hard to an older commit',
    git: ['reset', '-q', '--hard', 'older'],
    comparesFiles: true,
    tsgit: (workDir) => reset(createNodeContext({ workDir }), { mode: 'hard', rev: 'older' }),
  },
  {
    name: 'resetting mixed to an older commit',
    git: ['reset', '-q', 'older'],
    comparesFiles: true,
    tsgit: (workDir) => reset(createNodeContext({ workDir }), { mode: 'mixed', rev: 'older' }),
  },
  {
    name: 'switching to an older commit',
    git: ['checkout', '-q', 'older'],
    comparesFiles: true,
    tsgit: (workDir) => checkout(createNodeContext({ workDir }), { rev: 'older' }),
  },
];

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'a non-cone sparse checkout over a gitlink',
  () => {
    let root = '';
    let counter = 0;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-sparse-gitlink-')));
    });

    afterAll(async () => {
      await removeTree(root, { recursive: true, force: true });
    });

    describe.each(ROWS)(
      'Given $patterns after $before and a gitlink sub whose directory is present: $directory',
      (row) => {
        describe.each(OPERATIONS)('When $name', (operation) => {
          it('Then tsgit leaves the index tags and the files git leaves', async () => {
            // Arrange
            counter += 1;
            const gitRepo = path.join(root, `git-${counter}`);
            const tsgitRepo = path.join(root, `tsgit-${counter}`);
            await seed(gitRepo, row);
            await seed(tsgitRepo, row);
            gitIn(gitRepo, operation.git);

            // Act
            await operation.tsgit(tsgitRepo);

            // Assert
            expect(tagsOf(tsgitRepo)).toBe(tagsOf(gitRepo));
            if (operation.comparesFiles) {
              expect(await listDisk(tsgitRepo)).toEqual(await listDisk(gitRepo));
            }
          });
        });
      },
    );

    describe.each(ENTERING_ROWS)(
      'Given $patterns applied while the gitlink sub is not yet tracked and its directory is present: $directory',
      (row) => {
        describe.each(ENTERING_OPERATIONS)('When $name', (operation) => {
          it('Then tsgit leaves the index tags and the files git leaves', async () => {
            // Arrange
            counter += 1;
            const gitRepo = path.join(root, `git-${counter}`);
            const tsgitRepo = path.join(root, `tsgit-${counter}`);
            await seedEntering(gitRepo, row.patterns, row.directory);
            await seedEntering(tsgitRepo, row.patterns, row.directory);
            gitIn(gitRepo, operation.git);

            // Act
            await operation.tsgit(tsgitRepo);

            // Assert
            expect(tagsOf(tsgitRepo)).toBe(tagsOf(gitRepo));
            expect(await listDisk(tsgitRepo)).toEqual(await listDisk(gitRepo));
          });
        });
      },
    );

    describe.each(CONE_ROWS)(
      'Given the cone $before narrowed to $after and gitlinks whose directories are present: $directory',
      (row) => {
        describe.each(OPERATIONS)('When $name', (operation) => {
          it('Then tsgit leaves the index tags and the files git leaves', async () => {
            // Arrange
            counter += 1;
            const gitRepo = path.join(root, `git-${counter}`);
            const tsgitRepo = path.join(root, `tsgit-${counter}`);
            await seedCone(gitRepo, row);
            await seedCone(tsgitRepo, row);
            gitIn(gitRepo, operation.git);

            // Act
            await operation.tsgit(tsgitRepo);

            // Assert
            expect(tagsOf(tsgitRepo)).toBe(tagsOf(gitRepo));
            if (operation.comparesFiles) {
              expect(await listDisk(tsgitRepo)).toEqual(await listDisk(gitRepo));
            }
          });
        });
      },
    );
  },
);
