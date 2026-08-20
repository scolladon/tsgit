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
import { cp, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { init } from '../../src/application/commands/init.js';
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

/**
 * `git worktree add --relative-paths` capability, probed once in a
 * throwaway repo (needs an actual commit + worktree add, unlike the
 * `git init` flags `probeInitCapability` checks).
 */
const probeRelativeWorktreesCapability = (): boolean => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tsgit-relwt-caps-'));
  try {
    if (tryRunGitWithExit(['init', '-q', '-b', 'main', dir]).exitCode !== 0) return false;
    if (tryRunGitWithExit(['-C', dir, 'config', 'user.name', 'A U Thor']).exitCode !== 0)
      return false;
    if (
      tryRunGitWithExit(['-C', dir, 'config', 'user.email', 'author@example.com']).exitCode !== 0
    ) {
      return false;
    }
    if (tryRunGitWithExit(['-C', dir, 'config', 'commit.gpgsign', 'false']).exitCode !== 0)
      return false;
    writeFileSync(path.join(dir, 'file.txt'), 'hello\n');
    if (tryRunGitWithExit(['-C', dir, 'add', '-A']).exitCode !== 0) return false;
    const commit = tryRunGitWithExit(['-C', dir, 'commit', '-q', '--no-gpg-sign', '-m', 'c0'], {
      env: runGitEnv(),
    });
    if (commit.exitCode !== 0) return false;
    const wtDir = path.join(dir, 'wt');
    return (
      tryRunGitWithExit(['-C', dir, 'worktree', 'add', '-q', '--relative-paths', wtDir])
        .exitCode === 0
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const RELATIVE_WORKTREES_AVAILABLE = GIT_AVAILABLE && probeRelativeWorktreesCapability();

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
      // A real remote, so the `--rename-section` / `--remove-section` rows are
      // not self-fulfilling: without it git exits 128 on a HEALTHY repository
      // too ("no such section"), and those rows would hold with the format
      // gate deleted.
      git(baseDir, 'remote', 'add', 'origin', 'https://example.com/repo.git');
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

            // Assert — tsgit: the names it can act on carry no refusal.
            // `objectFormat` left the refuse set when SHA-256 support landed.
            // The two that remain are `refStorage` (no reftable backend yet)
            // and `compatObjectFormat`, which git itself refuses on a non-Rust
            // build — refusing that one IS the faithful behaviour, not a gap.
            const unbacked = new Set(['refStorage', 'compatObjectFormat']);
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
    // Row 12 — a relative admin gitdir pointer (`git worktree add
    // --relative-paths`): tsgit's worktree.list matches git's, both before
    // and after relocating the whole tree (repo + linked worktree move
    // together) — the portability property the extension exists for. The
    // fixture repository is repositoryformatversion = 1 with
    // extensions.relativeWorktrees = true, so this doubles as a live
    // acceptance-gate row: the gate must accept it.
    // ─────────────────────────────────────────────────────────────────────

    /** The `worktree <path>` lines from `git worktree list --porcelain`. */
    const parseWorktreePaths = (porcelain: string): ReadonlyArray<string> =>
      porcelain
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length));

    describe.skipIf(!RELATIVE_WORKTREES_AVAILABLE)(
      'Given a linked worktree built with git worktree add --relative-paths, When tsgit and git both list worktrees',
      () => {
        it('Then tsgit worktree.list matches git worktree list, before and after relocating the whole tree', async () => {
          // Arrange — repo and its linked worktree as SIBLINGS under one
          // parent, so relocating the parent moves both together without
          // changing their relative geometry to each other.
          const parent = await mkdtemp(path.join(os.tmpdir(), 'tsgit-relwt-'));
          rowDirs.push(parent);
          const repoDir = path.join(parent, 'repo');
          runGit(['init', '-q', '-b', 'main', repoDir]);
          runGit(['-C', repoDir, 'config', 'user.name', 'A U Thor']);
          runGit(['-C', repoDir, 'config', 'user.email', 'author@example.com']);
          runGit(['-C', repoDir, 'config', 'commit.gpgsign', 'false']);
          writeFileSync(path.join(repoDir, 'file.txt'), 'hello\n');
          runGit(['-C', repoDir, 'add', '-A']);
          runGit(['-C', repoDir, 'commit', '-q', '--no-gpg-sign', '-m', 'c0'], { env: datedEnv() });
          const wtDir = path.join(parent, 'wt');
          runGit(['-C', repoDir, 'worktree', 'add', '-q', '--relative-paths', wtDir, '-b', 'side']);

          // Assert — the fixture is itself a live acceptance-gate row: v1 +
          // extensions.relativeWorktrees = true, and a relative admin gitdir
          // pointer (never an absolute one — the write side is unchanged).
          const configText = readFileSync(configPath(repoDir), 'utf8');
          expect(configText).toMatch(/repositoryformatversion\s*=\s*1/);
          expect(configText).toMatch(/relativeWorktrees\s*=\s*true/);
          const gitdirPointer = readFileSync(
            path.join(repoDir, '.git', 'worktrees', 'wt', 'gitdir'),
            'utf8',
          );
          expect(gitdirPointer.startsWith('../')).toBe(true);

          // Act + Assert — before relocation: same paths, same (empty)
          // prunable verdicts in both tools.
          const gitBeforePorcelain = git(repoDir, 'worktree', 'list', '--porcelain');
          const repoBefore = await openRow(repoDir);
          try {
            const tsgitBefore = await repoBefore.worktree.list();
            expect(tsgitBefore.entries.map((entry) => entry.path).sort()).toEqual(
              [...parseWorktreePaths(gitBeforePorcelain)].sort(),
            );
            expect(gitBeforePorcelain).not.toContain('prunable');
            expect(tsgitBefore.entries.every((entry) => entry.prunable === undefined)).toBe(true);
          } finally {
            await repoBefore.dispose();
          }

          // Act + Assert — after relocating the WHOLE tree: the relative
          // pointers still resolve, with no absolute path baked in anywhere.
          const relocatedParent = `${parent}-relocated`;
          rowDirs.push(relocatedParent);
          await rename(parent, relocatedParent);
          const relocatedRepoDir = path.join(relocatedParent, 'repo');
          const gitAfterPorcelain = git(relocatedRepoDir, 'worktree', 'list', '--porcelain');
          const repoAfter = await openRow(relocatedRepoDir);
          try {
            const tsgitAfter = await repoAfter.worktree.list();
            const afterPaths = parseWorktreePaths(gitAfterPorcelain);
            expect(tsgitAfter.entries.map((entry) => entry.path).sort()).toEqual(
              [...afterPaths].sort(),
            );
            expect(gitAfterPorcelain).not.toContain('prunable');
            expect(tsgitAfter.entries.every((entry) => entry.prunable === undefined)).toBe(true);
            // Sanity: the relocation actually happened (paths moved).
            expect(afterPaths.every((p) => p.includes('-relocated'))).toBe(true);
          } finally {
            await repoAfter.dispose();
          }
        });
      },
    );

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
          it('Then the gate accepts it and the repository reports the sha256 algorithm', async () => {
            // Arrange — the gate refused this repository while `objectFormat`
            // sat in the point-of-use refuse set. SHA-256 support removed that
            // entry, so the same repository must now open and carry its
            // declared algorithm through to the context.
            const root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-format-sha256-'));
            rowDirs.push(root);
            const dir = path.join(root, 'repo');
            runGit(['init', '-q', '--object-format=sha256', dir]);

            // Act
            const repo = await openRow(dir);

            // Assert
            try {
              expect(repo.ctx.layout.formatRefusal).toBeUndefined();
              expect(repo.ctx.hashConfig.algorithm).toBe('sha256');
              expect(repo.ctx.hashConfig.hexLength).toBe(64);
            } finally {
              await repo.dispose();
            }
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

    // ─────────────────────────────────────────────────────────────────────
    // Row 8 (refusing side) — every mover verb refuses in BOTH tools on
    // BOTH the v99 and the v1+unknown-extension fixtures; each config
    // writer's config file is byte-unchanged afterwards.
    // ─────────────────────────────────────────────────────────────────────

    const FORMAT_FIXTURES: ReadonlyArray<{
      readonly given: string;
      readonly slug: string;
      readonly arm: (dir: string) => void;
      readonly refusalData: Record<string, unknown>;
    }> = [
      {
        given: 'repositoryformatversion = 99',
        slug: 'v99-mover',
        arm: (dir) => armVersion(dir, '99'),
        refusalData: { code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED', version: 99 },
      },
      {
        given: 'repositoryformatversion = 1 with an unknown extension',
        slug: 'ext-unknown-mover',
        arm: (dir) =>
          armRaw(dir, '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tbogus = 1\n'),
        refusalData: {
          code: 'REPOSITORY_EXTENSIONS_UNSUPPORTED',
          version: 1,
          extensions: ['bogus'],
        },
      },
    ];

    const CONFIG_WRITER_CASES: ReadonlyArray<{
      readonly name: string;
      readonly gitArgs: ReadonlyArray<string>;
      readonly run: (repo: Repository) => Promise<unknown>;
    }> = [
      {
        name: 'configSet',
        gitArgs: ['config', 'user.name', 'Ada'],
        run: (repo) => repo.config.set({ key: 'user.name', value: 'Ada' }),
      },
      {
        name: 'configUnset',
        gitArgs: ['config', '--unset', 'user.name'],
        run: (repo) => repo.config.unset({ key: 'user.name' }),
      },
      {
        name: 'configUnsetAll',
        gitArgs: ['config', '--unset-all', 'user.name'],
        run: (repo) => repo.config.unsetAll({ key: 'user.name' }),
      },
      {
        name: 'configRenameSection',
        gitArgs: ['config', '--rename-section', 'remote.origin', 'remote.upstream'],
        run: (repo) =>
          repo.config.renameSection({ oldName: 'remote.origin', newName: 'remote.upstream' }),
      },
      {
        name: 'configRemoveSection',
        gitArgs: ['config', '--remove-section', 'remote.origin'],
        run: (repo) => repo.config.removeSection({ name: 'remote.origin' }),
      },
    ];

    const REMOTE_VERB_CASES: ReadonlyArray<{
      readonly name: string;
      readonly gitArgs: ReadonlyArray<string>;
      readonly run: (repo: Repository) => Promise<unknown>;
    }> = [
      { name: 'remoteList', gitArgs: ['remote', '-v'], run: (repo) => repo.remote.list() },
      {
        name: 'remoteAdd',
        gitArgs: ['remote', 'add', 'origin', 'https://example.com/repo.git'],
        run: (repo) => repo.remote.add({ name: 'origin', url: 'https://example.com/repo.git' }),
      },
      {
        name: 'remoteRemove',
        gitArgs: ['remote', 'remove', 'origin'],
        run: (repo) => repo.remote.remove({ name: 'origin' }),
      },
      {
        name: 'remoteRename',
        gitArgs: ['remote', 'rename', 'origin', 'upstream'],
        run: (repo) => repo.remote.rename({ from: 'origin', to: 'upstream' }),
      },
      {
        name: 'remoteSetUrl',
        gitArgs: ['remote', 'set-url', 'origin', 'https://example.com/other.git'],
        run: (repo) => repo.remote.setUrl({ name: 'origin', url: 'https://example.com/other.git' }),
      },
      {
        name: 'remoteShow',
        gitArgs: ['remote', 'show', '-n', 'origin'],
        run: (repo) => repo.remote.show({ name: 'origin' }),
      },
    ];

    describe.each(FORMAT_FIXTURES)('Given $given', ({ slug, arm, refusalData }) => {
      describe('When each config writer runs', () => {
        it.each(CONFIG_WRITER_CASES)(
          'Then $name refuses in both tools, config byte-unchanged',
          async ({ name, gitArgs, run }) => {
            // Arrange
            const dir = await copyRow(`${slug}-${name}`);
            arm(dir);
            const before = readFileSync(configPath(dir));

            // Act
            const g = tryRunGitWithExit(['-C', dir, ...gitArgs]);
            const repo = await openRow(dir);
            try {
              let caught: unknown;
              try {
                await run(repo);
              } catch (err) {
                caught = err;
              }

              // Assert — git
              expect(g.exitCode).toBe(128);
              expect(readFileSync(configPath(dir))).toEqual(before);
              // Assert — tsgit
              expect(caught).toBeInstanceOf(TsgitError);
              expect((caught as TsgitError).data).toMatchObject(refusalData);
              expect(readFileSync(configPath(dir))).toEqual(before);
            } finally {
              await repo.dispose();
            }
          },
        );
      });

      describe('When each remote verb runs', () => {
        it.each(REMOTE_VERB_CASES)(
          'Then $name refuses in both tools',
          async ({ name, gitArgs, run }) => {
            // Arrange
            const dir = await copyRow(`${slug}-${name}`);
            arm(dir);

            // Act
            const g = tryRunGitWithExit(['-C', dir, ...gitArgs]);
            const repo = await openRow(dir);
            try {
              let caught: unknown;
              try {
                await run(repo);
              } catch (err) {
                caught = err;
              }

              // Assert — git
              expect(g.exitCode).toBe(128);
              // Assert — tsgit
              expect(caught).toBeInstanceOf(TsgitError);
              expect((caught as TsgitError).data).toMatchObject(refusalData);
            } finally {
              await repo.dispose();
            }
          },
        );
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Row 8 (surviving side) — the four config READ verbs demote the
    // repository to absent rather than refuse: `config --list` exits 0 with
    // the repository scope dropped, a repo-scoped key is "not found",
    // `--global --list` is untouched, and `--local --list` refuses.
    // ─────────────────────────────────────────────────────────────────────

    describe.each(FORMAT_FIXTURES)('Given $given', ({ slug, arm }) => {
      describe('When config --list runs', () => {
        it('Then git exits 0 and tsgit drops the repository scope', async () => {
          // Arrange — the base fixture sets user.name/user.email in LOCAL scope,
          // so their absence below is the guard's doing, not mere absence.
          const dir = await copyRow(`${slug}-list`);
          arm(dir);

          // Act
          const list = tryRunGitWithExit(['-C', dir, 'config', '--list']);
          const repo = await openRow(dir);
          try {
            const result = await repo.config.list();

            // Assert — git
            expect(list.exitCode).toBe(0);
            // Assert — tsgit
            expect(result.entries.some((entry) => entry.scope === 'local')).toBe(false);
          } finally {
            await repo.dispose();
          }
        });
      });

      describe('When a repository-scoped key is read', () => {
        it('Then it is "not found" in both tools', async () => {
          // Arrange
          const dir = await copyRow(`${slug}-getmiss`);
          arm(dir);

          // Act
          const getName = tryRunGitWithExit(['-C', dir, 'config', 'user.name']);
          const getRegexp = tryRunGitWithExit(['-C', dir, 'config', '--get-regexp', '^user\\.']);
          const repo = await openRow(dir);
          try {
            const name = await repo.config.get({ key: 'user.name' });
            const regexp = await repo.config.getRegexp({ keyPattern: /^user\./ });

            // Assert — git
            expect(getName.exitCode).toBe(1);
            expect(getRegexp.exitCode).toBe(1);
            // Assert — tsgit
            expect(name).toEqual({ key: 'user.name', value: undefined });
            expect(regexp.entries).toEqual([]);
          } finally {
            await repo.dispose();
          }
        });
      });

      describe('When config --local --list runs', () => {
        it('Then it refuses in both tools', async () => {
          // Arrange
          const dir = await copyRow(`${slug}-local-list`);
          arm(dir);

          // Act
          const g = tryRunGitWithExit(['-C', dir, 'config', '--local', '--list']);
          const repo = await openRow(dir);
          try {
            let caught: unknown;
            try {
              await repo.config.list({ scope: 'local' });
            } catch (err) {
              caught = err;
            }

            // Assert — git
            expect(g.exitCode).toBe(128);
            expect(g.stderr).toContain('fatal: --local can only be used inside a git repository');
            // Assert — tsgit
            expect(caught).toBeInstanceOf(TsgitError);
            expect((caught as TsgitError).data).toEqual({
              code: 'CONFIG_SCOPE_NOT_AVAILABLE',
              scope: 'local',
              reason: 'repository-not-accepted',
            });
          } finally {
            await repo.dispose();
          }
        });
      });

      describe('When config --global --list runs', () => {
        it('Then it stays reachable in git — non-repository scopes are untouched', async () => {
          // Arrange — a real ~/.gitconfig this time (the suite's shared ISOLATED_HOME has
          // none, and `--global --list` itself refuses when the target file is absent —
          // an artefact of that isolation, not of the format gate under test here).
          const dir = await copyRow(`${slug}-global-list`);
          arm(dir);
          const home = await mkdtemp(path.join(os.tmpdir(), 'tsgit-format-global-home-'));
          rowDirs.push(home);
          writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Global User\n');
          const env = { ...runGitEnv(), HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };

          // Act
          const g = tryRunGitWithExit(['-C', dir, 'config', '--global', '--list'], { env });

          // Assert
          expect(g.exitCode).toBe(0);
          expect(g.stdout).toContain('user.name=Global User');
        });
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Row 9 — precedence co-truth, both tiers per row: the discovery-tier
    // boolean gate and a syntax error BEAT the format verdict everywhere,
    // including on `config --list`; the eager `[core]` gate LOSES to the
    // format verdict on the operational verb and never fires on the
    // porcelain at all. compatObjectFormat proves the tier is per-condition:
    // at v1 it dies universally, at v99 the version wins and it survives.
    // ─────────────────────────────────────────────────────────────────────

    const PRECEDENCE_BEATS_VERSION: ReadonlyArray<{
      readonly given: string;
      readonly slug: string;
      readonly suffix: string;
      readonly refusalData: Record<string, unknown>;
    }> = [
      {
        given: 'v99 + core.bare = banana',
        slug: 'v99-bare-banana',
        suffix: '[core]\n\trepositoryformatversion = 99\n\tbare = banana\n',
        refusalData: { code: 'CONFIG_BAD_BOOLEAN_VALUE', key: 'core.bare', value: 'banana' },
      },
      {
        given: 'v99 + extensions.worktreeConfig = banana',
        slug: 'v99-wtconfig-banana',
        suffix: '[core]\n\trepositoryformatversion = 99\n[extensions]\n\tworktreeConfig = banana\n',
        refusalData: {
          code: 'CONFIG_BAD_BOOLEAN_VALUE',
          key: 'extensions.worktreeconfig',
          value: 'banana',
        },
      },
      {
        given: 'v99 + a syntactically broken config line',
        slug: 'v99-syntax-broken',
        suffix: '[core]\n\trepositoryformatversion = 99\n\tfoo = "unterminated\n',
        refusalData: { code: 'CONFIG_PARSE_ERROR' },
      },
    ];

    describe.each(PRECEDENCE_BEATS_VERSION)('Given $given', ({ slug, suffix, refusalData }) => {
      describe('When config --list runs', () => {
        it('Then the discovery-tier refusal beats the version in both tools', async () => {
          // Arrange — the refusal may fire as early as `openRepository` (bad `core.bare`,
          // a syntax error — both read while resolving the layout itself) or as late as
          // `config.list` (`extensions.worktreeConfig` — checked only per-command); either
          // way it must beat the version, so both layers are wrapped in one try.
          const dir = await copyRow(slug);
          armRaw(dir, suffix);

          // Act
          const list = tryRunGitWithExit(['-C', dir, 'config', '--list']);
          let repo: Repository | undefined;
          let caught: unknown;
          try {
            repo = await openRow(dir);
            await repo.config.list();
          } catch (err) {
            caught = err;
          } finally {
            await repo?.dispose();
          }

          // Assert — git: refuses (not the version fatal)
          expect(list.exitCode).toBe(128);
          expect(list.stderr).not.toContain('Expected git repo version');
          // Assert — tsgit: the discovery-tier code, not REPOSITORY_FORMAT_VERSION_UNSUPPORTED
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toMatchObject(refusalData);
        });
      });
    });

    const PRECEDENCE_LOSES_TO_VERSION: ReadonlyArray<{
      readonly given: string;
      readonly slug: string;
      readonly suffix: string;
    }> = [
      {
        given: 'v99 + core.sparseCheckout = banana',
        slug: 'v99-sparse-banana',
        suffix: '[core]\n\trepositoryformatversion = 99\n\tsparseCheckout = banana\n',
      },
      {
        given: 'v99 + core.maxTreeDepth = abc',
        slug: 'v99-maxdepth-abc',
        suffix: '[core]\n\trepositoryformatversion = 99\n\tmaxTreeDepth = abc\n',
      },
      {
        given: 'v99 + a valueless core.excludesFile',
        slug: 'v99-excludes-valueless',
        suffix: '[core]\n\trepositoryformatversion = 99\n\texcludesFile\n',
      },
    ];

    describe.each(PRECEDENCE_LOSES_TO_VERSION)('Given $given', ({ slug, suffix }) => {
      describe('When status runs and config --list runs', () => {
        it('Then the version wins on the operational verb and never fires on the porcelain', async () => {
          // Arrange
          const dir = await copyRow(`${slug}-op`);
          armRaw(dir, suffix);

          // Act
          const status = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);
          const list = tryRunGitWithExit(['-C', dir, 'config', '--list']);
          const repo = await openRow(dir);
          try {
            let caughtSet: unknown;
            try {
              await repo.config.set({ key: 'user.name', value: 'Ada' });
            } catch (err) {
              caughtSet = err;
            }
            const listResult = await repo.config.list();

            // Assert — git: the operational verb dies on the VERSION fatal, config --list survives
            expect(status.exitCode).toBe(128);
            expect(status.stderr).toContain(expectedVersionStderr(99));
            expect(list.exitCode).toBe(0);
            // Assert — tsgit: a mover sees the version refusal (not the eager-core one);
            // the porcelain read never reaches the eager gate at all.
            expect(caughtSet).toBeInstanceOf(TsgitError);
            expect((caughtSet as TsgitError).data).toMatchObject({
              code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED',
              version: 99,
            });
            expect(listResult.entries.some((entry) => entry.scope === 'local')).toBe(false);
          } finally {
            await repo.dispose();
          }
        });
      });
    });

    describe('Given extensions.compatObjectFormat at version 1 (co-truth: dies universally)', () => {
      describe('When config --list is attempted in both tools', () => {
        it('Then git refuses and tsgit cannot even open the repository', async () => {
          // Arrange
          const dir = await copyRow('compat-v1-config-list');
          armRaw(
            dir,
            '[core]\n\trepositoryformatversion = 1\n[extensions]\n\tcompatObjectFormat = sha1\n',
          );

          // Act
          const list = tryRunGitWithExit(['-C', dir, 'config', '--list']);
          let caught: unknown;
          try {
            await openRow(dir);
          } catch (err) {
            caught = err;
          }

          // Assert — git
          expect(list.exitCode).toBe(128);
          // Assert — tsgit: no repository, no config surface reachable at all
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toMatchObject({
            code: 'REPOSITORY_EXTENSION_UNSUPPORTED',
            extension: 'compatobjectformat',
          });
        });
      });
    });

    describe('Given extensions.compatObjectFormat at version 99 (co-truth: the version wins, it survives)', () => {
      describe('When config --list runs in both tools', () => {
        it('Then both exit 0 and tsgit drops the repository scope', async () => {
          // Arrange
          const dir = await copyRow('compat-v99-config-list');
          armRaw(
            dir,
            '[core]\n\trepositoryformatversion = 99\n[extensions]\n\tcompatObjectFormat = sha1\n',
          );

          // Act
          const list = tryRunGitWithExit(['-C', dir, 'config', '--list']);
          const repo = await openRow(dir);
          try {
            const result = await repo.config.list();

            // Assert — git
            expect(list.exitCode).toBe(0);
            // Assert — tsgit
            expect(repo.ctx.layout.formatRefusal).toStrictEqual({ kind: 'version', version: 99 });
            expect(result.entries.some((entry) => entry.scope === 'local')).toBe(false);
          } finally {
            await repo.dispose();
          }
        });
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Row 10 — route coverage: the carried format verdict is the SAME
    // regardless of how the repository is opened.
    // ─────────────────────────────────────────────────────────────────────

    describe('Given repositoryformatversion = 99 opened through five different discovery routes', () => {
      describe('When openRepository runs each route', () => {
        it('Then a subdirectory cwd still resolves the refusal', async () => {
          // Arrange
          const dir = await copyRow('v99-route-subdir');
          armVersion(dir, '99');
          const sub = path.join(dir, 'nested', 'deep');
          await mkdir(sub, { recursive: true });

          // Act
          const repo = await openRow(sub);
          try {
            // Assert
            expect(repo.ctx.layout.formatRefusal).toStrictEqual({ kind: 'version', version: 99 });
          } finally {
            await repo.dispose();
          }
        });

        it('Then an explicit gitDir with cwd elsewhere still resolves the refusal', async () => {
          // Arrange
          const dir = await copyRow('v99-route-gitdir');
          armVersion(dir, '99');
          const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'tsgit-format-elsewhere-'));
          rowDirs.push(elsewhere);

          // Act
          const repo = await openRepository({ cwd: elsewhere, gitDir: path.join(dir, '.git') });
          try {
            // Assert
            expect(repo.ctx.layout.formatRefusal).toStrictEqual({ kind: 'version', version: 99 });
          } finally {
            await repo.dispose();
          }
        });

        it('Then cwd-is-gitdir into a bare-shaped v99 gitdir still resolves the refusal', async () => {
          // Arrange
          const root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-format-bare-'));
          rowDirs.push(root);
          const bareDir = path.join(root, 'repo.git');
          runGit(['init', '-q', '--bare', '-b', 'main', bareDir]);
          const bareConfig = readFileSync(path.join(bareDir, 'config'), 'utf8');
          writeFileSync(
            path.join(bareDir, 'config'),
            `${bareConfig}[core]\n\trepositoryformatversion = 99\n`,
          );

          // Act
          const repo = await openRow(bareDir);
          try {
            // Assert
            expect(repo.ctx.layout.formatRefusal).toStrictEqual({ kind: 'version', version: 99 });
          } finally {
            await repo.dispose();
          }
        });

        it('Then a linked worktree and its main checkout both resolve the SAME refusal from the shared common config', async () => {
          // Arrange
          const dir = await copyRow('v99-route-worktree');
          const worktreeRoot = await mkdtemp(path.join(os.tmpdir(), 'tsgit-format-wt-'));
          rowDirs.push(worktreeRoot);
          const wtPath = path.join(worktreeRoot, 'wt');
          runGit(['-C', dir, 'branch', 'side']);
          runGit(['-C', dir, 'worktree', 'add', '-q', wtPath, 'side']);
          armVersion(dir, '99');

          // Act
          const mainRepo = await openRow(dir);
          const wtRepo = await openRow(wtPath);
          try {
            // Assert
            expect(mainRepo.ctx.layout.formatRefusal).toStrictEqual({
              kind: 'version',
              version: 99,
            });
            expect(wtRepo.ctx.layout.formatRefusal).toStrictEqual({ kind: 'version', version: 99 });
          } finally {
            await mainRepo.dispose();
            await wtRepo.dispose();
          }
        });

        it('Then a v99 repo nested inside a good outer repo refuses from the inner cwd — discovery does not climb past it', async () => {
          // Arrange
          const outerRoot = await mkdtemp(path.join(os.tmpdir(), 'tsgit-format-nested-'));
          rowDirs.push(outerRoot);
          runGit(['init', '-q', '-b', 'main', outerRoot]);
          const innerDir = path.join(outerRoot, 'inner');
          await mkdir(innerDir, { recursive: true });
          runGit(['init', '-q', '-b', 'main', innerDir]);
          const innerConfig = readFileSync(path.join(innerDir, '.git', 'config'), 'utf8');
          writeFileSync(
            path.join(innerDir, '.git', 'config'),
            `${innerConfig}[core]\n\trepositoryformatversion = 99\n`,
          );

          // Act
          const repo = await openRow(innerDir);
          try {
            // Assert
            // Platform note: `os.tmpdir()` resolves through a symlink on
            // macOS (`/var` -> `/private/var`), so the gitDir is compared by
            // suffix rather than exact equality — the point being proven is
            // WHICH repo was read (inner, not outer), not the tmpdir prefix.
            expect(repo.ctx.layout.gitDir.endsWith(path.join('inner', '.git'))).toBe(true);
            expect(repo.ctx.layout.formatRefusal).toStrictEqual({ kind: 'version', version: 99 });
          } finally {
            await repo.dispose();
          }
        });
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Row 11 — bootstrap: re-init against a v99 repository refuses in BOTH
    // tools with the config byte-unchanged (tsgit via ALREADY_INITIALIZED —
    // it has no re-init at all — git via the format gate: different codes,
    // same observable refusal); a tsgit-created repository is v0 with no
    // [extensions] and opens fine in real git.
    // ─────────────────────────────────────────────────────────────────────

    describe('Given repositoryformatversion = 99', () => {
      describe('When git init and tsgit init are both attempted against the existing repository', () => {
        it('Then both refuse with the config file byte-unchanged', async () => {
          // Arrange
          const dir = await copyRow('v99-reinit');
          armVersion(dir, '99');
          const before = readFileSync(configPath(dir));

          // Act
          const g = tryRunGitWithExit(['-C', dir, 'init', '-q']);
          const ctx = createNodeContext({ workDir: dir });
          let caught: unknown;
          try {
            await init(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert — git
          expect(g.exitCode).toBe(128);
          expect(readFileSync(configPath(dir))).toEqual(before);
          // Assert — tsgit
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toMatchObject({ code: 'ALREADY_INITIALIZED' });
          expect(readFileSync(configPath(dir))).toEqual(before);
        });
      });
    });

    describe('Given a fresh directory', () => {
      describe('When tsgit init runs and git reads the result back', () => {
        it('Then the config is v0 with no [extensions] section, and git opens it (exit 0)', async () => {
          // Arrange
          const root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-format-bootstrap-'));
          rowDirs.push(root);
          const dir = path.join(root, 'repo');
          await mkdir(dir, { recursive: true });
          const ctx = createNodeContext({ workDir: dir });

          // Act
          await init(ctx);
          const configText = readFileSync(configPath(dir), 'utf8');
          const g = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);

          // Assert
          expect(configText).toMatch(/repositoryformatversion\s*=\s*0/);
          expect(configText).not.toContain('[extensions]');
          expect(g.exitCode).toBe(0);
        });
      });
    });
  },
);
