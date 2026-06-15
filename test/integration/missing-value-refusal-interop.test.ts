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

  describe('Given a config with a valueless remote.origin.pushurl and a valued url', () => {
    describe('When git push origin main is run', () => {
      it('Then git refuses with exit 128 and the two-line missing-value message', async () => {
        // Arrange
        initRepo(ours);
        await writeFile(path.join(ours, '.git', 'config'), VALUELESS_REMOTE_PUSHURL_FIXTURE);

        // Act
        const g = tryRunGit(['-C', ours, 'push', 'origin', 'main'], {
          env: runGitEnv(),
        });

        // Assert
        expect(g.ok).toBe(false);
        expect(g.stderr).toContain("missing value for 'remote.origin.pushurl'");
        expect(g.stderr).toContain("bad config variable 'remote.origin.pushurl'");
        expect(g.stderr).toContain(`at line ${VALUELESS_REMOTE_PUSHURL_LINE}`);
      });
    });

    describe('When tsgit push is run', () => {
      it('Then throws CONFIG_MISSING_VALUE with key remote.origin.pushurl and correct line', async () => {
        // Arrange
        initRepo(ours);
        await writeFile(path.join(ours, '.git', 'config'), VALUELESS_REMOTE_PUSHURL_FIXTURE);
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
        expect(data.key).toBe('remote.origin.pushurl');
        expect(data.line).toBe(VALUELESS_REMOTE_PUSHURL_LINE);
        expect(data.source).toMatch(/\/config$/);
      });
    });

    describe("When reconstructing git's two lines from tsgit push structured fields", () => {
      it("Then the reconstructed lines match git's stderr after path-token normalization", async () => {
        // Arrange
        initRepo(ours);
        await writeFile(path.join(ours, '.git', 'config'), VALUELESS_REMOTE_PUSHURL_FIXTURE);

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

  describe('Given both remote.origin.pushurl and url valueless with pushurl earlier', () => {
    describe('When git push and tsgit push are run', () => {
      it('Then both report the earlier-by-line key remote.origin.pushurl at line 4', async () => {
        // Arrange
        initRepo(ours);
        await writeFile(
          path.join(ours, '.git', 'config'),
          VALUELESS_REMOTE_BOTH_PUSHURL_FIRST_FIXTURE,
        );

        // Act
        const g = tryRunGit(['-C', ours, 'push', 'origin', 'main'], { env: runGitEnv() });
        const repo = await openRepository({ cwd: ours });
        let caught: unknown;
        try {
          await repo.push({ remote: 'origin' });
        } catch (err) {
          caught = err;
        }

        // Assert — git reports pushurl (earlier line)
        expect(g.ok).toBe(false);
        expect(g.stderr).toContain("missing value for 'remote.origin.pushurl'");
        expect(g.stderr).toContain('at line 4');
        // tsgit reports the same earlier-by-line key
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; key: string; line: number };
        expect(data.code).toBe('CONFIG_MISSING_VALUE');
        expect(data.key).toBe('remote.origin.pushurl');
        expect(data.line).toBe(4);
      });
    });
  });

  describe('Given both remote.origin.pushurl and url valueless with url earlier', () => {
    describe('When git push and tsgit push are run', () => {
      it('Then both report the earlier-by-line key remote.origin.url at line 4', async () => {
        // Arrange
        initRepo(ours);
        await writeFile(path.join(ours, '.git', 'config'), VALUELESS_REMOTE_BOTH_URL_FIRST_FIXTURE);

        // Act
        const g = tryRunGit(['-C', ours, 'push', 'origin', 'main'], { env: runGitEnv() });
        const repo = await openRepository({ cwd: ours });
        let caught: unknown;
        try {
          await repo.push({ remote: 'origin' });
        } catch (err) {
          caught = err;
        }

        // Assert — git reports url (earlier line)
        expect(g.ok).toBe(false);
        expect(g.stderr).toContain("missing value for 'remote.origin.url'");
        expect(g.stderr).toContain('at line 4');
        // tsgit reports the same earlier-by-line key
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; key: string; line: number };
        expect(data.code).toBe('CONFIG_MISSING_VALUE');
        expect(data.key).toBe('remote.origin.url');
        expect(data.line).toBe(4);
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
