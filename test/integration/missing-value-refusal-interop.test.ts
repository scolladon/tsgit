/**
 * Cross-tool interop — valueless identity refusal. Drives `commit` via the
 * real `openRepository` facade and canonical `git commit` into isolated tmpdirs.
 * The valueless config line is written by `writeFile` — git's CLI cannot emit a
 * valueless entry, so file-write is mandatory for fixture setup.
 *
 * @proves
 *   surface:        commit/config
 *   bucket:         cross-tool-interop
 *   unique:         valueless identity refusal two-line reconstruction + absent-case distinctness
 *   interopSurface: config
 */
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { configGet, configGetRegexp, configList } from '../../src/application/commands/config.js';
import { TsgitError } from '../../src/domain/error.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGit } from './interop-helpers.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

/**
 * A fixture that controls line numbers. The valueless `user.name` lands at line 4.
 * Line 1: [core]
 * Line 2: \trepositoryformatversion = 0
 * Line 3: [user]
 * Line 4: \tname         <- valueless
 * Line 5: \temail = a@b.c
 */
const VALUELESS_NAME_FIXTURE =
  '[core]\n\trepositoryformatversion = 0\n[user]\n\tname\n\temail = a@b.c\n';
const VALUELESS_NAME_LINE = 4;

/** Fixture with no [user] section — the absent case. */
const ABSENT_USER_FIXTURE = '[core]\n\trepositoryformatversion = 0\n';

/**
 * Build commit env with an identity supplied via the GIT_AUTHOR and
 * GIT_COMMITTER variables.
 * We deliberately do NOT supply an identity when testing the valueless case so
 * git reads from config and trips on the NULL. We DO supply one for the absent
 * case so git can commit (proving absent is distinct from valueless).
 */
const makeIdentityEnv = (): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_COMMITTER_DATE: '1700000000 +0000',
});

describe.skipIf(!GIT_AVAILABLE)('missing-value-refusal interop', () => {
  let ours: string;

  beforeEach(async () => {
    ours = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-missing-value-ours-')));
  });

  afterEach(async () => {
    await rm(ours, { recursive: true, force: true });
  });

  const initRepo = (dir: string): void => {
    runGit(['init', '-q', '-b', 'main', dir]);
  };

  const stageFile = async (dir: string): Promise<void> => {
    await writeFile(path.join(dir, 'a.txt'), 'a');
    runGit(['-C', dir, 'add', 'a.txt']);
  };

  describe('Given a config with valueless user.name at line 4', () => {
    describe('When git config --list is run on the same file', () => {
      it('Then git config succeeds (refusal is at consumer, not read)', async () => {
        // Arrange
        initRepo(ours);
        await writeFile(path.join(ours, '.git', 'config'), VALUELESS_NAME_FIXTURE);

        // Act
        const g = tryRunGit(['config', '--file', path.join(ours, '.git', 'config'), '--list']);

        // Assert — config read succeeds even with a valueless entry
        expect(g.ok).toBe(true);
      });
    });
  });

  describe('Given a config with no [user] section (absent identity)', () => {
    describe('When git commit is run with identity in env', () => {
      it('Then git auto-commits with exit 0 (absent is distinct from valueless)', async () => {
        // Arrange
        initRepo(ours);
        await stageFile(ours);
        await writeFile(path.join(ours, '.git', 'config'), ABSENT_USER_FIXTURE);

        // Act — provide identity via GIT_AUTHOR_* so git can commit
        const g = tryRunGit(['-C', ours, 'commit', '-m', 'x'], {
          env: makeIdentityEnv(),
        });

        // Assert — git succeeds (absent identity resolves from env, not config)
        expect(g.ok).toBe(true);
      });
    });

    describe('When tsgit commit is run', () => {
      it('Then throws AUTHOR_UNCONFIGURED and NOT CONFIG_MISSING_VALUE', async () => {
        // Arrange
        initRepo(ours);
        await stageFile(ours);
        await writeFile(path.join(ours, '.git', 'config'), ABSENT_USER_FIXTURE);
        const repo = await openRepository({ cwd: ours });

        // Act
        let caught: unknown;
        try {
          await repo.commit({ message: 'x' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('AUTHOR_UNCONFIGURED');
        expect(data.code).not.toBe('CONFIG_MISSING_VALUE');
      });
    });
  });

  /**
   * A fixture that controls line numbers. The `[remote "origin"]` header lands at line 3;
   * the valueless `url` entry lands at line 4.
   * Line 1: [core]
   * Line 2: \trepositoryformatversion = 0
   * Line 3: [remote "origin"]
   * Line 4: \turl           <- valueless
   */
  const VALUELESS_REMOTE_URL_FIXTURE =
    '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl\n';
  const VALUELESS_REMOTE_URL_LINE = 4;

  /** Fixture with [remote "origin"] but no url line — the absent case. */
  const ABSENT_REMOTE_URL_FIXTURE = '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n';

  /**
   * The valueless `pushurl` lands at line 4 (url valued at line 5). Git dies on
   * the valueless `pushurl` even though `url` is valued — the `pushurl ?? url`
   * fallback does not rescue it.
   * Line 3: [remote "origin"]
   * Line 4: \tpushurl       <- valueless
   * Line 5: \turl = https://example.com/r.git
   */
  const VALUELESS_REMOTE_PUSHURL_FIXTURE =
    '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\tpushurl\n\turl = https://example.com/r.git\n';
  const VALUELESS_REMOTE_PUSHURL_LINE = 4;

  /** Both push urls valueless, pushurl earlier (line 4) than url (line 5). */
  const VALUELESS_REMOTE_BOTH_PUSHURL_FIRST_FIXTURE =
    '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\tpushurl\n\turl\n';

  /** Both push urls valueless, url earlier (line 4) than pushurl (line 5). */
  const VALUELESS_REMOTE_BOTH_URL_FIRST_FIXTURE =
    '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl\n\tpushurl\n';

  describe('Given both remote.origin.pushurl and url valueless, earlier-by-line tie-break', () => {
    describe('When git push and tsgit push are run', () => {
      it.each([
        {
          fixture: VALUELESS_REMOTE_BOTH_PUSHURL_FIRST_FIXTURE,
          expectedKey: 'remote.origin.pushurl',
          label: 'pushurl earlier',
        },
        {
          fixture: VALUELESS_REMOTE_BOTH_URL_FIRST_FIXTURE,
          expectedKey: 'remote.origin.url',
          label: 'url earlier',
        },
      ])(
        'Then both report the earlier-by-line key $expectedKey at line 4 ($label)',
        async ({ fixture, expectedKey }) => {
          // Arrange
          initRepo(ours);
          await writeFile(path.join(ours, '.git', 'config'), fixture);

          // Act
          const g = tryRunGit(['-C', ours, 'push', 'origin', 'main'], { env: runGitEnv() });
          const repo = await openRepository({ cwd: ours });
          let caught: unknown;
          try {
            await repo.push({ remote: 'origin' });
          } catch (err) {
            caught = err;
          }

          // Assert — git reports the earlier-by-line key
          expect(g.ok).toBe(false);
          expect(g.stderr).toContain(`missing value for '${expectedKey}'`);
          expect(g.stderr).toContain('at line 4');
          // tsgit reports the same earlier-by-line key
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { code: string; key: string; line: number };
          expect(data.code).toBe('CONFIG_MISSING_VALUE');
          expect(data.key).toBe(expectedKey);
          expect(data.line).toBe(4);
        },
      );
    });
  });

  describe('Given a config with no url in remote.origin (absent url)', () => {
    describe('When tsgit fetch is run', () => {
      it('Then throws REMOTE_NOT_CONFIGURED and NOT CONFIG_MISSING_VALUE', async () => {
        // Arrange
        initRepo(ours);
        await writeFile(path.join(ours, '.git', 'config'), ABSENT_REMOTE_URL_FIXTURE);
        const repo = await openRepository({ cwd: ours });

        // Act
        let caught: unknown;
        try {
          await repo.fetch({ remote: 'origin' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('REMOTE_NOT_CONFIGURED');
        expect(data.code).not.toBe('CONFIG_MISSING_VALUE');
      });
    });

    describe('When tsgit push is run', () => {
      it('Then throws REMOTE_NOT_CONFIGURED and NOT CONFIG_MISSING_VALUE', async () => {
        // Arrange
        initRepo(ours);
        await writeFile(path.join(ours, '.git', 'config'), ABSENT_REMOTE_URL_FIXTURE);
        const repo = await openRepository({ cwd: ours });

        // Act
        let caught: unknown;
        try {
          await repo.push({ remote: 'origin' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('REMOTE_NOT_CONFIGURED');
        expect(data.code).not.toBe('CONFIG_MISSING_VALUE');
      });
    });
  });

  /**
   * A fixture that controls line numbers. The `[branch "main"]` header lands at
   * line 3; the valueless `remote` entry lands at line 4 (merge valued at line 5).
   * Line 1: [core]
   * Line 2: \trepositoryformatversion = 0
   * Line 3: [branch "main"]
   * Line 4: \tremote          <- valueless
   * Line 5: \tmerge = refs/heads/main
   */
  const VALUELESS_BRANCH_REMOTE_FIXTURE =
    '[core]\n\trepositoryformatversion = 0\n[branch "main"]\n\tremote\n\tmerge = refs/heads/main\n';
  const VALUELESS_BRANCH_REMOTE_LINE = 4;

  /** Both upstream keys valueless, remote earlier (line 4) than merge (line 5). */
  const VALUELESS_BRANCH_BOTH_REMOTE_FIRST_FIXTURE =
    '[core]\n\trepositoryformatversion = 0\n[branch "main"]\n\tremote\n\tmerge\n';

  /** Both upstream keys valueless, merge earlier (line 4) than remote (line 5). */
  const VALUELESS_BRANCH_BOTH_MERGE_FIRST_FIXTURE =
    '[core]\n\trepositoryformatversion = 0\n[branch "main"]\n\tmerge\n\tremote\n';

  /** Fixture with [branch "main"] but no remote/merge — the absent case. */
  const ABSENT_BRANCH_UPSTREAM_FIXTURE = '[core]\n\trepositoryformatversion = 0\n[branch "main"]\n';

  describe('Given both branch.main.remote and merge valueless, earlier-by-line tie-break', () => {
    describe('When git pull and tsgit pull are run', () => {
      it.each([
        {
          fixture: VALUELESS_BRANCH_BOTH_REMOTE_FIRST_FIXTURE,
          expectedKey: 'branch.main.remote',
          label: 'remote earlier',
        },
        {
          fixture: VALUELESS_BRANCH_BOTH_MERGE_FIRST_FIXTURE,
          expectedKey: 'branch.main.merge',
          label: 'merge earlier',
        },
      ])(
        'Then both report the earlier-by-line key $expectedKey at line 4 ($label)',
        async ({ fixture, expectedKey }) => {
          // Arrange
          initRepo(ours);
          await writeFile(path.join(ours, '.git', 'config'), fixture);

          // Act
          const g = tryRunGit(['-C', ours, 'pull'], { env: runGitEnv() });
          const repo = await openRepository({ cwd: ours });
          let caught: unknown;
          try {
            await repo.pull({});
          } catch (err) {
            caught = err;
          }

          // Assert — git reports the earlier-by-line key
          expect(g.ok).toBe(false);
          expect(g.stderr).toContain(`missing value for '${expectedKey}'`);
          expect(g.stderr).toContain('at line 4');
          // tsgit reports the same earlier-by-line key
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { code: string; key: string; line: number };
          expect(data.code).toBe('CONFIG_MISSING_VALUE');
          expect(data.key).toBe(expectedKey);
          expect(data.line).toBe(4);
        },
      );
    });
  });

  describe('Given a config with [branch "main"] but no upstream keys (absent upstream)', () => {
    describe('When tsgit pull is run', () => {
      it('Then throws NO_UPSTREAM_CONFIGURED and NOT CONFIG_MISSING_VALUE', async () => {
        // Arrange
        initRepo(ours);
        await writeFile(path.join(ours, '.git', 'config'), ABSENT_BRANCH_UPSTREAM_FIXTURE);
        const repo = await openRepository({ cwd: ours });

        // Act
        let caught: unknown;
        try {
          await repo.pull({});
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('NO_UPSTREAM_CONFIGURED');
        expect(data.code).not.toBe('CONFIG_MISSING_VALUE');
      });
    });
  });

  type MissingValueRow = {
    key: string;
    fixture: string;
    line: number;
    gitArgs: string[];
    run: (repo: Awaited<ReturnType<typeof openRepository>>) => Promise<unknown>;
    stage?: boolean;
    label: string;
  };

  /**
   * Union of every valueless config key whose consuming command dies with the
   * identical three-oracle journey (git refuses / tsgit throws
   * CONFIG_MISSING_VALUE / stderr reconstruction), differing only by fixture
   * and the consuming command.
   */
  const MISSING_VALUE_MATRIX: MissingValueRow[] = [
    {
      key: 'user.name',
      fixture: VALUELESS_NAME_FIXTURE,
      line: VALUELESS_NAME_LINE,
      gitArgs: ['commit', '-m', 'x'],
      run: (repo) => repo.commit({ message: 'x' }),
      stage: true,
      label: 'user.name via commit',
    },
    {
      key: 'remote.origin.url',
      fixture: VALUELESS_REMOTE_URL_FIXTURE,
      line: VALUELESS_REMOTE_URL_LINE,
      gitArgs: ['fetch', 'origin'],
      run: (repo) => repo.fetch({ remote: 'origin' }),
      label: 'remote.origin.url via fetch',
    },
    {
      key: 'remote.origin.url',
      fixture: VALUELESS_REMOTE_URL_FIXTURE,
      line: VALUELESS_REMOTE_URL_LINE,
      gitArgs: ['push', 'origin', 'main'],
      run: (repo) => repo.push({ remote: 'origin' }),
      label: 'remote.origin.url via push',
    },
    {
      key: 'remote.origin.pushurl',
      fixture: VALUELESS_REMOTE_PUSHURL_FIXTURE,
      line: VALUELESS_REMOTE_PUSHURL_LINE,
      gitArgs: ['push', 'origin', 'main'],
      run: (repo) => repo.push({ remote: 'origin' }),
      label: 'remote.origin.pushurl via push (valued url present)',
    },
    {
      key: 'branch.main.remote',
      fixture: VALUELESS_BRANCH_REMOTE_FIXTURE,
      line: VALUELESS_BRANCH_REMOTE_LINE,
      gitArgs: ['pull'],
      run: (repo) => repo.pull({}),
      label: 'branch.main.remote via pull',
    },
  ];

  describe('Given a config with a valueless key consumed by a per-key command', () => {
    describe('When the consuming git command is run', () => {
      it.each(MISSING_VALUE_MATRIX)(
        'Then git refuses with exit 128 and the two-line missing-value message for $label',
        async ({ fixture, key, line, gitArgs, stage }) => {
          // Arrange
          initRepo(ours);
          if (stage) {
            await stageFile(ours);
          }
          await writeFile(path.join(ours, '.git', 'config'), fixture);

          // Act — no GIT_AUTHOR_* so git reads from config and trips on the NULL
          const g = tryRunGit(['-C', ours, ...gitArgs], { env: runGitEnv() });

          // Assert
          expect(g.ok).toBe(false);
          expect(g.stderr).toContain(`missing value for '${key}'`);
          expect(g.stderr).toContain(`bad config variable '${key}'`);
          expect(g.stderr).toContain(`at line ${line}`);
        },
      );
    });

    describe('When the consuming tsgit command is run', () => {
      it.each(MISSING_VALUE_MATRIX)(
        'Then throws CONFIG_MISSING_VALUE with key, line, and an absolute source for $label',
        async ({ fixture, key, line, run, stage }) => {
          // Arrange
          initRepo(ours);
          if (stage) {
            await stageFile(ours);
          }
          await writeFile(path.join(ours, '.git', 'config'), fixture);
          const repo = await openRepository({ cwd: ours });

          // Act
          let caught: unknown;
          try {
            await run(repo);
          } catch (err) {
            caught = err;
          }

          // Assert — each field individually (mutation-resistant)
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as {
            code: string;
            key: string;
            line: number;
            source: string;
          };
          expect(data.code).toBe('CONFIG_MISSING_VALUE');
          expect(data.key).toBe(key);
          expect(data.line).toBe(line);
          expect(data.source).toMatch(/\/config$/);
        },
      );
    });

    describe("When reconstructing git's two lines from tsgit structured fields", () => {
      it.each(MISSING_VALUE_MATRIX)(
        "Then the reconstructed lines match git's stderr after path-token normalization for $label",
        async ({ fixture, gitArgs, run, stage }) => {
          // Arrange
          initRepo(ours);
          if (stage) {
            await stageFile(ours);
          }
          await writeFile(path.join(ours, '.git', 'config'), fixture);

          // Act — run both git and tsgit against the same repo
          const g = tryRunGit(['-C', ours, ...gitArgs], { env: runGitEnv() });
          const repo = await openRepository({ cwd: ours });
          let caught: unknown;
          try {
            await run(repo);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as {
            code: string;
            key: string;
            line: number;
            source: string;
          };
          const gitLines = g.stderr.split('\n').filter((l) => l.length > 0);
          const errorLine = gitLines.find((l) => l.startsWith('error:')) ?? '';
          const fatalLine = gitLines.find((l) => l.startsWith('fatal:')) ?? '';

          expect(errorLine).toBe(`error: missing value for '${data.key}'`);

          const normalizedSource = '.git/config';
          const tsgitFatalLine = `fatal: bad config variable '${data.key}' in file '${normalizedSource}' at line ${data.line}`;
          const normalizedFatalLine = fatalLine.replace(
            /in file '[^']+'/,
            `in file '${normalizedSource}'`,
          );
          expect(normalizedFatalLine).toBe(tsgitFatalLine);
        },
      );
    });

    describe('When tsgit configList is run on the same file', () => {
      it.each([
        { fixture: VALUELESS_NAME_FIXTURE, label: 'user.name' },
        { fixture: VALUELESS_BRANCH_REMOTE_FIXTURE, label: 'branch.main.remote' },
      ])(
        'Then tsgit configList does not throw (refusal is at consumer, not read) for $label',
        async ({ fixture }) => {
          // Arrange
          initRepo(ours);
          await writeFile(path.join(ours, '.git', 'config'), fixture);
          const ctx = createNodeContext({ workDir: ours });

          // Act + Assert — no throw
          await expect(configList(ctx, {})).resolves.toBeDefined();
        },
      );
    });
  });
});

/**
 * Heavy merge-driver block (`.gitattributes` `* merge=mydriver` + a real
 * conflicting content merge). One shared `beforeAll` repo pair (project memory:
 * heavy git-spawning interop times out hooks under validate's concurrency
 * otherwise). The valueless `[merge "mydriver"]` death fires only when the
 * driver is selected for a conflicting path, so each test resets the diverged
 * graph to its pre-merge `main` tip, rewrites `.git/config`, then merges —
 * neither tool commits on the valueless death, so the shared graph survives.
 */
const MERGE_AUTHOR_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

/**
 * Controls line numbers: the valueless `driver` lands at line 4.
 * Line 1: [core]
 * Line 2: \trepositoryformatversion = 0
 * Line 3: [merge "mydriver"]
 * Line 4: \tdriver           <- valueless
 */
const VALUELESS_MERGE_DRIVER_FIXTURE =
  '[core]\n\trepositoryformatversion = 0\n[merge "mydriver"]\n\tdriver\n';
const VALUELESS_MERGE_DRIVER_LINE = 4;

/** Both driver keys valueless, driver earlier (line 4) than name (line 5). */
const VALUELESS_MERGE_BOTH_DRIVER_FIRST_FIXTURE =
  '[core]\n\trepositoryformatversion = 0\n[merge "mydriver"]\n\tdriver\n\tname\n';

/** Both driver keys valueless, name earlier (line 4) than driver (line 5). */
const VALUELESS_MERGE_BOTH_NAME_FIRST_FIXTURE =
  '[core]\n\trepositoryformatversion = 0\n[merge "mydriver"]\n\tname\n\tdriver\n';

/** No [merge "mydriver"] section — the absent case (built-in text driver). */
const ABSENT_MERGE_DRIVER_FIXTURE = '[core]\n\trepositoryformatversion = 0\n';

/**
 * Valued driver, valueless `name` at line 5 — git reads `name` independently of
 * `driver`, so it dies on `merge.mydriver.name` even with a valued driver.
 */
const VALUELESS_MERGE_NAME_VALUED_DRIVER_FIXTURE =
  '[core]\n\trepositoryformatversion = 0\n[merge "mydriver"]\n\tdriver = cat %A\n\tname\n';
const VALUELESS_MERGE_NAME_LINE = 5;

/**
 * Valueless `recursive` at line 4 — git reads `merge.<name>.recursive`
 * independently of `driver`, so it dies on `merge.mydriver.recursive` when the
 * driver is engaged (verified: exit 128, same missing-value shape as driver).
 */
const VALUELESS_MERGE_RECURSIVE_FIXTURE =
  '[core]\n\trepositoryformatversion = 0\n[merge "mydriver"]\n\trecursive\n';
const VALUELESS_MERGE_RECURSIVE_LINE = 4;

/**
 * Subsectionless valueless `[merge] recursive` (no `[merge "<name>"]` header) —
 * inert to git: merge-driver keys are only meaningful under a subsection, so git
 * ignores it and the merge proceeds (built-in text conflict, mydriver unconfigured).
 */
const SUBSECTIONLESS_VALUELESS_MERGE_FIXTURE =
  '[core]\n\trepositoryformatversion = 0\n[merge]\n\trecursive\n';

describe.skipIf(!GIT_AVAILABLE)('missing-value-refusal interop — merge driver', () => {
  let peer: string;
  let ours: string;

  /** Build a diverged graph whose merge conflicts on data.txt and engages mydriver. */
  beforeAll(async () => {
    peer = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-mv-merge-peer-')));
    ours = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-mv-merge-ours-')));
    for (const dir of [peer, ours]) {
      runGit(['init', '-q', '-b', 'main', dir]);
      await writeFile(path.join(dir, '.gitattributes'), '* merge=mydriver\n');
      await writeFile(path.join(dir, 'data.txt'), 'base\n');
      runGit(['-C', dir, 'add', '.gitattributes', 'data.txt']);
      runGit(['-C', dir, 'commit', '-q', '-m', 'base'], { env: MERGE_AUTHOR_ENV });
      runGit(['-C', dir, 'checkout', '-q', '-b', 'theirs']);
      await writeFile(path.join(dir, 'data.txt'), 'theirs\n');
      runGit(['-C', dir, 'add', 'data.txt']);
      runGit(['-C', dir, 'commit', '-q', '-m', 'theirs'], { env: MERGE_AUTHOR_ENV });
      runGit(['-C', dir, 'checkout', '-q', 'main']);
      await writeFile(path.join(dir, 'data.txt'), 'ours\n');
      runGit(['-C', dir, 'add', 'data.txt']);
      runGit(['-C', dir, 'commit', '-q', '-m', 'ours'], { env: MERGE_AUTHOR_ENV });
    }
  }, 60_000);

  afterAll(async () => {
    await rm(peer, { recursive: true, force: true });
    await rm(ours, { recursive: true, force: true });
  });

  /** Restore both repos to the pre-merge `main` tip with a clean worktree. */
  const resetBoth = (): void => {
    for (const dir of [peer, ours]) {
      runGit(['-C', dir, 'merge', '--abort'], { env: MERGE_AUTHOR_ENV });
      runGit(['-C', dir, 'checkout', '-q', '-f', 'main']);
      runGit(['-C', dir, 'reset', '-q', '--hard', 'main']);
    }
  };

  const writeBothConfig = async (fixture: string): Promise<void> => {
    await writeFile(path.join(peer, '.git', 'config'), fixture);
    await writeFile(path.join(ours, '.git', 'config'), fixture);
  };

  beforeEach(() => {
    // merge --abort fails cleanly when no merge is in progress; ignore.
    try {
      resetBoth();
    } catch {
      runGit(['-C', peer, 'checkout', '-q', '-f', 'main']);
      runGit(['-C', ours, 'checkout', '-q', '-f', 'main']);
    }
  });

  describe('Given a valued driver but a valueless merge.mydriver.name at line 5', () => {
    it('Then git dies on merge.mydriver.name (name read independently of driver)', async () => {
      // Arrange
      await writeBothConfig(VALUELESS_MERGE_NAME_VALUED_DRIVER_FIXTURE);

      // Act
      const g = tryRunGit(['-C', peer, 'merge', '--no-ff', '-m', 'm', 'theirs'], {
        env: MERGE_AUTHOR_ENV,
      });

      // Assert
      expect(g.ok).toBe(false);
      expect(g.stderr).toContain("missing value for 'merge.mydriver.name'");
      expect(g.stderr).toContain(`at line ${VALUELESS_MERGE_NAME_LINE}`);
    });

    it('Then tsgit throws CONFIG_MISSING_VALUE with key merge.mydriver.name and line 5', async () => {
      // Arrange
      await writeBothConfig(VALUELESS_MERGE_NAME_VALUED_DRIVER_FIXTURE);
      const repo = await openRepository({ cwd: ours });

      // Act
      let caught: unknown;
      try {
        await repo.merge.run({ rev: 'theirs', message: 'm' });
      } catch (err) {
        caught = err;
      }

      // Assert — each field individually (mutation-resistant)
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data as { code: string; key: string; line: number };
      expect(data.code).toBe('CONFIG_MISSING_VALUE');
      expect(data.key).toBe('merge.mydriver.name');
      expect(data.line).toBe(VALUELESS_MERGE_NAME_LINE);
    });
  });

  describe('Given a config with a valueless merge.mydriver.driver at line 4', () => {
    describe('When git merge engages the driver', () => {
      it('Then git refuses with exit 128 and the two-line missing-value message', async () => {
        // Arrange
        await writeBothConfig(VALUELESS_MERGE_DRIVER_FIXTURE);

        // Act
        const g = tryRunGit(['-C', peer, 'merge', '--no-ff', '-m', 'm', 'theirs'], {
          env: MERGE_AUTHOR_ENV,
        });

        // Assert
        expect(g.ok).toBe(false);
        expect(g.stderr).toContain("missing value for 'merge.mydriver.driver'");
        expect(g.stderr).toContain("bad config variable 'merge.mydriver.driver'");
        expect(g.stderr).toContain(`at line ${VALUELESS_MERGE_DRIVER_LINE}`);
      });
    });

    describe("When reconstructing git's two lines from tsgit merge structured fields", () => {
      it("Then the reconstructed lines match git's stderr after path-token normalization", async () => {
        // Arrange
        await writeBothConfig(VALUELESS_MERGE_DRIVER_FIXTURE);

        // Act — run both git and tsgit against the same fixture
        const g = tryRunGit(['-C', peer, 'merge', '--no-ff', '-m', 'm', 'theirs'], {
          env: MERGE_AUTHOR_ENV,
        });
        const repo = await openRepository({ cwd: ours });
        let caught: unknown;
        try {
          await repo.merge.run({ rev: 'theirs', message: 'm' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as {
          code: string;
          key: string;
          line: number;
          source: string;
        };
        const gitLines = g.stderr.split('\n').filter((l) => l.length > 0);
        const errorLine = gitLines.find((l) => l.startsWith('error:')) ?? '';
        const fatalLine = gitLines.find((l) => l.startsWith('fatal:')) ?? '';

        expect(errorLine).toBe(`error: missing value for '${data.key}'`);

        const normalizedSource = '.git/config';
        const tsgitFatalLine = `fatal: bad config variable '${data.key}' in file '${normalizedSource}' at line ${data.line}`;
        const normalizedFatalLine = fatalLine.replace(
          /in file '[^']+'/,
          `in file '${normalizedSource}'`,
        );
        expect(normalizedFatalLine).toBe(tsgitFatalLine);
      });
    });

    describe('When tsgit configList is run on the same file', () => {
      it('Then tsgit configList does not throw (refusal is at consumer, not read)', async () => {
        // Arrange
        await writeBothConfig(VALUELESS_MERGE_DRIVER_FIXTURE);
        const ctx = createNodeContext({ workDir: ours });

        // Act + Assert — no throw
        await expect(configList(ctx, {})).resolves.toBeDefined();
      });
    });
  });

  describe('Given a config with a valueless merge.mydriver.recursive at line 4', () => {
    describe('When git merge engages the driver', () => {
      it('Then git refuses with exit 128 and the missing-value message for recursive', async () => {
        // Arrange
        await writeBothConfig(VALUELESS_MERGE_RECURSIVE_FIXTURE);

        // Act
        const g = tryRunGit(['-C', peer, 'merge', '--no-ff', '-m', 'm', 'theirs'], {
          env: MERGE_AUTHOR_ENV,
        });

        // Assert
        expect(g.ok).toBe(false);
        expect(g.stderr).toContain("missing value for 'merge.mydriver.recursive'");
        expect(g.stderr).toContain(`at line ${VALUELESS_MERGE_RECURSIVE_LINE}`);
      });
    });
  });

  describe('Given a valueless merge driver key engaged by merge (driver or recursive)', () => {
    describe('When tsgit merge engages the driver', () => {
      it.each([
        {
          fixture: VALUELESS_MERGE_DRIVER_FIXTURE,
          key: 'merge.mydriver.driver',
          line: VALUELESS_MERGE_DRIVER_LINE,
        },
        {
          fixture: VALUELESS_MERGE_RECURSIVE_FIXTURE,
          key: 'merge.mydriver.recursive',
          line: VALUELESS_MERGE_RECURSIVE_LINE,
        },
      ])(
        'Then throws CONFIG_MISSING_VALUE with key $key and correct line',
        async ({ fixture, key, line }) => {
          // Arrange
          await writeBothConfig(fixture);
          const repo = await openRepository({ cwd: ours });

          // Act
          let caught: unknown;
          try {
            await repo.merge.run({ rev: 'theirs', message: 'm' });
          } catch (err) {
            caught = err;
          }

          // Assert — each field individually (mutation-resistant)
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as {
            code: string;
            key: string;
            line: number;
            source: string;
          };
          expect(data.code).toBe('CONFIG_MISSING_VALUE');
          expect(data.key).toBe(key);
          expect(data.line).toBe(line);
          expect(data.source).toMatch(/\/config$/);
        },
      );
    });
  });

  describe('Given a subsectionless valueless [merge] recursive (no subsection)', () => {
    describe('When git merge and tsgit merge engage mydriver', () => {
      it('Then neither refuses — git ignores the subsectionless key and both reach the conflict', async () => {
        // Arrange
        await writeBothConfig(SUBSECTIONLESS_VALUELESS_MERGE_FIXTURE);

        // Act — a missing-value throw here (regression) would fail the test
        const g = tryRunGit(['-C', peer, 'merge', '--no-ff', '-m', 'm', 'theirs'], {
          env: MERGE_AUTHOR_ENV,
        });
        const repo = await openRepository({ cwd: ours });
        const result = await repo.merge.run({ rev: 'theirs', message: 'm' });

        // Assert — no missing-value death on git; tsgit reaches the built-in text conflict
        expect(g.stderr).not.toContain('missing value');
        expect(result.kind).toBe('conflict');
      });
    });
  });

  describe('Given both merge.mydriver.driver and name valueless, earlier-by-line tie-break', () => {
    describe('When git merge and tsgit merge engage the driver', () => {
      it.each([
        {
          fixture: VALUELESS_MERGE_BOTH_DRIVER_FIRST_FIXTURE,
          expectedKey: 'merge.mydriver.driver',
          label: 'driver earlier',
        },
        {
          fixture: VALUELESS_MERGE_BOTH_NAME_FIRST_FIXTURE,
          expectedKey: 'merge.mydriver.name',
          label: 'name earlier',
        },
      ])(
        'Then both report the earlier-by-line key $expectedKey at line 4 ($label)',
        async ({ fixture, expectedKey }) => {
          // Arrange
          await writeBothConfig(fixture);

          // Act
          const g = tryRunGit(['-C', peer, 'merge', '--no-ff', '-m', 'm', 'theirs'], {
            env: MERGE_AUTHOR_ENV,
          });
          const repo = await openRepository({ cwd: ours });
          let caught: unknown;
          try {
            await repo.merge.run({ rev: 'theirs', message: 'm' });
          } catch (err) {
            caught = err;
          }

          // Assert — git reports the earlier-by-line key
          expect(g.ok).toBe(false);
          expect(g.stderr).toContain(`missing value for '${expectedKey}'`);
          expect(g.stderr).toContain('at line 4');
          // tsgit reports the same earlier-by-line key
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { code: string; key: string; line: number };
          expect(data.code).toBe('CONFIG_MISSING_VALUE');
          expect(data.key).toBe(expectedKey);
          expect(data.line).toBe(4);
        },
      );
    });
  });

  describe('Given no [merge "mydriver"] section (absent driver config)', () => {
    describe('When tsgit merge engages the built-in text driver', () => {
      it('Then the merge proceeds with a conflict and NOT CONFIG_MISSING_VALUE', async () => {
        // Arrange — no driver config: mydriver falls back to the built-in text
        // driver, which conflicts on the whole-file divergence (no death).
        await writeBothConfig(ABSENT_MERGE_DRIVER_FIXTURE);
        const repo = await openRepository({ cwd: ours });

        // Act
        let caught: unknown;
        let result: { kind: string } | undefined;
        try {
          result = await repo.merge.run({ rev: 'theirs', message: 'm', author: AUTHOR });
        } catch (err) {
          caught = err;
        }

        // Assert — no CONFIG_MISSING_VALUE; the merge engaged the built-in driver
        expect(caught).toBeUndefined();
        expect(result?.kind).toBe('conflict');
      });
    });
  });
});

/**
 * Valueless `[merge "custom"]` driver with NO `.gitattributes` referencing it.
 * The driver lands at line 4 — the eager content-merge chokepoint scans the whole
 * `[merge *]` table independent of attribute resolution, so ANY 3-way content
 * merge dies on it. Two diverged graphs distinguish the cases:
 *  - M4: both sides edit `f.txt` on NON-overlapping lines (auto-resolves, no
 *    conflict) — the merge still dies on the valueless driver, proving the death
 *    is at table load, not at conflict.
 *  - M3: only one side advances (fast-forward) — no 3-way content merge runs, so
 *    the valueless driver is never read and the merge succeeds.
 */
const VALUELESS_CUSTOM_DRIVER_FIXTURE =
  '[core]\n\trepositoryformatversion = 0\n[merge "custom"]\n\tdriver\n';
const VALUELESS_CUSTOM_DRIVER_LINE = 4;

describe.skipIf(!GIT_AVAILABLE)(
  'missing-value-refusal interop — merge driver chokepoint (no attribute)',
  () => {
    let m4Peer: string;
    let m4Ours: string;
    let ffPeer: string;
    let ffOurs: string;

    /** Build a graph diverging on non-overlapping edits of `f.txt` (auto-resolves). */
    const buildAutoResolveGraph = async (dir: string): Promise<void> => {
      runGit(['init', '-q', '-b', 'main', dir]);
      await writeFile(path.join(dir, 'f.txt'), 'A\nB\nC\nD\nE\n');
      runGit(['-C', dir, 'add', 'f.txt']);
      runGit(['-C', dir, 'commit', '-q', '-m', 'base'], { env: MERGE_AUTHOR_ENV });
      runGit(['-C', dir, 'checkout', '-q', '-b', 'theirs']);
      await writeFile(path.join(dir, 'f.txt'), 'A\nB\nC\nD\nEEE\n');
      runGit(['-C', dir, 'add', 'f.txt']);
      runGit(['-C', dir, 'commit', '-q', '-m', 'theirs'], { env: MERGE_AUTHOR_ENV });
      runGit(['-C', dir, 'checkout', '-q', 'main']);
      await writeFile(path.join(dir, 'f.txt'), 'AAA\nB\nC\nD\nE\n');
      runGit(['-C', dir, 'add', 'f.txt']);
      runGit(['-C', dir, 'commit', '-q', '-m', 'ours'], { env: MERGE_AUTHOR_ENV });
    };

    /** Build a graph where `theirs` strictly advances `main` (fast-forward). */
    const buildFastForwardGraph = async (dir: string): Promise<void> => {
      runGit(['init', '-q', '-b', 'main', dir]);
      await writeFile(path.join(dir, 'f.txt'), 'A\n');
      runGit(['-C', dir, 'add', 'f.txt']);
      runGit(['-C', dir, 'commit', '-q', '-m', 'base'], { env: MERGE_AUTHOR_ENV });
      runGit(['-C', dir, 'checkout', '-q', '-b', 'theirs']);
      await writeFile(path.join(dir, 'f.txt'), 'A\nB\n');
      runGit(['-C', dir, 'add', 'f.txt']);
      runGit(['-C', dir, 'commit', '-q', '-m', 'theirs'], { env: MERGE_AUTHOR_ENV });
      runGit(['-C', dir, 'checkout', '-q', 'main']);
    };

    const writeConfig = async (dir: string): Promise<void> => {
      await writeFile(path.join(dir, '.git', 'config'), VALUELESS_CUSTOM_DRIVER_FIXTURE);
    };

    beforeAll(async () => {
      m4Peer = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-mv-m4-peer-')));
      m4Ours = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-mv-m4-ours-')));
      ffPeer = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-mv-ff-peer-')));
      ffOurs = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-mv-ff-ours-')));
      await buildAutoResolveGraph(m4Peer);
      await buildAutoResolveGraph(m4Ours);
      await buildFastForwardGraph(ffPeer);
      await buildFastForwardGraph(ffOurs);
      await writeConfig(m4Peer);
      await writeConfig(m4Ours);
      await writeConfig(ffPeer);
      await writeConfig(ffOurs);
    }, 60_000);

    afterAll(async () => {
      for (const dir of [m4Peer, m4Ours, ffPeer, ffOurs]) {
        await rm(dir, { recursive: true, force: true });
      }
    });

    describe('Given a valueless merge.custom.driver, NO attribute, and an auto-resolving content merge', () => {
      it('Then git refuses with exit 128 reporting merge.custom.driver at its line', () => {
        // Act
        const g = tryRunGit(['-C', m4Peer, 'merge', '--no-ff', '-m', 'm', 'theirs'], {
          env: MERGE_AUTHOR_ENV,
        });

        // Assert
        expect(g.ok).toBe(false);
        expect(g.stderr).toContain("missing value for 'merge.custom.driver'");
        expect(g.stderr).toContain(`at line ${VALUELESS_CUSTOM_DRIVER_LINE}`);
      });

      it('Then tsgit throws CONFIG_MISSING_VALUE with key merge.custom.driver and the same line', async () => {
        // Arrange
        const repo = await openRepository({ cwd: m4Ours });

        // Act
        let caught: unknown;
        try {
          await repo.merge.run({ rev: 'theirs', message: 'm', author: AUTHOR });
        } catch (err) {
          caught = err;
        }

        // Assert — each field individually (mutation-resistant)
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as {
          code: string;
          key: string;
          line: number;
          source: string;
        };
        expect(data.code).toBe('CONFIG_MISSING_VALUE');
        expect(data.key).toBe('merge.custom.driver');
        expect(data.line).toBe(VALUELESS_CUSTOM_DRIVER_LINE);
        expect(data.source).toMatch(/\/config$/);
      });

      it("Then the reconstructed lines match git's stderr after path-token normalization", async () => {
        // Act — run both git and tsgit against the same-shape fixture
        const g = tryRunGit(['-C', m4Peer, 'merge', '--no-ff', '-m', 'm', 'theirs'], {
          env: MERGE_AUTHOR_ENV,
        });
        const repo = await openRepository({ cwd: m4Ours });
        let caught: unknown;
        try {
          await repo.merge.run({ rev: 'theirs', message: 'm', author: AUTHOR });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { key: string; line: number };
        const gitLines = g.stderr.split('\n').filter((l) => l.length > 0);
        const errorLine = gitLines.find((l) => l.startsWith('error:')) ?? '';
        const fatalLine = gitLines.find((l) => l.startsWith('fatal:')) ?? '';

        expect(errorLine).toBe(`error: missing value for '${data.key}'`);
        const normalizedSource = '.git/config';
        const tsgitFatalLine = `fatal: bad config variable '${data.key}' in file '${normalizedSource}' at line ${data.line}`;
        const normalizedFatalLine = fatalLine.replace(
          /in file '[^']+'/,
          `in file '${normalizedSource}'`,
        );
        expect(normalizedFatalLine).toBe(tsgitFatalLine);
      });
    });

    describe('Given the same valueless driver but a fast-forward merge (no content merge)', () => {
      it('Then git merge exits 0 (lazy — the driver table is never read)', () => {
        // Act
        const g = tryRunGit(['-C', ffPeer, 'merge', '-m', 'm', 'theirs'], {
          env: MERGE_AUTHOR_ENV,
        });

        // Assert
        expect(g.ok).toBe(true);
      });

      it('Then tsgit merge succeeds and does not raise CONFIG_MISSING_VALUE', async () => {
        // Arrange
        const repo = await openRepository({ cwd: ffOurs });

        // Act
        let caught: unknown;
        let result: { kind: string } | undefined;
        try {
          result = await repo.merge.run({ rev: 'theirs', message: 'm', author: AUTHOR });
        } catch (err) {
          caught = err;
        }

        // Assert — no death; the fast-forward materializes zero content-merge paths
        expect(caught).toBeUndefined();
        expect(result?.kind).toBe('fast-forward');
      });

      it('Then git status exits 0 on the same valueless-driver fixture (read command is lazy)', () => {
        // Act
        const g = tryRunGit(['-C', ffOurs, 'status', '--porcelain'], { env: MERGE_AUTHOR_ENV });

        // Assert
        expect(g.ok).toBe(true);
      });
    });
  },
);

/**
 * Heavy submodule block (`file://` upstream submodule). One shared `beforeAll`
 * builds a real upstream sub (two commits C1→C2), a superproject pinning the sub
 * at C2 via a relative url, and `.gitmodules` declaring it — exactly the
 * canonical-git layout `git submodule update` consumes. Each test takes a fresh
 * clone (its own `.git/config` to rewrite with a valueless `submodule.mysub.url`),
 * so the shared upstream survives across cases. 60s timeout: heavy git-spawning
 * interop times out hooks under validate's concurrency otherwise (project memory).
 *
 * The fixture is REUSABLE — `subModuleFixture()` exposes the shared dirs and the
 * `freshClone()` helper so a later mode-precedence block can drift the working
 * submodule and vary `.gitmodules` vs config update modes against the same C2 pin.
 */
const SUBMODULE_AUTHOR_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

/** `git` with `protocol.file.allow=always` (mandatory for `file://` submodules). */
const subGit = (cwd: string, ...args: ReadonlyArray<string>): string =>
  runGit(['-c', 'protocol.file.allow=always', '-C', cwd, ...args], { env: SUBMODULE_AUTHOR_ENV });

interface SubmoduleFixture {
  /** The base tmpdir holding `sub`, `super`, and the per-test clones. */
  readonly base: string;
  /** Clone the superproject into a fresh dir under `base`; returns its path. */
  readonly freshClone: () => string;
  /** The sub's C1 and C2 commit oids (C2 is the superproject pin). */
  readonly c1: string;
  readonly c2: string;
}

/**
 * Controls line numbers in the rewritten clone config: the valueless `url`
 * lands at line 4.
 * Line 1: [core]
 * Line 2: \trepositoryformatversion = 0
 * Line 3: [submodule "mysub"]
 * Line 4: \turl           <- valueless
 */
const VALUELESS_SUBMODULE_URL_FIXTURE =
  '[core]\n\trepositoryformatversion = 0\n[submodule "mysub"]\n\turl\n';
const VALUELESS_SUBMODULE_URL_LINE = 4;

/** `[submodule "mysub"]` present but no url line — the absent case. */
const ABSENT_SUBMODULE_URL_FIXTURE = '[core]\n\trepositoryformatversion = 0\n[submodule "mysub"]\n';

describe.skipIf(!GIT_AVAILABLE)('missing-value-refusal interop — submodule url', () => {
  let fixture: SubmoduleFixture;

  beforeAll(async () => {
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-mv-sub-')));
    // Upstream sub: two commits so the pin (C2) differs from the tip a fresh
    // clone might land on — slice-4-ready for a drift-to-C1 precedence matrix.
    const subDir = path.join(base, 'sub');
    runGit(['init', '-q', '-b', 'main', subDir]);
    await writeFile(path.join(subDir, 'a.txt'), 'sub v1\n');
    subGit(subDir, 'add', 'a.txt');
    subGit(subDir, 'commit', '-q', '-m', 'c1');
    const c1 = subGit(subDir, 'rev-parse', 'HEAD').trim();
    await writeFile(path.join(subDir, 'a.txt'), 'sub v2\n');
    subGit(subDir, 'add', 'a.txt');
    subGit(subDir, 'commit', '-q', '-m', 'c2');
    const c2 = subGit(subDir, 'rev-parse', 'HEAD').trim();
    // Superproject pinning the sub (at C2) via a relative url.
    const superDir = path.join(base, 'super');
    runGit(['init', '-q', '-b', 'main', superDir]);
    await writeFile(path.join(superDir, 'r.txt'), 'root\n');
    subGit(superDir, 'add', 'r.txt');
    subGit(superDir, 'commit', '-q', '-m', 'root');
    subGit(superDir, 'submodule', 'add', '../sub', 'mysub');
    subGit(superDir, 'commit', '-q', '-m', 'add submodule');
    let cloneCounter = 0;
    const freshClone = (): string => {
      cloneCounter += 1;
      const dir = path.join(base, `clone-${cloneCounter}`);
      subGit(base, 'clone', '-q', superDir, dir);
      return dir;
    };
    fixture = { base, freshClone, c1, c2 };
  }, 60_000);

  afterAll(async () => {
    if (fixture !== undefined) await rm(fixture.base, { recursive: true, force: true });
  });

  describe('Given a clone with a valueless submodule.mysub.url at line 4', () => {
    describe('When git submodule update is run', () => {
      it('Then git refuses with exit 128 and the two-line missing-value message', async () => {
        // Arrange
        const clone = fixture.freshClone();
        await writeFile(path.join(clone, '.git', 'config'), VALUELESS_SUBMODULE_URL_FIXTURE);

        // Act
        const g = tryRunGit(
          ['-c', 'protocol.file.allow=always', '-C', clone, 'submodule', 'update'],
          { env: SUBMODULE_AUTHOR_ENV },
        );

        // Assert
        expect(g.ok).toBe(false);
        expect(g.stderr).toContain("missing value for 'submodule.mysub.url'");
        expect(g.stderr).toContain("bad config variable 'submodule.mysub.url'");
        expect(g.stderr).toContain(`at line ${VALUELESS_SUBMODULE_URL_LINE}`);
      });
    });

    describe('When tsgit submodule.update is run', () => {
      it('Then throws CONFIG_MISSING_VALUE with key submodule.mysub.url and correct line', async () => {
        // Arrange
        const clone = fixture.freshClone();
        await writeFile(path.join(clone, '.git', 'config'), VALUELESS_SUBMODULE_URL_FIXTURE);
        const repo = await openRepository({ cwd: clone });

        // Act
        let caught: unknown;
        try {
          await repo.submodule.update({});
        } catch (err) {
          caught = err;
        }

        // Assert — each field individually (mutation-resistant)
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as {
          code: string;
          key: string;
          line: number;
          source: string;
        };
        expect(data.code).toBe('CONFIG_MISSING_VALUE');
        expect(data.key).toBe('submodule.mysub.url');
        expect(data.line).toBe(VALUELESS_SUBMODULE_URL_LINE);
        expect(data.source).toMatch(/\/config$/);
      });
    });

    describe("When reconstructing git's two lines from tsgit submodule.update structured fields", () => {
      it("Then the reconstructed lines match git's stderr after path-token normalization", async () => {
        // Arrange
        const clone = fixture.freshClone();
        await writeFile(path.join(clone, '.git', 'config'), VALUELESS_SUBMODULE_URL_FIXTURE);

        // Act — run both git and tsgit against the same clone
        const g = tryRunGit(
          ['-c', 'protocol.file.allow=always', '-C', clone, 'submodule', 'update'],
          { env: SUBMODULE_AUTHOR_ENV },
        );
        const repo = await openRepository({ cwd: clone });
        let caught: unknown;
        try {
          await repo.submodule.update({});
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as {
          code: string;
          key: string;
          line: number;
          source: string;
        };
        const gitLines = g.stderr.split('\n').filter((l) => l.length > 0);
        const errorLine = gitLines.find((l) => l.startsWith('error:')) ?? '';
        const fatalLine = gitLines.find((l) => l.startsWith('fatal:')) ?? '';

        expect(errorLine).toBe(`error: missing value for '${data.key}'`);

        const normalizedSource = '.git/config';
        const tsgitFatalLine = `fatal: bad config variable '${data.key}' in file '${normalizedSource}' at line ${data.line}`;
        const normalizedFatalLine = fatalLine.replace(
          /in file '[^']+'/,
          `in file '${normalizedSource}'`,
        );
        expect(normalizedFatalLine).toBe(tsgitFatalLine);
      });
    });

    describe('When tsgit configList is run on the same file', () => {
      it('Then tsgit configList does not throw (refusal is at consumer, not read)', async () => {
        // Arrange
        const clone = fixture.freshClone();
        await writeFile(path.join(clone, '.git', 'config'), VALUELESS_SUBMODULE_URL_FIXTURE);
        const ctx = createNodeContext({ workDir: clone });

        // Act + Assert — no throw
        await expect(configList(ctx, {})).resolves.toBeDefined();
      });
    });
  });

  describe('Given a clone with [submodule "mysub"] but no url (absent)', () => {
    describe('When tsgit submodule.update is run without init', () => {
      it('Then the registered-but-urlless submodule is skipped and NOT CONFIG_MISSING_VALUE', async () => {
        // Arrange
        const clone = fixture.freshClone();
        await writeFile(path.join(clone, '.git', 'config'), ABSENT_SUBMODULE_URL_FIXTURE);
        const repo = await openRepository({ cwd: clone });

        // Act
        let caught: unknown;
        let result: { entries: ReadonlyArray<unknown> } | undefined;
        try {
          result = await repo.submodule.update({});
        } catch (err) {
          caught = err;
        }

        // Assert — absent url skips the row, no death
        expect(caught).toBeUndefined();
        expect(result?.entries).toHaveLength(0);
      });
    });
  });
});

/**
 * Heavy submodule update-mode block (`file://` upstream submodule). One shared
 * `beforeAll` builds a real upstream sub (C1→C2), a superproject pinning it at C2,
 * and a `driftedClone()` helper that clones, populates the submodule (at C2 via
 * `submodule update --init`), and drifts the working submodule back to C1 — so a
 * `checkout`-mode update moves it C1→C2 and a `none`-mode update leaves it at C1.
 * The block pins:
 *   - the config-over-`.gitmodules` precedence matrix (tsgit submodule HEAD == git
 *     HEAD per row, both override directions),
 *   - the valueless `submodule.mysub.update` refusal (git pin / tsgit pin /
 *     reconstruction / absent → `.gitmodules`-sourced mode / `--list` ok),
 *   - the update-priority co-occurrence ordering (both orders report `update`,
 *     url-only reports `url`).
 * 60s timeout: heavy git-spawning interop times out hooks under validate's
 * concurrency otherwise (project memory).
 */
interface UpdateModeFixture {
  readonly base: string;
  /** Clone the superproject, populate the submodule at C2, drift it back to C1. */
  readonly driftedClone: () => string;
  /** Read the working submodule's current HEAD oid in a clone. */
  readonly subHead: (clone: string) => string;
  readonly c1: string;
  readonly c2: string;
}

/** Rewrite `submodule.mysub.update` in `.gitmodules`/config (file-write, valued). */
const setUpdateLine = async (
  filePath: string,
  baseText: string,
  mode: string | undefined,
): Promise<void> => {
  const line = mode !== undefined ? `\tupdate = ${mode}\n` : '';
  await writeFile(filePath, `${baseText}${line}`);
};

/**
 * Controls line numbers for the valueless `submodule.mysub.update` case.
 * Line 1: [core]
 * Line 2: \trepositoryformatversion = 0
 * Line 3: [submodule "mysub"]
 * Line 4: \turl = <relative>
 * Line 5: \tupdate          <- valueless
 */
const VALUELESS_SUBMODULE_UPDATE_LINE = 5;
/** url@L4 valueless, update@L5 valueless → git reports update (update-priority). */
const URL_THEN_UPDATE_VALUELESS =
  '[core]\n\trepositoryformatversion = 0\n[submodule "mysub"]\n\turl\n\tupdate\n';
/** update@L4 valueless, url@L5 valueless → git reports update. */
const UPDATE_THEN_URL_VALUELESS =
  '[core]\n\trepositoryformatversion = 0\n[submodule "mysub"]\n\tupdate\n\turl\n';
/** url@L4 valueless, update absent → git reports url. */
const URL_VALUELESS_UPDATE_ABSENT =
  '[core]\n\trepositoryformatversion = 0\n[submodule "mysub"]\n\turl\n';

describe.skipIf(!GIT_AVAILABLE)('missing-value-refusal interop — submodule update', () => {
  let fixture: UpdateModeFixture;
  /** The clone config preamble whose valueless `url`/`update` lands at line 5. */
  let configWithUrl: string;
  /** The clone's `.gitmodules` text up to (not including) the `update` line. */
  let gitmodulesBase: string;

  beforeAll(async () => {
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-mv-subupd-')));
    const subDir = path.join(base, 'sub');
    runGit(['init', '-q', '-b', 'main', subDir]);
    await writeFile(path.join(subDir, 'a.txt'), 'sub v1\n');
    subGit(subDir, 'add', 'a.txt');
    subGit(subDir, 'commit', '-q', '-m', 'c1');
    const c1 = subGit(subDir, 'rev-parse', 'HEAD').trim();
    await writeFile(path.join(subDir, 'a.txt'), 'sub v2\n');
    subGit(subDir, 'add', 'a.txt');
    subGit(subDir, 'commit', '-q', '-m', 'c2');
    const c2 = subGit(subDir, 'rev-parse', 'HEAD').trim();
    const superDir = path.join(base, 'super');
    runGit(['init', '-q', '-b', 'main', superDir]);
    await writeFile(path.join(superDir, 'r.txt'), 'root\n');
    subGit(superDir, 'add', 'r.txt');
    subGit(superDir, 'commit', '-q', '-m', 'root');
    subGit(superDir, 'submodule', 'add', '../sub', 'mysub');
    // Pin the submodule at C2, then drift the superproject's recorded gitlink
    // is left at C2 (the just-added tip). The clone drifts its working copy.
    subGit(superDir, 'commit', '-q', '-m', 'add submodule');
    let cloneCounter = 0;
    const driftedClone = (): string => {
      cloneCounter += 1;
      const dir = path.join(base, `clone-${cloneCounter}`);
      subGit(base, 'clone', '-q', superDir, dir);
      subGit(dir, 'submodule', 'update', '--init');
      subGit(path.join(dir, 'mysub'), 'checkout', '-q', c1);
      return dir;
    };
    const subHead = (clone: string): string =>
      subGit(path.join(clone, 'mysub'), 'rev-parse', 'HEAD').trim();
    fixture = { base, driftedClone, subHead, c1, c2 };
    // The relative url a clone records for the submodule (read from a sample clone).
    const sample = driftedClone();
    const url = subGit(sample, 'config', '--get', 'submodule.mysub.url').trim();
    configWithUrl = `[core]\n\trepositoryformatversion = 0\n[submodule "mysub"]\n\turl = ${url}\n`;
    gitmodulesBase = `[submodule "mysub"]\n\tpath = mysub\n\turl = ${url}\n`;
  }, 60_000);

  afterAll(async () => {
    if (fixture !== undefined) await rm(fixture.base, { recursive: true, force: true });
  });

  describe('Given config submodule.mysub.update overrides the .gitmodules mode', () => {
    const matrix: ReadonlyArray<{
      readonly title: string;
      readonly gitmodulesMode: string | undefined;
      readonly configMode: string | undefined;
    }> = [
      {
        title: 'config checkout over .gitmodules none',
        gitmodulesMode: 'none',
        configMode: 'checkout',
      },
      {
        title: 'config none over .gitmodules checkout',
        gitmodulesMode: 'checkout',
        configMode: 'none',
      },
      {
        title: '.gitmodules none with config unset',
        gitmodulesMode: 'none',
        configMode: undefined,
      },
      {
        title: '.gitmodules checkout with config unset',
        gitmodulesMode: 'checkout',
        configMode: undefined,
      },
      { title: 'both unset (checkout default)', gitmodulesMode: undefined, configMode: undefined },
    ];

    const applyModes = async (
      clone: string,
      gitmodulesMode: string | undefined,
      configMode: string | undefined,
    ): Promise<void> => {
      await setUpdateLine(path.join(clone, '.gitmodules'), gitmodulesBase, gitmodulesMode);
      if (configMode !== undefined) subGit(clone, 'config', 'submodule.mysub.update', configMode);
    };

    for (const row of matrix) {
      describe(`When the resolved mode is ${row.title}`, () => {
        it('Then tsgit reconciles the working submodule to the same HEAD as git', async () => {
          // Arrange — two independent drifted clones, identical modes
          const gitClone = fixture.driftedClone();
          const tsgitClone = fixture.driftedClone();
          await applyModes(gitClone, row.gitmodulesMode, row.configMode);
          await applyModes(tsgitClone, row.gitmodulesMode, row.configMode);

          // Act
          subGit(gitClone, 'submodule', 'update');
          const repo = await openRepository({ cwd: tsgitClone });
          await repo.submodule.update({});

          // Assert — same submodule HEAD, and it is the precedence-decided one
          expect(fixture.subHead(tsgitClone)).toBe(fixture.subHead(gitClone));
        });
      });
    }
  });

  describe('Given a clone with a valueless submodule.mysub.update at line 5', () => {
    const fixtureText = (): string => `${configWithUrl}\tupdate\n`;

    describe('When git submodule update is run', () => {
      it('Then git refuses with exit 128 and the two-line missing-value message', async () => {
        // Arrange
        const clone = fixture.driftedClone();
        await writeFile(path.join(clone, '.git', 'config'), fixtureText());

        // Act
        const g = tryRunGit(
          ['-c', 'protocol.file.allow=always', '-C', clone, 'submodule', 'update'],
          { env: SUBMODULE_AUTHOR_ENV },
        );

        // Assert
        expect(g.ok).toBe(false);
        expect(g.stderr).toContain("missing value for 'submodule.mysub.update'");
        expect(g.stderr).toContain("bad config variable 'submodule.mysub.update'");
        expect(g.stderr).toContain(`at line ${VALUELESS_SUBMODULE_UPDATE_LINE}`);
      });
    });

    describe('When tsgit submodule.update is run', () => {
      it('Then it throws CONFIG_MISSING_VALUE with key submodule.mysub.update and correct line', async () => {
        // Arrange
        const clone = fixture.driftedClone();
        await writeFile(path.join(clone, '.git', 'config'), fixtureText());
        const repo = await openRepository({ cwd: clone });

        // Act
        let caught: unknown;
        try {
          await repo.submodule.update({});
        } catch (err) {
          caught = err;
        }

        // Assert — each field individually (mutation-resistant)
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as {
          code: string;
          key: string;
          line: number;
          source: string;
        };
        expect(data.code).toBe('CONFIG_MISSING_VALUE');
        expect(data.key).toBe('submodule.mysub.update');
        expect(data.line).toBe(VALUELESS_SUBMODULE_UPDATE_LINE);
        expect(data.source).toMatch(/\/config$/);
      });
    });

    describe("When reconstructing git's two lines from tsgit structured fields", () => {
      it("Then the reconstructed lines match git's stderr after path-token normalization", async () => {
        // Arrange
        const clone = fixture.driftedClone();
        await writeFile(path.join(clone, '.git', 'config'), fixtureText());

        // Act — run both git and tsgit against the same clone
        const g = tryRunGit(
          ['-c', 'protocol.file.allow=always', '-C', clone, 'submodule', 'update'],
          { env: SUBMODULE_AUTHOR_ENV },
        );
        const repo = await openRepository({ cwd: clone });
        let caught: unknown;
        try {
          await repo.submodule.update({});
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { key: string; line: number };
        const gitLines = g.stderr.split('\n').filter((l) => l.length > 0);
        const errorLine = gitLines.find((l) => l.startsWith('error:')) ?? '';
        const fatalLine = gitLines.find((l) => l.startsWith('fatal:')) ?? '';

        expect(errorLine).toBe(`error: missing value for '${data.key}'`);

        const normalizedSource = '.git/config';
        const tsgitFatalLine = `fatal: bad config variable '${data.key}' in file '${normalizedSource}' at line ${data.line}`;
        const normalizedFatalLine = fatalLine.replace(
          /in file '[^']+'/,
          `in file '${normalizedSource}'`,
        );
        expect(normalizedFatalLine).toBe(tsgitFatalLine);
      });
    });

    describe('When tsgit configList is run on the same file', () => {
      it('Then tsgit configList does not throw (refusal is at consumer, not read)', async () => {
        // Arrange
        const clone = fixture.driftedClone();
        await writeFile(path.join(clone, '.git', 'config'), fixtureText());
        const ctx = createNodeContext({ workDir: clone });

        // Act + Assert — no throw
        await expect(configList(ctx, {})).resolves.toBeDefined();
      });
    });
  });

  describe('Given a clone whose submodule.mysub.update is absent (only .gitmodules sets it)', () => {
    describe('When tsgit submodule.update is run', () => {
      it('Then the .gitmodules-sourced mode applies (none) and NOT CONFIG_MISSING_VALUE', async () => {
        // Arrange — .gitmodules update=none, config has a valued url and no update
        const clone = fixture.driftedClone();
        await setUpdateLine(path.join(clone, '.gitmodules'), gitmodulesBase, 'none');
        const repo = await openRepository({ cwd: clone });

        // Act
        const result = await repo.submodule.update({});

        // Assert — .gitmodules none was applied (no-op), working submodule stays C1
        expect(result.entries[0]).toMatchObject({ mode: 'none', changed: false });
        expect(fixture.subHead(clone)).toBe(fixture.c1);
      });
    });
  });

  describe('Given co-occurring valueless submodule.mysub keys (update-priority)', () => {
    const cases: ReadonlyArray<{
      readonly title: string;
      readonly text: string;
      readonly expectedKey: string;
    }> = [
      {
        title: 'url valueless on an earlier line than a valueless update',
        text: URL_THEN_UPDATE_VALUELESS,
        expectedKey: 'submodule.mysub.update',
      },
      {
        title: 'update valueless on an earlier line than a valueless url',
        text: UPDATE_THEN_URL_VALUELESS,
        expectedKey: 'submodule.mysub.update',
      },
      {
        title: 'url valueless and update absent',
        text: URL_VALUELESS_UPDATE_ABSENT,
        expectedKey: 'submodule.mysub.url',
      },
    ];

    for (const c of cases) {
      describe(`When ${c.title}`, () => {
        it(`Then both git and tsgit report ${c.expectedKey}`, async () => {
          // Arrange
          const clone = fixture.driftedClone();
          await writeFile(path.join(clone, '.git', 'config'), c.text);

          // Act — git
          const g = tryRunGit(
            ['-c', 'protocol.file.allow=always', '-C', clone, 'submodule', 'update'],
            { env: SUBMODULE_AUTHOR_ENV },
          );
          // Act — tsgit
          const repo = await openRepository({ cwd: clone });
          let caught: unknown;
          try {
            await repo.submodule.update({});
          } catch (err) {
            caught = err;
          }

          // Assert — git reports the priority key, tsgit matches
          expect(g.ok).toBe(false);
          expect(g.stderr).toContain(`missing value for '${c.expectedKey}'`);
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { code: string; key: string };
          expect(data.code).toBe('CONFIG_MISSING_VALUE');
          expect(data.key).toBe(c.expectedKey);
        });
      });
    }
  });
});

/**
 * `[core]` eager broad-gate breadth matrix. git validates `core.excludesfile`
 * and `core.attributesfile` eagerly in `git_default_config`, so they die on the
 * ENTIRE operational surface — including config-free ref-listing (`branch`/`tag`
 * list) — yet the config porcelain (`config --get`/`--list`/`--get-regexp`)
 * survives through its separate read path. tsgit must reproduce this split: the
 * operational commands refuse via `assertOperationalRepository`, the porcelain
 * stays on the bare `assertRepository`.
 *
 * The fixtures are light (a one-commit repo + a hand-written `[core]` config),
 * so each case uses its own `beforeEach` tmpdir.
 */
const CORE_AUTHOR_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

const CORE_COMMIT_AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

/**
 * Controls line numbers: the valueless `[core]` path-like lands at line 2.
 * Line 1: [core]
 * Line 2: \t<key>          <- valueless
 */
const valuelessCoreFixture = (key: string): string => `[core]\n\t${key}\n`;
const VALUELESS_CORE_LINE = 2;

interface CoreData {
  readonly code: string;
  readonly key: string;
  readonly line: number;
  readonly source: string;
}

const assertCoreRefusal = (caught: unknown, key: string): void => {
  expect(caught).toBeInstanceOf(TsgitError);
  const data = (caught as TsgitError).data as CoreData;
  expect(data.code).toBe('CONFIG_MISSING_VALUE');
  expect(data.key).toBe(key);
  expect(data.line).toBe(VALUELESS_CORE_LINE);
  expect(data.source).toMatch(/\/config$/);
};

describe.skipIf(!GIT_AVAILABLE)(
  'missing-value-refusal interop — core path-likes eager broad gate',
  () => {
    let ours: string;

    beforeEach(async () => {
      ours = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-mv-core-')));
      runGit(['init', '-q', '-b', 'main', ours]);
      await writeFile(path.join(ours, 'r.txt'), 'root\n');
      runGit(['-C', ours, 'add', 'r.txt']);
      runGit(['-C', ours, 'commit', '-q', '-m', 'root'], { env: CORE_AUTHOR_ENV });
      runGit(['-C', ours, 'tag', 'v1']);
    });

    afterEach(async () => {
      await rm(ours, { recursive: true, force: true });
    });

    for (const key of ['excludesfile', 'attributesfile'] as const) {
      const qualifiedKey = `core.${key}`;

      describe(`Given a config with a valueless core.${key}`, () => {
        describe('When operational commands run', () => {
          it('Then git refuses with exit 128 and the two-line missing-value message', async () => {
            // Arrange
            await writeFile(path.join(ours, '.git', 'config'), valuelessCoreFixture(key));

            // Act — a representative work-doing command plus pure ref-listing
            const gStatus = tryRunGit(['-C', ours, 'status'], { env: runGitEnv() });
            const gBranch = tryRunGit(['-C', ours, 'branch'], { env: runGitEnv() });
            const gTag = tryRunGit(['-C', ours, 'tag'], { env: runGitEnv() });

            // Assert — every operational command dies, including ref-listing
            for (const g of [gStatus, gBranch, gTag]) {
              expect(g.ok).toBe(false);
              expect(g.stderr).toContain(`missing value for '${qualifiedKey}'`);
              expect(g.stderr).toContain(`bad config variable '${qualifiedKey}'`);
              expect(g.stderr).toContain(`at line ${VALUELESS_CORE_LINE}`);
            }
          });

          it('Then tsgit status refuses with CONFIG_MISSING_VALUE', async () => {
            // Arrange
            await writeFile(path.join(ours, '.git', 'config'), valuelessCoreFixture(key));
            const repo = await openRepository({ cwd: ours });

            // Act
            let caught: unknown;
            try {
              await repo.status();
            } catch (err) {
              caught = err;
            }

            // Assert
            assertCoreRefusal(caught, qualifiedKey);
          });

          it('Then tsgit log refuses with CONFIG_MISSING_VALUE', async () => {
            // Arrange
            await writeFile(path.join(ours, '.git', 'config'), valuelessCoreFixture(key));
            const repo = await openRepository({ cwd: ours });

            // Act
            let caught: unknown;
            try {
              await repo.log({});
            } catch (err) {
              caught = err;
            }

            // Assert
            assertCoreRefusal(caught, qualifiedKey);
          });

          it('Then tsgit commit refuses with CONFIG_MISSING_VALUE', async () => {
            // Arrange
            await writeFile(path.join(ours, 'r.txt'), 'changed\n');
            runGit(['-C', ours, 'add', 'r.txt']);
            await writeFile(path.join(ours, '.git', 'config'), valuelessCoreFixture(key));
            const repo = await openRepository({ cwd: ours });

            // Act
            let caught: unknown;
            try {
              await repo.commit({ message: 'x', author: CORE_COMMIT_AUTHOR });
            } catch (err) {
              caught = err;
            }

            // Assert
            assertCoreRefusal(caught, qualifiedKey);
          });

          it('Then tsgit branch.list refuses with CONFIG_MISSING_VALUE (ref-listing breadth)', async () => {
            // Arrange
            await writeFile(path.join(ours, '.git', 'config'), valuelessCoreFixture(key));
            const repo = await openRepository({ cwd: ours });

            // Act
            let caught: unknown;
            try {
              await repo.branch.list();
            } catch (err) {
              caught = err;
            }

            // Assert
            assertCoreRefusal(caught, qualifiedKey);
          });

          it('Then tsgit tag.list refuses with CONFIG_MISSING_VALUE (ref-listing breadth)', async () => {
            // Arrange
            await writeFile(path.join(ours, '.git', 'config'), valuelessCoreFixture(key));
            const repo = await openRepository({ cwd: ours });

            // Act
            let caught: unknown;
            try {
              await repo.tag.list();
            } catch (err) {
              caught = err;
            }

            // Assert
            assertCoreRefusal(caught, qualifiedKey);
          });
        });

        describe("When reconstructing git's two lines from tsgit status fields", () => {
          it("Then the reconstructed lines match git's stderr after path-token normalization", async () => {
            // Arrange
            await writeFile(path.join(ours, '.git', 'config'), valuelessCoreFixture(key));

            // Act — run both git and tsgit on the same fixture
            const g = tryRunGit(['-C', ours, 'status'], { env: runGitEnv() });
            const repo = await openRepository({ cwd: ours });
            let caught: unknown;
            try {
              await repo.status();
            } catch (err) {
              caught = err;
            }

            // Assert
            expect(caught).toBeInstanceOf(TsgitError);
            const data = (caught as TsgitError).data as CoreData;
            const gitLines = g.stderr.split('\n').filter((l) => l.length > 0);
            const errorLine = gitLines.find((l) => l.startsWith('error:')) ?? '';
            const fatalLine = gitLines.find((l) => l.startsWith('fatal:')) ?? '';

            expect(errorLine).toBe(`error: missing value for '${data.key}'`);

            const normalizedSource = '.git/config';
            const tsgitFatalLine = `fatal: bad config variable '${data.key}' in file '${normalizedSource}' at line ${data.line}`;
            const normalizedFatalLine = fatalLine.replace(
              /in file '[^']+'/,
              `in file '${normalizedSource}'`,
            );
            expect(normalizedFatalLine).toBe(tsgitFatalLine);
          });
        });

        describe('When the config porcelain reads the same fixture', () => {
          it('Then git config --get/--list/--get-regexp all survive (exit 0)', async () => {
            // Arrange
            await writeFile(path.join(ours, '.git', 'config'), valuelessCoreFixture(key));
            const configPath = path.join(ours, '.git', 'config');

            // Act
            const gList = tryRunGit(['config', '--file', configPath, '--list']);
            const gGet = tryRunGit(['config', '--file', configPath, '--get', qualifiedKey]);
            const gRegexp = tryRunGit([
              'config',
              '--file',
              configPath,
              '--get-regexp',
              'core\\..*',
            ]);

            // Assert — the porcelain bypasses the eager gate
            expect(gList.ok).toBe(true);
            expect(gGet.ok).toBe(true);
            expect(gRegexp.ok).toBe(true);
          });

          it('Then tsgit configList/configGet/configGetRegexp all survive with the valueless entry visible', async () => {
            // Arrange
            await writeFile(path.join(ours, '.git', 'config'), valuelessCoreFixture(key));
            const ctx = createNodeContext({ workDir: ours });

            // Act
            const list = await configList(ctx, {});
            const regexp = await configGetRegexp(ctx, { keyPattern: /core\..*/ });
            let getCaught: unknown;
            try {
              await configGet(ctx, { key: qualifiedKey });
            } catch (err) {
              getCaught = err;
            }

            // Assert — porcelain survives; the valueless entry is visible as value: null
            const listed = list.entries.find((e) => e.key === qualifiedKey);
            expect(listed?.value).toBeNull();
            const matched = regexp.entries.find((e) => e.key === qualifiedKey);
            expect(matched?.value).toBeNull();
            // configGet of a valueless key surfaces it as a present entry, never CONFIG_MISSING_VALUE.
            if (getCaught !== undefined) {
              expect((getCaught as TsgitError).data.code).not.toBe('CONFIG_MISSING_VALUE');
            }
          });
        });
      });
    }

    describe('Given a config with both core path-likes valueless and excludesfile earlier', () => {
      describe('When git status and tsgit status run', () => {
        it('Then both report the earlier-by-line key core.excludesfile at line 2', async () => {
          // Arrange
          await writeFile(
            path.join(ours, '.git', 'config'),
            '[core]\n\texcludesfile\n\tattributesfile\n',
          );

          // Act
          const g = tryRunGit(['-C', ours, 'status'], { env: runGitEnv() });
          const repo = await openRepository({ cwd: ours });
          let caught: unknown;
          try {
            await repo.status();
          } catch (err) {
            caught = err;
          }

          // Assert — git reports excludesfile (earlier line), tsgit matches
          expect(g.ok).toBe(false);
          expect(g.stderr).toContain("missing value for 'core.excludesfile'");
          expect(g.stderr).toContain('at line 2');
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { code: string; key: string; line: number };
          expect(data.code).toBe('CONFIG_MISSING_VALUE');
          expect(data.key).toBe('core.excludesfile');
          expect(data.line).toBe(2);
        });
      });
    });

    describe('Given a config with both core path-likes valueless and attributesfile earlier', () => {
      describe('When git status and tsgit status run', () => {
        it('Then both report the earlier-by-line key core.attributesfile at line 2', async () => {
          // Arrange
          await writeFile(
            path.join(ours, '.git', 'config'),
            '[core]\n\tattributesfile\n\texcludesfile\n',
          );

          // Act
          const g = tryRunGit(['-C', ours, 'status'], { env: runGitEnv() });
          const repo = await openRepository({ cwd: ours });
          let caught: unknown;
          try {
            await repo.status();
          } catch (err) {
            caught = err;
          }

          // Assert — git reports attributesfile (earlier line), tsgit matches
          expect(g.ok).toBe(false);
          expect(g.stderr).toContain("missing value for 'core.attributesfile'");
          expect(g.stderr).toContain('at line 2');
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { code: string; key: string; line: number };
          expect(data.code).toBe('CONFIG_MISSING_VALUE');
          expect(data.key).toBe('core.attributesfile');
          expect(data.line).toBe(2);
        });
      });
    });

    describe('Given a config with a valued [core] section', () => {
      describe('When tsgit status runs', () => {
        it('Then it does not throw CONFIG_MISSING_VALUE (the gate no-ops on valued)', async () => {
          // Arrange
          await writeFile(path.join(ours, '.git', 'config'), '[core]\n\texcludesfile = /tmp/x\n');
          const repo = await openRepository({ cwd: ours });

          // Act
          let caught: unknown;
          try {
            await repo.status();
          } catch (err) {
            caught = err;
          }

          // Assert — a valued path-like resolves; no missing-value refusal
          if (caught !== undefined) {
            expect((caught as TsgitError).data.code).not.toBe('CONFIG_MISSING_VALUE');
          }
        });
      });
    });

    /**
     * Int keys: `core.loosecompression` and `core.compression` die on the same
     * eager broad gate as the string path-likes (decision 6=b cross-class line
     * compare). Git's death message is a ONE-line `fatal:` with no `error:` prefix
     * and no `at line` suffix — distinct from the string two-line shape.
     *
     * Line layout for the simple int fixture (valueless at line 2):
     *   Line 1: [core]
     *   Line 2: \tloosecompression   <- valueless
     */
    const VALUELESS_INT_LINE = 2;
    const valuelessIntFixture = (key: string): string => `[core]\n\t${key}\n`;

    interface IntData {
      readonly code: string;
      readonly key: string;
      readonly value: string;
      readonly reason: string;
      readonly source: string;
    }

    describe('Given a config with a valueless core.loosecompression', () => {
      describe('When git status runs', () => {
        it('Then git refuses with exit 128, single fatal line, no error: prefix, no at line', async () => {
          // Arrange
          await writeFile(
            path.join(ours, '.git', 'config'),
            valuelessIntFixture('loosecompression'),
          );

          // Act
          const g = tryRunGit(['-C', ours, 'status'], { env: runGitEnv() });

          // Assert — git dies on the int key; single-line (no error: line)
          expect(g.ok).toBe(false);
          expect(g.stderr).toContain("bad numeric config value ''");
          expect(g.stderr).toContain("for 'core.loosecompression'");
          expect(g.stderr).toContain(': invalid unit');
          expect(g.stderr).not.toMatch(/^error:/m);
          expect(g.stderr).not.toContain('at line');
        }, 60_000);
      });

      describe('When tsgit status / log / branch.list run', () => {
        it('Then tsgit status throws CONFIG_BAD_NUMERIC_VALUE with correct fields', async () => {
          // Arrange
          await writeFile(
            path.join(ours, '.git', 'config'),
            valuelessIntFixture('loosecompression'),
          );
          const repo = await openRepository({ cwd: ours });

          // Act
          let caught: unknown;
          try {
            await repo.status();
          } catch (err) {
            caught = err;
          }

          // Assert — each field individually (mutation-resistant)
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as IntData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.loosecompression');
          expect(data.value).toBe('');
          expect(data.reason).toBe('invalid unit');
          expect(data.source).toMatch(/\/config$/);
        }, 60_000);

        it('Then tsgit log throws CONFIG_BAD_NUMERIC_VALUE (ref-listing breadth)', async () => {
          // Arrange
          await writeFile(
            path.join(ours, '.git', 'config'),
            valuelessIntFixture('loosecompression'),
          );
          const repo = await openRepository({ cwd: ours });

          // Act
          let caught: unknown;
          try {
            await repo.log({});
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
        }, 60_000);

        it('Then tsgit branch.list throws CONFIG_BAD_NUMERIC_VALUE (ref-listing breadth)', async () => {
          // Arrange
          await writeFile(
            path.join(ours, '.git', 'config'),
            valuelessIntFixture('loosecompression'),
          );
          const repo = await openRepository({ cwd: ours });

          // Act
          let caught: unknown;
          try {
            await repo.branch.list();
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
        }, 60_000);
      });

      describe('When reconstructing the single-line fatal from tsgit structured fields', () => {
        it('Then the reconstructed line matches git stderr (unquoted file, no at line)', async () => {
          // Arrange
          await writeFile(
            path.join(ours, '.git', 'config'),
            valuelessIntFixture('loosecompression'),
          );

          // Act — run both tools on the same fixture
          const g = tryRunGit(['-C', ours, 'status'], { env: runGitEnv() });
          const repo = await openRepository({ cwd: ours });
          let caught: unknown;
          try {
            await repo.status();
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as IntData;
          const gitLines = g.stderr.split('\n').filter((l) => l.length > 0);
          // No error: line — only a fatal: line
          expect(gitLines.some((l) => l.startsWith('error:'))).toBe(false);
          const fatalLine = gitLines.find((l) => l.startsWith('fatal:')) ?? '';

          // Reconstruct tsgit's single line with repo-relative path normalization
          const normalizedSource = '.git/config';
          const tsgitFatalLine = `fatal: bad numeric config value '${data.value}' for '${data.key}' in file ${normalizedSource}: ${data.reason}`;
          const normalizedFatalLine = fatalLine.replace(
            /in file [^\s:]+/,
            `in file ${normalizedSource}`,
          );
          expect(normalizedFatalLine).toBe(tsgitFatalLine);
        }, 60_000);
      });

      describe('When a sibling string key (excludesfile) is also valueless (shape-distinctness)', () => {
        it('Then the string key alone refuses CONFIG_MISSING_VALUE (two-line, with at line)', async () => {
          // Arrange — string key only, valued int
          await writeFile(path.join(ours, '.git', 'config'), valuelessCoreFixture('excludesfile'));
          const repo = await openRepository({ cwd: ours });

          // Act
          let caught: unknown;
          try {
            await repo.status();
          } catch (err) {
            caught = err;
          }

          // Assert — CONFIG_MISSING_VALUE shape (distinct from CONFIG_BAD_NUMERIC_VALUE)
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as CoreData;
          expect(data.code).toBe('CONFIG_MISSING_VALUE');
          expect(data.key).toBe('core.excludesfile');
          expect(data.line).toBe(VALUELESS_CORE_LINE);
        }, 60_000);
      });

      describe('When config porcelain reads the same valueless int fixture', () => {
        it('Then tsgit configList/configGet/configGetRegexp all survive (porcelain bypass)', async () => {
          // Arrange
          await writeFile(
            path.join(ours, '.git', 'config'),
            valuelessIntFixture('loosecompression'),
          );
          const ctx = createNodeContext({ workDir: ours });

          // Act
          const list = await configList(ctx, {});
          const regexp = await configGetRegexp(ctx, { keyPattern: /core\..*/ });
          let getCaught: unknown;
          try {
            await configGet(ctx, { key: 'core.loosecompression' });
          } catch (err) {
            getCaught = err;
          }

          // Assert — porcelain survives; valueless entry visible as value: null
          const listed = list.entries.find((e) => e.key === 'core.loosecompression');
          expect(listed?.value).toBeNull();
          const matched = regexp.entries.find((e) => e.key === 'core.loosecompression');
          expect(matched?.value).toBeNull();
          if (getCaught !== undefined) {
            expect((getCaught as TsgitError).data.code).not.toBe('CONFIG_BAD_NUMERIC_VALUE');
          }
        }, 60_000);
      });

      describe('When the int key is absent from [core]', () => {
        it('Then neither git nor tsgit refuses (absent is distinct from valueless)', async () => {
          // Arrange — standard init config has no loosecompression
          // (config is as git init wrote it)
          const repo = await openRepository({ cwd: ours });

          // Act
          let caught: unknown;
          try {
            await repo.status();
          } catch (err) {
            caught = err;
          }

          // Assert — absent int key: no CONFIG_BAD_NUMERIC_VALUE
          if (caught !== undefined) {
            expect((caught as TsgitError).data.code).not.toBe('CONFIG_BAD_NUMERIC_VALUE');
          }
        }, 60_000);
      });
    });

    describe('Given a config with the int key (loosecompression) at line 2 and string key (excludesfile) at line 3', () => {
      describe('When git status and tsgit status run', () => {
        it('Then both report core.loosecompression (CONFIG_BAD_NUMERIC_VALUE — int earlier)', async () => {
          // Arrange — int (line 2) before string (line 3)
          await writeFile(
            path.join(ours, '.git', 'config'),
            '[core]\n\tloosecompression\n\texcludesfile\n',
          );

          // Act
          const g = tryRunGit(['-C', ours, 'status'], { env: runGitEnv() });
          const repo = await openRepository({ cwd: ours });
          let caught: unknown;
          try {
            await repo.status();
          } catch (err) {
            caught = err;
          }

          // Assert — git reports loosecompression (earlier); tsgit matches code
          expect(g.ok).toBe(false);
          expect(g.stderr).toContain("bad numeric config value ''");
          expect(g.stderr).toContain("for 'core.loosecompression'");
          expect(g.stderr).not.toMatch(/^error:/m);
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as IntData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.loosecompression');
        }, 60_000);
      });
    });

    describe('Given a config with the string key (excludesfile) at line 2 and int key (loosecompression) at line 3', () => {
      describe('When git status and tsgit status run', () => {
        it('Then both report core.excludesfile (CONFIG_MISSING_VALUE — string earlier)', async () => {
          // Arrange — string (line 2) before int (line 3)
          await writeFile(
            path.join(ours, '.git', 'config'),
            '[core]\n\texcludesfile\n\tloosecompression\n',
          );

          // Act
          const g = tryRunGit(['-C', ours, 'status'], { env: runGitEnv() });
          const repo = await openRepository({ cwd: ours });
          let caught: unknown;
          try {
            await repo.status();
          } catch (err) {
            caught = err;
          }

          // Assert — git reports excludesfile (earlier); tsgit matches code
          expect(g.ok).toBe(false);
          expect(g.stderr).toContain("missing value for 'core.excludesfile'");
          expect(g.stderr).toContain('at line 2');
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as CoreData;
          expect(data.code).toBe('CONFIG_MISSING_VALUE');
          expect(data.key).toBe('core.excludesfile');
          expect(data.line).toBe(VALUELESS_INT_LINE);
        }, 60_000);
      });
    });

    /**
     * Valued-invalid compression keys: `abc` / over-int64 / bad-zlib-level.
     * Each pinned against git 2.54.0 in a mktemp throwaway.
     *
     * Line layout:
     *   Line 1: [core]
     *   Line 2: \tloosecompression = <value>
     */
    interface CompressionNumericData {
      readonly code: string;
      readonly key: string;
      readonly value: string;
      readonly reason: string;
      readonly source: string;
    }

    interface CompressionZlibData {
      readonly code: string;
      readonly level: number;
    }

    describe('Given core.loosecompression = abc (invalid unit)', () => {
      describe('When git status and tsgit status run', () => {
        it('Then git refuses with bad numeric config value abc and tsgit throws CONFIG_BAD_NUMERIC_VALUE', async () => {
          // Arrange
          await writeFile(path.join(ours, '.git', 'config'), '[core]\n\tloosecompression = abc\n');

          // Act
          const g = tryRunGit(['-C', ours, 'status'], { env: runGitEnv() });
          const repo = await openRepository({ cwd: ours });
          let caught: unknown;
          try {
            await repo.status();
          } catch (err) {
            caught = err;
          }

          // Assert — git shape
          expect(g.ok).toBe(false);
          expect(g.stderr).toContain("bad numeric config value 'abc'");
          expect(g.stderr).toContain("for 'core.loosecompression'");
          expect(g.stderr).toContain(': invalid unit');
          // Assert — tsgit shape
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as CompressionNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.loosecompression');
          expect(data.value).toBe('abc');
          expect(data.reason).toBe('invalid unit');
          expect(data.source).toMatch(/\/config$/);
        }, 60_000);
      });
    });

    describe('Given core.compression = abc (invalid unit, independence)', () => {
      describe('When git status and tsgit status run', () => {
        it('Then git refuses and tsgit throws CONFIG_BAD_NUMERIC_VALUE for core.compression', async () => {
          // Arrange
          await writeFile(path.join(ours, '.git', 'config'), '[core]\n\tcompression = abc\n');

          // Act
          const g = tryRunGit(['-C', ours, 'status'], { env: runGitEnv() });
          const repo = await openRepository({ cwd: ours });
          let caught: unknown;
          try {
            await repo.status();
          } catch (err) {
            caught = err;
          }

          // Assert — git shape
          expect(g.ok).toBe(false);
          expect(g.stderr).toContain("bad numeric config value 'abc'");
          expect(g.stderr).toContain("for 'core.compression'");
          // Assert — tsgit shape
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as CompressionNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.compression');
          expect(data.value).toBe('abc');
          expect(data.reason).toBe('invalid unit');
        }, 60_000);
      });
    });

    describe('Given core.loosecompression = 999999999999999999999999 (out of range)', () => {
      describe('When git status and tsgit status run', () => {
        it('Then git refuses with out of range and tsgit throws CONFIG_BAD_NUMERIC_VALUE reason out of range', async () => {
          // Arrange
          await writeFile(
            path.join(ours, '.git', 'config'),
            '[core]\n\tloosecompression = 999999999999999999999999\n',
          );

          // Act
          const g = tryRunGit(['-C', ours, 'status'], { env: runGitEnv() });
          const repo = await openRepository({ cwd: ours });
          let caught: unknown;
          try {
            await repo.status();
          } catch (err) {
            caught = err;
          }

          // Assert — git shape
          expect(g.ok).toBe(false);
          expect(g.stderr).toContain(': out of range');
          // Assert — tsgit shape
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as CompressionNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.loosecompression');
          expect(data.reason).toBe('out of range');
        }, 60_000);
      });
    });

    describe('Given core.loosecompression = 99 (valid int, outside zlib range -1..9)', () => {
      describe('When git status and tsgit status run', () => {
        it('Then git refuses with bare bad zlib compression level 99 (no key/file) and tsgit throws CONFIG_BAD_ZLIB_LEVEL', async () => {
          // Arrange
          await writeFile(path.join(ours, '.git', 'config'), '[core]\n\tloosecompression = 99\n');

          // Act
          const g = tryRunGit(['-C', ours, 'status'], { env: runGitEnv() });
          const repo = await openRepository({ cwd: ours });
          let caught: unknown;
          try {
            await repo.status();
          } catch (err) {
            caught = err;
          }

          // Assert — git: bare fatal with no key/file token
          expect(g.ok).toBe(false);
          expect(g.stderr).toContain('bad zlib compression level 99');
          expect(g.stderr).not.toMatch(/for '/);
          // Assert — tsgit shape
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as CompressionZlibData;
          expect(data.code).toBe('CONFIG_BAD_ZLIB_LEVEL');
          expect(data.level).toBe(99);
        }, 60_000);
      });
    });

    describe('Given core.loosecompression = 1 (valid) and core.compression = 99 (bad zlib)', () => {
      describe('When tsgit status runs', () => {
        it('Then throws CONFIG_BAD_ZLIB_LEVEL for compression=99 (two-key independence, each validated independently)', async () => {
          // Arrange
          await writeFile(
            path.join(ours, '.git', 'config'),
            '[core]\n\tloosecompression = 1\n\tcompression = 99\n',
          );
          const repo = await openRepository({ cwd: ours });

          // Act
          let caught: unknown;
          try {
            await repo.status();
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as CompressionZlibData;
          expect(data.code).toBe('CONFIG_BAD_ZLIB_LEVEL');
          expect(data.level).toBe(99);
        }, 60_000);
      });
    });

    describe('Given core.excludesfile valueless (line 2) and core.loosecompression = abc (line 3) — cross-class string earlier', () => {
      describe('When tsgit status runs', () => {
        it('Then throws CONFIG_MISSING_VALUE for excludesfile (string class at lower line wins)', async () => {
          // Arrange — string valueless at line 2, compression invalid at line 3
          await writeFile(
            path.join(ours, '.git', 'config'),
            '[core]\n\texcludesfile\n\tloosecompression = abc\n',
          );
          const repo = await openRepository({ cwd: ours });

          // Act
          let caught: unknown;
          try {
            await repo.status();
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as CoreData;
          expect(data.code).toBe('CONFIG_MISSING_VALUE');
          expect(data.key).toBe('core.excludesfile');
          expect(data.line).toBe(VALUELESS_INT_LINE);
        }, 60_000);
      });
    });

    describe('Given core.loosecompression = abc (line 2) and core.excludesfile valueless (line 3) — cross-class compression earlier', () => {
      describe('When tsgit status runs', () => {
        it('Then throws CONFIG_BAD_NUMERIC_VALUE for loosecompression (compression class at lower line wins)', async () => {
          // Arrange — compression invalid at line 2, string valueless at line 3
          await writeFile(
            path.join(ours, '.git', 'config'),
            '[core]\n\tloosecompression = abc\n\texcludesfile\n',
          );
          const repo = await openRepository({ cwd: ours });

          // Act
          let caught: unknown;
          try {
            await repo.status();
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as CompressionNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.loosecompression');
          expect(data.value).toBe('abc');
          expect(data.reason).toBe('invalid unit');
        }, 60_000);
      });
    });
  },
);

/**
 * `core.hooksPath` per-accessor refusal. Unlike the `[core]` path-likes above,
 * `hooksPath`'s git death breadth is intricate, ruleless, and flag-dependent, so
 * tsgit gates it per-accessor at the hook-resolution point (`run-hook`/
 * `invokeHook`), mirroring git's `find_hook` mechanism. tsgit and git AGREE on
 * hook-running commands (commit/merge/checkout/…); tsgit accepts a DOCUMENTED
 * UNDER-REFUSAL on commands that resolve no hook (`branch.list`, `log`, …) where
 * git dies incidentally — those pins assert tsgit survives and do NOT assert git
 * agreement.
 *
 * The fixtures are light (a one-commit repo + a hand-written `[core]` config), so
 * each case uses its own `beforeEach` tmpdir.
 */
const VALUELESS_HOOKSPATH_FIXTURE = '[core]\n\thooksPath\n';
const VALUELESS_HOOKSPATH_LINE = 2;

describe.skipIf(!GIT_AVAILABLE)(
  'missing-value-refusal interop — core.hooksPath per-accessor',
  () => {
    let ours: string;

    beforeEach(async () => {
      ours = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-mv-hookspath-')));
      runGit(['init', '-q', '-b', 'main', ours]);
      await writeFile(path.join(ours, 'r.txt'), 'root\n');
      runGit(['-C', ours, 'add', 'r.txt']);
      runGit(['-C', ours, 'commit', '-q', '-m', 'root'], { env: CORE_AUTHOR_ENV });
    });

    afterEach(async () => {
      await rm(ours, { recursive: true, force: true });
    });

    describe('Given a config with a valueless core.hooksPath at line 2', () => {
      describe('When a hook-resolving command runs', () => {
        it('Then git commit refuses with exit 128 and the two-line missing-value message', async () => {
          // Arrange
          await writeFile(path.join(ours, 'r.txt'), 'changed\n');
          runGit(['-C', ours, 'add', 'r.txt']);
          await writeFile(path.join(ours, '.git', 'config'), VALUELESS_HOOKSPATH_FIXTURE);

          // Act
          const g = tryRunGit(['-C', ours, 'commit', '-m', 'x'], { env: CORE_AUTHOR_ENV });

          // Assert
          expect(g.ok).toBe(false);
          expect(g.stderr).toContain("missing value for 'core.hookspath'");
          expect(g.stderr).toContain("bad config variable 'core.hookspath'");
          expect(g.stderr).toContain(`at line ${VALUELESS_HOOKSPATH_LINE}`);
        });

        it('Then tsgit commit refuses with CONFIG_MISSING_VALUE for core.hookspath', async () => {
          // Arrange
          await writeFile(path.join(ours, 'r.txt'), 'changed\n');
          runGit(['-C', ours, 'add', 'r.txt']);
          await writeFile(path.join(ours, '.git', 'config'), VALUELESS_HOOKSPATH_FIXTURE);
          const repo = await openRepository({ cwd: ours });

          // Act
          let caught: unknown;
          try {
            await repo.commit({ message: 'x', author: CORE_COMMIT_AUTHOR });
          } catch (err) {
            caught = err;
          }

          // Assert — each field individually (mutation-resistant)
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as CoreData;
          expect(data.code).toBe('CONFIG_MISSING_VALUE');
          expect(data.key).toBe('core.hookspath');
          expect(data.line).toBe(VALUELESS_HOOKSPATH_LINE);
          expect(data.source).toMatch(/\/config$/);
        });
      });

      describe("When reconstructing git's two lines from tsgit commit fields", () => {
        it("Then the reconstructed lines match git's stderr after path-token normalization", async () => {
          // Arrange
          await writeFile(path.join(ours, 'r.txt'), 'changed\n');
          runGit(['-C', ours, 'add', 'r.txt']);
          await writeFile(path.join(ours, '.git', 'config'), VALUELESS_HOOKSPATH_FIXTURE);

          // Act — run both git and tsgit on the same fixture
          const g = tryRunGit(['-C', ours, 'commit', '-m', 'x'], { env: CORE_AUTHOR_ENV });
          const repo = await openRepository({ cwd: ours });
          let caught: unknown;
          try {
            await repo.commit({ message: 'x', author: CORE_COMMIT_AUTHOR });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as CoreData;
          const gitLines = g.stderr.split('\n').filter((l) => l.length > 0);
          const errorLine = gitLines.find((l) => l.startsWith('error:')) ?? '';
          const fatalLine = gitLines.find((l) => l.startsWith('fatal:')) ?? '';

          expect(errorLine).toBe(`error: missing value for '${data.key}'`);

          const normalizedSource = '.git/config';
          const tsgitFatalLine = `fatal: bad config variable '${data.key}' in file '${normalizedSource}' at line ${data.line}`;
          const normalizedFatalLine = fatalLine.replace(
            /in file '[^']+'/,
            `in file '${normalizedSource}'`,
          );
          expect(normalizedFatalLine).toBe(tsgitFatalLine);
        });
      });

      describe('When a command that resolves no hook runs (documented under-refusal)', () => {
        it('Then tsgit branch.list SURVIVES the valueless hooksPath (no agreement with git asserted)', async () => {
          // Arrange — git's branch listing dies incidentally on a valueless
          // hooksPath; tsgit's per-accessor gate is the recorded boundary:
          // branch.list resolves no hook, so tsgit does NOT refuse. Agreement with
          // git is deliberately NOT asserted here.
          await writeFile(path.join(ours, '.git', 'config'), VALUELESS_HOOKSPATH_FIXTURE);
          const repo = await openRepository({ cwd: ours });

          // Act
          let caught: unknown;
          try {
            await repo.branch.list();
          } catch (err) {
            caught = err;
          }

          // Assert — tsgit survives (under-refusal); definitely not a missing-value refusal
          expect(caught).toBeUndefined();
        });
      });

      describe('When the config porcelain reads the same fixture', () => {
        it('Then tsgit configList/configGet survive with the valueless entry visible', async () => {
          // Arrange
          await writeFile(path.join(ours, '.git', 'config'), VALUELESS_HOOKSPATH_FIXTURE);
          const ctx = createNodeContext({ workDir: ours });

          // Act
          const list = await configList(ctx, {});
          let getCaught: unknown;
          try {
            await configGet(ctx, { key: 'core.hookspath' });
          } catch (err) {
            getCaught = err;
          }

          // Assert — porcelain survives; the valueless entry is visible as value: null
          const listed = list.entries.find((e) => e.key === 'core.hookspath');
          expect(listed?.value).toBeNull();
          if (getCaught !== undefined) {
            expect((getCaught as TsgitError).data.code).not.toBe('CONFIG_MISSING_VALUE');
          }
        });
      });
    });

    describe('Given a config with an absent core.hooksPath', () => {
      describe('When tsgit commit runs', () => {
        it('Then it proceeds (default hooks dir), not a CONFIG_MISSING_VALUE refusal', async () => {
          // Arrange
          await writeFile(path.join(ours, 'r.txt'), 'changed\n');
          runGit(['-C', ours, 'add', 'r.txt']);
          await writeFile(
            path.join(ours, '.git', 'config'),
            '[core]\n\trepositoryformatversion = 0\n',
          );
          const repo = await openRepository({ cwd: ours });

          // Act
          let caught: unknown;
          try {
            await repo.commit({ message: 'x', author: CORE_COMMIT_AUTHOR });
          } catch (err) {
            caught = err;
          }

          // Assert — no missing-value refusal on the absent path
          if (caught !== undefined) {
            expect((caught as TsgitError).data.code).not.toBe('CONFIG_MISSING_VALUE');
          }
        });
      });
    });
  },
);

/**
 * Empty-string `core` path-likes feature-off parity. A valued-but-EMPTY
 * (`''`, has `=`) `core.excludesFile`/`attributesFile` is feature-OFF in git
 * (exit 0, no file loaded) — distinct from the VALUELESS (null, no `=`) refusal,
 * which still dies 128 (the E3a-ctrl boundary). git's CLI cannot emit a valueless
 * line, but it CAN write an empty one; we use `writeFile` for both to control the
 * exact bytes (a trailing space after `=` then newline for empty; no `=` for
 * valueless).
 *
 * The fixtures are light (a one-commit repo + a hand-written `[core]` config), so
 * each case uses its own `beforeEach` tmpdir.
 */
const emptyCoreFixture = (key: string): string => `[core]\n\t${key} = \n`;
const valuelessCorePathLikeFixture = (key: string): string => `[core]\n\t${key}\n`;

describe.skipIf(!GIT_AVAILABLE)(
  'missing-value-refusal interop — empty core path-likes feature-off',
  () => {
    let ours: string;

    beforeEach(async () => {
      ours = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-mv-empty-core-')));
      runGit(['init', '-q', '-b', 'main', ours]);
      await writeFile(path.join(ours, 'r.txt'), 'root\n');
      runGit(['-C', ours, 'add', 'r.txt']);
      runGit(['-C', ours, 'commit', '-q', '-m', 'root'], { env: CORE_AUTHOR_ENV });
    });

    afterEach(async () => {
      await rm(ours, { recursive: true, force: true });
    });

    describe('Given an empty core.excludesFile and an untracked file (E3a)', () => {
      describe('When git status and tsgit status run', () => {
        it('Then git status exits 0 with the untracked file shown', async () => {
          // Arrange
          await writeFile(path.join(ours, '.git', 'config'), emptyCoreFixture('excludesFile'));
          await writeFile(path.join(ours, 'ignoreme.log'), 'noise\n');

          // Act
          const g = tryRunGit(['-C', ours, 'status', '--porcelain'], { env: runGitEnv() });

          // Assert — empty excludesFile is feature-off: no global ignore loaded
          expect(g.ok).toBe(true);
          expect(g.stdout).toContain('?? ignoreme.log');
        });

        it('Then tsgit status succeeds and reports the untracked file', async () => {
          // Arrange
          await writeFile(path.join(ours, '.git', 'config'), emptyCoreFixture('excludesFile'));
          await writeFile(path.join(ours, 'ignoreme.log'), 'noise\n');
          const repo = await openRepository({ cwd: ours });

          // Act
          const result = await repo.status();

          // Assert — does not raise; the untracked file is visible
          expect(result.untracked).toContain('ignoreme.log');
        });
      });
    });

    describe('Given an empty vs a valueless core.excludesFile (E3a-ctrl boundary)', () => {
      describe('When git status and tsgit status run on each fixture', () => {
        it('Then empty exits 0 in both while valueless dies 128 in both', async () => {
          // Arrange — empty fixture
          await writeFile(path.join(ours, '.git', 'config'), emptyCoreFixture('excludesFile'));

          // Act — empty: git exits 0, tsgit does not raise
          const gEmpty = tryRunGit(['-C', ours, 'status', '--porcelain'], { env: runGitEnv() });
          const emptyRepo = await openRepository({ cwd: ours });
          let emptyCaught: unknown;
          try {
            await emptyRepo.status();
          } catch (err) {
            emptyCaught = err;
          }

          // Assert — empty is feature-off in both tools
          expect(gEmpty.ok).toBe(true);
          expect(emptyCaught).toBeUndefined();

          // Arrange — valueless fixture (the control)
          await writeFile(
            path.join(ours, '.git', 'config'),
            valuelessCorePathLikeFixture('excludesFile'),
          );

          // Act — valueless: git dies 128, tsgit refuses
          const gValueless = tryRunGit(['-C', ours, 'status', '--porcelain'], { env: runGitEnv() });
          const valuelessRepo = await openRepository({ cwd: ours });
          let valuelessCaught: unknown;
          try {
            await valuelessRepo.status();
          } catch (err) {
            valuelessCaught = err;
          }

          // Assert — valueless still dies in both (the boundary the fix respects)
          expect(gValueless.ok).toBe(false);
          expect(gValueless.stderr).toContain("missing value for 'core.excludesfile'");
          expect(valuelessCaught).toBeInstanceOf(TsgitError);
          expect((valuelessCaught as TsgitError).data.code).toBe('CONFIG_MISSING_VALUE');
        });
      });
    });

    describe('Given an empty core.excludesFile and the config porcelain (E3a-cfg)', () => {
      describe('When git config --list and tsgit configList run', () => {
        it('Then both survive with the empty value kept', async () => {
          // Arrange
          await writeFile(path.join(ours, '.git', 'config'), emptyCoreFixture('excludesFile'));
          const configPath = path.join(ours, '.git', 'config');
          const ctx = createNodeContext({ workDir: ours });

          // Act
          const gList = tryRunGit(['config', '--file', configPath, '--list']);
          const list = await configList(ctx, {});

          // Assert — porcelain reads keep the empty value, unaffected by the fix
          expect(gList.ok).toBe(true);
          const listed = list.entries.find((e) => e.key === 'core.excludesfile');
          expect(listed?.value).toBe('');
        });
      });
    });

    describe('Given an empty core.attributesFile (E3b)', () => {
      describe('When git status / checkout and tsgit status run', () => {
        it('Then git status and checkout . exit 0', async () => {
          // Arrange
          await writeFile(path.join(ours, '.git', 'config'), emptyCoreFixture('attributesFile'));

          // Act
          const gStatus = tryRunGit(['-C', ours, 'status', '--porcelain'], { env: runGitEnv() });
          const gCheckout = tryRunGit(['-C', ours, 'checkout', '.'], { env: runGitEnv() });

          // Assert — empty attributesFile is feature-off, not a literal path
          expect(gStatus.ok).toBe(true);
          expect(gCheckout.ok).toBe(true);
        });

        it('Then tsgit status succeeds (does not raise)', async () => {
          // Arrange
          await writeFile(path.join(ours, '.git', 'config'), emptyCoreFixture('attributesFile'));
          const repo = await openRepository({ cwd: ours });

          // Act
          let caught: unknown;
          try {
            await repo.status();
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeUndefined();
        });
      });
    });
  },
);

const EMPTY_HOOKSPATH_FIXTURE = '[core]\n\thooksPath = \n';
const BLOCKING_PRE_COMMIT = '#!/bin/sh\nexit 1\n';

const installBlockingPreCommit = async (repoDir: string): Promise<void> => {
  const hookPath = path.join(repoDir, '.git', 'hooks', 'pre-commit');
  await writeFile(hookPath, BLOCKING_PRE_COMMIT);
  await chmod(hookPath, 0o755);
};

// The pre-commit hook must be executable, which only the POSIX bit conveys —
// skip on Windows where the hook would never be treated as runnable anyway.
describe.skipIf(process.platform === 'win32' || !GIT_AVAILABLE)(
  'missing-value-refusal interop — empty core.hooksPath is a no-hooks sentinel',
  () => {
    let ours: string;

    beforeEach(async () => {
      ours = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-mv-empty-hooks-')));
      runGit(['init', '-q', '-b', 'main', ours]);
      await writeFile(path.join(ours, 'r.txt'), 'root\n');
      runGit(['-C', ours, 'add', 'r.txt']);
      runGit(['-C', ours, 'commit', '-q', '-m', 'root'], { env: CORE_AUTHOR_ENV });
      await installBlockingPreCommit(ours);
    });

    afterEach(async () => {
      await rm(ours, { recursive: true, force: true });
    });

    describe('Given an empty core.hooksPath and a blocking default-dir pre-commit (E3c)', () => {
      describe('When git commit and tsgit commit run', () => {
        it('Then git commit succeeds because the hook does not fire', async () => {
          // Arrange
          await writeFile(path.join(ours, 'r.txt'), 'changed\n');
          runGit(['-C', ours, 'add', 'r.txt']);
          await writeFile(path.join(ours, '.git', 'config'), EMPTY_HOOKSPATH_FIXTURE);

          // Act
          const g = tryRunGit(['-C', ours, 'commit', '-m', 'x'], { env: CORE_AUTHOR_ENV });

          // Assert — empty hooksPath is feature-off: the blocking hook never runs
          expect(g.ok).toBe(true);
        });

        it('Then tsgit commit succeeds because the hook does not fire', async () => {
          // Arrange
          await writeFile(path.join(ours, 'r.txt'), 'changed\n');
          runGit(['-C', ours, 'add', 'r.txt']);
          await writeFile(path.join(ours, '.git', 'config'), EMPTY_HOOKSPATH_FIXTURE);
          const repo = await openRepository({ cwd: ours });

          // Act — the node hook runner is wired, so a real hook would fire if found
          const result = await repo.commit({ message: 'x', author: CORE_COMMIT_AUTHOR });

          // Assert — a commit object is produced; the sentinel dir holds no hook
          expect(result.id).toMatch(/^[0-9a-f]{40}$/);
        });
      });
    });

    describe('Given an UNSET core.hooksPath and the same blocking pre-commit (E3c-dist)', () => {
      describe('When git commit and tsgit commit run', () => {
        it('Then git commit is blocked because the default-dir hook fires', () => {
          // Arrange — config left as git init wrote it (no [core] hooksPath line):
          // absent fires the default .git/hooks dir

          // Act
          const g = tryRunGit(['-C', ours, 'commit', '-m', 'x', '--allow-empty'], {
            env: CORE_AUTHOR_ENV,
          });

          // Assert — absent ≠ empty: the blocking default-dir hook fires
          expect(g.ok).toBe(false);
        });

        it('Then tsgit commit throws HOOK_FAILED because the default-dir hook fires', async () => {
          // Arrange — no hooksPath written: absent fires the default .git/hooks dir
          await writeFile(path.join(ours, 'r.txt'), 'changed\n');
          runGit(['-C', ours, 'add', 'r.txt']);
          const repo = await openRepository({ cwd: ours });

          // Act
          let caught: unknown;
          try {
            await repo.commit({ message: 'x', author: CORE_COMMIT_AUTHOR });
          } catch (err) {
            caught = err;
          }

          // Assert — absent ≠ empty: the default-dir hook fires and blocks
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('HOOK_FAILED');
        });
      });
    });
  },
);
