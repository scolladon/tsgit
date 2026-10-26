/**
 * Cross-tool interop — what a pull merges. git's `pull` fetches, then merges
 * the refs `FETCH_HEAD` marks for merging under `fmt_merge_msg`'s title — the
 * shortened url, and ` into <branch>` unless the branch is `main` or `master`.
 * A pull with nothing marked refuses after its fetch. tsgit pulls through
 * `git http-backend`, git over a local path; with the url each tool records
 * swapped for one, the merge commits agree byte for byte.
 *
 * @proves
 *   surface:        pull
 *   bucket:         cross-tool-interop
 *   unique:         pull merges the FETCH_HEAD merge heads under git's merge message
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { pull } from '../../src/application/commands/pull.js';
import { errorDataCode } from '../../src/domain/error-data-code.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { backendTransport } from './http-backend-transport.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';
import {
  buildHistory,
  danglingLinkAt,
  directoryHolding,
  fileAt,
  ignoring,
  indexState,
  link1,
  listing,
  type Occupant,
  OK,
  type Outcome,
  outcomeOfTsgitRefusal,
  refusedUntracked,
  regular,
  replacing,
  runGitOutcome,
  symlink,
  type TreeEntry,
  v1,
} from './occupant-displacement-fixtures.js';

const PEER_URL = 'https://example.com/peer.git';
const SHORT_URL = 'https://example.com/peer';
const EPOCH = 1_700_000_000;
const IDENTITY: AuthorIdentity = {
  name: 't',
  email: 't@t',
  timestamp: EPOCH,
  timezoneOffset: '+0000',
};
const DATED_ENV = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_AUTHOR_DATE: `${EPOCH} +0000`,
  GIT_COMMITTER_DATE: `${EPOCH} +0000`,
};

let root: string;
let peerRoot: string;
let peerPath: string;

const dated = (args: ReadonlyArray<string>): string => runGit(args, { env: DATED_ENV });

beforeAll(() => {
  if (!GIT_AVAILABLE) return;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-pull-fetch-head-')));
  peerRoot = path.join(root, 'peer');
  peerPath = path.join(peerRoot, 'peer.git');
  const work = path.join(root, 'work');
  dated(['init', '-q', '-b', 'main', work]);
  dated(['-C', work, 'commit', '-q', '--allow-empty', '-m', 'a']);
  dated(['-C', work, 'checkout', '-q', '-b', 'side']);
  dated(['-C', work, 'commit', '-q', '--allow-empty', '-m', 'side']);
  dated(['-C', work, 'checkout', '-q', '-b', 'side2', 'main']);
  dated(['-C', work, 'commit', '-q', '--allow-empty', '-m', 'side2']);
  dated(['-C', work, 'checkout', '-q', '--orphan', 'root']);
  dated(['-C', work, 'commit', '-q', '--allow-empty', '-m', 'root']);
  dated(['-C', work, 'checkout', '-q', 'main']);
  const signed = `object ${git(work, 'rev-parse', 'side').trim()}\ntype commit\ntag st\ntagger T <t@x> ${EPOCH} +0000\n\nst body\n-----BEGIN PGP SIGNATURE-----\n\nAAAA\n-----END PGP SIGNATURE-----\n`;
  const tag = runGit(['-C', work, 'hash-object', '-t', 'tag', '-w', '--literally', '--stdin'], {
    input: signed,
  });
  dated(['-C', work, 'update-ref', 'refs/tags/st', tag.trim()]);
  dated(['clone', '-q', '--bare', work, peerPath]);
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/** One clone per tool, on `branch` with a local commit, configured alike but for the url. */
const setUp = (label: string, branch: string, config: ReadonlyArray<readonly [string, string]>) => {
  const dirs = {
    ours: path.join(root, `${label}-ours`),
    theirs: path.join(root, `${label}-theirs`),
  };
  for (const [dir, url] of [
    [dirs.ours, PEER_URL],
    [dirs.theirs, peerPath],
  ] as const) {
    dated(['clone', '-q', '-b', 'main', peerPath, dir]);
    dated(['-C', dir, 'remote', 'set-url', 'origin', url]);
    dated(['-C', dir, 'checkout', '-q', '-B', branch]);
    dated(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'local']);
    const seen = new Set<string>();
    for (const [key, value] of config) {
      dated(['-C', dir, 'config', ...(seen.has(key) ? ['--add'] : []), key, value]);
      seen.add(key);
    }
  }
  return dirs;
};

const head = (dir: string): string => git(dir, 'cat-file', 'commit', 'HEAD');

describe.skipIf(!GIT_AVAILABLE)('pull FETCH_HEAD interop', () => {
  describe.each([
    {
      label: 'upstream-main',
      branch: 'main',
      config: [
        ['branch.main.remote', 'origin'],
        ['branch.main.merge', 'refs/heads/side'],
      ],
    },
    {
      label: 'upstream-feat',
      branch: 'feat',
      config: [
        ['branch.feat.remote', 'origin'],
        ['branch.feat.merge', 'refs/heads/side'],
      ],
    },
    {
      label: 'mirrored',
      branch: 'main',
      config: [
        ['remote.origin.fetch', '+refs/heads/*:refs/remotes/mirror/*'],
        ['branch.main.remote', 'origin'],
        ['branch.main.merge', 'refs/heads/side'],
      ],
    },
    {
      label: 'octopus',
      branch: 'main',
      config: [
        ['branch.main.remote', 'origin'],
        ['branch.main.merge', 'refs/heads/side'],
        ['branch.main.merge', 'refs/heads/side2'],
      ],
    },
    {
      label: 'reduced-to-one',
      branch: 'main',
      config: [
        ['branch.main.remote', 'origin'],
        ['branch.main.merge', 'refs/heads/main'],
        ['branch.main.merge', 'refs/heads/side'],
      ],
    },
    {
      label: 'signed-tag',
      branch: 'main',
      config: [
        ['branch.main.remote', 'origin'],
        ['branch.main.merge', 'refs/tags/st'],
        ['gpg.program', 'false'],
      ],
    },
    {
      label: 'suppressed-feat',
      branch: 'feat',
      config: [
        ['branch.feat.remote', 'origin'],
        ['branch.feat.merge', 'refs/heads/side'],
        ['merge.suppressDest', 'fe*'],
      ],
    },
  ] as ReadonlyArray<{
    label: string;
    branch: string;
    config: ReadonlyArray<readonly [string, string]>;
  }>)('Given the $label upstream', ({ label, branch, config }) => {
    describe('When both tools pull', () => {
      it('Then the merge commits and their reflog notes agree', async () => {
        // Arrange
        const { ours, theirs } = setUp(label, branch, config);
        const ctx = {
          ...createNodeContext({ workDir: ours }),
          transport: backendTransport(peerRoot),
        };
        const sut = pull;
        dated(['-C', theirs, 'pull', '-q', '--no-rebase', '--no-edit']);
        const expected = head(theirs).replaceAll(peerPath.slice(0, -'.git'.length), SHORT_URL);

        // Act
        await sut(ctx, { rebase: false, author: IDENTITY, committer: IDENTITY });

        // Assert
        expect(head(ours)).toBe(expected);
        const note = (dir: string) =>
          git(dir, 'reflog', '-1', '--format=%gs', 'HEAD').split(': ').slice(1).join(': ');
        expect(note(ours)).toBe(note(theirs));
      });
    });
  });

  describe('Given a non-forcing fetch refspec and a tracking ref the fetched upstream does not descend from', () => {
    describe('When both tools pull', () => {
      it('Then both refuse before merging and leave the same refs', async () => {
        // Arrange
        const { ours, theirs } = setUp('rejected', 'main', [
          ['remote.origin.fetch', 'refs/heads/*:refs/remotes/origin/*'],
          ['branch.main.remote', 'origin'],
          ['branch.main.merge', 'refs/heads/side'],
        ]);
        for (const dir of [ours, theirs]) {
          dated(['-C', dir, 'update-ref', 'refs/remotes/origin/side', 'HEAD']);
        }
        const ctx = {
          ...createNodeContext({ workDir: ours }),
          transport: backendTransport(peerRoot),
        };
        const sut = pull;
        const theirsRun = tryRunGitWithExit(
          ['-C', theirs, 'pull', '-q', '--no-rebase', '--no-edit'],
          {
            env: DATED_ENV,
          },
        );
        let caught: unknown;

        // Act
        try {
          await sut(ctx, { rebase: false, author: IDENTITY, committer: IDENTITY });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(theirsRun.exitCode).toBe(1);
        expect((caught as { data?: { code?: string } }).data?.code).toBe('FETCH_REJECTED');
        const refs = (dir: string) => git(dir, 'for-each-ref', '--format=%(refname) %(objectname)');
        expect(refs(ours)).toBe(refs(theirs));
        expect(existsSync(path.join(ours, '.git', 'MERGE_HEAD'))).toBe(false);
        expect(existsSync(path.join(theirs, '.git', 'MERGE_HEAD'))).toBe(false);
      });
    });
  });

  describe('Given an upstream sharing no history with the branch', () => {
    const UNRELATED = [
      ['branch.main.remote', 'origin'],
      ['branch.main.merge', 'refs/heads/root'],
    ] as const;
    const ctxFor = (ours: string) => ({
      ...createNodeContext({ workDir: ours }),
      transport: backendTransport(peerRoot),
    });
    const origHead = (dir: string): string | undefined => {
      const file = path.join(dir, '.git', 'ORIG_HEAD');
      return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    };

    describe.each([
      { label: 'unrelated', flags: [], opts: {}, code: 'UNRELATED_HISTORIES', config: UNRELATED },
      {
        label: 'unrelated-ff-only',
        flags: ['--ff-only'],
        opts: { fastForward: 'only' },
        code: 'NON_FAST_FORWARD',
        config: UNRELATED,
      },
      {
        label: 'two-heads-ff-only',
        flags: ['--ff-only'],
        opts: { fastForward: 'only' },
        code: 'FAST_FORWARD_MULTIPLE_BRANCHES',
        config: [...UNRELATED, ['branch.main.merge', 'refs/heads/side']],
      },
    ] as const)(
      'When both tools pull the $label upstream',
      ({ label, flags, opts, code, config }) => {
        it('Then both refuse and leave ORIG_HEAD alike', async () => {
          // Arrange
          const { ours, theirs } = setUp(label, 'main', config);
          const theirsRun = tryRunGitWithExit(
            ['-C', theirs, 'pull', '-q', '--no-rebase', '--no-edit', ...flags],
            { env: DATED_ENV },
          );
          const sut = pull;

          // Act
          const result = await sut(ctxFor(ours), {
            ...opts,
            rebase: false,
            author: IDENTITY,
            committer: IDENTITY,
          })
            .then(() => undefined)
            .catch(errorDataCode);

          // Assert
          expect(theirsRun.exitCode).toBe(128);
          expect(result).toBe(code);
          expect(origHead(ours)).toBe(origHead(theirs));
        });
      },
    );

    describe('When both tools pull it allowing unrelated histories', () => {
      it('Then the merge commits agree', async () => {
        // Arrange
        const { ours, theirs } = setUp('unrelated-allowed', 'main', UNRELATED);
        dated([
          '-C',
          theirs,
          'pull',
          '-q',
          '--no-rebase',
          '--no-edit',
          '--allow-unrelated-histories',
        ]);
        const expected = head(theirs).replaceAll(peerPath.slice(0, -'.git'.length), SHORT_URL);
        const sut = pull;

        // Act
        await sut(ctxFor(ours), {
          rebase: false,
          allowUnrelatedHistories: true,
          author: IDENTITY,
          committer: IDENTITY,
        });

        // Assert
        expect(head(ours)).toBe(expected);
      });
    });
  });

  describe('Given an upstream bringing in a commit', () => {
    const SIDE = [
      ['branch.main.remote', 'origin'],
      ['branch.main.merge', 'refs/heads/side'],
    ] as const;

    describe.each([
      { label: 'log-flag', flags: ['--log'], opts: { log: true }, config: SIDE },
      { label: 'log-config', flags: [], opts: {}, config: [...SIDE, ['merge.log', '1']] },
    ] as const)(
      'When both tools pull it with a shortlog ($label)',
      ({ label, flags, opts, config }) => {
        it('Then the merge commits agree', async () => {
          // Arrange
          const { ours, theirs } = setUp(label, 'main', config);
          dated(['-C', theirs, 'pull', '-q', '--no-rebase', '--no-edit', ...flags]);
          const expected = head(theirs).replaceAll(peerPath.slice(0, -'.git'.length), SHORT_URL);
          const sut = pull;

          // Act
          await sut(
            { ...createNodeContext({ workDir: ours }), transport: backendTransport(peerRoot) },
            { ...opts, rebase: false, author: IDENTITY, committer: IDENTITY },
          );

          // Assert
          expect(head(ours)).toBe(expected);
        });
      },
    );
  });

  describe('Given fast-forward configuration', () => {
    const UPSTREAM = [
      ['branch.main.remote', 'origin'],
      ['branch.main.merge', 'refs/heads/side'],
    ] as const;
    const ctxFor = (ours: string) => ({
      ...createNodeContext({ workDir: ours }),
      transport: backendTransport(peerRoot),
    });
    /** Both clones without their local commit, so the upstream fast-forwards. */
    const dropLocal = (dirs: ReadonlyArray<string>) => {
      for (const dir of dirs) dated(['-C', dir, 'reset', '-q', '--hard', 'HEAD~1']);
    };

    describe.each([
      { label: 'merge-ff-false', ff: true, config: [['merge.ff', 'false']] },
      { label: 'pull-ff-false', ff: true, config: [['pull.ff', 'false']] },
      {
        label: 'pull-ff-true',
        ff: true,
        config: [
          ['merge.ff', 'false'],
          ['pull.ff', 'true'],
        ],
      },
      { label: 'pull-ff-only-diverged', ff: false, config: [['pull.ff', 'only']] },
    ] as const)('When both tools pull under $label', ({ label, ff, config }) => {
      it('Then the commits HEAD lands on and the reflog notes agree', async () => {
        // Arrange
        const { ours, theirs } = setUp(label, 'main', [...UPSTREAM, ...config]);
        if (ff) dropLocal([ours, theirs]);
        dated(['-C', theirs, 'pull', '-q', '--no-rebase', '--no-edit']);
        const expected = head(theirs).replaceAll(peerPath.slice(0, -'.git'.length), SHORT_URL);
        const sut = pull;

        // Act
        await sut(ctxFor(ours), { rebase: false, author: IDENTITY, committer: IDENTITY });

        // Assert
        expect(head(ours)).toBe(expected);
        const note = (dir: string) =>
          git(dir, 'reflog', '-1', '--format=%gs', 'HEAD').split(': ').slice(1).join(': ');
        expect(note(ours)).toBe(note(theirs));
      });
    });

    describe.each([
      { label: 'merge-ff-only-diverged', config: [['merge.ff', 'only']], code: 'NON_FAST_FORWARD' },
      { label: 'pull-ff-bogus', config: [['pull.ff', 'bogus']], code: 'CONFIG_INVALID_ENUM_VALUE' },
    ] as const)('When both tools pull under $label', ({ label, config, code }) => {
      it('Then both refuse and leave HEAD and FETCH_HEAD alike', async () => {
        // Arrange
        const { ours, theirs } = setUp(label, 'main', [...UPSTREAM, ...config]);
        const theirsRun = tryRunGitWithExit(
          ['-C', theirs, 'pull', '-q', '--no-rebase', '--no-edit'],
          { env: DATED_ENV },
        );
        const sut = pull;

        // Act
        const result = await sut(ctxFor(ours), {
          rebase: false,
          author: IDENTITY,
          committer: IDENTITY,
        })
          .then(() => undefined)
          .catch(errorDataCode);

        // Assert
        expect(theirsRun.exitCode).toBe(128);
        expect(result).toBe(code);
        expect(git(ours, 'rev-parse', 'HEAD')).toBe(git(theirs, 'rev-parse', 'HEAD'));
        const fetched = (dir: string) => existsSync(path.join(dir, '.git', 'FETCH_HEAD'));
        expect(fetched(ours)).toBe(fetched(theirs));
      });
    });
  });

  describe('Given a clone whose main the remote has advanced with a file change', () => {
    describe('When both tools pull origin main:main', () => {
      it('Then both warn and fast-forward the index and working tree to the fetched head', async () => {
        // Arrange
        const caseRoot = path.join(root, 'head-updated');
        const work = path.join(caseRoot, 'work');
        const bare = path.join(caseRoot, 'peer', 'peer.git');
        dated(['init', '-q', '-b', 'main', work]);
        writeFileSync(path.join(work, 'f'), 'old\n');
        dated(['-C', work, 'add', 'f']);
        dated(['-C', work, 'commit', '-q', '-m', 'a']);
        dated(['clone', '-q', '--bare', work, bare]);
        const dirs = { ours: path.join(caseRoot, 'ours'), theirs: path.join(caseRoot, 'theirs') };
        for (const [dir, url] of [
          [dirs.ours, PEER_URL],
          [dirs.theirs, bare],
        ] as const) {
          dated(['clone', '-q', bare, dir]);
          dated(['-C', dir, 'remote', 'set-url', 'origin', url]);
        }
        const orig = git(dirs.ours, 'rev-parse', 'HEAD').trim();
        writeFileSync(path.join(work, 'f'), 'new\n');
        dated(['-C', work, 'commit', '-q', '-am', 'b']);
        dated(['-C', work, 'push', '-q', bare, 'main']);
        const warnings: string[] = [];
        const ctx = {
          ...createNodeContext({ workDir: dirs.ours }),
          transport: backendTransport(path.join(caseRoot, 'peer')),
          logger: { warn: (message: string) => warnings.push(message) },
        };

        // Act
        await pull(ctx, {
          remote: 'origin',
          ref: 'main:main',
          author: IDENTITY,
          committer: IDENTITY,
        });
        const theirsRun = tryRunGitWithExit(['-C', dirs.theirs, 'pull', 'origin', 'main:main'], {
          env: DATED_ENV,
        });

        // Assert
        expect(theirsRun.exitCode).toBe(0);
        const gitWarning = theirsRun.stderr.slice(theirsRun.stderr.indexOf('warning: '));
        expect(`warning: ${warnings[0]}\n`).toBe(gitWarning);
        expect(gitWarning).toContain(`commit ${orig}.`);
        expect(git(dirs.ours, 'status', '--porcelain')).toBe('');
        expect(git(dirs.theirs, 'status', '--porcelain')).toBe('');
        const stage = (dir: string) => git(dir, 'ls-files', '-s');
        expect(stage(dirs.ours)).toBe(stage(dirs.theirs));
        expect(readFileSync(path.join(dirs.ours, 'f'), 'utf8')).toBe('new\n');
      });
    });
  });
});

/** The index an unborn repository starts from: none, one staged file, or a file with no entries. */
type UnbornIndex = 'absent' | 'staged' | 'empty-file';

describe.skipIf(!GIT_AVAILABLE)('pull into an unborn HEAD interop', () => {
  /** One fresh repository per tool with `main` unborn and set to pull `merge` from origin. */
  const unborn = (label: string, merges: ReadonlyArray<string>, index: UnbornIndex) => {
    const dirs = {
      ours: path.join(root, `${label}-ours`),
      theirs: path.join(root, `${label}-theirs`),
    };
    for (const [dir, url] of [
      [dirs.ours, PEER_URL],
      [dirs.theirs, peerPath],
    ] as const) {
      dated(['init', '-q', '-b', 'main', dir]);
      dated(['-C', dir, 'remote', 'add', 'origin', url]);
      dated(['-C', dir, 'config', 'branch.main.remote', 'origin']);
      for (const merge of merges) dated(['-C', dir, 'config', '--add', 'branch.main.merge', merge]);
      if (index === 'staged') {
        writeFileSync(path.join(dir, 'g'), 'g\n');
        dated(['-C', dir, 'add', 'g']);
      }
      if (index === 'empty-file') dated(['-C', dir, 'read-tree', '--empty']);
    }
    return dirs;
  };
  const ctxFor = (ours: string) => ({
    ...createNodeContext({ workDir: ours }),
    transport: backendTransport(peerRoot),
  });
  const state = (dir: string): string =>
    [
      git(dir, 'rev-parse', 'HEAD'),
      git(dir, 'reflog', '--format=%gs', 'HEAD'),
      git(dir, 'ls-files', '-s'),
      git(dir, 'status', '--porcelain'),
    ].join('\n');

  describe.each([
    { label: 'unborn-clean', index: 'absent' },
    { label: 'unborn-staged', index: 'staged' },
    { label: 'unborn-empty-index-merge', index: 'empty-file' },
  ] as const)('Given the $label repository', ({ label, index }) => {
    describe('When both tools pull', () => {
      it('Then both check the fetched head out on main under the reflog "initial pull"', async () => {
        // Arrange
        const { ours, theirs } = unborn(label, ['refs/heads/main'], index);
        dated(['-C', theirs, 'pull', '-q']);
        const sut = pull;

        // Act
        await sut(ctxFor(ours));

        // Assert
        expect(state(ours)).toBe(state(theirs));
      });
    });
  });

  describe.each([
    {
      label: 'unborn-two-merges',
      merges: ['refs/heads/main', 'refs/heads/side'],
      index: 'absent',
      rebase: false,
      code: 'PULL_EMPTY_HEAD_MULTIPLE_BRANCHES',
      message: 'fatal: Cannot merge multiple branches into empty head.',
    },
    {
      label: 'unborn-rebase-staged',
      merges: ['refs/heads/main'],
      index: 'staged',
      rebase: true,
      code: 'PULL_REBASE_UNBORN_INDEX',
      message: 'fatal: Updating an unborn branch with changes added to the index.',
    },
    {
      label: 'unborn-rebase-empty-index',
      merges: ['refs/heads/main'],
      index: 'empty-file',
      rebase: true,
      code: 'PULL_REBASE_UNBORN_INDEX',
      message: 'fatal: Updating an unborn branch with changes added to the index.',
    },
  ] as const)('Given the $label repository', ({ label, merges, index, rebase, code, message }) => {
    describe('When both tools pull', () => {
      it('Then both refuse and main stays unborn', async () => {
        // Arrange
        const { ours, theirs } = unborn(label, merges, index);
        const theirsRun = tryRunGitWithExit(
          ['-C', theirs, 'pull', '-q', rebase ? '--rebase' : '--no-rebase'],
          { env: DATED_ENV },
        );
        const sut = pull;
        let caught: unknown;

        // Act
        try {
          await sut(ctxFor(ours), { rebase });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(theirsRun.exitCode).toBe(128);
        expect(theirsRun.stderr).toContain(message);
        expect(errorDataCode(caught)).toBe(code);
        for (const dir of [ours, theirs]) {
          expect(existsSync(path.join(dir, '.git', 'refs', 'heads', 'main'))).toBe(false);
        }
      });
    });
  });
});

interface UnbornPullRow {
  readonly id: string;
  readonly tracked: ReadonlyArray<TreeEntry>;
  readonly due: ReadonlyArray<TreeEntry>;
  readonly occupant: Occupant;
  readonly git: Outcome;
}

const ignoredFile = (rel: string): Occupant => ignoring(rel, fileAt(rel));

const UNBORN_ADD_ROWS: ReadonlyArray<UnbornPullRow> = [
  { id: 'S1/add', due: [regular('d/x')], occupant: fileAt('d'), git: refusedUntracked('d') },
  {
    id: 'S2/add',
    due: [regular('f')],
    occupant: directoryHolding('f', 'u'),
    git: refusedUntracked('f'),
  },
  {
    id: 'S3a/add',
    due: [regular('d/x')],
    occupant: danglingLinkAt('d'),
    git: refusedUntracked('d'),
  },
  { id: 'S3b/add', due: [regular('f')], occupant: danglingLinkAt('f'), git: refusedUntracked('f') },
  {
    id: 'S3c/add',
    due: [symlink('l')],
    occupant: directoryHolding('l', 'u'),
    git: refusedUntracked('l'),
  },
  { id: 'S3d/add', due: [symlink('d/l')], occupant: fileAt('d'), git: refusedUntracked('d') },
  {
    id: 'S3e/add',
    due: [symlink('d/l')],
    occupant: danglingLinkAt('d'),
    git: refusedUntracked('d'),
  },
  { id: 'S3f/add', due: [symlink('f')], occupant: fileAt('f'), git: refusedUntracked('f') },
  { id: 'I1/add', due: [regular('d/x')], occupant: ignoredFile('d'), git: refusedUntracked('d') },
  {
    id: 'I2/add',
    due: [regular('f')],
    occupant: ignoring('f/u', directoryHolding('f', 'u')),
    git: refusedUntracked('f'),
  },
  {
    id: 'I3/add',
    due: [regular('d/x')],
    occupant: ignoring('d', danglingLinkAt('d')),
    git: refusedUntracked('d'),
  },
  { id: 'I4/add', due: [symlink('d/l')], occupant: ignoredFile('d'), git: refusedUntracked('d') },
  {
    id: 'I5/add',
    due: [symlink('l')],
    occupant: ignoring('l/u', directoryHolding('l', 'u')),
    git: refusedUntracked('l'),
  },
  { id: 'I6/add', due: [regular('f')], occupant: ignoredFile('f'), git: refusedUntracked('f') },
].map((row) => ({ ...row, tracked: [] }));

const UNBORN_UPDATE_ROWS: ReadonlyArray<UnbornPullRow> = [
  {
    id: 'S1/update',
    tracked: [v1('d/x')],
    due: [regular('d/x')],
    occupant: replacing('d/x', fileAt('d')),
    git: refusedUntracked('d'),
  },
  {
    id: 'S2/update',
    tracked: [v1('f')],
    due: [regular('f')],
    occupant: replacing('f', directoryHolding('f', 'u')),
    git: refusedUntracked('f'),
  },
  {
    id: 'S3a/update',
    tracked: [v1('d/x')],
    due: [regular('d/x')],
    occupant: replacing('d/x', danglingLinkAt('d')),
    git: refusedUntracked('d'),
  },
  {
    id: 'S3b/update',
    tracked: [v1('f')],
    due: [regular('f')],
    occupant: replacing('f', danglingLinkAt('f')),
    git: refusedUntracked('f'),
  },
  {
    id: 'S3c/update',
    tracked: [link1('l')],
    due: [symlink('l')],
    occupant: replacing('l', directoryHolding('l', 'u')),
    git: refusedUntracked('l'),
  },
  {
    id: 'S3d/update',
    tracked: [link1('d/l')],
    due: [symlink('d/l')],
    occupant: replacing('d/l', fileAt('d')),
    git: refusedUntracked('d'),
  },
  {
    id: 'S3e/update',
    tracked: [link1('d/l')],
    due: [symlink('d/l')],
    occupant: replacing('d/l', danglingLinkAt('d')),
    git: refusedUntracked('d'),
  },
  {
    id: 'S3f/update',
    tracked: [link1('f')],
    due: [symlink('f')],
    occupant: replacing('f', fileAt('f')),
    git: refusedUntracked('f'),
  },
  {
    id: 'I1/update',
    tracked: [v1('d/x')],
    due: [regular('d/x')],
    occupant: replacing('d/x', ignoredFile('d')),
    git: refusedUntracked('d'),
  },
  {
    id: 'I2/update',
    tracked: [v1('f')],
    due: [regular('f')],
    occupant: replacing('f', ignoring('f/u', directoryHolding('f', 'u'))),
    git: refusedUntracked('f'),
  },
  {
    id: 'I3/update',
    tracked: [v1('d/x')],
    due: [regular('d/x')],
    occupant: replacing('d/x', ignoring('d', danglingLinkAt('d'))),
    git: refusedUntracked('d'),
  },
  {
    id: 'I4/update',
    tracked: [link1('d/l')],
    due: [symlink('d/l')],
    occupant: replacing('d/l', ignoredFile('d')),
    git: refusedUntracked('d'),
  },
  {
    id: 'I5/update',
    tracked: [link1('l')],
    due: [symlink('l')],
    occupant: replacing('l', ignoring('l/u', directoryHolding('l', 'u'))),
    git: refusedUntracked('l'),
  },
];

const UNBORN_DELETE_ROWS: ReadonlyArray<UnbornPullRow> = [
  {
    id: 'D1/delete',
    tracked: [v1('d/x')],
    due: [],
    occupant: replacing('d/x', fileAt('d')),
    git: OK,
  },
  {
    id: 'D2/delete',
    tracked: [v1('f')],
    due: [],
    occupant: replacing('f', directoryHolding('f', 'u')),
    git: OK,
  },
  {
    id: 'D3/delete',
    tracked: [link1('l')],
    due: [],
    occupant: replacing('l', directoryHolding('l', 'u')),
    git: OK,
  },
  {
    id: 'D4/delete',
    tracked: [link1('d/l')],
    due: [],
    occupant: replacing('d/l', fileAt('d')),
    git: OK,
  },
];

const UNBORN_PULL_ROWS = [...UNBORN_ADD_ROWS, ...UNBORN_UPDATE_ROWS, ...UNBORN_DELETE_ROWS];

const outcomeOfTsgitPull = (err: unknown): Outcome =>
  outcomeOfTsgitRefusal(err, 'WORKING_TREE_DIRTY');

describe.skipIf(!GIT_AVAILABLE)('pull into an unborn branch over an occupant interop', () => {
  describe.each(UNBORN_PULL_ROWS)('Given the $id occupant', (row) => {
    describe('When both tools pull self t into an unborn branch', () => {
      it('Then the outcome, work tree and index match git', async () => {
        // Arrange
        const caseRoot = path.join(root, `unborn-occupant-${row.id.replace('/', '-')}`);
        const serveRoot = path.join(caseRoot, 'serve');
        const dirs = { ours: path.join(caseRoot, 'ours'), theirs: path.join(caseRoot, 'theirs') };
        for (const dir of Object.values(dirs)) {
          dated(['init', '-q', '-b', 'main', dir]);
          buildHistory(dir, row.due, row.tracked);
        }
        dated(['clone', '-q', '--bare', dirs.ours, path.join(serveRoot, 'self.git')]);
        dated(['-C', dirs.ours, 'remote', 'add', 'self', 'https://example.com/self.git']);
        dated(['-C', dirs.theirs, 'remote', 'add', 'self', path.join(serveRoot, 'self.git')]);
        for (const dir of Object.values(dirs)) {
          dated(['-C', dir, 'symbolic-ref', 'HEAD', 'refs/heads/fresh']);
          rmSync(path.join(dir, '.git', 'index'));
          rmSync(path.join(dir, 'keep'));
          row.occupant(dir);
          writeFileSync(path.join(dir, 'other'), 'o\n');
        }
        const ctx = {
          ...createNodeContext({ workDir: dirs.ours }),
          transport: backendTransport(serveRoot),
        };
        const sut = pull;

        // Act
        const expected = runGitOutcome(
          dirs.theirs,
          ['pull', '-q', '--no-rebase', '--no-edit', 'self', 't'],
          1,
        );
        const result = await sut(ctx, {
          remote: 'self',
          ref: 't',
          rebase: false,
          author: IDENTITY,
          committer: IDENTITY,
        })
          .then((): Outcome => OK)
          .catch(outcomeOfTsgitPull);

        // Assert
        expect(expected).toEqual(row.git);
        expect(result).toEqual(expected);
        expect(listing(dirs.ours)).toEqual(listing(dirs.theirs));
        expect(indexState(dirs.ours)).toEqual(indexState(dirs.theirs));
      });
    });
  });
});
