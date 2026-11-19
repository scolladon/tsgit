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
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

const AUTHOR = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;
const ROW_TIMEOUT = 60_000;
const OWNER_EXEC = 0o100;
const EXECUTABLE_PERMISSIONS = 0o755;
const PLAIN_PERMISSIONS = 0o644;
const GROUP_OTHER_EXEC_PERMISSIONS = 0o654;
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
    id: 'gained-group-other-bits-only-default-trust',
    files: [BASE_FILE],
    prepare: chmodTo(GROUP_OTHER_EXEC_PERMISSIONS),
    expected: [],
  },
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

const KEPT_FILE: SeedFile = { path: 'keep', content: 'k\n', executable: true };
// git's ctime test is whole-second: the chmod must land past the second the index was written in.
const PAST_THE_INDEX_SECOND_MS = 1_100;

const writeNested = (name: string, content: string) => (dir: string) => {
  mkdirSync(join(dir, name, '..'), { recursive: true });
  writeFileSync(join(dir, name), content);
};
const chmodPath = (name: string, permissions: number) => (dir: string) =>
  chmodSync(join(dir, name), permissions);

interface SwitchRow {
  readonly id: string;
  readonly files: ReadonlyArray<SeedFile>;
  readonly operation: 'checkout' | 'merge';
  readonly prepareOther: (dir: string) => void;
  readonly prepareMain?: (dir: string) => void;
  readonly chmodPath: string;
  readonly refusal: 'CHECKOUT_OVERWRITE_DIRTY' | 'WORKING_TREE_DIRTY';
  readonly expectedExecWhenIgnored: Readonly<Record<string, boolean>>;
}

const SWITCH_ROWS: ReadonlyArray<SwitchRow> = [
  {
    id: 'K1 a file the target rewrites gained the bit',
    files: [BASE_FILE, KEPT_FILE],
    operation: 'checkout',
    prepareOther: writeFileWith('f', 'two\n', PLAIN_PERMISSIONS),
    chmodPath: 'f',
    refusal: 'CHECKOUT_OVERWRITE_DIRTY',
    expectedExecWhenIgnored: { f: false, keep: true },
  },
  {
    id: 'K3 a file the target replaces by a directory gained the bit',
    files: [BASE_FILE, KEPT_FILE],
    operation: 'checkout',
    prepareOther: inOrder(gitRemove('f'), writeNested('f/x', 'x\n')),
    chmodPath: 'f',
    refusal: 'CHECKOUT_OVERWRITE_DIRTY',
    expectedExecWhenIgnored: { 'f/x': false, keep: true },
  },
  {
    id: 'K4 a file the target removes from a directory gained the bit',
    files: [{ path: 'f/x', content: 'x\n' }, KEPT_FILE],
    operation: 'checkout',
    prepareOther: inOrder(
      (dir) => sh(dir, 'rm', '-q', '-r', 'f'),
      writeNested('f', 'now a file\n'),
    ),
    chmodPath: 'f/x',
    refusal: 'CHECKOUT_OVERWRITE_DIRTY',
    expectedExecWhenIgnored: { f: false, keep: true },
  },
  {
    id: 'M1 a file the merge rewrites gained the bit',
    files: [BASE_FILE, KEPT_FILE, { path: 'g', content: 'g\n' }],
    operation: 'merge',
    prepareOther: writeFileWith('f', 'two\n', PLAIN_PERMISSIONS),
    prepareMain: writeFileWith('g', 'main\n', PLAIN_PERMISSIONS),
    chmodPath: 'f',
    refusal: 'WORKING_TREE_DIRTY',
    expectedExecWhenIgnored: { f: false, keep: true },
  },
];

interface RestoreRow {
  readonly id: string;
  readonly files: ReadonlyArray<SeedFile>;
  readonly prepare: (dir: string) => void;
  readonly expectedExec: boolean;
}

const RESTORE_ROWS: ReadonlyArray<RestoreRow> = [
  {
    id: 'P1 100644 entry gaining the bit a second after the index write',
    files: [BASE_FILE],
    prepare: chmodTo(EXECUTABLE_PERMISSIONS),
    expectedExec: false,
  },
  {
    id: 'P3 100755 entry losing the bit with new content',
    files: [EXECUTABLE_FILE],
    prepare: writeFileWith('f', 'two and more\n', PLAIN_PERMISSIONS),
    expectedExec: true,
  },
];

const commitAll = (dir: string, message: string): void => {
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', message);
};

const branchOffMain = (dir: string, row: SwitchRow): void => {
  sh(dir, 'checkout', '-q', '-b', 'other');
  row.prepareOther(dir);
  commitAll(dir, 'other');
  sh(dir, 'checkout', '-q', 'main');
  if (row.prepareMain === undefined) return;
  row.prepareMain(dir);
  commitAll(dir, 'main');
};

const gitSwitch = (dir: string, row: SwitchRow) =>
  tryRunGitWithExit(
    row.operation === 'checkout'
      ? ['-C', dir, 'checkout', 'other']
      : ['-C', dir, 'merge', '--no-ff', '-m', 'merge', 'other'],
    { env: COMMIT_ENV },
  );

const tsgitSwitch = async (repo: Repository, row: SwitchRow): Promise<void> => {
  if (row.operation === 'checkout') {
    await repo.checkout({ rev: 'other' });
    return;
  }
  await repo.merge.run({ rev: 'other', message: 'merge', author: AUTHOR, fastForward: 'never' });
};

const refusalDataOf = async (run: Promise<void>): Promise<unknown> => {
  try {
    await run;
  } catch (err) {
    return (err as { readonly data?: unknown }).data;
  }
  return undefined;
};

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

    describe.each(SWITCH_ROWS)('Given the $id row and core.fileMode=true', (row) => {
      describe('When both tools switch or merge', () => {
        it(
          'Then both refuse, name the path and leave the work tree and index untouched',
          async () => {
            // Arrange
            seedBoth(ignoreCase, row.files);
            for (const dir of [pair.peer, pair.ours]) {
              branchOffMain(dir, row);
              setFileMode('true')(dir);
              chmodPath(row.chmodPath, EXECUTABLE_PERMISSIONS)(dir);
            }
            const sut = await open({ cwd: pair.ours });
            const indexBefore = lsStage(pair.ours);

            // Act
            const git = gitSwitch(pair.peer, row);
            const data = await refusalDataOf(tsgitSwitch(sut, row));

            // Assert
            expect(git.exitCode).not.toBe(0);
            expect(data).toEqual({
              code: row.refusal,
              localChanges: [row.chmodPath],
              untracked: [],
            });
            expect(lsStage(pair.ours)).toBe(indexBefore);
            expect(lsStage(pair.peer)).toBe(indexBefore);
            expect(ownerExec(pair.ours, row.chmodPath)).toBe(true);
            expect(ownerExec(pair.peer, row.chmodPath)).toBe(true);
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe.each(SWITCH_ROWS)('Given the $id row and core.fileMode=false', (row) => {
      describe('When both tools switch or merge', () => {
        it(
          'Then both apply it, and the rewritten file loses the bit while an untouched one keeps it',
          async () => {
            // Arrange
            seedBoth(ignoreCase, row.files);
            for (const dir of [pair.peer, pair.ours]) {
              branchOffMain(dir, row);
              setFileMode('false')(dir);
              chmodPath(row.chmodPath, EXECUTABLE_PERMISSIONS)(dir);
            }
            const sut = await open({ cwd: pair.ours });

            // Act
            const git = gitSwitch(pair.peer, row);
            await tsgitSwitch(sut, row);

            // Assert
            expect(git.exitCode).toBe(0);
            expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
            for (const [name, executable] of Object.entries(row.expectedExecWhenIgnored)) {
              expect(ownerExec(pair.peer, name)).toBe(executable);
              expect(ownerExec(pair.ours, name)).toBe(executable);
            }
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe('Given a new file with group and other execute bits but no owner one and the default core.fileMode', () => {
      describe('When both tools add it', () => {
        it(
          'Then both stage 100644 and agree on the index',
          async () => {
            // Arrange
            seedBoth(ignoreCase, [SEED_FILE]);
            for (const dir of [pair.peer, pair.ours]) {
              writeSeedFile(dir, BASE_FILE);
              chmodTo(GROUP_OTHER_EXEC_PERMISSIONS)(dir);
            }
            const sut = await open({ cwd: pair.ours });

            // Act
            sh(pair.peer, 'add', 'f');
            await sut.add(['f']);

            // Assert
            expect(lsStage(pair.peer)).toContain('100644');
            expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe('Given a file the target rewrites carrying group and other execute bits but no owner one', () => {
      describe('When both tools switch with the default core.fileMode', () => {
        it(
          'Then both switch and agree on the index',
          async () => {
            // Arrange
            const row = SWITCH_ROWS[0] as SwitchRow;
            seedBoth(ignoreCase, row.files);
            for (const dir of [pair.peer, pair.ours]) {
              branchOffMain(dir, row);
              chmodPath(row.chmodPath, GROUP_OTHER_EXEC_PERMISSIONS)(dir);
            }
            const sut = await open({ cwd: pair.ours });

            // Act
            const git = gitSwitch(pair.peer, row);
            await tsgitSwitch(sut, row);

            // Assert
            expect(git.exitCode).toBe(0);
            expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe.each(RESTORE_ROWS)('Given the $id row and core.fileMode=false', (row) => {
      describe('When both tools check the path out of the index', () => {
        it(
          'Then both rewrite it with the index entry mode',
          async () => {
            // Arrange
            seedBoth(ignoreCase, row.files);
            await pause(PAST_THE_INDEX_SECOND_MS);
            for (const dir of [pair.peer, pair.ours]) {
              setFileMode('false')(dir);
              row.prepare(dir);
            }
            const sut = await open({ cwd: pair.ours });

            // Act
            sh(pair.peer, 'checkout', '--', 'f');
            await sut.checkout({ paths: ['f'] });

            // Assert
            expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
            expect(ownerExec(pair.peer, 'f')).toBe(row.expectedExec);
            expect(ownerExec(pair.ours, 'f')).toBe(row.expectedExec);
            expect(readFileSync(join(pair.ours, 'f'), 'utf8')).toBe(
              readFileSync(join(pair.peer, 'f'), 'utf8'),
            );
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe.each([
      {
        scope: 'local config',
        prepare: (dir: string) => sh(dir, 'config', 'core.fileMode', 'bogus'),
        source: '.git/config',
      },
      {
        scope: 'config.worktree with the extension on',
        prepare: (dir: string) => {
          sh(dir, 'config', 'extensions.worktreeConfig', 'true');
          sh(dir, 'config', '--worktree', 'core.fileMode', 'bogus');
        },
        source: '.git/config.worktree',
      },
    ])('Given core.fileMode = bogus in $scope', ({ prepare, source }) => {
      describe('When both tools run status and log', () => {
        it(
          'Then git exits 128 on the bad boolean and tsgit refuses with the same key and value',
          async () => {
            // Arrange
            seedBoth(ignoreCase, [BASE_FILE]);
            for (const dir of [pair.peer, pair.ours]) prepare(dir);
            const sut = await open({ cwd: pair.ours });

            // Act
            const gitRuns = ['status', 'log'].map((command) =>
              tryRunGitWithExit(['-C', pair.peer, command], { env: COMMIT_ENV }),
            );
            const refusals = await Promise.all(
              [() => sut.status(), () => sut.log()].map(async (run) => {
                try {
                  await run();
                } catch (error) {
                  return (error as { readonly data: Record<string, unknown> }).data;
                }
                return undefined;
              }),
            );

            // Assert
            for (const gitRun of gitRuns) {
              expect(gitRun.exitCode).toBe(128);
              expect(gitRun.stderr).toContain(
                "fatal: bad boolean config value 'bogus' for 'core.filemode'",
              );
            }
            for (const refusal of refusals) {
              expect(refusal).toMatchObject({
                code: 'CONFIG_BAD_BOOLEAN_VALUE',
                key: 'core.filemode',
                value: 'bogus',
                source: join(realpathSync(pair.ours), source),
              });
            }
          },
          ROW_TIMEOUT,
        );
      });
    });
  });
});
