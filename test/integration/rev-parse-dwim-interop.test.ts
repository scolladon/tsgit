/**
 * Cross-tool interop — `revParse`'s ref DWIM over a candidate git's reading
 * walk does not resolve: a symbolic chain deeper than its cap, a cycle, or a
 * dangling link. One repository is built once with canonical git; each row
 * runs `git rev-parse` and tsgit's `revParse` on the same argument against it
 * and compares the resolved object id, or that neither resolves.
 *
 * @proves
 *   surface:        revParse
 *   bucket:         cross-tool-interop
 *   unique:         ref DWIM skips a candidate git's reading walk cannot resolve and tries the next
 *   interopSurface: revParse
 */
import { writeFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { branchCreate } from '../../src/application/commands/branch.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { cherryPickRun } from '../../src/application/commands/cherry-pick.js';
import { diff } from '../../src/application/commands/diff.js';
import { log } from '../../src/application/commands/log.js';
import { nameRev } from '../../src/application/commands/name-rev.js';
import { packObjects } from '../../src/application/commands/pack-objects.js';
import { rangeDiff } from '../../src/application/commands/range-diff.js';
import { reset } from '../../src/application/commands/reset.js';
import { revList } from '../../src/application/commands/rev-list.js';
import { revParse } from '../../src/application/commands/rev-parse.js';
import { show } from '../../src/application/commands/show.js';
import { status } from '../../src/application/commands/status.js';
import { mergeBase } from '../../src/application/primitives/merge-base.js';
import type { TsgitError } from '../../src/domain/error.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import type { Context } from '../../src/ports/context.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  revParseStdout,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const IDENTITY_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A',
  GIT_AUTHOR_EMAIL: 'a@x',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'A',
  GIT_COMMITTER_EMAIL: 'a@x',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

/** `refs/<namespace>/<base>` and `hops - 1` further links, the last naming `tip`. */
const plantChain = (
  dir: string,
  namespace: string,
  base: string,
  hops: number,
  tip: string,
): void => {
  const link = (index: number): string =>
    `refs/${namespace}/${index === 0 ? base : `${base}-${index}`}`;
  for (let index = 0; index < hops; index += 1) {
    git(dir, 'symbolic-ref', link(index), link(index + 1));
  }
  git(dir, 'update-ref', link(hops), tip);
};

describe.skipIf(!GIT_AVAILABLE)('integration — revParse ref DWIM parity with canonical git', () => {
  let repo = '';
  let first = '';
  let second = '';
  const caseRoots: string[] = [];

  beforeAll(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rev-parse-dwim-interop-'));
    runGit(['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'commit.gpgsign', 'false');
    git(repo, 'config', 'tag.gpgsign', 'false');
    disableAutoMaintenance(repo);
    runGit(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'c1'], { env: IDENTITY_ENV });
    first = git(repo, 'rev-parse', 'HEAD').trim();
    runGit(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'c2'], { env: IDENTITY_ENV });
    second = git(repo, 'rev-parse', 'HEAD').trim();
    plantChain(repo, 'heads', 'x', 5, second);
    git(repo, 'update-ref', 'refs/tags/x', first);
    plantChain(repo, 'heads', 'four', 4, second);
    plantChain(repo, 'tags', 'y', 5, second);
    git(repo, 'update-ref', 'refs/heads/y', first);
    git(repo, 'symbolic-ref', 'refs/tags/cy', 'refs/tags/cy2');
    git(repo, 'symbolic-ref', 'refs/tags/cy2', 'refs/tags/cy');
    git(repo, 'update-ref', 'refs/heads/cy', first);
    git(repo, 'symbolic-ref', 'refs/tags/dg', 'refs/tags/nope');
    git(repo, 'update-ref', 'refs/heads/dg', first);
    // A short name two namespaces carry, the tag on the newer commit.
    git(repo, 'update-ref', 'refs/heads/amb', first);
    git(repo, 'update-ref', 'refs/tags/amb', second);
    // Hex-only branch names: too short to abbreviate an oid, and one that also abbreviates `first`.
    git(repo, 'update-ref', 'refs/heads/a2', second);
    git(repo, 'update-ref', `refs/heads/${first.slice(0, 4)}`, second);
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
    await Promise.all(
      caseRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  /** A private copy of the shared fixture, for the rows that write. */
  const caseRepo = async (slug: string): Promise<string> => {
    const root = await mkdtemp(path.join(os.tmpdir(), `tsgit-rev-parse-dwim-${slug}-`));
    caseRoots.push(root);
    const dir = path.join(root, 'repo');
    await cp(repo, dir, { recursive: true });
    return dir;
  };

  describe('Given candidates git skips ahead of one it resolves', () => {
    describe('When git rev-parse and revParse resolve the short name', () => {
      it.each([
        {
          label: 'a five-hop refs/heads/x behind a valid refs/tags/x',
          argument: 'x',
          expected: () => first,
        },
        {
          label: 'a five-hop refs/tags/y ahead of a valid refs/heads/y',
          argument: 'y',
          expected: () => first,
        },
        {
          label: 'a refs/tags/cy cycle ahead of a valid refs/heads/cy',
          argument: 'cy',
          expected: () => first,
        },
        {
          label: 'a dangling refs/tags/dg ahead of a valid refs/heads/dg',
          argument: 'dg',
          expected: () => first,
        },
        { label: 'a four-hop chain, within the cap', argument: 'four', expected: () => second },
      ])('Then both resolve $label to the same object', async ({ argument, expected }) => {
        // Arrange
        const sut = revParse;
        const ctx = createNodeContext({ workDir: repo });

        // Act
        const result = revParseStdout(await sut(ctx, argument));

        // Assert
        const gitResult = tryRunGitWithExit(['-C', repo, 'rev-parse', argument], {
          env: runGitEnv(),
        });
        expect(gitResult.exitCode).toBe(0);
        expect(gitResult.stdout.trim()).toBe(expected());
        expect(result).toBe(expected());
      });
    });
  });

  describe('Given a five-hop chain', () => {
    describe('When both resolve it named in full or through a partial prefix', () => {
      it.each([
        { argument: 'refs/heads/x', verify: true },
        { argument: 'heads/x', verify: true },
        { argument: 'refs/heads/x', verify: false },
        { argument: 'heads/x', verify: false },
      ])('Then neither resolves $argument (--verify: $verify)', async ({ argument, verify }) => {
        // Arrange — both forms refuse; only the wording git prints differs,
        // so the row runs each one rather than assuming they agree.
        const sut = revParse;
        const ctx = createNodeContext({ workDir: repo });

        // Act
        let caught: unknown;
        try {
          await sut(ctx, argument);
        } catch (err) {
          caught = err;
        }

        // Assert
        const gitResult = tryRunGitWithExit(
          ['-C', repo, 'rev-parse', ...(verify ? ['--verify'] : []), argument],
          { env: runGitEnv() },
        );
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toContain('ignoring dangling symref refs/heads/x');
        expect(gitResult.stderr).toContain(
          verify ? 'Needed a single revision' : 'ambiguous argument',
        );
        expect((caught as TsgitError).data).toEqual({ code: 'OBJECT_NOT_FOUND', id: argument });
      });
    });
  });

  describe('Given a short name a branch and a tag both carry', () => {
    describe('When git rev-parse and revParse both resolve it', () => {
      it('Then both take the tag, which the ladder reaches first', async () => {
        // Arrange
        const sut = revParse;
        const ctx = createNodeContext({ workDir: repo });

        // Act
        const result = revParseStdout(await sut(ctx, 'amb'));

        // Assert
        const gitResult = tryRunGitWithExit(['-C', repo, 'rev-parse', 'amb'], { env: runGitEnv() });
        expect(gitResult.exitCode).toBe(0);
        expect(gitResult.stderr).toBe("warning: refname 'amb' is ambiguous.\n");
        expect(gitResult.stdout.trim()).toBe(second);
        expect(result).toBe(second);
        expect(git(repo, 'rev-parse', 'refs/heads/amb').trim()).toBe(first);
      });
    });
  });

  describe.each([
    { name: () => 'a2', label: 'a two-character hex branch name' },
    { name: () => 'a2^', label: 'a two-character hex branch name with a parent operator' },
    {
      name: () => first.slice(0, 4),
      label: "a hex branch name that also abbreviates another commit's oid",
    },
  ])('Given $label', ({ name }) => {
    describe('When git rev-parse and revParse both resolve it', () => {
      it('Then both resolve the branch', async () => {
        // Arrange
        const sut = revParse;
        const ctx = createNodeContext({ workDir: repo });

        // Act
        const result = revParseStdout(await sut(ctx, name()));

        // Assert
        expect(result).toBe(git(repo, 'rev-parse', name()).trim());
      });
    });
  });

  describe('Given a short name whose earlier candidate git cannot walk', () => {
    describe('When the surfaces that take a name, other than rev-parse, resolve it', () => {
      it('Then every one of them lands on the later candidate, on both tools', async () => {
        // Arrange — one copy per tool: four of these five surfaces write.
        const peer = await caseRepo('dw4-peer');
        const ours = await caseRepo('dw4-ours');
        const ctx = createNodeContext({ workDir: ours });

        // Act — git's five
        const gitLog = tryRunGitWithExit(['-C', peer, 'log', '-1', '--format=%H', 'y'], {
          env: runGitEnv(),
        });
        const gitMergeBase = tryRunGitWithExit(['-C', peer, 'merge-base', 'y', 'main'], {
          env: runGitEnv(),
        });
        runGit(['-C', peer, 'branch', 'fresh-branch', 'y'], { env: IDENTITY_ENV });
        runGit(['-C', peer, 'reset', '--soft', 'y'], { env: IDENTITY_ENV });
        runGit(['-C', peer, 'checkout', '--detach', 'y'], { env: IDENTITY_ENV });

        // Act — tsgit's four name-taking equivalents; `mergeBase` takes
        // resolved ids, so its DWIM is `revParse`'s, run here explicitly.
        const entries = await log(ctx, { rev: 'y', limit: 1 });
        const bases = await mergeBase(ctx, [
          revParseStdout(await revParse(ctx, 'y')) as ObjectId,
          revParseStdout(await revParse(ctx, 'main')) as ObjectId,
        ]);
        const created = await branchCreate(ctx, { name: 'fresh-branch', startPoint: 'y' });
        const resetResult = await reset(ctx, { mode: 'soft', rev: 'y' });
        const detached = await checkout(ctx, { rev: 'y', detach: true });

        // Assert
        expect(gitLog.stdout.trim()).toBe(first);
        expect(gitMergeBase.stdout.trim()).toBe(first);
        expect(git(peer, 'rev-parse', 'refs/heads/fresh-branch').trim()).toBe(first);
        expect(git(peer, 'rev-parse', 'HEAD').trim()).toBe(first);
        expect(entries[0]?.id).toBe(first);
        expect(bases).toEqual([first]);
        expect(created.id).toBe(first);
        expect(resetResult.id).toBe(first);
        expect(detached.id).toBe(first);
        expect(git(ours, 'rev-parse', 'HEAD').trim()).toBe(git(peer, 'rev-parse', 'HEAD').trim());
      });
    });
  });
});

/** git's stderr as lines, its closing newline dropped and blank lines inside kept. */
const stderrLines = (stderr: string): ReadonlyArray<string> =>
  stderr === '' ? [] : stderr.replace(/\n$/, '').split('\n');

describe.skipIf(!GIT_AVAILABLE)('integration — revParse ambiguous refname warning', () => {
  let repo = '';
  let tip = '';

  beforeAll(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rev-parse-ambiguous-interop-'));
    runGit(['init', '-q', '-b', 'main', repo]);
    disableAutoMaintenance(repo);
    runGit(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'c1'], { env: IDENTITY_ENV });
    tip = git(repo, 'rev-parse', 'HEAD').trim();
    git(repo, 'update-ref', 'refs/tags/main', tip);
    git(repo, 'update-ref', 'refs/heads/solo', tip);
    git(repo, 'update-ref', `refs/heads/${tip.slice(0, 7)}`, tip);
    git(repo, 'update-ref', `refs/heads/${tip}`, tip);
    git(repo, 'update-ref', 'refs/heads/dg', tip);
    git(repo, 'symbolic-ref', 'refs/tags/dg', 'refs/tags/nope');
    git(repo, 'update-ref', 'refs/heads/br', tip);
    writeFileSync(path.join(repo, '.git', 'refs', 'tags', 'br'), 'garbage\n');
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  describe.each([
    { label: 'a branch and a tag', arg: () => 'main' },
    { label: 'one namespace', arg: () => 'solo' },
    { label: 'a ref and an abbreviated object id', arg: () => tip.slice(0, 7) },
    { label: 'a full object id and a ref', arg: () => tip },
    { label: 'a ref under a revision suffix', arg: () => 'main~0' },
    { label: 'a branch behind a dangling symref', arg: () => 'dg' },
    { label: 'a branch behind a broken ref', arg: () => 'br' },
  ])('Given a name that resolves as $label', ({ arg }) => {
    describe('When git and tsgit rev-parse it', () => {
      it('Then tsgit warns the lines git prints to stderr', async () => {
        // Arrange
        const { stderr } = tryRunGitWithExit(['-C', repo, 'rev-parse', arg()]);
        const warnings: string[] = [];
        const ctx = {
          ...createNodeContext({ workDir: repo }),
          logger: { warn: (message: string) => warnings.push(message) },
        };
        const sut = revParse;

        // Act
        await sut(ctx, arg());

        // Assert
        const rendered = warnings.flatMap((message, at) =>
          (at === 0 ? `warning: ${message}` : message).split('\n'),
        );
        expect(rendered).toEqual(stderrLines(stderr));
      });
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  'integration — revParse under a malformed core.warnAmbiguousRefs',
  () => {
    let repo = '';
    let tip = '';

    beforeAll(async () => {
      repo = await mkdtemp(path.join(os.tmpdir(), 'tsgit-rev-parse-warn-ambiguous-bad-'));
      runGit(['init', '-q', '-b', 'main', repo]);
      disableAutoMaintenance(repo);
      runGit(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'c1'], { env: IDENTITY_ENV });
      tip = git(repo, 'rev-parse', 'HEAD').trim();
      git(repo, 'config', 'core.warnAmbiguousRefs', 'maybe');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(repo, { recursive: true, force: true });
    });

    describe.each([
      { label: 'a branch', arg: () => 'main' },
      { label: 'HEAD under a revision suffix', arg: () => 'HEAD~0' },
      { label: 'a full object id', arg: () => tip },
    ])('Given $label', ({ arg }) => {
      describe('When git and tsgit rev-parse it', () => {
        it('Then both refuse the value', async () => {
          // Arrange
          const gitRun = tryRunGitWithExit(['-C', repo, 'rev-parse', arg()]);
          const sut = revParse;

          // Act
          let caught: unknown;
          try {
            await sut(createNodeContext({ workDir: repo }), arg());
          } catch (error) {
            caught = error;
          }

          // Assert
          expect(gitRun.exitCode).toBe(128);
          expect(gitRun.stderr).toContain(
            "fatal: bad boolean config value 'maybe' for 'core.warnambiguousrefs'",
          );
          expect((caught as TsgitError).data).toMatchObject({
            code: 'CONFIG_BAD_BOOLEAN_VALUE',
            key: 'core.warnambiguousrefs',
            value: 'maybe',
          });
        });
      });
    });

    describe('Given an abbreviated object id no ref names', () => {
      describe('When git and tsgit rev-parse it', () => {
        it('Then both resolve it, never reading the setting', async () => {
          // Arrange
          const expected = git(repo, 'rev-parse', tip.slice(0, 7)).trim();
          const sut = revParse;

          // Act
          const result = revParseStdout(
            await sut(createNodeContext({ workDir: repo }), tip.slice(0, 7)),
          );

          // Assert
          expect(result).toBe(expected);
        });
      });
    });
  },
);

type CommandRun = (ctx: Context) => Promise<unknown>;

describe.skipIf(!GIT_AVAILABLE)('integration — skip and ambiguity warnings per command', () => {
  let repo = '';
  const caseRoots: string[] = [];

  beforeAll(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'tsgit-command-warnings-interop-'));
    runGit(['init', '-q', '-b', 'main', repo]);
    disableAutoMaintenance(repo);
    runGit(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'c1'], { env: IDENTITY_ENV });
    const tip = git(repo, 'rev-parse', 'HEAD').trim();
    git(repo, 'update-ref', 'refs/heads/dg', tip);
    git(repo, 'symbolic-ref', 'refs/tags/dg', 'refs/tags/nope');
    git(repo, 'symbolic-ref', 'refs/tags/only', 'refs/heads/nope');
    git(repo, 'update-ref', 'refs/heads/amb', tip);
    git(repo, '-c', 'core.logAllRefUpdates=always', 'update-ref', 'refs/tags/amb', tip);
    git(repo, 'symbolic-ref', 'refs/heads/sym', 'refs/heads/main');
    git(repo, 'update-ref', 'refs/tags/main', tip);
    git(repo, 'update-ref', 'refs/tags/td', tip);
    git(repo, 'symbolic-ref', 'refs/heads/td', 'refs/heads/nowhere');
    await mkdir(path.join(repo, 'sub'));
    await writeFile(path.join(repo, 'sub', 'x'), 'x\n');
    await symlink('sub', path.join(repo, 'dg:link'));
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
    await Promise.all(
      caseRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  const caseRepo = async (slug: string): Promise<string> => {
    const root = await mkdtemp(path.join(os.tmpdir(), `tsgit-command-warnings-${slug}-`));
    caseRoots.push(root);
    const dir = path.join(root, 'repo');
    await cp(repo, dir, { recursive: true });
    return dir;
  };

  describe.each([
    {
      label: 'branch from a name past a dangling symref',
      args: ['branch', 'x', 'dg'],
      run: ((ctx) => branchCreate(ctx, { name: 'x', startPoint: 'dg' })) as CommandRun,
    },
    {
      label: 'branch from a name only a dangling symref carries',
      args: ['branch', 'x', 'only'],
      run: ((ctx) => branchCreate(ctx, { name: 'x', startPoint: 'only' })) as CommandRun,
    },
    {
      label: 'branch from a name two namespaces carry',
      args: ['branch', 'x', 'amb'],
      run: ((ctx) => branchCreate(ctx, { name: 'x', startPoint: 'amb' })) as CommandRun,
    },
    {
      label: 'a soft reset to a name past a dangling symref',
      args: ['reset', '--soft', 'dg'],
      run: ((ctx) => reset(ctx, { mode: 'soft', rev: 'dg' })) as CommandRun,
    },
    {
      label: 'a mixed reset to a name past a dangling symref',
      args: ['reset', '--mixed', '-q', 'dg'],
      run: ((ctx) => reset(ctx, { mode: 'mixed', rev: 'dg' })) as CommandRun,
    },
    {
      label: 'a hard reset to a name past a dangling symref',
      args: ['reset', '--hard', '-q', 'dg'],
      run: ((ctx) => reset(ctx, { mode: 'hard', rev: 'dg' })) as CommandRun,
    },
    {
      label: 'a soft reset to a name only a dangling symref carries',
      args: ['reset', '--soft', 'only'],
      run: ((ctx) => reset(ctx, { mode: 'soft', rev: 'only' })) as CommandRun,
    },
    {
      label: 'a checkout of a branch past a dangling symref',
      args: ['checkout', '-q', 'dg'],
      run: ((ctx) => checkout(ctx, { rev: 'dg' })) as CommandRun,
    },
    {
      label: 'a detaching checkout of a name past a dangling symref',
      args: ['checkout', '-q', '--detach', 'dg'],
      run: ((ctx) => checkout(ctx, { rev: 'dg', detach: true })) as CommandRun,
    },
    {
      label: 'a checkout creating a branch at a name past a dangling symref',
      args: ['checkout', '-q', '-b', 'nb', 'dg'],
      run: ((ctx) => checkout(ctx, { rev: 'dg', createBranch: { name: 'nb' } })) as CommandRun,
    },
    {
      label: 'a checkout of a tag a dangling branch symref shadows',
      args: ['checkout', '-q', 'td'],
      run: ((ctx) => checkout(ctx, { rev: 'td' })) as CommandRun,
    },
    {
      label: 'branch without a start point while a tag shares the current branch name',
      args: ['branch', 'x'],
      run: ((ctx) => branchCreate(ctx, { name: 'x' })) as CommandRun,
    },
    {
      label: 'rev-parse of a reflog two namespaces carry',
      args: ['rev-parse', 'amb@{0}'],
      run: ((ctx) => revParse(ctx, 'amb@{0}')) as CommandRun,
    },
    {
      label: 'rev-parse of the current branch reflog',
      args: ['rev-parse', '@{0}'],
      run: ((ctx) => revParse(ctx, '@{0}')) as CommandRun,
    },
    {
      label: 'rev-parse of a name only a dangling symref carries',
      args: ['rev-parse', 'only'],
      run: ((ctx) => revParse(ctx, 'only')) as CommandRun,
    },
    {
      label: 'rev-parse of a missing ancestor past a dangling symref',
      args: ['rev-parse', 'dg~5'],
      run: ((ctx) => revParse(ctx, 'dg~5')) as CommandRun,
    },
    {
      label: 'rev-parse of a missing path past a dangling symref',
      args: ['rev-parse', 'dg:absent'],
      run: ((ctx) => revParse(ctx, 'dg:absent')) as CommandRun,
    },
    {
      label: 'rev-parse of a range whose start warns and whose end names nothing',
      args: ['rev-parse', 'dg..nope'],
      run: ((ctx) => revParse(ctx, 'dg..nope')) as CommandRun,
    },
    {
      label: 'rev-parse of a range whose start names nothing',
      args: ['rev-parse', 'nope..dg'],
      run: ((ctx) => revParse(ctx, 'nope..dg')) as CommandRun,
    },
    {
      label: 'rev-parse of a symmetric range whose start is a missing ancestor',
      args: ['rev-parse', 'dg~5...nope'],
      run: ((ctx) => revParse(ctx, 'dg~5...nope')) as CommandRun,
    },
    {
      label: 'rev-parse of a parent hop in a missing path past a dangling symref',
      args: ['rev-parse', 'dg:a/..'],
      run: ((ctx) => revParse(ctx, 'dg:a/..')) as CommandRun,
    },
    {
      label: 'rev-parse of a relative path climbing out past a dangling symref',
      args: ['rev-parse', 'dg:../absent'],
      run: ((ctx) => revParse(ctx, 'dg:../absent')) as CommandRun,
    },
    {
      label: 'rev-parse of a path reached through a symlinked directory',
      args: ['rev-parse', 'dg:link/x'],
      run: ((ctx) => revParse(ctx, 'dg:link/x')) as CommandRun,
    },
    {
      label: 'rev-parse of a missing path under a symlinked directory',
      args: ['rev-parse', 'dg:link/nope'],
      run: ((ctx) => revParse(ctx, 'dg:link/nope')) as CommandRun,
    },
    {
      label: 'rev-parse of a missing path that reads as a pathspec',
      args: ['rev-parse', 'dg:absent*'],
      run: ((ctx) => revParse(ctx, 'dg:absent*')) as CommandRun,
    },
    {
      label: 'log of a name only a dangling symref carries',
      args: ['log', 'only'],
      run: ((ctx) => log(ctx, { rev: 'only' })) as CommandRun,
    },
    {
      label: 'show of a name only a dangling symref carries',
      args: ['show', 'only'],
      run: ((ctx) => show(ctx, 'only')) as CommandRun,
    },
    {
      label: 'show of a missing path past a dangling symref',
      args: ['show', 'dg:absent'],
      run: ((ctx) => show(ctx, 'dg:absent')) as CommandRun,
    },
    {
      label: 'show of the root tree past a dangling symref',
      args: ['show', 'dg:'],
      run: ((ctx) => show(ctx, 'dg:')) as CommandRun,
    },
    {
      label: 'show of a missing ancestor past a dangling symref',
      args: ['show', '-s', 'dg~5'],
      run: ((ctx) => show(ctx, 'dg~5')) as CommandRun,
    },
    {
      label: 'rev-list of a name only a dangling symref carries',
      args: ['rev-list', 'only'],
      run: ((ctx) => revList(ctx, { wants: ['only'] })) as CommandRun,
    },
    {
      label: 'diff against a name only a dangling symref carries',
      args: ['diff', 'only'],
      run: ((ctx) => diff(ctx, { from: 'only' })) as CommandRun,
    },
    {
      label: 'cherry-pick of a name only a dangling symref carries',
      args: ['cherry-pick', 'only'],
      run: ((ctx) => cherryPickRun(ctx, { commits: ['only'] })) as CommandRun,
    },
    {
      label: 'cherry-pick of a range a dangling symref ends',
      args: ['cherry-pick', 'main..only'],
      run: ((ctx) => cherryPickRun(ctx, { commits: ['main..only'] })) as CommandRun,
    },
    {
      label: 'name-rev of a name only a dangling symref carries',
      args: ['name-rev', 'only'],
      run: ((ctx) => nameRev(ctx, 'only')) as CommandRun,
    },
    {
      label: 'range-diff over a range a dangling symref ends',
      args: ['range-diff', 'only..main', 'main..main'],
      run: ((ctx) =>
        rangeDiff(ctx, {
          old: { base: 'only', tip: 'main' },
          new: { base: 'main', tip: 'main' },
        })) as CommandRun,
    },
    {
      label: 'pack-objects over a name only a dangling symref carries',
      args: ['pack-objects', '--revs', '--stdout'],
      input: 'only\n',
      run: ((ctx) => packObjects(ctx, { wants: ['only'] })) as CommandRun,
    },
  ])('Given $label', ({ args, input, run }) => {
    describe('When git and tsgit run it', () => {
      it('Then tsgit warns each line git warns', async () => {
        // Arrange
        const gitDir = await caseRepo('git');
        const { stderr } = tryRunGitWithExit(
          ['-C', gitDir, ...args],
          input === undefined ? {} : { input },
        );
        const warnings: string[] = [];
        const ctx = {
          ...createNodeContext({ workDir: await caseRepo('tsgit') }),
          logger: { warn: (message: string) => warnings.push(message) },
        };
        const sut = run;

        // Act
        await sut(ctx).catch(() => undefined);

        // Assert
        const expected = stderrLines(stderr).filter((line) => line.startsWith('warning: '));
        expect(warnings.map((message) => `warning: ${message}`)).toEqual(expected);
      });
    });
  });

  describe.each([
    { label: 'present', target: 'outside', plant: true, refused: 0 },
    { label: 'absent', target: 'absent', plant: false, refused: 128 },
  ])(
    'Given an argument whose parent hops climb out of the worktree to a $label path',
    ({ target, plant, refused }) => {
      describe('When git and tsgit rev-parse it', () => {
        it('Then tsgit warns each line git warns', async () => {
          // Arrange
          const arg = `dg:a/../../${target}`;
          const outsideRepo = async (slug: string): Promise<string> => {
            const dir = await caseRepo(slug);
            await mkdir(path.join(dir, 'dg:a'));
            if (plant) writeFileSync(path.join(dir, '..', 'outside'), '');
            return dir;
          };
          const gitRun = tryRunGitWithExit(['-C', await outsideRepo('git'), 'rev-parse', arg]);
          const warnings: string[] = [];
          const ctx = {
            ...createNodeContext({ workDir: await outsideRepo('tsgit') }),
            logger: { warn: (message: string) => warnings.push(message) },
          };
          const sut = revParse;

          // Act
          const result = await sut(ctx, arg).catch((err: TsgitError) => err.data);

          // Assert
          const expected = stderrLines(gitRun.stderr).filter((line) =>
            line.startsWith('warning: '),
          );
          expect(gitRun.exitCode).toBe(refused);
          expect(warnings.map((message) => `warning: ${message}`)).toEqual(expected);
          expect(result).toMatchObject({ code: 'PATH_NOT_IN_TREE', path: `a/../../${target}` });
        });
      });
    },
  );
});

describe.skipIf(!GIT_AVAILABLE)('integration — dwim_log through a symbolic branch', () => {
  let repo = '';

  beforeAll(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'tsgit-dwim-log-symref-interop-'));
    runGit(['init', '-q', '-b', 'main', repo]);
    disableAutoMaintenance(repo);
    runGit(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'c1'], { env: IDENTITY_ENV });
    git(repo, 'symbolic-ref', 'refs/heads/sym', 'refs/heads/main');
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  describe('Given a symbolic branch with no reflog of its own', () => {
    describe('When git and tsgit rev-parse its reflog selector', () => {
      it('Then both read the reflog of the branch it points at', async () => {
        // Arrange
        const expected = git(repo, 'rev-parse', 'sym@{0}').trim();
        const sut = revParse;

        // Act
        const result = revParseStdout(await sut(createNodeContext({ workDir: repo }), 'sym@{0}'));

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  'integration — commands naming HEAD under a malformed core.warnAmbiguousRefs',
  () => {
    let repo = '';

    beforeAll(async () => {
      repo = await mkdtemp(path.join(os.tmpdir(), 'tsgit-head-warn-ambiguous-bad-'));
      runGit(['init', '-q', '-b', 'main', repo]);
      disableAutoMaintenance(repo);
      runGit(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'c1'], { env: IDENTITY_ENV });
      git(repo, 'config', 'core.warnAmbiguousRefs', 'maybe');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(repo, { recursive: true, force: true });
    });

    describe.each([
      {
        label: 'rev-parse @{0}',
        args: ['rev-parse', '@{0}'],
        run: ((ctx) => revParse(ctx, '@{0}')) as CommandRun,
      },
      {
        label: 'rev-parse main@{0}',
        args: ['rev-parse', 'main@{0}'],
        run: ((ctx) => revParse(ctx, 'main@{0}')) as CommandRun,
      },
      { label: 'status', args: ['status', '--short'], run: ((ctx) => status(ctx)) as CommandRun },
      {
        label: 'reset --soft HEAD',
        args: ['reset', '--soft', 'HEAD'],
        run: ((ctx) => reset(ctx, { mode: 'soft', rev: 'HEAD' })) as CommandRun,
      },
      {
        label: 'branch without a start point',
        args: ['branch', 'b1'],
        run: ((ctx) => branchCreate(ctx, { name: 'b1' })) as CommandRun,
      },
    ])('Given $label', ({ args, run }) => {
      describe('When git and tsgit run it', () => {
        it('Then both refuse the value', async () => {
          // Arrange
          const gitRun = tryRunGitWithExit(['-C', repo, ...args]);
          const sut = run;

          // Act
          const refusal = await sut(createNodeContext({ workDir: repo })).catch(
            (err: TsgitError) => err.data,
          );

          // Assert
          expect(gitRun.exitCode).toBe(128);
          expect(gitRun.stderr).toContain(
            "fatal: bad boolean config value 'maybe' for 'core.warnambiguousrefs'",
          );
          expect(refusal).toMatchObject({
            code: 'CONFIG_BAD_BOOLEAN_VALUE',
            key: 'core.warnambiguousrefs',
            value: 'maybe',
          });
        });
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)('integration — error lines a revision operator prints', () => {
  let repo = '';

  beforeAll(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'tsgit-operator-errors-interop-'));
    runGit(['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'tag.gpgsign', 'false');
    disableAutoMaintenance(repo);
    writeFileSync(path.join(repo, 'f'), 'a\n');
    git(repo, 'add', 'f');
    runGit(['-C', repo, 'commit', '-q', '-m', 'c1'], { env: IDENTITY_ENV });
    runGit(['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'c2'], { env: IDENTITY_ENV });
    runGit(['-C', repo, 'tag', '-a', '-m', 't', 'tt', 'HEAD^{tree}'], { env: IDENTITY_ENV });
    runGit(['-C', repo, 'tag', '-a', '-m', 't', 'tc', 'HEAD'], { env: IDENTITY_ENV });
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  describe.each([
    {
      args: ['rev-parse', 'HEAD^{tree}^{commit}'],
      run: ((ctx) => revParse(ctx, 'HEAD^{tree}^{commit}')) as CommandRun,
    },
    {
      args: ['rev-parse', 'tt^{blob}~1'],
      run: ((ctx) => revParse(ctx, 'tt^{blob}~1')) as CommandRun,
    },
    {
      args: ['rev-parse', 'HEAD^{tag}'],
      run: ((ctx) => revParse(ctx, 'HEAD^{tag}')) as CommandRun,
    },
    {
      args: ['rev-parse', 'HEAD^{tree}~0'],
      run: ((ctx) => revParse(ctx, 'HEAD^{tree}~0')) as CommandRun,
    },
    { args: ['rev-parse', 'tt^'], run: ((ctx) => revParse(ctx, 'tt^')) as CommandRun },
    { args: ['rev-parse', 'tc^0'], run: ((ctx) => revParse(ctx, 'tc^0')) as CommandRun },
    {
      args: ['log', 'HEAD^{tree}^{commit}'],
      run: ((ctx) => log(ctx, { rev: 'HEAD^{tree}^{commit}' })) as CommandRun,
    },
    { args: ['show', 'tt^0'], run: ((ctx) => show(ctx, 'tt^0')) as CommandRun },
    {
      args: ['rev-list', 'HEAD^{tree}^'],
      run: ((ctx) => revList(ctx, { wants: ['HEAD^{tree}^'] })) as CommandRun,
    },
  ])('Given git $args', ({ args, run }) => {
    describe('When tsgit reads the same revision', () => {
      it('Then it reports each error line git prints, as many times', async () => {
        // Arrange
        const { stderr } = tryRunGitWithExit(['-C', repo, ...args]);
        const errors: string[] = [];
        const ctx = {
          ...createNodeContext({ workDir: repo }),
          logger: { error: (message: string) => errors.push(message) },
        };
        const sut = run;

        // Act
        await sut(ctx).catch(() => undefined);

        // Assert
        const expected = stderrLines(stderr).filter((line) => line.startsWith('error: '));
        expect(errors.map((message) => `error: ${message}`)).toEqual(expected);
      });
    });
  });

  describe.each(['tc^0', 'tc^', 'tc~1', 'tc~0', 'HEAD^0'])(
    'Given an operator on the commit-ish %s',
    (arg) => {
      describe('When git and tsgit rev-parse it', () => {
        it('Then both peel the tag and resolve the same commit', async () => {
          // Arrange
          const expected = git(repo, 'rev-parse', arg).trim();
          const ctx = createNodeContext({ workDir: repo });
          const sut = revParse;

          // Act
          const result = revParseStdout(await sut(ctx, arg));

          // Assert
          expect(result).toBe(expected);
        });
      });
    },
  );
});
