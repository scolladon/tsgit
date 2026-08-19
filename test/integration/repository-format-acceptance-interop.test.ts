/**
 * Cross-tool interop — the repository-format acceptance gate's version arm.
 * Builds ONE one-commit source repository with real git (deterministic dates,
 * signing off); each row copies it and poisons `<gitDir>/config`'s
 * `core.repositoryformatversion` directly with a raw `writeFile` — git's CLI
 * cannot emit a valueless entry and file-line order is load-bearing for the
 * last-wins resolution, so every row goes through raw fixture text. Proves
 * canonical git's accept/refuse split at `core.repositoryformatversion`
 * matches tsgit's `openRepository` verdict, which is CARRIED rather than
 * thrown: observable as `repo.ctx.layout.formatRefusal`. tsgit emits no
 * display string, so git's exact stderr is reconstructed here from tsgit's
 * structured fields alone.
 *
 * @proves
 *   surface:        repo-state
 *   bucket:         cross-tool-interop
 *   unique:         core.repositoryformatversion's accept/refuse split (a named ceiling, not membership; the parsed integer, not the literal) matches canonical git (git 2.55.0), reconstructed from tsgit's structured fields alone
 *   interopSurface: config, init, status
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;

const datedEnv = (): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A U Thor',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'A U Thor',
  GIT_COMMITTER_EMAIL: 'author@example.com',
  GIT_COMMITTER_DATE: '1700000000 +0000',
});

interface FormatRefusal {
  readonly kind: string;
  readonly version: number;
}

interface BadNumericData {
  readonly code: string;
  readonly key: string;
  readonly value: string;
  readonly reason: string;
}

const configPath = (dir: string): string => path.join(dir, '.git', 'config');

/** git's exact stderr for a refused version, reconstructed from tsgit's structured fields. */
const expectedVersionStderr = (version: number): string =>
  `fatal: Expected git repo version <= 1, found ${version}`;

describe.skipIf(!GIT_AVAILABLE)(
  'core.repositoryformatversion acceptance gate — cross-tool interop',
  () => {
    let baseDir = '';
    let baseConfigText = '';
    const rowDirs: string[] = [];

    beforeAll(async () => {
      baseDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-format-version-base-'));
      git(baseDir, 'init', '-q', '-b', 'main');
      git(baseDir, 'config', 'user.name', 'A U Thor');
      git(baseDir, 'config', 'user.email', 'author@example.com');
      git(baseDir, 'config', 'commit.gpgsign', 'false');
      writeFileSync(path.join(baseDir, 'file.txt'), 'hello\n');
      git(baseDir, 'add', '-A');
      runGit(['-C', baseDir, 'commit', '-q', '--no-gpg-sign', '-m', 'c0'], { env: datedEnv() });
      baseConfigText = readFileSync(configPath(baseDir), 'utf8');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
      await Promise.all(rowDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    /** Every row gets its OWN copy of the shared base repo — no row mutates a shared tree. */
    const copyRow = async (slug: string): Promise<string> => {
      const root = await mkdtemp(path.join(os.tmpdir(), `tsgit-format-version-${slug}-`));
      rowDirs.push(root);
      const target = path.join(root, 'repo');
      await cp(baseDir, target, { recursive: true });
      return target;
    };

    /** Append a NEW [core] block naming `literal` — its entry lands AFTER the
     *  init-written one, so it is the effective (last-wins) value. */
    const armVersion = (dir: string, literal: string): void => {
      writeFileSync(
        configPath(dir),
        `${baseConfigText}[core]\n\trepositoryformatversion = ${literal}\n`,
      );
    };

    /** Strip the init-written repositoryformatversion line entirely — the key absent. */
    const armAbsentVersion = (dir: string): void => {
      writeFileSync(
        configPath(dir),
        baseConfigText.replace(/^\s*repositoryformatversion\s*=.*\n/im, ''),
      );
    };

    const openRow = async (dir: string): Promise<Repository> => openRepository({ cwd: dir });

    // ─────────────────────────────────────────────────────────────────────
    // Row 1 — v0 and v1 (no extensions) accepted.
    // ─────────────────────────────────────────────────────────────────────

    describe('Given repositoryformatversion = 0', () => {
      describe('When git status and openRepository run', () => {
        it('Then both accept — git exits 0 and formatRefusal is undefined', async () => {
          // Arrange
          const dir = await copyRow('v0');
          armVersion(dir, '0');

          // Act
          const g = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);
          const repo = await openRow(dir);
          try {
            // Assert
            expect(g.exitCode).toBe(0);
            expect(repo.ctx.layout.formatRefusal).toBeUndefined();
          } finally {
            await repo.dispose();
          }
        });
      });
    });

    describe('Given repositoryformatversion = 1 (no extensions)', () => {
      describe('When git status and openRepository run', () => {
        it('Then both accept — git exits 0 and formatRefusal is undefined', async () => {
          // Arrange
          const dir = await copyRow('v1');
          armVersion(dir, '1');

          // Act
          const g = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);
          const repo = await openRow(dir);
          try {
            // Assert
            expect(g.exitCode).toBe(0);
            expect(repo.ctx.layout.formatRefusal).toBeUndefined();
          } finally {
            await repo.dispose();
          }
        });
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Row 2 — 2, 99, 1k refused; 1k proves the payload carries the PARSED
    // integer, not the literal.
    // ─────────────────────────────────────────────────────────────────────

    describe('Given repositoryformatversion = 2', () => {
      describe('When git status and openRepository run', () => {
        it('Then both refuse, naming the parsed version 2', async () => {
          // Arrange
          const dir = await copyRow('v2');
          armVersion(dir, '2');

          // Act
          const g = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);
          const repo = await openRow(dir);
          try {
            // Assert — git
            expect(g.exitCode).toBe(128);
            expect(g.stderr).toContain(expectedVersionStderr(2));
            // Assert — tsgit
            expect(repo.ctx.layout.formatRefusal).toStrictEqual({ kind: 'version', version: 2 });
          } finally {
            await repo.dispose();
          }
        });
      });
    });

    describe('Given repositoryformatversion = 99', () => {
      describe('When git status and openRepository run', () => {
        it('Then both refuse, naming the parsed version 99', async () => {
          // Arrange
          const dir = await copyRow('v99');
          armVersion(dir, '99');

          // Act
          const g = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);
          const repo = await openRow(dir);
          try {
            // Assert — git
            expect(g.exitCode).toBe(128);
            expect(g.stderr).toContain(expectedVersionStderr(99));
            // Assert — tsgit
            const refusal = repo.ctx.layout.formatRefusal as FormatRefusal | undefined;
            expect(refusal).toStrictEqual({ kind: 'version', version: 99 });
          } finally {
            await repo.dispose();
          }
        });
      });
    });

    describe('Given repositoryformatversion = 1k', () => {
      describe('When git status and openRepository run', () => {
        it('Then both refuse, naming the PARSED integer 1024 — never the literal 1k', async () => {
          // Arrange
          const dir = await copyRow('v1k');
          armVersion(dir, '1k');

          // Act
          const g = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);
          const repo = await openRow(dir);
          try {
            // Assert — git
            expect(g.exitCode).toBe(128);
            expect(g.stderr).toContain(expectedVersionStderr(1024));
            // Assert — tsgit
            const refusal = repo.ctx.layout.formatRefusal as FormatRefusal | undefined;
            expect(refusal).toStrictEqual({ kind: 'version', version: 1024 });
          } finally {
            await repo.dispose();
          }
        });
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Row 3 — -1, 0x1, and the absent key all accepted: the rows a
    // membership test in {0, 1}, or an absent-⇒-0 default, would fail.
    // ─────────────────────────────────────────────────────────────────────

    describe('Given repositoryformatversion = -1', () => {
      describe('When git status and openRepository run', () => {
        it('Then both accept — a named ceiling, not membership in {0, 1}', async () => {
          // Arrange
          const dir = await copyRow('vneg1');
          armVersion(dir, '-1');

          // Act
          const g = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);
          const repo = await openRow(dir);
          try {
            // Assert
            expect(g.exitCode).toBe(0);
            expect(repo.ctx.layout.formatRefusal).toBeUndefined();
          } finally {
            await repo.dispose();
          }
        });
      });
    });

    describe('Given repositoryformatversion = 0x1', () => {
      describe('When git status and openRepository run', () => {
        it('Then both accept — base-0 hex parses to 1', async () => {
          // Arrange
          const dir = await copyRow('vhex1');
          armVersion(dir, '0x1');

          // Act
          const g = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);
          const repo = await openRow(dir);
          try {
            // Assert
            expect(g.exitCode).toBe(0);
            expect(repo.ctx.layout.formatRefusal).toBeUndefined();
          } finally {
            await repo.dispose();
          }
        });
      });
    });

    describe('Given the repositoryformatversion key is absent entirely', () => {
      describe('When git status and openRepository run', () => {
        it('Then both accept — absent is a third state, never defaulted to 0', async () => {
          // Arrange
          const dir = await copyRow('vabsent');
          armAbsentVersion(dir);

          // Act
          const g = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);
          const repo = await openRow(dir);
          try {
            // Assert
            expect(g.exitCode).toBe(0);
            expect(repo.ctx.layout.formatRefusal).toBeUndefined();
          } finally {
            await repo.dispose();
          }
        });
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Row 4 — a malformed value throws CONFIG_BAD_NUMERIC_VALUE at open,
    // reconstructing git's single-line fatal.
    // ─────────────────────────────────────────────────────────────────────

    describe('Given repositoryformatversion = abc', () => {
      describe('When git status runs and openRepository is attempted', () => {
        it("Then both refuse — git with its bad-numeric fatal, tsgit with CONFIG_BAD_NUMERIC_VALUE ('invalid unit')", async () => {
          // Arrange
          const dir = await copyRow('vabc');
          armVersion(dir, 'abc');

          // Act
          const g = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);
          let caught: unknown;
          try {
            await openRow(dir);
          } catch (err) {
            caught = err;
          }

          // Assert — git
          expect(g.exitCode).toBe(128);
          expect(g.stderr).toContain(
            "fatal: bad numeric config value 'abc' for 'core.repositoryformatversion' in file",
          );
          expect(g.stderr).toContain(': invalid unit');
          // Assert — tsgit
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.repositoryformatversion');
          expect(data.value).toBe('abc');
          expect(data.reason).toBe('invalid unit');
        });
      });
    });

    describe('Given repositoryformatversion = 9223372036854775808 (int64 max + 1)', () => {
      describe('When git status runs and openRepository is attempted', () => {
        it("Then both refuse — git with its bad-numeric fatal, tsgit with CONFIG_BAD_NUMERIC_VALUE ('out of range')", async () => {
          // Arrange
          const dir = await copyRow('voverflow');
          armVersion(dir, '9223372036854775808');

          // Act
          const g = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);
          let caught: unknown;
          try {
            await openRow(dir);
          } catch (err) {
            caught = err;
          }

          // Assert — git
          expect(g.exitCode).toBe(128);
          expect(g.stderr).toContain(
            "fatal: bad numeric config value '9223372036854775808' for 'core.repositoryformatversion' in file",
          );
          expect(g.stderr).toContain(': out of range');
          // Assert — tsgit
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.repositoryformatversion');
          expect(data.value).toBe('9223372036854775808');
          expect(data.reason).toBe('out of range');
        });
      });
    });
  },
);
