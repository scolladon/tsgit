/**
 * Cross-tool interop — `add` stages a gitlink whose submodule checkout moved to
 * another commit, as git does through `<path>/.git`, and refuses with
 * NOT_A_REPOSITORY when that checkout is broken.
 *
 * @proves
 *   surface:        add
 *   bucket:         cross-tool-interop
 *   unique:         add stages a moved gitlink and refuses a broken one as git does
 *   interopSurface: add
 */
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm as removeTree,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { TsgitError } from '../../src/domain/index.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const PINNED_DATE = '@1700000000 +0000';

type Setup = (repo: string, upstream: string) => Promise<void>;

const pinnedEnv = () => ({
  ...runGitEnv(),
  GIT_AUTHOR_DATE: PINNED_DATE,
  GIT_COMMITTER_DATE: PINNED_DATE,
});

const commitIn = (repo: string, message: string): void => {
  runGit(
    [
      '-C',
      repo,
      '-c',
      'user.name=A',
      '-c',
      'user.email=a@a',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      message,
    ],
    { env: pinnedEnv() },
  );
};

const writeFiles = async (repo: string, files: Readonly<Record<string, string>>): Promise<void> => {
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await writeFile(path.join(repo, name), body);
  }
};

/** A superproject holding `k` and the submodule `sub`, committed. */
const withSubmodule: Setup = async (repo, upstream) => {
  await writeFiles(repo, { k: 'k\n' });
  runGit(['-C', repo, 'add', 'k']);
  runGit(
    ['-C', repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream, 'sub'],
    {
      env: pinnedEnv(),
    },
  );
  commitIn(repo, 'super');
};

/** The submodule checked out at a commit of its own, which the superproject does not record. */
const moved: Setup = async (repo, upstream) => {
  await withSubmodule(repo, upstream);
  commitIn(path.join(repo, 'sub'), 'moved');
};

/** The superproject with `sub` edited inside but still at the recorded commit. */
const editedInside: Setup = async (repo, upstream) => {
  await withSubmodule(repo, upstream);
  await writeFiles(path.join(repo, 'sub'), { 'untracked.txt': 'u\n' });
};

/** A moved submodule that an ignore rule names. */
const movedAndIgnored: Setup = async (repo, upstream) => {
  await moved(repo, upstream);
  await writeFiles(repo, { '.gitignore': 'sub\n' });
};

const movedAndSkipped: Setup = async (repo, upstream) => {
  await moved(repo, upstream);
  runGit(['-C', repo, 'update-index', '--skip-worktree', 'sub']);
};

const deinitialised: Setup = async (repo, upstream) => {
  await withSubmodule(repo, upstream);
  runGit(['-C', repo, 'submodule', 'deinit', '-q', '-f', 'sub']);
};

const replacedBy =
  (replace: (sub: string) => Promise<void>): Setup =>
  async (repo, upstream) => {
    await withSubmodule(repo, upstream);
    await removeTree(path.join(repo, 'sub'), { recursive: true, force: true });
    await replace(path.join(repo, 'sub'));
  };

const freshRepositoryInPlace = async (sub: string): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', sub]);
};

const unrelatedRepositoryInPlace = async (sub: string): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', sub]);
  commitIn(sub, 'unrelated');
};

/** A repository cloned into `sub` and recorded as a gitlink with no .gitmodules entry. */
const embedded: Setup = async (repo, upstream) => {
  await writeFiles(repo, { k: 'k\n' });
  runGit(['clone', '-q', upstream, path.join(repo, 'sub')], { env: pinnedEnv() });
  runGit(['-C', repo, 'add', '.']);
  commitIn(repo, 'super');
  commitIn(path.join(repo, 'sub'), 'moved');
};

/** The embedded repository's own `.git` moved to `target`, which the superproject's `sub/.git` then reaches. */
const movedGitdirReachedBy =
  (
    target: (repo: string) => string,
    reach: (dotGit: string, target: string) => Promise<void>,
  ): Setup =>
  async (repo, upstream) => {
    await embedded(repo, upstream);
    const dotGit = path.join(repo, 'sub', '.git');
    const moved = target(repo);
    await rename(dotGit, moved);
    await reach(dotGit, moved);
  };

const pointerTo = (dotGit: string, target: string): Promise<void> =>
  writeFile(dotGit, `gitdir: ${target}\n`);

const linkTo = (dotGit: string, target: string): Promise<void> => symlink(target, dotGit);

const outsideTheSuperproject = (repo: string): string => `${repo}-gitdir`;

const insideTheGitDir = (repo: string): string => path.join(repo, '.git', 'store');

/** Gitlink `d/sub` recorded, then `d` replaced by a relative symlink to a directory holding a moved repository `sub`. */
const behindSymlinkedParent: Setup = async (repo, upstream) => {
  await writeFiles(repo, { k: 'k\n' });
  runGit(['clone', '-q', upstream, path.join(repo, 'd', 'sub')], { env: pinnedEnv() });
  runGit(['-C', repo, 'add', '.']);
  commitIn(repo, 'super');
  await removeTree(path.join(repo, 'd'), { recursive: true, force: true });
  // Shared by both twins and only ever read, so the symlink blob is the same in each.
  const out = `${upstream}-out`;
  await removeTree(out, { recursive: true, force: true });
  runGit(['clone', '-q', upstream, path.join(out, 'sub')], { env: pinnedEnv() });
  commitIn(path.join(out, 'sub'), 'moved');
  await symlink(`../${path.basename(out)}`, path.join(repo, 'd'));
};

/** The embedded repository holding committed files `u` and `x`, its `.git` then made to be what `reach` builds. */
const holdingFilesBehind =
  (reach: (repo: string, dotGit: string, moved: string) => Promise<void>): Setup =>
  async (repo, upstream) => {
    await embedded(repo, upstream);
    const sub = path.join(repo, 'sub');
    await writeFiles(sub, { u: 'u\n', x: 'x\n' });
    runGit(['-C', sub, 'add', 'u', 'x']);
    commitIn(sub, 'files');
    const dotGit = path.join(sub, '.git');
    const moved = outsideTheSuperproject(repo);
    await rename(dotGit, moved);
    await reach(repo, dotGit, moved);
  };

const symlinkedToRepository = holdingFilesBehind((_repo, dotGit, moved) => linkTo(dotGit, moved));

const symlinkedToGitfile = holdingFilesBehind(async (repo, dotGit, moved) => {
  const gitfile = `${repo}-gitfile`;
  await pointerTo(gitfile, moved);
  await linkTo(dotGit, gitfile);
});

const withoutDotGit = holdingFilesBehind(async () => undefined);

/** An embedded repository whose refs live in reftable, recorded as a gitlink and then moved. */
const embeddedReftable: Setup = async (repo) => {
  await writeFiles(repo, { k: 'k\n' });
  const sub = path.join(repo, 'sub');
  runGit(['init', '-q', '-b', 'main', '--ref-format=reftable', sub]);
  commitIn(sub, 'first');
  runGit(['-C', repo, 'add', '.']);
  commitIn(repo, 'super');
  commitIn(sub, 'moved');
};

/** `sub/.git` a gitfile naming a linked worktree's admin dir, whose branch the common dir moved past the recorded commit. */
const linkedWorktreeOn =
  (init: ReadonlyArray<string>): Setup =>
  async (repo) => {
    const ext = `${repo}-ext`;
    const worktree = `${repo}-linked-worktree`;
    runGit(['init', '-q', '-b', 'main', ...init, ext]);
    commitIn(ext, 'A');
    const recorded = runGit(['-C', ext, 'rev-parse', 'HEAD']).trim();
    commitIn(ext, 'B');
    const moved = runGit(['-C', ext, 'rev-parse', 'HEAD']).trim();
    runGit(['-C', ext, 'worktree', 'add', '-q', '-b', 'wt', worktree, recorded]);
    runGit(['-C', ext, 'update-ref', 'refs/heads/wt', moved]);
    await writeFiles(repo, { k: 'k\n' });
    runGit(['-C', repo, 'add', 'k']);
    runGit(['-C', repo, 'update-index', '--add', '--cacheinfo', `160000,${recorded},sub`]);
    commitIn(repo, 'super');
    await mkdir(path.join(repo, 'sub'));
    await writeFile(
      path.join(repo, 'sub', '.git'),
      `gitdir: ${path.join(ext, '.git', 'worktrees', path.basename(worktree))}\n`,
    );
  };

const linkedWorktreeCheckout = linkedWorktreeOn([]);
const linkedReftableWorktreeCheckout = linkedWorktreeOn(['--ref-format=reftable']);

const movedUnderAnotherName: Setup = async (repo, upstream) => {
  await writeFiles(repo, { k: 'k\n' });
  runGit(['-C', repo, 'add', 'k']);
  runGit(
    [
      '-C',
      repo,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      '--name',
      'other',
      upstream,
      'sub',
    ],
    { env: pinnedEnv() },
  );
  commitIn(repo, 'super');
  commitIn(path.join(repo, 'sub'), 'moved');
};

const movedAndEdited: Setup = async (repo, upstream) => {
  await moved(repo, upstream);
  await writeFiles(repo, { k: 'k2\n' });
};

const brokenBy =
  (breakIt: (repo: string) => Promise<void>): Setup =>
  async (repo, upstream) => {
    await withSubmodule(repo, upstream);
    await breakIt(repo);
    await writeFiles(repo, { n: 'untracked\n' });
  };

const notARepository = (shown: string): string => `fatal: not a git repository: ${shown}\n`;
const invalidGitfile = (shown: string): string => `fatal: invalid gitfile format: ${shown}\n`;
const notRecognized = (shown: string): string =>
  `fatal: '${shown}' not recognized as a git repository\n`;

const pointAt = (pointer: (repo: string) => string) =>
  brokenBy((repo) => writeFile(path.join(repo, 'sub', '.git'), `gitdir: ${pointer(repo)}\n`));

/** The absorbed module's own config, with `text` appended so its last-wins keys decide. */
const withModuleConfig = (text: string) =>
  brokenBy((repo) => appendFile(path.join(repo, '.git', 'modules', 'sub', 'config'), text));

const FORMAT_1 = '[core]\n\trepositoryformatversion = 1\n';

const MODULE_POINTER = 'sub/../.git/modules/sub';

const moduleDirOf = (repo: string): string => path.join(repo, '.git', 'modules', 'sub');

/** The absorbed module's `commondir` file holding `content`, which may name a directory made by `prepare`. */
const commondirNaming = (
  content: (repo: string) => string,
  prepare: (repo: string) => Promise<unknown> = async () => undefined,
): Setup =>
  brokenBy(async (repo) => {
    await prepare(repo);
    await writeFile(path.join(moduleDirOf(repo), 'commondir'), content(repo));
  });

const aSiblingDirectory = (name: string) => (repo: string) => `${repo}-${name}`;

/** How many lines of the module's config come before the `appended` text that ends it. */
const linesBefore = async (config: string, appended: string): Promise<number> => {
  const newlines = (text: string): number => text.split('\n').length - 1;
  return newlines(await readFile(config, 'utf8')) - newlines(appended);
};

const moduleConfigOf = (repo: string): string => path.join(moduleDirOf(repo), 'config');

type ConfigRefusal =
  | {
      readonly code: 'CONFIG_INVALID_ENUM_VALUE';
      readonly key: string;
      readonly value: string;
      readonly line: number;
    }
  | { readonly code: 'CONFIG_MISSING_VALUE'; readonly key: string; readonly line: number }
  | {
      readonly code: 'CONFIG_BAD_NUMERIC_VALUE';
      readonly key: string;
      readonly value: string;
      readonly reason: string;
    };

/** What git prints for a malformed config entry, rebuilt from the structured refusal. */
const gitConfigErrorOf = (refusal: ConfigRefusal, source: string): string => {
  if (refusal.code === 'CONFIG_BAD_NUMERIC_VALUE') {
    return `fatal: bad numeric config value '${refusal.value}' for '${refusal.key}' in file ${source}: ${refusal.reason}\n`;
  }
  const complaint =
    refusal.code === 'CONFIG_MISSING_VALUE'
      ? `missing value for '${refusal.key}'`
      : `invalid value for '${refusal.key}': '${refusal.value}'`;
  return `error: ${complaint}\nfatal: bad config line ${refusal.line} in file ${source}\n`;
};

interface ConfigErrorRow {
  readonly label: string;
  readonly config: string;
  readonly refusal: ConfigRefusal;
}

const CONFIG_ERROR_ROWS: ReadonlyArray<ConfigErrorRow> = [
  {
    label: 'an unknown ref storage at format version 1',
    config: `${FORMAT_1}[extensions]\n\trefStorage = bogus\n`,
    refusal: {
      code: 'CONFIG_INVALID_ENUM_VALUE',
      key: 'extensions.refstorage',
      value: 'bogus',
      line: 4,
    },
  },
  {
    label: 'an unknown ref storage at format version 0',
    config: '[extensions]\n\trefStorage = bogus\n',
    refusal: {
      code: 'CONFIG_INVALID_ENUM_VALUE',
      key: 'extensions.refstorage',
      value: 'bogus',
      line: 2,
    },
  },
  {
    label: 'a valueless ref storage at format version 1',
    config: `${FORMAT_1}[extensions]\n\trefStorage\n`,
    refusal: { code: 'CONFIG_MISSING_VALUE', key: 'extensions.refstorage', line: 4 },
  },
  {
    label: 'an unknown ref storage before a malformed format version',
    config: '[extensions]\n\trefStorage = bogus\n[core]\n\trepositoryformatversion = x\n',
    refusal: {
      code: 'CONFIG_INVALID_ENUM_VALUE',
      key: 'extensions.refstorage',
      value: 'bogus',
      line: 2,
    },
  },
  {
    label: 'a valueless ref storage before a valueless format version',
    config: '[extensions]\n\trefStorage\n[core]\n\trepositoryformatversion\n',
    refusal: { code: 'CONFIG_MISSING_VALUE', key: 'extensions.refstorage', line: 2 },
  },
  {
    label: 'a malformed format version before an unknown ref storage',
    config: '[core]\n\trepositoryformatversion = x\n[extensions]\n\trefStorage = bogus\n',
    refusal: {
      code: 'CONFIG_BAD_NUMERIC_VALUE',
      key: 'core.repositoryformatversion',
      value: 'x',
      reason: 'invalid unit',
    },
  },
  {
    label: 'a valueless format version',
    config: '[core]\n\trepositoryformatversion\n',
    refusal: {
      code: 'CONFIG_BAD_NUMERIC_VALUE',
      key: 'core.repositoryformatversion',
      value: '',
      reason: 'invalid unit',
    },
  },
];

/** The embedded repository that moved, its own config then extended by `text`. */
const embeddedWithConfig =
  (text: string): Setup =>
  async (repo, upstream) => {
    await embedded(repo, upstream);
    await appendFile(path.join(repo, 'sub', '.git', 'config'), text);
  };

/** The linked-worktree checkout, whose common dir's config is then extended by `text`. */
const linkedWorktreeWithConfig =
  (text: string): Setup =>
  async (repo, upstream) => {
    await linkedWorktreeCheckout(repo, upstream);
    await appendFile(path.join(`${repo}-ext`, '.git', 'config'), text);
  };

const replaceDotGit = async (repo: string, make: (dotGit: string) => Promise<void>) => {
  const dotGit = path.join(repo, 'sub', '.git');
  await removeTree(dotGit, { force: true });
  await make(dotGit);
};

/** The submodule's `.git` replaced by a symlink to nothing, beside an edited file. */
const danglingDotGit: Setup = async (repo, upstream) => {
  await withSubmodule(repo, upstream);
  await replaceDotGit(repo, (dotGit) => symlink(`${repo}-nowhere`, dotGit));
  await writeFiles(repo, { k: 'k2\n' });
};

/** The submodule's `.git` replaced by a symlink to itself, beside an edited file. */
const selfLoopingDotGit: Setup = async (repo, upstream) => {
  await withSubmodule(repo, upstream);
  await replaceDotGit(repo, (dotGit) => symlink('.git', dotGit));
  await writeFiles(repo, { k: 'k2\n' });
};

/** The reftable embedded repository that moved, its stack then damaged by `damage`. */
const reftableStackDamagedBy =
  (damage: (stack: string, table: string) => Promise<void>): Setup =>
  async (repo, upstream) => {
    await embeddedReftable(repo, upstream);
    const stack = path.join(repo, 'sub', '.git', 'reftable');
    const [table] = (await readdir(stack)).filter((name) => name.endsWith('.ref'));
    await damage(stack, path.join(stack, table as string));
  };

const damagedStackList = (body: string) =>
  reftableStackDamagedBy((stack) => writeFile(path.join(stack, 'tables.list'), body));

/** The embedded repository that moved, its `main` branch a symlink to a file that holds no ref. */
const looseRefLinkedToContent: Setup = async (repo, upstream) => {
  await embedded(repo, upstream);
  const branch = path.join(repo, 'sub', '.git', 'refs', 'heads', 'main');
  await removeTree(branch);
  await symlink(path.join(repo, 'k'), branch);
};

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'add over a gitlink whose submodule checkout moved',
  () => {
    let root = '';
    let counter = 0;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-add-gitlink-')));
    });

    afterAll(async () => {
      await removeTree(root, { recursive: true, force: true });
    });

    const twins = async (setup: Setup) => {
      counter += 1;
      const upstream = path.join(root, `up-${counter}`);
      runGit(['init', '-q', '-b', 'main', upstream]);
      commitIn(upstream, 'up');
      const gitRepo = path.join(root, `git-${counter}`);
      const tsgitRepo = path.join(root, `tsgit-${counter}`);
      for (const repo of [gitRepo, tsgitRepo]) {
        runGit(['init', '-q', '-b', 'main', repo]);
        await setup(repo, upstream);
      }
      return { gitRepo, tsgitRepo };
    };

    const indexOf = (repo: string): string => runGit(['-C', repo, 'ls-files', '-s']);

    const looseCountOf = async (repo: string): Promise<number> => {
      const prefixes = (await readdir(path.join(repo, '.git', 'objects'))).filter((name) =>
        /^[0-9a-f]{2}$/.test(name),
      );
      const counts = await Promise.all(
        prefixes.map(
          async (prefix) => (await readdir(path.join(repo, '.git', 'objects', prefix))).length,
        ),
      );
      return counts.reduce((sum, count) => sum + count, 0);
    };

    const verbose = (repo: string): string => runGit(['-C', repo, 'ls-files', '-v']);

    describe.each([
      { label: 'a moved submodule, added by dot', setup: moved, spec: ['.'] },
      { label: 'a moved submodule, added by name', setup: moved, spec: ['sub'] },
      { label: 'a moved submodule, added by wildcard', setup: moved, spec: ['s*'] },
      { label: 'a moved submodule, added by name and slash', setup: moved, spec: ['sub/'] },
      {
        label: 'a moved submodule and an edited file, added by name',
        setup: movedAndEdited,
        spec: ['sub', 'k'],
      },
      {
        label: 'a moved submodule an ignore rule names, added by dot',
        setup: movedAndIgnored,
        spec: ['.'],
      },
      {
        label: 'a moved submodule an ignore rule names, added by name',
        setup: movedAndIgnored,
        spec: ['sub'],
      },
      {
        label: 'a moved submodule an ignore rule names, added by wildcard',
        setup: movedAndIgnored,
        spec: ['s*'],
      },
      { label: 'a submodule edited inside, added by dot', setup: editedInside, spec: ['.'] },
      { label: 'a submodule edited inside, added by name', setup: editedInside, spec: ['sub'] },
      { label: 'a submodule edited inside, added by wildcard', setup: editedInside, spec: ['s*'] },
      { label: 'an untouched submodule, added by dot', setup: withSubmodule, spec: ['.'] },
      { label: 'a deinitialised submodule, added by dot', setup: deinitialised, spec: ['.'] },
      {
        label: 'a submodule replaced by a file, added by dot',
        setup: replacedBy((sub) => writeFile(sub, 'f\n')),
        spec: ['.'],
      },
      {
        label: 'a submodule replaced by a symlink, added by dot',
        setup: replacedBy((sub) => symlink('k', sub)),
        spec: ['.'],
      },
      {
        label: 'a submodule replaced by a repository with no commit',
        setup: replacedBy(freshRepositoryInPlace),
        spec: ['.'],
      },
      { label: 'an embedded repository, added by dot', setup: embedded, spec: ['.'] },
      { label: 'an embedded repository, added by name', setup: embedded, spec: ['sub'] },
      {
        label: 'a submodule absorbed under another name',
        setup: movedUnderAnotherName,
        spec: ['.'],
      },
      {
        label: 'a submodule replaced by an unrelated repository',
        setup: replacedBy(unrelatedRepositoryInPlace),
        spec: ['.'],
      },
      { label: 'a skip-worktree submodule that moved', setup: movedAndSkipped, spec: ['.'] },
      {
        label: 'a moved repository whose gitfile points outside the superproject',
        setup: movedGitdirReachedBy(outsideTheSuperproject, pointerTo),
        spec: ['.'],
      },
      {
        label: 'a moved repository whose .git is a symlink into the git directory',
        setup: movedGitdirReachedBy(insideTheGitDir, linkTo),
        spec: ['.'],
      },
      {
        label: 'a moved repository whose .git is a symlink outside the superproject',
        setup: movedGitdirReachedBy(outsideTheSuperproject, linkTo),
        spec: ['.'],
      },
      { label: 'a dangling .git symlink, added by dot', setup: danglingDotGit, spec: ['.'] },
      {
        label: 'a dangling .git symlink, added by name and a file',
        setup: danglingDotGit,
        spec: ['k', 'sub'],
      },
      {
        label: 'a .git that is a gitfile to a linked worktree whose branch moved, added by dot',
        setup: linkedWorktreeCheckout,
        spec: ['.'],
      },
      {
        label: 'a .git that is a gitfile to a linked worktree whose branch moved, added by name',
        setup: linkedWorktreeCheckout,
        spec: ['sub'],
      },
      {
        label:
          'a .git that is a gitfile to a linked worktree of a reftable repository, added by dot',
        setup: linkedReftableWorktreeCheckout,
        spec: ['.'],
      },
      {
        label:
          'a .git that is a gitfile to a linked worktree of a reftable repository, added by name',
        setup: linkedReftableWorktreeCheckout,
        spec: ['sub'],
      },
      {
        label: 'an embedded repository on reftable that moved',
        setup: embeddedReftable,
        spec: ['.'],
      },
      { label: 'a self-looping .git symlink, added by dot', setup: selfLoopingDotGit, spec: ['.'] },
      {
        label: 'a self-looping .git symlink, added by name and a file',
        setup: selfLoopingDotGit,
        spec: ['k', 'sub'],
      },
      {
        label: 'a reftable stack naming a missing table, added by dot',
        setup: damagedStackList('0x000000000001-0x000000000009-deadbeef.ref\n'),
        spec: ['.'],
      },
      {
        label: 'a reftable stack naming a missing table, added by name',
        setup: damagedStackList('0x000000000001-0x000000000009-deadbeef.ref\n'),
        spec: ['sub'],
      },
      {
        label: 'a reftable stack list that is garbage',
        setup: damagedStackList('garbage\n'),
        spec: ['.'],
      },
      {
        label: 'a reftable table of four bytes',
        setup: reftableStackDamagedBy((_stack, table) => writeFile(table, 'REFT')),
        spec: ['.'],
      },
      {
        label: 'a loose ref that is a symlink to something holding no ref',
        setup: looseRefLinkedToContent,
        spec: ['.'],
      },
      {
        label: 'a gitlink under a symlinked parent, added by wildcard',
        setup: behindSymlinkedParent,
        spec: ['*sub'],
      },
      {
        label: 'a gitlink under a symlinked parent, added by dot',
        setup: behindSymlinkedParent,
        spec: ['.'],
      },
    ])('Given $label', ({ setup, spec }) => {
      describe('When git and tsgit add it', () => {
        it('Then both leave the same index and exit status', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins(setup);
          const sut = add;

          // Act
          const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', '--', ...spec]);
          await sut(createNodeContext({ workDir: tsgitRepo }), spec);

          // Assert
          expect(gitRun.exitCode).toBe(0);
          expect(indexOf(tsgitRepo)).toBe(indexOf(gitRepo));
          expect(verbose(tsgitRepo)).toBe(verbose(gitRepo));
        });
      });
    });

    describe.each([
      {
        label: 'a symlink to a repository, added by dot',
        setup: symlinkedToRepository,
        spec: ['.'],
      },
      {
        label: 'a symlink to a repository, added by name',
        setup: symlinkedToRepository,
        spec: ['sub'],
      },
      { label: 'a symlink to a gitfile, added by dot', setup: symlinkedToGitfile, spec: ['.'] },
      { label: 'no .git at all, added by dot', setup: withoutDotGit, spec: ['.'] },
    ])('Given a recorded gitlink holding committed files behind $label', ({ setup, spec }) => {
      describe('When git and tsgit add it', () => {
        it('Then both keep the gitlink alone and write the same objects', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins(setup);
          const looseBefore = await looseCountOf(gitRepo);
          const sut = add;

          // Act
          const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', '--', ...spec]);
          await sut(createNodeContext({ workDir: tsgitRepo }), spec);

          // Assert
          expect(gitRun.exitCode).toBe(0);
          expect(indexOf(tsgitRepo)).toBe(indexOf(gitRepo));
          expect(await looseCountOf(tsgitRepo)).toBe(await looseCountOf(gitRepo));
          expect(await looseCountOf(gitRepo)).toBe(looseBefore);
        });
      });
    });

    describe.each([
      { label: 'the whole tree minus the submodule', gitSpec: ['.', ':!sub'], spec: ['.', '!sub'] },
      { label: 'the submodule minus itself', gitSpec: ['sub', ':!sub'], spec: ['sub', '!sub'] },
    ])('Given a moved submodule and $label', ({ gitSpec, spec }) => {
      describe('When git and tsgit add it', () => {
        it('Then both leave the gitlink as recorded and exit cleanly', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins(moved);
          const recorded = indexOf(gitRepo);
          const sut = add;

          // Act
          const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', '--', ...gitSpec]);
          await sut(createNodeContext({ workDir: tsgitRepo }), spec);

          // Assert
          expect(gitRun.exitCode).toBe(0);
          expect(indexOf(gitRepo)).toBe(recorded);
          expect(indexOf(tsgitRepo)).toBe(indexOf(gitRepo));
        });
      });
    });

    describe('Given a moved submodule', () => {
      describe('When git and tsgit add all', () => {
        it('Then both stage the gitlink at the new commit', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins(moved);
          const sut = add;

          // Act
          runGit(['-C', gitRepo, 'add', '-A']);
          await sut(createNodeContext({ workDir: tsgitRepo }), [], { all: true });

          // Assert
          expect(indexOf(tsgitRepo)).toBe(indexOf(gitRepo));
        });
      });
    });

    describe('Given a moved submodule an ignore rule names', () => {
      describe('When git and tsgit add all', () => {
        it('Then both stage the gitlink at the new commit', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins(movedAndIgnored);
          const sut = add;

          // Act
          runGit(['-C', gitRepo, 'add', '-A']);
          await sut(createNodeContext({ workDir: tsgitRepo }), [], { all: true });

          // Assert
          expect(indexOf(tsgitRepo)).toBe(indexOf(gitRepo));
        });
      });
    });

    describe('Given a moved submodule', () => {
      describe('When git and tsgit renormalize the whole tree', () => {
        it('Then neither restages the gitlink', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins(moved);
          const sut = add;

          // Act
          runGit(['-C', gitRepo, 'add', '--renormalize', '.']);
          await sut(createNodeContext({ workDir: tsgitRepo }), ['.'], { renormalize: true });

          // Assert
          expect(indexOf(tsgitRepo)).toBe(indexOf(gitRepo));
        });
      });
    });

    describe.each([
      {
        label: 'a pointer to a gitdir that does not exist',
        setup: pointAt(() => '../.git/modules/nowhere'),
        line: notARepository,
      },
      {
        label: 'a module whose HEAD is garbage',
        setup: brokenBy((repo) =>
          writeFile(path.join(repo, '.git', 'modules', 'sub', 'HEAD'), 'garbage\n'),
        ),
        line: notARepository,
      },
      {
        label: 'a gitfile that does not parse',
        setup: brokenBy((repo) => writeFile(path.join(repo, 'sub', '.git'), 'garbage\n')),
        line: invalidGitfile,
      },
      {
        label: 'an empty .git directory',
        setup: brokenBy((repo) => replaceDotGit(repo, (dotGit) => mkdir(dotGit))),
        line: notRecognized,
      },
      {
        label: 'a .git directory whose HEAD is garbage',
        setup: brokenBy((repo) =>
          replaceDotGit(repo, async (dotGit) => {
            await mkdir(dotGit);
            await writeFile(path.join(dotGit, 'HEAD'), 'garbage\n');
          }),
        ),
        line: notRecognized,
      },
      {
        label: 'a .git symlink to a directory holding no HEAD',
        setup: brokenBy((repo) =>
          replaceDotGit(repo, async (dotGit) => {
            const target = `${repo}-empty-gitdir`;
            await mkdir(target);
            await symlink(target, dotGit);
          }),
        ),
        line: notRecognized,
      },
      {
        label: 'an absolute pointer to nothing',
        setup: pointAt((repo) => `${repo}-nowhere`),
        line: notARepository,
      },
    ])('Given $label and an untracked file', ({ setup, line }) => {
      describe('When git and tsgit add the whole tree', () => {
        it('Then both refuse, name the same path and leave the index alone', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins(setup);
          const before = indexOf(gitRepo);
          const looseBefore = await looseCountOf(gitRepo);
          const sut = add;

          // Act
          const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', '--', '.']);
          const refusal = await sut(createNodeContext({ workDir: tsgitRepo }), ['.']).then(
            () => undefined,
            (error: unknown) => (error instanceof TsgitError ? error.data : error),
          );

          // Assert
          expect(gitRun.exitCode).toBe(128);
          expect(refusal).toMatchObject({ code: 'NOT_A_REPOSITORY' });
          expect(gitRun.stderr).toBe(
            line((refusal as { path: string }).path.replace(tsgitRepo, gitRepo)),
          );
          expect(indexOf(gitRepo)).toBe(before);
          expect(indexOf(tsgitRepo)).toBe(before);
          expect(await looseCountOf(gitRepo)).toBe(looseBefore);
          expect(await looseCountOf(tsgitRepo)).toBe(looseBefore);
        });
      });
    });

    describe.skipIf(process.getuid?.() === 0)(
      'Given a moved repository whose refs/heads is unreadable',
      () => {
        const unreadable: string[] = [];

        afterEach(async () => {
          await Promise.all(unreadable.splice(0).map((dir) => chmod(dir, 0o755)));
        });

        describe.each([{ spec: ['.'] }, { spec: ['sub'] }])('And $spec is added', ({ spec }) => {
          describe('When git and tsgit add it', () => {
            it('Then both leave the gitlink as recorded and exit cleanly', async () => {
              // Arrange
              const { gitRepo, tsgitRepo } = await twins(async (repo, upstream) => {
                await embedded(repo, upstream);
                const heads = path.join(repo, 'sub', '.git', 'refs', 'heads');
                await chmod(heads, 0o000);
                unreadable.push(heads);
              });
              const sut = add;

              // Act
              const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', '--', ...spec]);
              await sut(createNodeContext({ workDir: tsgitRepo }), spec);

              // Assert
              expect(gitRun.exitCode).toBe(0);
              expect(indexOf(tsgitRepo)).toBe(indexOf(gitRepo));
            });
          });
        });
      },
    );

    describe.each([
      {
        label: 'a format version above 1',
        config: '[core]\n\trepositoryformatversion = 2\n',
        stderr: 'fatal: Expected git repo version <= 1, found 2\n',
        refusal: { code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED', version: 2 },
      },
      {
        label: 'an unknown extension at format version 1',
        config: `${FORMAT_1}[extensions]\n\tbogus = x\n`,
        stderr: 'fatal: unknown repository extension found:\n\tbogus\n',
        refusal: { code: 'REPOSITORY_EXTENSIONS_UNSUPPORTED', version: 1, extensions: ['bogus'] },
      },
      {
        label: 'a subsectioned ref storage at format version 1',
        config: `${FORMAT_1}[extensions "x"]\n\trefStorage = reftable\n`,
        stderr: 'fatal: unknown repository extension found:\n\tx.refstorage\n',
        refusal: {
          code: 'REPOSITORY_EXTENSIONS_UNSUPPORTED',
          version: 1,
          extensions: ['x.refstorage'],
        },
      },
      {
        label: 'an object format at format version 0',
        config: '[core]\n\trepositoryformatversion = 0\n[extensions]\n\tobjectFormat = sha1\n',
        stderr: 'fatal: repo version is 0, but v1-only extension found:\n\tobjectformat\n',
        refusal: {
          code: 'REPOSITORY_EXTENSIONS_UNSUPPORTED',
          version: 0,
          extensions: ['objectformat'],
        },
      },
    ])(
      'Given a submodule config holding $label and an untracked file',
      ({ config, stderr, refusal }) => {
        describe('When git and tsgit add the whole tree', () => {
          it('Then both refuse the repository format and leave the index and objects alone', async () => {
            // Arrange
            const { gitRepo, tsgitRepo } = await twins(withModuleConfig(config));
            const before = indexOf(gitRepo);
            const looseBefore = await looseCountOf(gitRepo);
            const sut = add;

            // Act
            const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', '--', '.']);
            const thrown = await sut(createNodeContext({ workDir: tsgitRepo }), ['.']).then(
              () => undefined,
              (error: unknown) => (error instanceof TsgitError ? error.data : error),
            );

            // Assert
            expect(gitRun.exitCode).toBe(128);
            expect(gitRun.stderr).toContain(stderr);
            expect(thrown).toEqual(refusal);
            expect(indexOf(tsgitRepo)).toBe(before);
            expect(await looseCountOf(tsgitRepo)).toBe(looseBefore);
          });
        });
      },
    );

    describe.each([
      {
        label: 'an unknown extension at format version 1',
        config: `${FORMAT_1}[extensions]\n\tbogus = x\n`,
        stderr: 'fatal: unknown repository extension found:\n\tbogus\n',
        refusal: { code: 'REPOSITORY_EXTENSIONS_UNSUPPORTED', version: 1, extensions: ['bogus'] },
      },
      {
        label: 'a format version above 1',
        config: '[core]\n\trepositoryformatversion = 2\n',
        stderr: 'fatal: Expected git repo version <= 1, found 2\n',
        refusal: { code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED', version: 2 },
      },
      {
        label: 'a v1-only extension at format version 0',
        config: '[extensions]\n\trefStorage = reftable\n',
        stderr: 'fatal: repo version is 0, but v1-only extension found:\n\trefstorage\n',
        refusal: {
          code: 'REPOSITORY_EXTENSIONS_UNSUPPORTED',
          version: 0,
          extensions: ['refstorage'],
        },
      },
    ])('Given a repository config holding $label', ({ config, stderr, refusal }) => {
      describe.each([
        { layout: 'an embedded repository', setup: embeddedWithConfig(config) },
        { layout: 'a linked worktree admin directory', setup: linkedWorktreeWithConfig(config) },
      ])('And $layout behind a moved gitlink', ({ setup }) => {
        describe('When git and tsgit add the whole tree', () => {
          it('Then both refuse the repository format and leave the index and objects alone', async () => {
            // Arrange
            const { gitRepo, tsgitRepo } = await twins(setup);
            await writeFiles(gitRepo, { n: 'untracked\n' });
            await writeFiles(tsgitRepo, { n: 'untracked\n' });
            const before = indexOf(gitRepo);
            const looseBefore = await looseCountOf(gitRepo);
            const sut = add;

            // Act
            const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', '--', '.']);
            const thrown = await sut(createNodeContext({ workDir: tsgitRepo }), ['.']).then(
              () => undefined,
              (error: unknown) => (error instanceof TsgitError ? error.data : error),
            );

            // Assert
            expect(gitRun.exitCode).toBe(128);
            expect(gitRun.stderr).toContain(stderr);
            expect(thrown).toEqual(refusal);
            expect(indexOf(gitRepo)).toBe(before);
            expect(indexOf(tsgitRepo)).toBe(before);
            expect(await looseCountOf(tsgitRepo)).toBe(looseBefore);
          });
        });
      });
    });

    describe.each([
      { label: 'a commondir naming nothing', setup: commondirNaming(() => '/nonexistent\n') },
      { label: 'a commondir naming the filesystem root', setup: commondirNaming(() => '/\n') },
      {
        label: 'a commondir naming an empty directory',
        setup: commondirNaming(
          (repo) => `${aSiblingDirectory('empty')(repo)}\n`,
          (repo) => mkdir(aSiblingDirectory('empty')(repo)),
        ),
      },
      {
        label: 'a commondir naming a directory with refs and no objects',
        setup: commondirNaming(
          (repo) => `${aSiblingDirectory('refs-only')(repo)}\n`,
          (repo) =>
            mkdir(path.join(aSiblingDirectory('refs-only')(repo), 'refs'), { recursive: true }),
        ),
      },
      {
        label: 'a commondir naming a directory with objects and no refs',
        setup: commondirNaming(
          (repo) => `${aSiblingDirectory('objects-only')(repo)}\n`,
          (repo) =>
            mkdir(path.join(aSiblingDirectory('objects-only')(repo), 'objects'), {
              recursive: true,
            }),
        ),
      },
      {
        label: 'a commondir naming a regular file',
        setup: commondirNaming(
          (repo) => `${aSiblingDirectory('file')(repo)}\n`,
          (repo) => writeFile(aSiblingDirectory('file')(repo), 'plain\n'),
        ),
      },
      {
        label: 'a module whose objects directory is missing',
        setup: brokenBy((repo) =>
          removeTree(path.join(moduleDirOf(repo), 'objects'), { recursive: true }),
        ),
      },
      {
        label: 'a module whose refs directory is missing',
        setup: brokenBy((repo) =>
          removeTree(path.join(moduleDirOf(repo), 'refs'), { recursive: true }),
        ),
      },
    ])('Given $label and an untracked file', ({ setup }) => {
      describe('When git and tsgit add the whole tree', () => {
        it('Then both refuse with the pointer as typed and leave the index and objects alone', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins(setup);
          const before = indexOf(gitRepo);
          const looseBefore = await looseCountOf(gitRepo);
          const sut = add;

          // Act
          const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', '--', '.']);
          const thrown = await sut(createNodeContext({ workDir: tsgitRepo }), ['.']).then(
            () => undefined,
            (error: unknown) => (error instanceof TsgitError ? error.data : error),
          );

          // Assert
          expect(gitRun.exitCode).toBe(128);
          expect(gitRun.stderr).toBe(notARepository(MODULE_POINTER));
          expect(thrown).toEqual({ code: 'NOT_A_REPOSITORY', path: MODULE_POINTER });
          expect(indexOf(tsgitRepo)).toBe(before);
          expect(await looseCountOf(tsgitRepo)).toBe(looseBefore);
        });
      });
    });

    describe('Given a commondir file of zero bytes and an untracked file', () => {
      describe('When git and tsgit add the whole tree', () => {
        it('Then both refuse and leave the index and objects alone', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins(commondirNaming(() => ''));
          const before = indexOf(gitRepo);
          const looseBefore = await looseCountOf(gitRepo);
          const sut = add;

          // Act
          const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', '--', '.']);
          const thrown = await sut(createNodeContext({ workDir: tsgitRepo }), ['.']).then(
            () => undefined,
            (error: unknown) => (error instanceof TsgitError ? error.data : error),
          );

          // Assert
          expect(gitRun.exitCode).toBe(128);
          expect(gitRun.stderr).toBe(
            `fatal: failed to read ${MODULE_POINTER}/commondir: No such file or directory\n`,
          );
          expect(thrown).toEqual({ code: 'NOT_A_REPOSITORY', path: MODULE_POINTER });
          expect(indexOf(tsgitRepo)).toBe(before);
          expect(await looseCountOf(tsgitRepo)).toBe(looseBefore);
        });
      });
    });

    describe('Given a commondir file holding a bare newline and an untracked file', () => {
      describe('When git and tsgit add the whole tree', () => {
        it('Then both ignore it, stage the untracked file and the moved gitlink alike', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins(commondirNaming(() => '\n'));
          const sut = add;

          // Act
          const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', '--', '.']);
          await sut(createNodeContext({ workDir: tsgitRepo }), ['.']);

          // Assert
          expect(gitRun.exitCode).toBe(0);
          expect(indexOf(tsgitRepo)).toBe(indexOf(gitRepo));
        });
      });
    });

    describe.each(CONFIG_ERROR_ROWS)(
      'Given a submodule config holding $label and an untracked file',
      ({ config, refusal }) => {
        describe('When git and tsgit add the whole tree', () => {
          it('Then both refuse with the config error and leave the index and objects alone', async () => {
            // Arrange
            const { gitRepo, tsgitRepo } = await twins(withModuleConfig(config));
            const before = indexOf(gitRepo);
            const looseBefore = await looseCountOf(gitRepo);
            const precedingLines = await linesBefore(moduleConfigOf(tsgitRepo), config);
            const expected =
              'line' in refusal ? { ...refusal, line: refusal.line + precedingLines } : refusal;
            const sut = add;

            // Act
            const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', '--', '.']);
            const thrown = await sut(createNodeContext({ workDir: tsgitRepo }), ['.']).then(
              () => undefined,
              (error: unknown) => (error instanceof TsgitError ? error.data : error),
            );

            // Assert
            expect(gitRun.exitCode).toBe(128);
            expect(thrown).toEqual({ ...expected, source: moduleConfigOf(tsgitRepo) });
            expect(gitRun.stderr).toBe(gitConfigErrorOf(expected, moduleConfigOf(gitRepo)));
            expect(indexOf(gitRepo)).toBe(before);
            expect(indexOf(tsgitRepo)).toBe(before);
            expect(await looseCountOf(gitRepo)).toBe(looseBefore);
            expect(await looseCountOf(tsgitRepo)).toBe(looseBefore);
          });
        });
      },
    );

    describe('Given a submodule config naming a ref storage at format version 0 and an untracked file', () => {
      describe('When git and tsgit add the whole tree', () => {
        it('Then both refuse the v1-only extension and leave the index and objects alone', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins(
            withModuleConfig('[extensions]\n\trefStorage = reftable\n'),
          );
          const before = indexOf(gitRepo);
          const looseBefore = await looseCountOf(gitRepo);
          const sut = add;

          // Act
          const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', '--', '.']);
          const refusal = await sut(createNodeContext({ workDir: tsgitRepo }), ['.']).then(
            () => undefined,
            (error: unknown) => (error instanceof TsgitError ? error.data : error),
          );

          // Assert
          expect(gitRun.exitCode).toBe(128);
          expect(gitRun.stderr).toContain(
            'fatal: repo version is 0, but v1-only extension found:\n\trefstorage\n',
          );
          expect(refusal).toEqual({
            code: 'REPOSITORY_EXTENSIONS_UNSUPPORTED',
            version: 0,
            extensions: ['refstorage'],
          });
          expect(indexOf(tsgitRepo)).toBe(before);
          expect(await looseCountOf(tsgitRepo)).toBe(looseBefore);
        });
      });
    });

    describe.each([{ spec: ['k'] }, { spec: ['k*'] }])(
      'Given a broken submodule and an edited file added as $spec',
      ({ spec }) => {
        describe('When git and tsgit add it', () => {
          it('Then both stage the file and neither refuses', async () => {
            // Arrange
            const setup = brokenBy(async (repo) => {
              await writeFile(path.join(repo, '.git', 'modules', 'sub', 'HEAD'), 'garbage\n');
              await writeFiles(repo, { k: 'k2\n' });
            });
            const { gitRepo, tsgitRepo } = await twins(setup);
            const sut = add;

            // Act
            const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', '--', ...spec]);
            await sut(createNodeContext({ workDir: tsgitRepo }), spec);

            // Assert
            expect(gitRun.exitCode).toBe(0);
            expect(indexOf(tsgitRepo)).toBe(indexOf(gitRepo));
          });
        });
      },
    );
  },
);
