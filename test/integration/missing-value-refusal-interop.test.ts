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
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { configList } from '../../src/application/commands/config.js';
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
    describe('When git commit is run', () => {
      it('Then git refuses with exit 128 and the two-line missing-value message', async () => {
        // Arrange
        initRepo(ours);
        await stageFile(ours);
        await writeFile(path.join(ours, '.git', 'config'), VALUELESS_NAME_FIXTURE);

        // Act — no GIT_AUTHOR_* so git reads from config and trips on the NULL
        const g = tryRunGit(['-C', ours, 'commit', '-m', 'x'], {
          env: runGitEnv(),
        });

        // Assert
        expect(g.ok).toBe(false);
        expect(g.stderr).toContain("missing value for 'user.name'");
        expect(g.stderr).toContain("bad config variable 'user.name'");
        expect(g.stderr).toContain(`at line ${VALUELESS_NAME_LINE}`);
      });
    });

    describe('When tsgit commit is run', () => {
      it('Then throws CONFIG_MISSING_VALUE with key user.name, the correct line, and an absolute source', async () => {
        // Arrange
        initRepo(ours);
        await stageFile(ours);
        await writeFile(path.join(ours, '.git', 'config'), VALUELESS_NAME_FIXTURE);
        const repo = await openRepository({ cwd: ours });

        // Act
        let caught: unknown;
        try {
          await repo.commit({ message: 'x' });
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
        expect(data.key).toBe('user.name');
        expect(data.line).toBe(VALUELESS_NAME_LINE);
        expect(data.source).toMatch(/\/config$/);
      });
    });

    describe("When reconstructing git's two lines from tsgit structured fields", () => {
      it("Then the reconstructed lines match git's stderr after path-token normalization", async () => {
        // Arrange
        initRepo(ours);
        await stageFile(ours);
        await writeFile(path.join(ours, '.git', 'config'), VALUELESS_NAME_FIXTURE);

        // Act — run both git and tsgit against the same repo
        const g = tryRunGit(['-C', ours, 'commit', '-m', 'x'], {
          env: runGitEnv(),
        });
        const repo = await openRepository({ cwd: ours });
        let caught: unknown;
        try {
          await repo.commit({ message: 'x' });
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

        // key and line compare verbatim
        expect(errorLine).toBe(`error: missing value for '${data.key}'`);

        // path-token normalization: git prints repo-relative `.git/config`;
        // tsgit emits an absolute path. Normalize tsgit's absolute source to the
        // same `.git/config` relative form for the comparison.
        const normalizedSource = '.git/config';
        const tsgitFatalLine = `fatal: bad config variable '${data.key}' in file '${normalizedSource}' at line ${data.line}`;
        const normalizedFatalLine = fatalLine.replace(
          /in file '[^']+'/,
          `in file '${normalizedSource}'`,
        );
        expect(normalizedFatalLine).toBe(tsgitFatalLine);
      });
    });

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

    describe('When tsgit configList is run on the same file', () => {
      it('Then tsgit configList does not throw (refusal is at consumer, not read)', async () => {
        // Arrange
        initRepo(ours);
        await writeFile(path.join(ours, '.git', 'config'), VALUELESS_NAME_FIXTURE);
        const ctx = createNodeContext({ workDir: ours });

        // Act + Assert — no throw
        await expect(configList(ctx, {})).resolves.toBeDefined();
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

  describe('Given a config with a valueless remote.origin.url', () => {
    describe('When git fetch origin is run', () => {
      it('Then git refuses with exit 128 and the two-line missing-value message', async () => {
        // Arrange
        initRepo(ours);
        await writeFile(path.join(ours, '.git', 'config'), VALUELESS_REMOTE_URL_FIXTURE);

        // Act
        const g = tryRunGit(['-C', ours, 'fetch', 'origin'], {
          env: runGitEnv(),
        });

        // Assert
        expect(g.ok).toBe(false);
        expect(g.stderr).toContain("missing value for 'remote.origin.url'");
        expect(g.stderr).toContain("bad config variable 'remote.origin.url'");
        expect(g.stderr).toContain(`at line ${VALUELESS_REMOTE_URL_LINE}`);
      });
    });

    describe('When tsgit fetch is run', () => {
      it('Then throws CONFIG_MISSING_VALUE with key remote.origin.url and correct line', async () => {
        // Arrange
        initRepo(ours);
        await writeFile(path.join(ours, '.git', 'config'), VALUELESS_REMOTE_URL_FIXTURE);
        const repo = await openRepository({ cwd: ours });

        // Act
        let caught: unknown;
        try {
          await repo.fetch({ remote: 'origin' });
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
        expect(data.key).toBe('remote.origin.url');
        expect(data.line).toBe(VALUELESS_REMOTE_URL_LINE);
        expect(data.source).toMatch(/\/config$/);
      });
    });

    describe("When reconstructing git's two lines from tsgit fetch structured fields", () => {
      it("Then the reconstructed lines match git's stderr after path-token normalization", async () => {
        // Arrange
        initRepo(ours);
        await writeFile(path.join(ours, '.git', 'config'), VALUELESS_REMOTE_URL_FIXTURE);

        // Act — run both git and tsgit against the same repo
        const g = tryRunGit(['-C', ours, 'fetch', 'origin'], {
          env: runGitEnv(),
        });
        const repo = await openRepository({ cwd: ours });
        let caught: unknown;
        try {
          await repo.fetch({ remote: 'origin' });
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

    describe('When git push origin main is run', () => {
      it('Then git refuses with exit 128 and the two-line missing-value message', async () => {
        // Arrange
        initRepo(ours);
        await writeFile(path.join(ours, '.git', 'config'), VALUELESS_REMOTE_URL_FIXTURE);

        // Act
        const g = tryRunGit(['-C', ours, 'push', 'origin', 'main'], {
          env: runGitEnv(),
        });

        // Assert
        expect(g.ok).toBe(false);
        expect(g.stderr).toContain("missing value for 'remote.origin.url'");
        expect(g.stderr).toContain("bad config variable 'remote.origin.url'");
        expect(g.stderr).toContain(`at line ${VALUELESS_REMOTE_URL_LINE}`);
      });
    });

    describe('When tsgit push is run', () => {
      it('Then throws CONFIG_MISSING_VALUE with key remote.origin.url and correct line', async () => {
        // Arrange
        initRepo(ours);
        await writeFile(path.join(ours, '.git', 'config'), VALUELESS_REMOTE_URL_FIXTURE);
        const repo = await openRepository({ cwd: ours });

        // Act
        let caught: unknown;
        try {
          await repo.push({ remote: 'origin' });
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
        expect(data.key).toBe('remote.origin.url');
        expect(data.line).toBe(VALUELESS_REMOTE_URL_LINE);
        expect(data.source).toMatch(/\/config$/);
      });
    });

    describe("When reconstructing git's two lines from tsgit push structured fields", () => {
      it("Then the reconstructed lines match git's stderr after path-token normalization", async () => {
        // Arrange
        initRepo(ours);
        await writeFile(path.join(ours, '.git', 'config'), VALUELESS_REMOTE_URL_FIXTURE);

        // Act — run both git and tsgit against the same repo
        const g = tryRunGit(['-C', ours, 'push', 'origin', 'main'], {
          env: runGitEnv(),
        });
        const repo = await openRepository({ cwd: ours });
        let caught: unknown;
        try {
          await repo.push({ remote: 'origin' });
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

  describe('Given a config with a valueless branch.main.remote', () => {
    describe('When git pull is run', () => {
      it('Then git refuses with exit 128 and the two-line missing-value message', async () => {
        // Arrange
        initRepo(ours);
        await writeFile(path.join(ours, '.git', 'config'), VALUELESS_BRANCH_REMOTE_FIXTURE);

        // Act
        const g = tryRunGit(['-C', ours, 'pull'], { env: runGitEnv() });

        // Assert
        expect(g.ok).toBe(false);
        expect(g.stderr).toContain("missing value for 'branch.main.remote'");
        expect(g.stderr).toContain("bad config variable 'branch.main.remote'");
        expect(g.stderr).toContain(`at line ${VALUELESS_BRANCH_REMOTE_LINE}`);
      });
    });

    describe('When tsgit pull is run', () => {
      it('Then throws CONFIG_MISSING_VALUE with key branch.main.remote and correct line', async () => {
        // Arrange
        initRepo(ours);
        await writeFile(path.join(ours, '.git', 'config'), VALUELESS_BRANCH_REMOTE_FIXTURE);
        const repo = await openRepository({ cwd: ours });

        // Act
        let caught: unknown;
        try {
          await repo.pull({});
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
        expect(data.key).toBe('branch.main.remote');
        expect(data.line).toBe(VALUELESS_BRANCH_REMOTE_LINE);
        expect(data.source).toMatch(/\/config$/);
      });
    });

    describe("When reconstructing git's two lines from tsgit pull structured fields", () => {
      it("Then the reconstructed lines match git's stderr after path-token normalization", async () => {
        // Arrange
        initRepo(ours);
        await writeFile(path.join(ours, '.git', 'config'), VALUELESS_BRANCH_REMOTE_FIXTURE);

        // Act — run both git and tsgit against the same repo
        const g = tryRunGit(['-C', ours, 'pull'], { env: runGitEnv() });
        const repo = await openRepository({ cwd: ours });
        let caught: unknown;
        try {
          await repo.pull({});
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
        initRepo(ours);
        await writeFile(path.join(ours, '.git', 'config'), VALUELESS_BRANCH_REMOTE_FIXTURE);
        const ctx = createNodeContext({ workDir: ours });

        // Act + Assert — no throw
        await expect(configList(ctx, {})).resolves.toBeDefined();
      });
    });
  });

  describe('Given both branch.main.remote and merge valueless with remote earlier', () => {
    describe('When git pull and tsgit pull are run', () => {
      it('Then both report the earlier-by-line key branch.main.remote at line 4', async () => {
        // Arrange
        initRepo(ours);
        await writeFile(
          path.join(ours, '.git', 'config'),
          VALUELESS_BRANCH_BOTH_REMOTE_FIRST_FIXTURE,
        );

        // Act
        const g = tryRunGit(['-C', ours, 'pull'], { env: runGitEnv() });
        const repo = await openRepository({ cwd: ours });
        let caught: unknown;
        try {
          await repo.pull({});
        } catch (err) {
          caught = err;
        }

        // Assert — git reports remote (earlier line)
        expect(g.ok).toBe(false);
        expect(g.stderr).toContain("missing value for 'branch.main.remote'");
        expect(g.stderr).toContain('at line 4');
        // tsgit reports the same earlier-by-line key
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; key: string; line: number };
        expect(data.code).toBe('CONFIG_MISSING_VALUE');
        expect(data.key).toBe('branch.main.remote');
        expect(data.line).toBe(4);
      });
    });
  });

  describe('Given both branch.main.remote and merge valueless with merge earlier', () => {
    describe('When git pull and tsgit pull are run', () => {
      it('Then both report the earlier-by-line key branch.main.merge at line 4', async () => {
        // Arrange
        initRepo(ours);
        await writeFile(
          path.join(ours, '.git', 'config'),
          VALUELESS_BRANCH_BOTH_MERGE_FIRST_FIXTURE,
        );

        // Act
        const g = tryRunGit(['-C', ours, 'pull'], { env: runGitEnv() });
        const repo = await openRepository({ cwd: ours });
        let caught: unknown;
        try {
          await repo.pull({});
        } catch (err) {
          caught = err;
        }

        // Assert — git reports merge (earlier line)
        expect(g.ok).toBe(false);
        expect(g.stderr).toContain("missing value for 'branch.main.merge'");
        expect(g.stderr).toContain('at line 4');
        // tsgit reports the same earlier-by-line key
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; key: string; line: number };
        expect(data.code).toBe('CONFIG_MISSING_VALUE');
        expect(data.key).toBe('branch.main.merge');
        expect(data.line).toBe(4);
      });
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

    describe('When tsgit merge engages the driver', () => {
      it('Then throws CONFIG_MISSING_VALUE with key merge.mydriver.driver and correct line', async () => {
        // Arrange
        await writeBothConfig(VALUELESS_MERGE_DRIVER_FIXTURE);
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
        expect(data.key).toBe('merge.mydriver.driver');
        expect(data.line).toBe(VALUELESS_MERGE_DRIVER_LINE);
        expect(data.source).toMatch(/\/config$/);
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

  describe('Given both merge.mydriver.driver and name valueless with driver earlier', () => {
    describe('When git merge and tsgit merge engage the driver', () => {
      it('Then both report the earlier-by-line key merge.mydriver.driver at line 4', async () => {
        // Arrange
        await writeBothConfig(VALUELESS_MERGE_BOTH_DRIVER_FIRST_FIXTURE);

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

        // Assert — git reports driver (earlier line)
        expect(g.ok).toBe(false);
        expect(g.stderr).toContain("missing value for 'merge.mydriver.driver'");
        expect(g.stderr).toContain('at line 4');
        // tsgit reports the same earlier-by-line key
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; key: string; line: number };
        expect(data.code).toBe('CONFIG_MISSING_VALUE');
        expect(data.key).toBe('merge.mydriver.driver');
        expect(data.line).toBe(4);
      });
    });
  });

  describe('Given both merge.mydriver.driver and name valueless with name earlier', () => {
    describe('When git merge and tsgit merge engage the driver', () => {
      it('Then both report the earlier-by-line key merge.mydriver.name at line 4', async () => {
        // Arrange
        await writeBothConfig(VALUELESS_MERGE_BOTH_NAME_FIRST_FIXTURE);

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

        // Assert — git reports name (earlier line)
        expect(g.ok).toBe(false);
        expect(g.stderr).toContain("missing value for 'merge.mydriver.name'");
        expect(g.stderr).toContain('at line 4');
        // tsgit reports the same earlier-by-line key
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; key: string; line: number };
        expect(data.code).toBe('CONFIG_MISSING_VALUE');
        expect(data.key).toBe('merge.mydriver.name');
        expect(data.line).toBe(4);
      });
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
