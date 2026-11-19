/**
 * POSIX-only interop — core.fileMode decides whether the executable bit is staged,
 * reported, refused or overwritten. Each row seeds two identical repositories with the
 * same git script, runs one operation in canonical git and in tsgit, and compares the
 * index, the owner exec bit on disk and the outcome.
 *
 * @proves
 *   surface:        repo.add, repo.status, repo.rm, repo.stash.push, repo.stash.pop, repo.cherryPick.run, repo.checkout, repo.merge.run
 *   bucket:         platform-only
 *   unique:         core.fileMode decides whether the exec bit is staged, reported, refused or overwritten, as canonical git does
 *   interopSurface: add, status, stash, checkout, merge, sequencer, config
 */
import { chmodSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChangeKind } from '../../../src/application/commands/status.js';
import type { Repository } from '../../../src/repository.js';
import {
  GIT_AVAILABLE,
  lsStage,
  makePeerPair,
  type PeerPair,
  runGit,
  tryRunGitWithExit,
} from '../interop-helpers.js';
import { COMMIT_ENV } from '../occupant-displacement-fixtures.js';
import { trackedRepositories } from '../repository-lifecycle.js';

const ROW_TIMEOUT = 60_000;
const OWNER_EXEC = 0o100;
const EXECUTABLE_PERMISSIONS = 0o755;
const PLAIN_PERMISSIONS = 0o644;
const UNSTAGED_COLUMN: Readonly<Record<ChangeKind, string>> = {
  modified: 'M',
  'mode-changed': 'M',
  'type-changed': 'T',
  deleted: 'D',
  added: 'A',
};

const open = trackedRepositories();

interface SeedFile {
  readonly path: string;
  readonly content: string;
  readonly executable?: boolean;
  readonly linkTo?: string;
}

const sh = (dir: string, ...args: ReadonlyArray<string>): string =>
  runGit(['-C', dir, ...args], { env: COMMIT_ENV });

const writeSeedFile = (dir: string, file: SeedFile): void => {
  const target = join(dir, file.path);
  mkdirSync(join(target, '..'), { recursive: true });
  if (file.linkTo !== undefined) {
    symlinkSync(file.linkTo, target);
    return;
  }
  writeFileSync(target, file.content);
  if (file.executable === true) chmodSync(target, EXECUTABLE_PERMISSIONS);
};

const seedTwin = (dir: string, ignoreCase: string, files: ReadonlyArray<SeedFile>): void => {
  sh(dir, 'config', 'core.ignorecase', ignoreCase);
  for (const file of files) writeSeedFile(dir, file);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'base');
};

const ownerExec = (dir: string, name: string): boolean =>
  (statSync(join(dir, name)).mode & OWNER_EXEC) !== 0;

const gitStatusRows = (dir: string): ReadonlyArray<string> =>
  sh(dir, 'status', '--porcelain=v2')
    .split('\n')
    .filter((line) => line.startsWith('1 '))
    .map((line) => line.split(' '))
    .map((cols) => `${cols[1]?.[1]} ${cols[4]} ${cols[5]} ${cols[8]}`);

const tsgitStatusRows = async (repo: Repository): Promise<ReadonlyArray<string>> =>
  (await repo.status()).changes.map(
    (change) =>
      `${change.unstaged === undefined ? '.' : UNSTAGED_COLUMN[change.unstaged]} ${change.index?.mode} ${change.worktree?.mode} ${change.path}`,
  );

const BASE_FILE: SeedFile = { path: 'f', content: 'one\n' };
const EXECUTABLE_FILE: SeedFile = { ...BASE_FILE, executable: true };
const SEED_FILE: SeedFile = { path: 'seed', content: 's\n' };

interface StatusRow {
  readonly id: string;
  readonly files: ReadonlyArray<SeedFile>;
  readonly prepare: (dir: string) => void;
  readonly expected: ReadonlyArray<string>;
}

const setFileMode = (value: string) => (dir: string) => sh(dir, 'config', 'core.fileMode', value);
const chmodTo = (permissions: number) => (dir: string) => chmodSync(join(dir, 'f'), permissions);
const inOrder =
  (...steps: ReadonlyArray<(dir: string) => void>) =>
  (dir: string) => {
    for (const step of steps) step(dir);
  };

const STATUS_ROWS: ReadonlyArray<StatusRow> = [
  {
    id: 'gained-bit-ignored',
    files: [BASE_FILE],
    prepare: inOrder(setFileMode('false'), chmodTo(EXECUTABLE_PERMISSIONS)),
    expected: [],
  },
  {
    id: 'gained-bit-trusted',
    files: [BASE_FILE],
    prepare: inOrder(setFileMode('true'), chmodTo(EXECUTABLE_PERMISSIONS)),
    expected: ['M 100644 100755 f'],
  },
  {
    id: 'lost-bit-ignored',
    files: [EXECUTABLE_FILE],
    prepare: inOrder(setFileMode('false'), chmodTo(PLAIN_PERMISSIONS)),
    expected: [],
  },
  {
    id: 'symlink-replaced-by-executable-file',
    files: [{ path: 'l', content: '', linkTo: 'target' }],
    prepare: inOrder(setFileMode('false'), (dir) => {
      rmSync(join(dir, 'l'));
      writeFileSync(join(dir, 'l'), 'target');
      chmodSync(join(dir, 'l'), EXECUTABLE_PERMISSIONS);
    }),
    expected: ['T 120000 100644 l'],
  },
  {
    id: 'worktree-config-overrides-local',
    files: [BASE_FILE],
    prepare: inOrder(
      (dir) => sh(dir, 'config', 'extensions.worktreeConfig', 'true'),
      setFileMode('true'),
      (dir) => sh(dir, 'config', '--worktree', 'core.fileMode', 'false'),
      chmodTo(EXECUTABLE_PERMISSIONS),
    ),
    expected: [],
  },
];

interface ConflictShape {
  readonly id: string;
  readonly base: SeedFile | undefined;
  readonly prepareMain: (dir: string) => void;
  readonly prepareOther: (dir: string) => void;
}

const writeFileWith = (name: string, content: string, permissions: number) => (dir: string) => {
  writeFileSync(join(dir, name), content);
  chmodSync(join(dir, name), permissions);
};
const gitRemove = (name: string) => (dir: string) => sh(dir, 'rm', '-q', name);

const AA_OURS_EXECUTABLE: ConflictShape = {
  id: 'AA with ours 100755 and theirs 100644',
  base: undefined,
  prepareMain: writeFileWith('f', 'main\n', EXECUTABLE_PERMISSIONS),
  prepareOther: writeFileWith('f', 'other\n', PLAIN_PERMISSIONS),
};

const DU_BASE_EXECUTABLE: ConflictShape = {
  id: 'DU with base 100755 and theirs 100644',
  base: EXECUTABLE_FILE,
  prepareMain: gitRemove('f'),
  prepareOther: writeFileWith('f', 'two\n', PLAIN_PERMISSIONS),
};

const CONFLICT_SHAPES: ReadonlyArray<ConflictShape> = [
  {
    id: 'UD with ours 100755 over base 100644',
    base: BASE_FILE,
    prepareMain: writeFileWith('f', 'two\n', EXECUTABLE_PERMISSIONS),
    prepareOther: gitRemove('f'),
  },
  AA_OURS_EXECUTABLE,
  DU_BASE_EXECUTABLE,
];

const DU_BASE_PLAIN_THEIRS_EXECUTABLE: ConflictShape = {
  id: 'DU with base 100644 and theirs 100755',
  base: BASE_FILE,
  prepareMain: gitRemove('f'),
  prepareOther: writeFileWith('f', 'two\n', EXECUTABLE_PERMISSIONS),
};

const conflictIn = (dir: string, shape: ConflictShape): void => {
  sh(dir, 'checkout', '-q', '-b', 'other');
  shape.prepareOther(dir);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'other');
  sh(dir, 'checkout', '-q', 'main');
  shape.prepareMain(dir);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'main');
  tryRunGitWithExit(['-C', dir, 'merge', 'other'], { env: COMMIT_ENV });
};

const gitConflictModes = (dir: string): ReadonlyArray<string> =>
  sh(dir, 'status', '--porcelain=v2')
    .split('\n')
    .filter((line) => line.startsWith('u '))
    .map((line) => line.split(' '))
    .map((cols) => `${cols[1]} ${cols[6]} ${cols[10]}`);

interface AddRow {
  readonly id: string;
  readonly files: ReadonlyArray<SeedFile>;
  readonly conflict?: ConflictShape;
  readonly prepare: (dir: string) => void;
  readonly path: string;
  readonly expectedMode: string;
  readonly expectedStatus?: ReadonlyArray<string>;
}

const removeAndWrite = (name: string, content: string, permissions: number) => (dir: string) => {
  rmSync(join(dir, name));
  writeFileWith(name, content, permissions)(dir);
};

const ADD_ROWS: ReadonlyArray<AddRow> = [
  {
    id: 'A1 tracked 100644 gaining the bit',
    files: [BASE_FILE],
    prepare: inOrder(setFileMode('false'), chmodTo(EXECUTABLE_PERMISSIONS)),
    path: 'f',
    expectedMode: '100644',
  },
  {
    id: 'A2 tracked 100755 losing the bit',
    files: [EXECUTABLE_FILE],
    prepare: inOrder(setFileMode('false'), chmodTo(PLAIN_PERMISSIONS)),
    path: 'f',
    expectedMode: '100755',
  },
  {
    id: 'A3 tracked 100755 losing the bit with new content',
    files: [EXECUTABLE_FILE],
    prepare: inOrder(
      setFileMode('false'),
      writeFileWith('f', 'two\n', PLAIN_PERMISSIONS),
      chmodTo(PLAIN_PERMISSIONS),
    ),
    path: 'f',
    expectedMode: '100755',
  },
  {
    id: 'A5 untracked executable file',
    files: [SEED_FILE],
    prepare: inOrder(setFileMode('false'), writeFileWith('n', 'new\n', EXECUTABLE_PERMISSIONS)),
    path: 'n',
    expectedMode: '100644',
  },
  {
    id: 'A6 tracked 100755 removed and recreated plain with new content',
    files: [EXECUTABLE_FILE],
    prepare: inOrder(setFileMode('false'), removeAndWrite('f', 'two\n', PLAIN_PERMISSIONS)),
    path: 'f',
    expectedMode: '100755',
    expectedStatus: ['M 100755 100755 f'],
  },
  {
    id: 'A13 symlink replaced by an executable file',
    files: [{ path: 'l', content: '', linkTo: 'target' }],
    prepare: inOrder(setFileMode('false'), removeAndWrite('l', 'target', EXECUTABLE_PERMISSIONS)),
    path: 'l',
    expectedMode: '100644',
  },
  {
    id: 'A7 stage 2 executable beside stage 3 plain',
    files: [SEED_FILE],
    conflict: AA_OURS_EXECUTABLE,
    prepare: inOrder(setFileMode('false'), chmodTo(PLAIN_PERMISSIONS)),
    path: 'f',
    expectedMode: '100755',
  },
  {
    id: 'A9 stage 1 executable beside stage 3 plain',
    files: [EXECUTABLE_FILE],
    conflict: DU_BASE_EXECUTABLE,
    prepare: inOrder(setFileMode('false'), chmodTo(PLAIN_PERMISSIONS)),
    path: 'f',
    expectedMode: '100755',
  },
  {
    id: 'A10 stage 1 plain beside stage 3 executable',
    files: [BASE_FILE],
    conflict: DU_BASE_PLAIN_THEIRS_EXECUTABLE,
    prepare: inOrder(setFileMode('false'), chmodTo(EXECUTABLE_PERMISSIONS)),
    path: 'f',
    expectedMode: '100644',
  },
];

interface StashRow {
  readonly id: string;
  readonly files: ReadonlyArray<SeedFile>;
  readonly prepare: (dir: string) => void;
  readonly expectedTreeMode: string;
  readonly restore: 'apply' | 'pop';
  readonly expectedStatusAfterRestore: ReadonlyArray<string>;
  readonly expectedExecAfterRestore: boolean;
}

const STASH_ROWS: ReadonlyArray<StashRow> = [
  {
    id: 'T2 100644 entry gaining the bit with new content',
    files: [BASE_FILE],
    prepare: inOrder(setFileMode('false'), writeFileWith('f', 'two\n', EXECUTABLE_PERMISSIONS)),
    expectedTreeMode: '100644',
    restore: 'apply',
    expectedStatusAfterRestore: ['M 100644 100644 f'],
    expectedExecAfterRestore: false,
  },
  {
    id: 'T3 100755 entry losing the bit with new content',
    files: [EXECUTABLE_FILE],
    prepare: inOrder(setFileMode('false'), writeFileWith('f', 'two\n', PLAIN_PERMISSIONS)),
    expectedTreeMode: '100755',
    restore: 'pop',
    expectedStatusAfterRestore: ['M 100755 100755 f'],
    expectedExecAfterRestore: true,
  },
];

const stashTree = (dir: string): string => sh(dir, 'ls-tree', '-r', 'refs/stash');

describe.skipIf(!GIT_AVAILABLE)('core.fileMode interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('core-filemode-false');
    runGit(['init', '-q', '-b', 'main', pair.peer]);
    runGit(['init', '-q', '-b', 'main', pair.ours]);
    for (const dir of [pair.peer, pair.ours]) {
      sh(dir, 'config', 'user.name', 'Ada');
      sh(dir, 'config', 'user.email', 'ada@example.com');
    }
  });

  afterEach(async () => {
    await pair.dispose();
  });

  const seedBoth = (ignoreCase: string, files: ReadonlyArray<SeedFile>): void => {
    seedTwin(pair.peer, ignoreCase, files);
    seedTwin(pair.ours, ignoreCase, files);
  };

  describe.each(['false', 'true'] as const)('core.ignorecase=%s in both twins', (ignoreCase) => {
    describe.each(STATUS_ROWS)('Given the $id row', ({ files, prepare, expected }) => {
      describe('When both tools report the status', () => {
        it(
          'Then the unstaged columns, index modes and worktree modes agree',
          async () => {
            // Arrange
            seedBoth(ignoreCase, files);
            prepare(pair.peer);
            prepare(pair.ours);
            const sut = await open({ cwd: pair.ours });

            // Act
            const ours = await tsgitStatusRows(sut);
            const status = await sut.status();

            // Assert
            expect(gitStatusRows(pair.peer)).toEqual(expected);
            expect(ours).toEqual(expected);
            expect(status.clean).toBe(expected.length === 0);
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe('Given a tracked file that gained the exec bit and core.fileMode=false', () => {
      describe('When both tools remove it', () => {
        it(
          'Then both remove the file and agree on the index',
          async () => {
            // Arrange
            seedBoth(ignoreCase, [BASE_FILE]);
            for (const dir of [pair.peer, pair.ours]) {
              setFileMode('false')(dir);
              chmodTo(EXECUTABLE_PERMISSIONS)(dir);
            }
            const sut = await open({ cwd: pair.ours });

            // Act
            sh(pair.peer, 'rm', '-q', 'f');
            await sut.rm(['f']);

            // Assert
            expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
            expect(lsStage(pair.ours)).toBe('');
            expect(() => statSync(join(pair.ours, 'f'))).toThrow();
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe('Given a tracked file that gained the exec bit and core.fileMode=false', () => {
      describe('When both tools stash push', () => {
        it(
          'Then neither saves a stash and the file keeps its bit',
          async () => {
            // Arrange
            seedBoth(ignoreCase, [BASE_FILE]);
            for (const dir of [pair.peer, pair.ours]) {
              setFileMode('false')(dir);
              chmodTo(EXECUTABLE_PERMISSIONS)(dir);
            }
            const sut = await open({ cwd: pair.ours });

            // Act
            const gitRun = tryRunGitWithExit(['-C', pair.peer, 'stash', 'push'], {
              env: COMMIT_ENV,
            });
            const result = await sut.stash.push({});

            // Assert
            expect(gitRun.exitCode).toBe(0);
            expect(gitRun.stdout).toContain('No local changes to save');
            expect(result).toEqual({ kind: 'no-local-changes' });
            for (const dir of [pair.peer, pair.ours]) {
              expect(ownerExec(dir, 'f')).toBe(true);
              const stashRef = tryRunGitWithExit([
                '-C',
                dir,
                'rev-parse',
                '--verify',
                '-q',
                'refs/stash',
              ]);
              expect(stashRef.exitCode).not.toBe(0);
            }
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe('Given a commit changing a file that gained the exec bit and core.fileMode=false', () => {
      describe('When both tools cherry-pick it', () => {
        it(
          'Then both pick, drop the bit and agree on the index',
          async () => {
            // Arrange
            seedBoth(ignoreCase, [BASE_FILE]);
            for (const dir of [pair.peer, pair.ours]) {
              sh(dir, 'checkout', '-q', '-b', 'other');
              writeFileSync(join(dir, 'f'), 'two\n');
              sh(dir, 'commit', '-q', '-a', '-m', 'change');
              sh(dir, 'checkout', '-q', 'main');
              setFileMode('false')(dir);
              chmodTo(EXECUTABLE_PERMISSIONS)(dir);
            }
            const sut = await open({ cwd: pair.ours });

            // Act
            sh(pair.peer, 'cherry-pick', 'other');
            await sut.cherryPick.run({ commits: ['other'] });

            // Assert
            expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
            expect(ownerExec(pair.peer, 'f')).toBe(false);
            expect(ownerExec(pair.ours, 'f')).toBe(false);
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe('Given a main worktree trusting the bit and a linked worktree ignoring it', () => {
      describe('When both tools report the status of each', () => {
        it(
          'Then the linked worktree is clean and the main one is dirty',
          async () => {
            // Arrange
            seedBoth(ignoreCase, [BASE_FILE]);
            const linkedOf = (dir: string): string => `${dir}-linked`;
            for (const dir of [pair.peer, pair.ours]) {
              sh(dir, 'config', 'extensions.worktreeConfig', 'true');
              setFileMode('true')(dir);
              sh(dir, 'worktree', 'add', '-q', '-b', 'linked', linkedOf(dir));
              sh(linkedOf(dir), 'config', '--worktree', 'core.fileMode', 'false');
              chmodTo(EXECUTABLE_PERMISSIONS)(dir);
              chmodTo(EXECUTABLE_PERMISSIONS)(linkedOf(dir));
            }
            const main = await open({ cwd: pair.ours });
            const linked = await open({ cwd: linkedOf(pair.ours) });

            // Act
            const ours = {
              main: await tsgitStatusRows(main),
              linked: await tsgitStatusRows(linked),
            };

            // Assert
            expect(gitStatusRows(pair.peer)).toEqual(['M 100644 100755 f']);
            expect(gitStatusRows(linkedOf(pair.peer))).toEqual([]);
            expect(ours).toEqual({ main: ['M 100644 100755 f'], linked: [] });
            for (const dir of [pair.peer, pair.ours])
              rmSync(linkedOf(dir), { recursive: true, force: true });
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe.each(ADD_ROWS)('Given the $id row and core.fileMode=false', (row) => {
      describe('When both tools add the path', () => {
        it(
          'Then both stage the donor mode and agree on the index',
          async () => {
            // Arrange
            seedBoth(ignoreCase, row.files);
            for (const dir of [pair.peer, pair.ours]) {
              if (row.conflict !== undefined) conflictIn(dir, row.conflict);
              row.prepare(dir);
            }
            const sut = await open({ cwd: pair.ours });
            const oursBefore = await tsgitStatusRows(sut);
            const gitBefore = gitStatusRows(pair.peer);

            // Act
            sh(pair.peer, 'add', row.path);
            await sut.add([row.path]);

            // Assert
            if (row.expectedStatus !== undefined) {
              expect(gitBefore).toEqual(row.expectedStatus);
              expect(oursBefore).toEqual(row.expectedStatus);
            }
            expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
            expect(lsStage(pair.ours)).toMatch(new RegExp(`^${row.expectedMode} `));
            expect(ownerExec(pair.ours, row.path)).toBe(ownerExec(pair.peer, row.path));
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe.each(STASH_ROWS)('Given the $id row and core.fileMode=false', (row) => {
      describe('When both tools stash push then restore it', () => {
        it(
          'Then the work-tree trees agree and record the donor mode',
          async () => {
            // Arrange
            seedBoth(ignoreCase, row.files);
            row.prepare(pair.peer);
            row.prepare(pair.ours);
            const sut = await open({ cwd: pair.ours });

            // Act
            sh(pair.peer, 'stash', 'push');
            await sut.stash.push({});
            const afterPush = {
              trees: { peer: stashTree(pair.peer), ours: stashTree(pair.ours) },
              exec: { peer: ownerExec(pair.peer, 'f'), ours: ownerExec(pair.ours, 'f') },
            };
            sh(pair.peer, 'stash', row.restore);
            await sut.stash[row.restore]({});

            // Assert
            expect(afterPush.trees.ours).toBe(afterPush.trees.peer);
            expect(afterPush.trees.peer).toMatch(new RegExp(`^${row.expectedTreeMode} blob `));
            expect(afterPush.exec.ours).toBe(afterPush.exec.peer);
            expect(gitStatusRows(pair.peer)).toEqual(row.expectedStatusAfterRestore);
            expect(await tsgitStatusRows(sut)).toEqual(row.expectedStatusAfterRestore);
            expect(ownerExec(pair.peer, 'f')).toBe(row.expectedExecAfterRestore);
            expect(ownerExec(pair.ours, 'f')).toBe(row.expectedExecAfterRestore);
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe.each(CONFLICT_SHAPES)('Given a $id conflict and core.fileMode=false', (shape) => {
      describe('When both tools report the status', () => {
        it(
          'Then the work-tree mode is the donor stage mode, not the stat',
          async () => {
            // Arrange
            seedBoth(ignoreCase, [shape.base ?? SEED_FILE]);
            for (const dir of [pair.peer, pair.ours]) {
              conflictIn(dir, shape);
              setFileMode('false')(dir);
              chmodTo(PLAIN_PERMISSIONS)(dir);
            }
            const sut = await open({ cwd: pair.ours });

            // Act
            const status = await sut.status();

            // Assert
            expect(gitConflictModes(pair.peer)).toHaveLength(1);
            expect(gitConflictModes(pair.peer)[0]).toMatch(/^\S+ 100755 f$/);
            expect(status.unmerged.map((u) => u.worktree?.mode)).toEqual(['100755']);
          },
          ROW_TIMEOUT,
        );
      });
    });
  });
});
