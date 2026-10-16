/**
 * Cross-tool interop — merge-engine commands over trees holding a non-UTF-8
 * path. The histories are built with plumbing, tsgit acts through
 * `openRepository`, and the assertions read path bytes from `git ls-files -s -z`.
 *
 * @proves
 *   surface:        merge
 *   bucket:         cross-tool-interop
 *   unique:         merge-engine commands carry raw path bytes like git
 *   interopSurface: merge
 */
import { cpSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  hashBlob,
  makePeerPair,
  mergeTreeResult,
  type PeerPair,
  runGit,
  runGitBytes,
  runGitEnv,
  stageRaw,
  tryRunGit,
} from './interop-helpers.js';

const COMMIT_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

const REGULAR_MODE = '100644';
const FF_TXT = Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74);
const FF_TXT_LATIN1 = 'ÿ.txt';
const VIEW_PATH = '�.txt';

describe.skipIf(!GIT_AVAILABLE)(
  'merge path bytes interop — stash apply',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository | undefined;

    const git = (...args: ReadonlyArray<string>): string =>
      runGit(['-C', pair.peer, ...args], { env: COMMIT_ENV });

    const stage = (
      rows: ReadonlyArray<{ readonly path: Uint8Array; readonly oid: string }>,
    ): void =>
      stageRaw(
        pair.peer,
        rows.map((row) => ({ mode: REGULAR_MODE, ...row })),
      );

    const commitIndex = (message: string): string =>
      git('commit-tree', git('write-tree').trim(), '-m', message).trim();

    const stagedRecords = (): string[] =>
      Buffer.from(runGitBytes(['-C', pair.peer, 'ls-files', '-s', '-z']))
        .toString('latin1')
        .split('\0')
        .filter((record) => record !== '');

    beforeEach(async () => {
      pair = await makePeerPair('merge-path-bytes');
      runGit(['init', '-q', '-b', 'main', pair.peer]);
      runGit(['-C', pair.peer, 'config', 'user.name', 'Ada']);
      runGit(['-C', pair.peer, 'config', 'user.email', 'ada@example.com']);
    });

    afterEach(async () => {
      await repo?.dispose();
      repo = undefined;
      await pair.dispose();
    });

    describe('Given the non-UTF-8 path staged as l2 over a committed l1', () => {
      describe('When stash push then stash apply restoring the index run', () => {
        it('Then the modify/delete conflict names the view and stages 1 and 2 keep the raw bytes', async () => {
          // Arrange
          const [l1, l2] = [hashBlob(pair.peer, 'l1\n'), hashBlob(pair.peer, 'l2\n')];
          stage([{ path: FF_TXT, oid: l1 }]);
          git('update-ref', 'refs/heads/main', commitIndex('seed'));
          stage([{ path: FF_TXT, oid: l2 }]);
          repo = await openRepository({ cwd: pair.peer });
          await repo.stash.push();
          // git cannot reset the absent file on macOS, so its index still holds l2 at apply time
          stage([{ path: FF_TXT, oid: l2 }]);

          // Act
          const sut = repo.stash;
          const result = await sut.apply({ restoreIndex: true });

          // Assert
          expect(result).toEqual({
            kind: 'conflict',
            conflicts: [{ path: VIEW_PATH, type: 'modify-delete' }],
          });
          expect(stagedRecords()).toEqual([
            `${REGULAR_MODE} ${l1} 1\t${FF_TXT_LATIN1}`,
            `${REGULAR_MODE} ${l2} 2\t${FF_TXT_LATIN1}`,
          ]);
        });
      });
    });
  },
);

const A_PATH = Uint8Array.of(0x61);
const C_PATH = Uint8Array.of(0x63);

interface History {
  readonly path: Uint8Array;
  readonly sideBlob: string;
}

describe.skipIf(!GIT_AVAILABLE)(
  'merge path bytes interop — cherry-pick and revert',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository | undefined;

    const gitIn = (dir: string, ...args: ReadonlyArray<string>): string =>
      runGit(['-C', dir, ...args], { env: COMMIT_ENV });

    const stageIn = (dir: string, rows: ReadonlyArray<{ path: Uint8Array; oid: string }>): void =>
      stageRaw(
        dir,
        rows.map((row) => ({ mode: REGULAR_MODE, ...row })),
      );

    const commitIn = (dir: string, ref: string, message: string, parent?: string): string => {
      const parents = parent === undefined ? [] : ['-p', parent];
      const id = gitIn(
        dir,
        'commit-tree',
        gitIn(dir, 'write-tree').trim(),
        ...parents,
        '-m',
        message,
      );
      gitIn(dir, 'update-ref', ref, id.trim());
      return id.trim();
    };

    const records = (dir: string): string =>
      Buffer.from(runGitBytes(['-C', dir, 'ls-files', '-s', '-z'])).toString('latin1');

    const headTree = (dir: string): string => gitIn(dir, 'rev-parse', 'HEAD^{tree}').trim();

    /** base: a, `path`; side edits `path`; main edits `a`; worktree holds only the UTF-8 file `a`. */
    const seedHistory = (dir: string, history: History): void => {
      runGit(['init', '-q', '-b', 'main', dir]);
      runGit(['-C', dir, 'config', 'user.name', 'Ada']);
      runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);
      const [a0, a1, base] = [
        hashBlob(dir, 'a0\n'),
        hashBlob(dir, 'a1\n'),
        hashBlob(dir, 'base\n'),
      ];
      stageIn(dir, [
        { path: A_PATH, oid: a0 },
        { path: history.path, oid: base },
      ]);
      const root = commitIn(dir, 'refs/heads/main', 'base');
      stageIn(dir, [{ path: history.path, oid: hashBlob(dir, history.sideBlob) }]);
      commitIn(dir, 'refs/heads/side', 'side', root);
      gitIn(dir, 'read-tree', root);
      stageIn(dir, [{ path: A_PATH, oid: a1 }]);
      commitIn(dir, 'refs/heads/main', 'main', root);
      gitIn(dir, 'read-tree', 'main');
      gitIn(dir, 'checkout-index', '-f', '--', 'a');
    };

    beforeEach(async () => {
      pair = await makePeerPair('merge-path-bytes-pick');
    });

    afterEach(async () => {
      await repo?.dispose();
      repo = undefined;
      await pair.dispose();
    });

    const expectSameOutcome = async (
      gitArgs: ReadonlyArray<string>,
      tsgit: (sut: Repository) => Promise<unknown>,
    ): Promise<void> => {
      const gitRun = tryRunGit(['-C', pair.peer, ...gitArgs], { env: COMMIT_ENV });
      repo = await openRepository({ cwd: pair.ours });
      const tsgitRun = await tsgit(repo).then(
        () => true,
        () => false,
      );
      expect(tsgitRun).toBe(gitRun.ok);
      expect(headTree(pair.ours)).toBe(headTree(pair.peer));
      expect(records(pair.ours)).toBe(records(pair.peer));
    };

    describe('Given a lossy path that the picked commit modifies and the work tree lacks', () => {
      describe('When cherry-picking it', () => {
        it('Then the commit carries the merge-tree result and the path stays an unstaged deletion', async () => {
          // Arrange
          seedHistory(pair.ours, { path: FF_TXT, sideBlob: 'side\n' });
          const engineTree = mergeTreeResult(pair.ours, 'main', 'side').tree;
          repo = await openRepository({ cwd: pair.ours });

          // Act
          const sut = repo.cherryPick;
          await sut.run({ commits: ['side'] });

          // Assert
          expect(headTree(pair.ours)).toBe(engineTree);
          expect(records(pair.ours)).toContain(
            `${REGULAR_MODE} ${hashBlob(pair.ours, 'side\n')} 0\t${FF_TXT_LATIN1}`,
          );
          expect(gitIn(pair.ours, 'status', '--porcelain', '-z')).toBe(` D ${VIEW_PATH}\0`);
          expect(() => gitIn(pair.ours, 'fsck', '--strict')).not.toThrow();
        });
      });
    });

    describe('Given a lossy path that the reverted commit leaves untouched', () => {
      describe('When reverting the tip', () => {
        it('Then tsgit ends in the state git ends in', async () => {
          // Arrange
          const history = { path: FF_TXT, sideBlob: 'side\n' };
          seedHistory(pair.peer, history);
          seedHistory(pair.ours, history);

          // Act + Assert
          await expectSameOutcome(['revert', '--no-edit', 'HEAD'], (sut) =>
            sut.revert.run({ commits: ['HEAD'] }),
          );
        });
      });
    });

    describe('Given a UTF-8 tracked file deleted on disk and left unstaged', () => {
      describe('When cherry-picking an unrelated commit', () => {
        it('Then tsgit picks it like git and leaves the deletion unstaged', async () => {
          // Arrange
          const history = { path: C_PATH, sideBlob: 'side\n' };
          for (const dir of [pair.peer, pair.ours]) {
            seedHistory(dir, history);
            gitIn(dir, 'checkout-index', '-f', '--', 'c');
            rmSync(path.join(dir, 'a'));
          }

          // Act + Assert
          await expectSameOutcome(['cherry-pick', 'side'], (sut) =>
            sut.cherryPick.run({ commits: ['side'] }),
          );
          expect(gitIn(pair.ours, 'status', '--porcelain')).toBe(
            gitIn(pair.peer, 'status', '--porcelain'),
          );
        });
      });
    });
  },
);

type Row = readonly [path: string | Uint8Array, text: string];

const FIVE_LINES = 'l1\nl2\nl3\nl4\nl5\n';
const FIVE_LINES_EDITED = 'L1\nl2\nl3\nl4\nl5\n';
const FIVE_LINES_THEIRS = 'S1\nl2\nl3\nl4\nl5\n';
const THREE_LINES = '1\n2\n3\n';
const UNION_ATTRIBUTES = '*.txt merge=union\n';
const COMMIT_AUTHOR = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;
const U_TXT = '�.txt';

const bytesOf = (path: string | Uint8Array): Uint8Array =>
  typeof path === 'string' ? new TextEncoder().encode(path) : path;

const isUtf8Path = (path: Uint8Array): boolean => {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(path);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!GIT_AVAILABLE)(
  'merge path bytes interop — three-way merge',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository | undefined;

    const gitIn = (...args: ReadonlyArray<string>): string =>
      runGit(['-C', pair.ours, ...args], { env: COMMIT_ENV });

    const commitRows = (ref: string, rows: ReadonlyArray<Row>, parent?: string): string => {
      gitIn('read-tree', '--empty');
      stageRaw(
        pair.ours,
        rows.map(([path, text]) => ({
          mode: REGULAR_MODE,
          path: bytesOf(path),
          oid: hashBlob(pair.ours, text),
        })),
      );
      const parents = parent === undefined ? [] : ['-p', parent];
      const id = gitIn('commit-tree', gitIn('write-tree').trim(), ...parents, '-m', ref).trim();
      gitIn('update-ref', `refs/heads/${ref}`, id);
      return id;
    };

    /** main and side fork from base; HEAD, index and the UTF-8 files follow main. */
    const seed = (base: ReadonlyArray<Row>, main: ReadonlyArray<Row>, side: ReadonlyArray<Row>) => {
      runGit(['init', '-q', '-b', 'main', pair.ours]);
      gitIn('config', 'user.name', 'Ada');
      gitIn('config', 'user.email', 'ada@example.com');
      const root = commitRows('main', base);
      commitRows('side', side, root);
      commitRows('main', main, root);
      gitIn('read-tree', 'main');
      const utf8 = main.map(([path]) => bytesOf(path)).filter(isUtf8Path);
      for (const path of utf8) {
        gitIn('checkout-index', '-f', '--', Buffer.from(path).toString('utf8'));
      }
    };

    const records = (): string[] =>
      Buffer.from(runGitBytes(['-C', pair.ours, 'ls-files', '-s', '-z']))
        .toString('latin1')
        .split('\0')
        .filter((record) => record !== '');

    const peerRecords = (): string[] =>
      Buffer.from(runGitBytes(['-C', pair.peer, 'ls-files', '-s', '-z']))
        .toString('latin1')
        .split('\0')
        .filter((record) => record !== '');

    const conflictRecords = (): string[] => records().filter((record) => !/ 0\t/.test(record));

    const headTree = (): string => gitIn('rev-parse', 'HEAD^{tree}').trim();

    const engineConflictRecords = (engine: ReturnType<typeof mergeTreeResult>): string[] =>
      engine.conflicted
        .map(
          (entry) =>
            `${entry.mode} ${entry.oid} ${entry.stage}\t${Buffer.from(entry.pathHex, 'hex').toString('latin1')}`,
        )
        .sort();

    const mergeSide = async () => {
      repo = await openRepository({ cwd: pair.ours });
      return repo.merge.run({ rev: 'side', author: COMMIT_AUTHOR });
    };

    const expectCleanLikeEngine = async (): Promise<void> => {
      const engine = mergeTreeResult(pair.ours, 'main', 'side');
      const result = await mergeSide();
      expect(result.kind).toBe('merge');
      expect(engine.conflicted).toEqual([]);
      expect(headTree()).toBe(engine.tree);
    };

    const expectConflictLikeEngine = async (): Promise<void> => {
      const engine = mergeTreeResult(pair.ours, 'main', 'side');
      const result = await mergeSide();
      expect(result.kind).toBe('conflict');
      expect(conflictRecords().sort()).toEqual(engineConflictRecords(engine));
    };

    beforeEach(async () => {
      pair = await makePeerPair('merge-path-bytes-three-way');
    });

    afterEach(async () => {
      await repo?.dispose();
      repo = undefined;
      await pair.dispose();
    });

    describe('Given main and side change different ASCII files and both carry a lossy name', () => {
      describe('When merging side', () => {
        it('Then the merge tree is the merge-tree result', async () => {
          // Arrange
          seed(
            [
              ['a', 'a0\n'],
              ['b', 'b0\n'],
              [FF_TXT, 'x\n'],
            ],
            [
              ['a', 'a1\n'],
              ['b', 'b0\n'],
              [FF_TXT, 'x\n'],
            ],
            [
              ['a', 'a0\n'],
              ['b', 'b1\n'],
              [FF_TXT, 'x\n'],
            ],
          );

          // Act + Assert
          await expectCleanLikeEngine();
        });
      });
    });

    describe('Given side edits the lossy name while main edits another file', () => {
      describe('When merging side', () => {
        it('Then the merge tree is the merge-tree result', async () => {
          // Arrange
          seed(
            [
              ['a', 'a0\n'],
              [FF_TXT, 'x\n'],
            ],
            [
              ['a', 'a1\n'],
              [FF_TXT, 'x\n'],
            ],
            [
              ['a', 'a0\n'],
              [FF_TXT, 'x2\n'],
            ],
          );

          // Act + Assert
          await expectCleanLikeEngine();
        });
      });
    });

    describe('Given both sides edit the lossy name', () => {
      describe('When merging side', () => {
        it('Then the conflict stages are the merge-tree conflicted entries', async () => {
          // Arrange
          seed([[FF_TXT, THREE_LINES]], [[FF_TXT, 'M\n2\n3\n']], [[FF_TXT, 'S\n2\n3\n']]);

          // Act + Assert
          await expectConflictLikeEngine();
        });
      });
    });

    describe('Given a lossy name and its U+FFFD twin where side edits the lossy one', () => {
      describe('When merging side', () => {
        it('Then the merge tree keeps both names like merge-tree', async () => {
          // Arrange
          seed(
            [
              ['a', 'a0\n'],
              [FF_TXT, 'x\n'],
              [U_TXT, 'y\n'],
            ],
            [
              ['a', 'a1\n'],
              [FF_TXT, 'x\n'],
              [U_TXT, 'y\n'],
            ],
            [
              ['a', 'a0\n'],
              [FF_TXT, 'x2\n'],
              [U_TXT, 'y\n'],
            ],
          );

          // Act + Assert
          await expectCleanLikeEngine();
        });
      });
    });

    describe('Given main edits a lossy file that side renames to r.txt', () => {
      describe('When merging side', () => {
        it('Then the rename pairs on content and the tree is the merge-tree result', async () => {
          // Arrange
          seed([[FF_TXT, FIVE_LINES]], [[FF_TXT, FIVE_LINES_EDITED]], [['r.txt', FIVE_LINES]]);

          // Act + Assert
          await expectCleanLikeEngine();
        });
      });
    });

    describe('Given main renames r.txt to a lossy name while side edits r.txt', () => {
      describe('When merging side', () => {
        it('Then the merge tree is the merge-tree result', async () => {
          // Arrange
          seed([['r.txt', FIVE_LINES]], [[FF_TXT, FIVE_LINES]], [['r.txt', FIVE_LINES_EDITED]]);

          // Act + Assert
          await expectCleanLikeEngine();
        });
      });
    });

    describe('Given main renames a lossy file to r.txt and both edit its first line', () => {
      describe('When merging side', () => {
        it('Then the stages match merge-tree and the marker label carries the raw byte', async () => {
          // Arrange
          seed(
            [[FF_TXT, FIVE_LINES]],
            [['r.txt', FIVE_LINES_EDITED]],
            [[FF_TXT, FIVE_LINES_THEIRS]],
          );

          // Act
          await expectConflictLikeEngine();

          // Assert
          const marked = Buffer.from(readFileSync(path.join(pair.ours, 'r.txt'))).toString(
            'latin1',
          );
          expect(marked).toContain('>>>>>>> side:\xff.txt');
        });
      });
    });

    describe.each(['conflict', 'true'])(
      'Given merge.directoryRenames=%s and main adds a lossy file in a directory side renames',
      (setting) => {
        describe('When merging side', () => {
          it('Then the outcome matches merge-tree', async () => {
            // Arrange
            seed(
              [
                ['d/a', 'a\n'],
                ['d/b', 'b\n'],
              ],
              [
                ['d/a', 'a\n'],
                ['d/b', 'b\n'],
                [Uint8Array.of(0x64, 0x2f, 0xff), 'f\n'],
              ],
              [
                ['e/a', 'a\n'],
                ['e/b', 'b\n'],
              ],
            );
            gitIn('config', 'merge.directoryRenames', setting);
            const engine = mergeTreeResult(pair.ours, 'main', 'side');

            // Act
            const result = await mergeSide();

            // Assert
            expect(result.kind).toBe(engine.conflicted.length === 0 ? 'merge' : 'conflict');
            if (engine.conflicted.length === 0) expect(headTree()).toBe(engine.tree);
            else expect(conflictRecords().sort()).toEqual(engineConflictRecords(engine));
          });
        });
      },
    );

    describe('Given a union merge attribute on *.txt and both sides edit the lossy name', () => {
      describe('When merging side', () => {
        it('Then the merge tree is the merge-tree result', async () => {
          // Arrange
          seed(
            [
              ['.gitattributes', UNION_ATTRIBUTES],
              [FF_TXT, THREE_LINES],
            ],
            [
              ['.gitattributes', UNION_ATTRIBUTES],
              [FF_TXT, 'M\n2\n3\n'],
            ],
            [
              ['.gitattributes', UNION_ATTRIBUTES],
              [FF_TXT, 'S\n2\n3\n'],
            ],
          );

          // Act + Assert
          await expectCleanLikeEngine();
        });
      });
    });

    describe('Given main adds a lossy-named file and side adds a directory of that name', () => {
      describe('When merging side', () => {
        it('Then the conflict stages are the merge-tree conflicted entries', async () => {
          // Arrange
          const lossyDir = Uint8Array.of(0xff, 0x2f, 0x78);
          seed(
            [['a', 'a0\n']],
            [
              ['a', 'a0\n'],
              [Uint8Array.of(0xff), 'file\n'],
            ],
            [
              ['a', 'a0\n'],
              [lossyDir, 'inner\n'],
            ],
          );

          // Act
          const engine = mergeTreeResult(pair.ours, 'main', 'side');
          const result = await mergeSide();

          // Assert — merge-tree labels our side by branch name, merge by HEAD
          expect(result.kind).toBe('conflict');
          expect(conflictRecords()).toEqual(
            engineConflictRecords(engine).map((record) => record.replace('~main', '~HEAD')),
          );
        });
      });
    });

    describe.each([
      ['main adds a file and side adds a directory', 'main', 'side'],
      ['side adds a file and main adds a directory', 'side', 'main'],
    ] as const)('Given %s of the same ASCII name', (_title, fileOn, merged) => {
      describe('When merging the other branch', () => {
        it('Then the conflict, the index stages and the work tree are those of git merge', async () => {
          // Arrange
          const file: Row[] = [['f', 'file\n']];
          const directory: Row[] = [['f/x', 'inner\n']];
          seed(
            [['b', 'b0\n']],
            [['b', 'b0\n'], ...(fileOn === 'main' ? file : directory)],
            [['b', 'b0\n'], ...(fileOn === 'main' ? directory : file)],
          );
          if (merged === 'main') {
            gitIn('checkout', '-q', 'side');
          }
          cpSync(pair.ours, pair.peer, { recursive: true });
          const gitRun = tryRunGit(['-C', pair.peer, 'merge', merged], { env: COMMIT_ENV });
          repo = await openRepository({ cwd: pair.ours });

          // Act
          const result = await repo.merge.run({ rev: merged, author: COMMIT_AUTHOR });

          // Assert
          expect(gitRun.ok).toBe(false);
          expect(result.kind).toBe('conflict');
          expect(records()).toEqual(peerRecords());
          expect(gitIn('status', '--porcelain')).toBe(
            runGit(['-C', pair.peer, 'status', '--porcelain']),
          );
        });
      });
    });

    describe.each([
      ['main modifies the file', 'side'],
      ['side modifies the file', 'main'],
    ] as const)(
      'Given base holds file f, %s and the other replaces it with a directory',
      (_title, merged) => {
        describe('When merging the other branch', () => {
          it('Then the modify/delete conflict, the index stages and the work tree are those of git merge', async () => {
            // Arrange
            const base: Row[] = [
              ['b', 'b0\n'],
              ['f', 'base\n'],
            ];
            const modified: Row[] = [
              ['b', 'b0\n'],
              ['f', 'changed\n'],
            ];
            const replaced: Row[] = [
              ['b', 'b0\n'],
              ['f/x', 'inner\n'],
            ];
            seed(
              base,
              merged === 'side' ? modified : replaced,
              merged === 'side' ? replaced : modified,
            );
            if (merged === 'main') {
              gitIn('checkout', '-q', 'side');
            }
            cpSync(pair.ours, pair.peer, { recursive: true });
            const gitRun = tryRunGit(['-C', pair.peer, 'merge', merged], { env: COMMIT_ENV });
            repo = await openRepository({ cwd: pair.ours });

            // Act
            const result = await repo.merge.run({ rev: merged, author: COMMIT_AUTHOR });

            // Assert
            expect(gitRun.ok).toBe(false);
            expect(result.kind).toBe('conflict');
            expect(records()).toEqual(peerRecords());
            expect(gitIn('status', '--porcelain')).toBe(
              runGit(['-C', pair.peer, 'status', '--porcelain']),
            );
          });
        });
      },
    );
  },
);
