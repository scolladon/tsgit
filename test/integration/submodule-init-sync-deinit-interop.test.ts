/**
 * Cross-tool interop — submodule `init` / `sync` / `deinit`. Builds a real
 * superproject with one submodule (relative url + an `update` mode) using
 * canonical git, then drives tsgit's write verbs against fresh clones and
 * asserts the resulting `.git/config` `[submodule …]` sections and working-tree
 * state are byte-identical to what real `git submodule init/sync/deinit`
 * produces on an identical clone.
 *
 * @proves
 *   surface:        submodule.init, submodule.sync, submodule.deinit
 *   bucket:         cross-tool-interop
 *   unique:         tsgit submodule write verbs reproduce git's .git/config + worktree state
 *   interopSurface: submodule
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import {
  submoduleDeinit,
  submoduleInit,
  submoduleSync,
} from '../../src/application/commands/submodule.js';
import { TsgitError } from '../../src/domain/error.js';
import { GIT_AVAILABLE, runGitEnv } from './interop-helpers.js';

const ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A U Thor',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'A U Thor',
  GIT_COMMITTER_EMAIL: 'author@example.com',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync('git', ['-c', 'protocol.file.allow=always', '-C', cwd, ...args], {
    env: ENV,
  }).toString();

/** The `[submodule …]` sections of a repo's `.git/config`, as raw text. */
const submoduleSections = (repoDir: string): string => {
  const text = readFileSync(path.join(repoDir, '.git', 'config'), 'utf8');
  const lines = text.split('\n');
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^\[/.test(line)) inSection = /^\[submodule /.test(line);
    if (inSection) out.push(line);
  }
  return out.join('\n');
};

let base: string;
let superDir: string;
let cloneCounter = 0;

const freshClone = (): string => {
  cloneCounter += 1;
  const dir = path.join(base, `clone-${cloneCounter}`);
  git(base, 'clone', '-q', superDir, dir);
  return dir;
};

beforeAll(() => {
  if (!GIT_AVAILABLE) return;
  base = mkdtempSync(path.join(os.tmpdir(), 'tsgit-submodule-interop-'));
  // A submodule source repo.
  const subDir = path.join(base, 'sub');
  git(base, 'init', '-q', '-b', 'main', subDir);
  writeFileSync(path.join(subDir, 'a.txt'), 'hi\n');
  git(subDir, 'add', 'a.txt');
  git(subDir, 'commit', '-qm', 'sub init');
  // A superproject pinning it via a relative url, with an `update` mode.
  superDir = path.join(base, 'super');
  git(base, 'init', '-q', '-b', 'main', superDir);
  writeFileSync(path.join(superDir, 'r.txt'), 'root\n');
  git(superDir, 'add', 'r.txt');
  git(superDir, 'commit', '-qm', 'root');
  git(superDir, 'submodule', 'add', '../sub', 'libs/sub');
  git(superDir, 'config', '-f', '.gitmodules', 'submodule.libs/sub.update', 'rebase');
  git(superDir, 'add', '.gitmodules');
  git(superDir, 'commit', '-qm', 'add submodule');
}, 60_000);

afterAll(async () => {
  if (base !== undefined) await rm(base, { recursive: true, force: true });
});

describe.skipIf(!GIT_AVAILABLE)('integration/submodule write-side interop', () => {
  describe('Given a fresh clone with an un-initialised submodule', () => {
    describe('When init runs', () => {
      it('Then the .git/config submodule section matches git submodule init', async () => {
        // Arrange
        const gitClone = freshClone();
        const tsgitClone = freshClone();

        // Act
        git(gitClone, 'submodule', 'init');
        await submoduleInit(createNodeContext({ workDir: tsgitClone }));

        // Assert
        expect(submoduleSections(tsgitClone)).toBe(submoduleSections(gitClone));
        expect(submoduleSections(tsgitClone)).toContain('active = true');
        expect(submoduleSections(tsgitClone)).toContain('update = rebase');
      });
    });
  });

  describe('Given an initialised, checked-out submodule whose url changed', () => {
    describe('When sync runs', () => {
      it('Then both the superproject and submodule remote urls match git submodule sync', async () => {
        // Arrange — clone, init+update (checkout), then re-point .gitmodules
        const gitClone = freshClone();
        const tsgitClone = freshClone();
        for (const clone of [gitClone, tsgitClone]) {
          git(clone, 'submodule', 'update', '--init');
          git(clone, 'config', '-f', '.gitmodules', 'submodule.libs/sub.url', '../sub');
        }

        // Act
        git(gitClone, 'submodule', 'sync');
        await submoduleSync(createNodeContext({ workDir: tsgitClone }));

        // Assert
        expect(submoduleSections(tsgitClone)).toBe(submoduleSections(gitClone));
        const moduleConfig = (clone: string): string =>
          readFileSync(path.join(clone, '.git', 'modules', 'libs', 'sub', 'config'), 'utf8');
        expect(moduleConfig(tsgitClone)).toBe(moduleConfig(gitClone));
      });
    });
  });

  describe('Given an initialised, clean submodule', () => {
    describe('When deinit runs', () => {
      it('Then config + worktree match git submodule deinit', async () => {
        // Arrange
        const gitClone = freshClone();
        const tsgitClone = freshClone();
        for (const clone of [gitClone, tsgitClone]) {
          git(clone, 'submodule', 'update', '--init');
        }

        // Act
        git(gitClone, 'submodule', 'deinit', 'libs/sub');
        await submoduleDeinit(createNodeContext({ workDir: tsgitClone }), { paths: ['libs/sub'] });

        // Assert — no submodule config section remains in either
        expect(submoduleSections(tsgitClone)).toBe(submoduleSections(gitClone));
        expect(submoduleSections(tsgitClone)).toBe('');
        // Worktree dir is present but empty in both
        const worktree = (clone: string): readonly string[] =>
          readdirSync(path.join(clone, 'libs', 'sub'));
        expect(worktree(tsgitClone)).toEqual(worktree(gitClone));
        expect(worktree(tsgitClone)).toEqual([]);
        // The absorbed gitdir and .gitmodules survive deinit
        expect(existsSync(path.join(tsgitClone, '.git', 'modules', 'libs', 'sub'))).toBe(true);
        expect(existsSync(path.join(tsgitClone, '.gitmodules'))).toBe(true);
      });
    });
  });

  describe('Given all combined with an explicit pathspec', () => {
    describe('When deinit runs', () => {
      it('Then it refuses, as git does', async () => {
        // Arrange
        const gitClone = freshClone();
        const tsgitClone = freshClone();

        // Act & Assert — git refuses (non-zero exit)
        let gitRefused = false;
        try {
          git(gitClone, 'submodule', 'deinit', '--all', 'libs/sub');
        } catch {
          gitRefused = true;
        }
        expect(gitRefused).toBe(true);

        // tsgit refuses with INVALID_OPTION before touching the working tree
        let thrown: unknown;
        try {
          await submoduleDeinit(createNodeContext({ workDir: tsgitClone }), {
            all: true,
            paths: ['libs/sub'],
          });
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(TsgitError);
        expect((thrown as TsgitError).data).toMatchObject({
          code: 'INVALID_OPTION',
          option: 'submodule.deinit',
          reason: expect.stringContaining('incompatible'),
        });
      });
    });
  });

  describe('Given a submodule with local modifications', () => {
    describe('When deinit runs without force', () => {
      it('Then it refuses, as git does', async () => {
        // Arrange
        const gitClone = freshClone();
        const tsgitClone = freshClone();
        for (const clone of [gitClone, tsgitClone]) {
          git(clone, 'submodule', 'update', '--init');
          writeFileSync(path.join(clone, 'libs', 'sub', 'untracked.txt'), 'dirty\n');
        }

        // Act & Assert — git refuses (non-zero exit)
        let gitRefused = false;
        try {
          git(gitClone, 'submodule', 'deinit', 'libs/sub');
        } catch {
          gitRefused = true;
        }
        expect(gitRefused).toBe(true);

        // tsgit refuses with SUBMODULE_HAS_MODIFICATIONS
        let thrown: unknown;
        try {
          await submoduleDeinit(createNodeContext({ workDir: tsgitClone }), {
            paths: ['libs/sub'],
          });
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(TsgitError);
        expect((thrown as TsgitError).data.code).toBe('SUBMODULE_HAS_MODIFICATIONS');
      });
    });
  });
});
