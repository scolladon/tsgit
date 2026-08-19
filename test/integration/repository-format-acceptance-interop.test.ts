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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

/** Probes one `git init` capability once, in a throwaway `mktemp` dir, never touching a fixture. */
const probeInitCapability = (...args: ReadonlyArray<string>): boolean => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tsgit-format-caps-'));
  try {
    return tryRunGitWithExit(['init', '-q', ...args, dir]).exitCode === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// Computed once at module load (mirroring `GIT_AVAILABLE`'s own pattern) rather
// than inside `beforeAll`: `it.skipIf`/`describe.skipIf` read their condition at
// collection time, before any `beforeAll` has run.
const SHA256_AVAILABLE = GIT_AVAILABLE && probeInitCapability('--object-format=sha256');
const REFTABLE_AVAILABLE = GIT_AVAILABLE && probeInitCapability('--ref-format=reftable');

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

/** git's exact stderr for N unknown extensions at v1 — singular/plural, `\t`-indented, file order. */
const expectedUnknownStderr = (names: ReadonlyArray<string>): string => {
  const label = names.length === 1 ? 'extension' : 'extensions';
  const lines = names.map((name) => `\t${name}`).join('\n');
  return `fatal: unknown repository ${label} found:\n${lines}\n`;
};

/** git's exact stderr for N v1-only extensions at v0 — singular/plural, `\t`-indented, file order. */
const expectedV1OnlyStderr = (names: ReadonlyArray<string>): string => {
  const label = names.length === 1 ? 'extension' : 'extensions';
  const lines = names.map((name) => `\t${name}`).join('\n');
  return `fatal: repo version is 0, but v1-only ${label} found:\n${lines}\n`;
};

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

    /** Append arbitrary raw config text after the init-written base — for combined version+extensions fixtures. */
    const armRaw = (dir: string, suffix: string): void => {
      writeFileSync(configPath(dir), `${baseConfigText}${suffix}`);
    };

    /** Same as `armRaw`, but first strips the init-written repositoryformatversion line — the key absent. */
    const armRawVersionAbsent = (dir: string, suffix: string): void => {
      const withoutVersion = baseConfigText.replace(/^\s*repositoryformatversion\s*=.*\n/im, '');
      writeFileSync(configPath(dir), `${withoutVersion}${suffix}`);
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

    // ─────────────────────────────────────────────────────────────────────
    // Row 5 — the unknown-extension shapes: singular, plural (file order),
    // and subsectioned.
    // ─────────────────────────────────────────────────────────────────────

    describe('Given repositoryformatversion = 1 with one unknown extension', () => {
      describe('When git status and openRepository run', () => {
        it('Then both refuse, reconstructing the singular unknown-extension header', async () => {
          // Arrange
          const dir = await copyRow('ext-unknown-one');
          armRaw(dir, '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tbogus = 1\n');

          // Act
          const g = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);
          const repo = await openRow(dir);
          try {
            // Assert — git
            expect(g.exitCode).toBe(128);
            expect(g.stderr).toContain(expectedUnknownStderr(['bogus']));
            // Assert — tsgit
            expect(repo.ctx.layout.formatRefusal).toStrictEqual({
              kind: 'extensions',
              version: 1,
              extensions: ['bogus'],
            });
          } finally {
            await repo.dispose();
          }
        });
      });
    });

    describe('Given repositoryformatversion = 1 with three unknown extensions in file order', () => {
      describe('When git status and openRepository run', () => {
        it('Then both refuse, reconstructing the plural header in config-file order, never sorted', async () => {
          // Arrange
          const dir = await copyRow('ext-unknown-three');
          armRaw(
            dir,
            '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tzzz = 1\n\taaa = 1\n\tmmm = 1\n',
          );

          // Act
          const g = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);
          const repo = await openRow(dir);
          try {
            // Assert — git
            expect(g.exitCode).toBe(128);
            expect(g.stderr).toContain(expectedUnknownStderr(['zzz', 'aaa', 'mmm']));
            // Assert — tsgit
            expect(repo.ctx.layout.formatRefusal).toStrictEqual({
              kind: 'extensions',
              version: 1,
              extensions: ['zzz', 'aaa', 'mmm'],
            });
          } finally {
            await repo.dispose();
          }
        });
      });
    });

    describe('Given repositoryformatversion = 1 with a subsectioned unknown extension', () => {
      describe('When git status and openRepository run', () => {
        it('Then both refuse, naming the subsection verbatim and the key lower-cased', async () => {
          // Arrange
          const dir = await copyRow('ext-unknown-sub');
          armRaw(dir, '[core]\n\trepositoryformatversion = 1\n[extensions "X"]\n\tbogus = 1\n');

          // Act
          const g = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);
          const repo = await openRow(dir);
          try {
            // Assert — git
            expect(g.exitCode).toBe(128);
            expect(g.stderr).toContain(expectedUnknownStderr(['X.bogus']));
            // Assert — tsgit
            expect(repo.ctx.layout.formatRefusal).toStrictEqual({
              kind: 'extensions',
              version: 1,
              extensions: ['X.bogus'],
            });
          } finally {
            await repo.dispose();
          }
        });
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Row 6 — the version-conditioned split: a v1-only name refuses at v0,
    // an unknown name is silently ignored at v0.
    // ─────────────────────────────────────────────────────────────────────

    describe('Given repositoryformatversion = 0 with the v1-only extension objectFormat', () => {
      describe('When git status and openRepository run', () => {
        it('Then both refuse — the v1-only arm fires', async () => {
          // Arrange
          const dir = await copyRow('v0-v1only');
          armRaw(
            dir,
            '[core]\n\trepositoryformatversion = 0\n[extensions]\n\tobjectFormat = sha1\n',
          );

          // Act
          const g = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);
          const repo = await openRow(dir);
          try {
            // Assert — git
            expect(g.exitCode).toBe(128);
            expect(g.stderr).toContain(expectedV1OnlyStderr(['objectformat']));
            // Assert — tsgit
            expect(repo.ctx.layout.formatRefusal).toStrictEqual({
              kind: 'extensions',
              version: 0,
              extensions: ['objectformat'],
            });
          } finally {
            await repo.dispose();
          }
        });
      });
    });

    describe('Given repositoryformatversion = 0 with an unknown extension', () => {
      describe('When git status and openRepository run', () => {
        it('Then both accept — v0 silently ignores unknown names', async () => {
          // Arrange
          const dir = await copyRow('v0-unknown');
          armRaw(dir, '[core]\n\trepositoryformatversion = 0\n[extensions]\n\tbogus = 1\n');

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
    // Row 7 — the nine-name acceptance sweep: the regression detector for
    // the registry constant against a future git. Six names are backed and
    // fully operate in both tools; `objectFormat`/`refStorage` are backed by
    // real git but tsgit has not yet implemented them here (TRANSIENT —
    // each sibling PR removes one row when its support lands);
    // `compatObjectFormat` is refused by real git itself on this build (no
    // Rust support) and is a PERMANENT co-refusal.
    // ─────────────────────────────────────────────────────────────────────

    describe("Given each of git's nine known extensions planted alone at version 1", () => {
      describe('When git status and openRepository run', () => {
        it.each([
          ['noop', 'true', 'accept'],
          ['noop-v1', 'true', 'accept'],
          ['worktreeConfig', 'true', 'accept'],
          ['preciousObjects', 'true', 'accept'],
          ['partialClone', 'origin', 'accept'],
          ['relativeWorktrees', 'true', 'accept'],
          ['objectFormat', 'sha1', 'accept'],
          ['refStorage', 'files', 'accept'],
          ['compatObjectFormat', 'sha256', 'compatRefused'],
        ] as const)(
          'Then extensions.%s is planted and both tools report on it',
          async (name, value, gitOutcome) => {
            // Arrange
            const dir = await copyRow(`ext-${name.toLowerCase()}`);
            armRaw(
              dir,
              `[core]\n\trepositoryformatversion = 1\n[extensions]\n\t${name} = ${value}\n`,
            );

            // Act
            const g = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);

            // Assert — git
            if (gitOutcome === 'accept') {
              expect(g.exitCode).toBe(0);
            } else {
              expect(g.exitCode).toBe(128);
              expect(g.stderr).toContain(
                'fatal: compatibility hash algorithm support requires Rust',
              );
            }

            // Assert — tsgit: the six implemented names carry no refusal;
            // objectFormat/refStorage/compatObjectFormat are all still in
            // tsgit's unbacked-extension refuse set today, so all three throw.
            const unbacked = new Set(['objectFormat', 'refStorage', 'compatObjectFormat']);
            if (unbacked.has(name)) {
              let caught: unknown;
              try {
                await openRow(dir);
              } catch (err) {
                caught = err;
              }
              expect(caught).toBeInstanceOf(TsgitError);
              expect((caught as TsgitError).data).toMatchObject({
                code: 'REPOSITORY_EXTENSION_UNSUPPORTED',
                extension: name.toLowerCase(),
              });
            } else {
              const repo = await openRow(dir);
              try {
                expect(repo.ctx.layout.formatRefusal).toBeUndefined();
              } finally {
                await repo.dispose();
              }
            }
          },
        );
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Row 13 — compatObjectFormat's version matrix as co-truth: the
    // predicate is narrow (only version === 1 reaches the refusal), the
    // tier is wide (config --list dies too, unlike the plain version arm).
    // ─────────────────────────────────────────────────────────────────────

    describe('Given extensions.compatObjectFormat with the version key absent', () => {
      describe('When git status and openRepository run', () => {
        it('Then both operate the repository', async () => {
          // Arrange
          const dir = await copyRow('compat-absent');
          armRawVersionAbsent(dir, '[extensions]\n\tcompatObjectFormat = sha1\n');

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

    describe('Given extensions.compatObjectFormat with repositoryformatversion = -1', () => {
      describe('When git status and openRepository run', () => {
        it('Then both operate the repository', async () => {
          // Arrange
          const dir = await copyRow('compat-neg1');
          armRaw(
            dir,
            '[core]\n\trepositoryformatversion = -1\n[extensions]\n\tcompatObjectFormat = sha1\n',
          );

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

    describe('Given extensions.compatObjectFormat with repositoryformatversion = 0', () => {
      describe('When git status, git config --list, and openRepository run', () => {
        it('Then both take the v1-only arm, and the config porcelain survives in git', async () => {
          // Arrange
          const dir = await copyRow('compat-v0');
          armRaw(
            dir,
            '[core]\n\trepositoryformatversion = 0\n[extensions]\n\tcompatObjectFormat = sha1\n',
          );

          // Act
          const status = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);
          const list = tryRunGitWithExit(['-C', dir, 'config', '--list']);
          const repo = await openRow(dir);
          try {
            // Assert — git
            expect(status.exitCode).toBe(128);
            expect(status.stderr).toContain(expectedV1OnlyStderr(['compatobjectformat']));
            expect(list.exitCode).toBe(0);
            // Assert — tsgit
            expect(repo.ctx.layout.formatRefusal).toStrictEqual({
              kind: 'extensions',
              version: 0,
              extensions: ['compatobjectformat'],
            });
          } finally {
            await repo.dispose();
          }
        });
      });
    });

    describe('Given extensions.compatObjectFormat with repositoryformatversion = 1', () => {
      describe('When git status, git config --list, and openRepository run', () => {
        it('Then both refuse on every verb, and tsgit throws REPOSITORY_EXTENSION_UNSUPPORTED at open', async () => {
          // Arrange
          const dir = await copyRow('compat-v1');
          armRaw(
            dir,
            '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tcompatObjectFormat = sha1\n',
          );

          // Act
          const status = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);
          const list = tryRunGitWithExit(['-C', dir, 'config', '--list']);
          let caught: unknown;
          try {
            await openRow(dir);
          } catch (err) {
            caught = err;
          }

          // Assert — git
          expect(status.exitCode).toBe(128);
          expect(status.stderr).toContain(
            'fatal: compatibility hash algorithm support requires Rust',
          );
          expect(list.exitCode).toBe(128);
          expect(list.stderr).toContain(
            'fatal: compatibility hash algorithm support requires Rust',
          );
          // Assert — tsgit
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'REPOSITORY_EXTENSION_UNSUPPORTED',
            extension: 'compatobjectformat',
            value: 'sha1',
          });
        });
      });
    });

    describe('Given extensions.compatObjectFormat with repositoryformatversion = 2 or 99', () => {
      describe('When git status, git config --list, and openRepository run', () => {
        it.each([[2], [99]])(
          'Then both take the version arm for %i, and the config porcelain survives in git',
          async (version) => {
            // Arrange
            const dir = await copyRow(`compat-v${version}`);
            armRaw(
              dir,
              `[core]\n\trepositoryformatversion = ${version}\n[extensions]\n\tcompatObjectFormat = sha1\n`,
            );

            // Act
            const status = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);
            const list = tryRunGitWithExit(['-C', dir, 'config', '--list']);
            const repo = await openRow(dir);
            try {
              // Assert — git
              expect(status.exitCode).toBe(128);
              expect(status.stderr).toContain(expectedVersionStderr(version));
              expect(list.exitCode).toBe(0);
              // Assert — tsgit
              expect(repo.ctx.layout.formatRefusal).toStrictEqual({ kind: 'version', version });
            } finally {
              await repo.dispose();
            }
          },
        );
      });
    });

    describe('Given a valueless extensions.compatObjectFormat at version 1', () => {
      describe('When git status and openRepository are attempted', () => {
        it('Then git reports missing value + bad config line, and tsgit throws CONFIG_MISSING_VALUE', async () => {
          // Arrange
          const dir = await copyRow('compat-valueless');
          armRaw(
            dir,
            '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tcompatObjectFormat\n',
          );

          // Act
          const status = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);
          let caught: unknown;
          try {
            await openRow(dir);
          } catch (err) {
            caught = err;
          }

          // Assert — git
          expect(status.exitCode).toBe(128);
          expect(status.stderr).toContain(
            "error: missing value for 'extensions.compatobjectformat'",
          );
          expect(status.stderr).toContain('fatal: bad config line');
          // Assert — tsgit
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { code: string; key: string };
          expect(data.code).toBe('CONFIG_MISSING_VALUE');
          expect(data.key).toBe('extensions.compatobjectformat');
        });
      });
    });

    describe('Given a subsectioned extensions.compatObjectFormat at version 1', () => {
      describe('When git status and openRepository run', () => {
        it('Then both take the unknown-extension arm, naming the subsection verbatim', async () => {
          // Arrange
          const dir = await copyRow('compat-subsectioned');
          armRaw(
            dir,
            '[core]\n\trepositoryformatversion = 1\n[extensions "x"]\n\tcompatObjectFormat = sha1\n',
          );

          // Act
          const g = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);
          const repo = await openRow(dir);
          try {
            // Assert — git
            expect(g.exitCode).toBe(128);
            expect(g.stderr).toContain(expectedUnknownStderr(['x.compatobjectformat']));
            // Assert — tsgit
            expect(repo.ctx.layout.formatRefusal).toStrictEqual({
              kind: 'extensions',
              version: 1,
              extensions: ['x.compatobjectformat'],
            });
          } finally {
            await repo.dispose();
          }
        });
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Row 14 — the backed extensions, cross-referenced from the sibling
    // suites: this suite asserts the gate's verdict only.
    // Capability-probed — neither git build feature is guaranteed present.
    // ─────────────────────────────────────────────────────────────────────

    describe.skipIf(!SHA256_AVAILABLE)(
      'Given a real git init --object-format=sha256 repository',
      () => {
        describe('When openRepository runs', () => {
          it('Then tsgit refuses at the gate — TRANSIENT until SHA-256 support lands', async () => {
            // Arrange
            const root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-format-sha256-'));
            rowDirs.push(root);
            const dir = path.join(root, 'repo');
            runGit(['init', '-q', '--object-format=sha256', dir]);

            // Act
            let caught: unknown;
            try {
              await openRow(dir);
            } catch (err) {
              caught = err;
            }

            // Assert
            expect(caught).toBeInstanceOf(TsgitError);
            expect((caught as TsgitError).data).toMatchObject({
              code: 'REPOSITORY_EXTENSION_UNSUPPORTED',
              extension: 'objectformat',
            });
          });
        });
      },
    );

    describe.skipIf(!REFTABLE_AVAILABLE)(
      'Given a real git init --ref-format=reftable repository',
      () => {
        describe('When openRepository runs', () => {
          it('Then tsgit refuses at the gate — TRANSIENT until reftable support lands', async () => {
            // Arrange
            const root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-format-reftable-'));
            rowDirs.push(root);
            const dir = path.join(root, 'repo');
            runGit(['init', '-q', '--ref-format=reftable', dir]);

            // Act
            let caught: unknown;
            try {
              await openRow(dir);
            } catch (err) {
              caught = err;
            }

            // Assert
            expect(caught).toBeInstanceOf(TsgitError);
            expect((caught as TsgitError).data).toMatchObject({
              code: 'REPOSITORY_EXTENSION_UNSUPPORTED',
              extension: 'refstorage',
            });
          });
        });
      },
    );
  },
);
