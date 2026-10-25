/**
 * Cross-tool interop — a conflicting merge that would overwrite a tracked,
 * locally-modified working file refuses exactly like canonical git. Builds the
 * same graph in a git peer and a tsgit repo, runs `merge --no-ff` on both, and
 * asserts the refusal axis: both refuse (exit 2, no MERGE_HEAD, working tree /
 * index / HEAD untouched) or both materialise the conflict.
 *
 * The library returns structured data (`WORKING_TREE_DIRTY { localChanges,
 * untracked }`); git's two prose blocks are reconstructed from those arrays
 * inside the test and matched against the peer's captured stderr — local-changes
 * block first (ascending), untracked block second. The library emits no string.
 *
 * @proves
 *   surface:        repo.merge.run
 *   bucket:         cross-tool-interop
 *   unique:         conflict-path tracked-dirty / untracked overwrite refusal matches git
 *   interopSurface: merge
 */
import { appendFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  initBothRepos,
  lsStage,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
  tryRunGit,
  tryRunGitWithExit,
} from './interop-helpers.js';
import {
  indexState,
  listing,
  outcomeOfGitStderr,
  regular,
} from './occupant-displacement-fixtures.js';
import { ABORT_ROWS, buildStoppedMerge, entriesOf } from './stopped-state-fixtures.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const COMMIT_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: AUTHOR.name,
  GIT_AUTHOR_EMAIL: AUTHOR.email,
  GIT_AUTHOR_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
  GIT_COMMITTER_NAME: AUTHOR.name,
  GIT_COMMITTER_EMAIL: AUTHOR.email,
  GIT_COMMITTER_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
};

interface WorkingTreeDirtyData {
  readonly code?: string;
  readonly localChanges?: ReadonlyArray<string>;
  readonly untracked?: ReadonlyArray<string>;
}

/** git's local-changes prose block, reconstructed from the structured array. */
const localChangesBlock = (paths: ReadonlyArray<string>): string =>
  [
    'error: Your local changes to the following files would be overwritten by merge:',
    ...paths.map((p) => `\t${p}`),
    'Please commit your changes or stash them before you merge.',
  ].join('\n');

/** git's untracked-overwrite prose block, reconstructed from the structured array. */
const untrackedBlock = (paths: ReadonlyArray<string>): string =>
  [
    'error: The following untracked working tree files would be overwritten by merge:',
    ...paths.map((p) => `\t${p}`),
    'Please move or remove them before you merge.',
  ].join('\n');

describe.skipIf(!GIT_AVAILABLE)(
  'merge interop — conflict-path tracked-dirty / untracked refusal',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository;

    beforeEach(async () => {
      pair = await makePeerPair('merge-dirty-conflict');
      runGit(['init', '-q', '-b', 'main', pair.peer]);
      repo = await openRepository({ cwd: pair.ours });
      await repo.init();
    });

    afterEach(async () => {
      await repo.dispose();
      await pair.dispose();
    });

    // ── shared peer + tsgit graph helpers ─────────────────────────────────────

    const writeBoth = async (rel: string, content: string): Promise<void> => {
      await writeFile(path.join(pair.peer, rel), content);
      await writeFile(path.join(pair.ours, rel), content);
    };

    const symlinkBoth = async (target: string, rel: string): Promise<void> => {
      await symlink(target, path.join(pair.peer, rel));
      await symlink(target, path.join(pair.ours, rel));
    };

    const commitBoth = async (message: string, paths: ReadonlyArray<string>): Promise<void> => {
      runGit(['-C', pair.peer, 'add', ...paths]);
      await repo.add(paths);
      runGit(['-C', pair.peer, 'commit', '-q', '-m', message], {
        env: COMMIT_ENV,
      });
      await repo.commit({ message, author: AUTHOR, committer: AUTHOR });
    };

    const rmBoth = async (rel: string): Promise<void> => {
      runGit(['-C', pair.peer, 'rm', '-q', rel]);
      await repo.rm([rel]);
    };

    const branchBoth = async (name: string): Promise<void> => {
      runGit(['-C', pair.peer, 'checkout', '-q', '-b', name]);
      await repo.branch.create({ name });
      await repo.checkout({ rev: name });
    };

    const checkoutBoth = async (rev: string): Promise<void> => {
      runGit(['-C', pair.peer, 'checkout', '-q', rev]);
      await repo.checkout({ rev });
    };

    const read = (dir: string, rel: string): Promise<string> =>
      readFile(path.join(dir, rel), 'utf8');

    const peerMerge = (): ReturnType<typeof tryRunGit> =>
      tryRunGit(['-C', pair.peer, 'merge', '--no-ff', '-m', 'm', 'theirs'], { env: COMMIT_ENV });

    const headOf = (dir: string): string => runGit(['-C', dir, 'rev-parse', 'HEAD']).trim();

    const hasMergeHead = (dir: string): boolean =>
      tryRunGit(['-C', dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok;

    /**
     * Run the merge on both tools expecting a co-refusal; return tsgit's
     * structured `WORKING_TREE_DIRTY` data and the peer's stderr. Asserts both
     * refuse (peer exit non-zero), tsgit raised `WORKING_TREE_DIRTY`, and the
     * working tree / index / HEAD are untouched with no `MERGE_HEAD` on tsgit.
     */
    const expectCoRefusal = async (): Promise<{
      data: WorkingTreeDirtyData;
      peerStderr: string;
    }> => {
      const stageBefore = lsStage(pair.ours);
      const headBefore = headOf(pair.ours);

      const peerResult = peerMerge();
      let data: WorkingTreeDirtyData | undefined;
      try {
        await repo.merge.run({ rev: 'theirs', message: 'm', author: AUTHOR });
      } catch (err) {
        data = (err as { data?: WorkingTreeDirtyData }).data;
      }

      expect(peerResult.ok).toBe(false);
      expect(data?.code).toBe('WORKING_TREE_DIRTY');
      // Atomic, pre-write: nothing moved, no MERGE_HEAD, no leaked lock.
      expect(headOf(pair.ours)).toBe(headBefore);
      expect(lsStage(pair.ours)).toBe(stageBefore);
      expect(hasMergeHead(pair.ours)).toBe(false);
      return { data: data ?? {}, peerStderr: peerResult.stderr };
    };

    /** base/ours/theirs all edit `file.txt`; ours & theirs conflict on the middle. */
    const divergeConflict = async (): Promise<void> => {
      await writeBoth('file.txt', 'a\nb\nc\n');
      await commitBoth('base', ['file.txt']);
      await branchBoth('theirs');
      await writeBoth('file.txt', 'a\nY\nc\n');
      await commitBoth('theirs-edit', ['file.txt']);
      await checkoutBoth('main');
      await writeBoth('file.txt', 'a\nX\nc\n');
      await commitBoth('ours-edit', ['file.txt']);
    };

    /**
     * Distinct-types graph: base regular `p`, ours regular `p` (renamed to
     * `p~HEAD` on conflict), theirs symlink `p`. Conflict at `p`.
     */
    const distinctTypesGraph = async (): Promise<void> => {
      await writeBoth('root.txt', 'root\n');
      await writeBoth('p', 'base\n');
      await commitBoth('base', ['root.txt', 'p']);
      await branchBoth('theirs');
      await rmBoth('p');
      await symlinkBoth('target-b', 'p');
      await commitBoth('theirs-symlink', ['p']);
      await checkoutBoth('main');
      await rmBoth('p');
      await writeBoth('p', 'ours\n');
      await commitBoth('ours-regular', ['p']);
    };

    // ── S13: single tracked-dirty content conflict ────────────────────────────

    describe('Given a tracked file with a content conflict is locally modified (S13)', () => {
      describe('When both tools merge', () => {
        it('Then both refuse with the path as a local change and no MERGE_HEAD', async () => {
          // Arrange
          await divergeConflict();
          await writeFile(path.join(pair.peer, 'file.txt'), 'a\nDIRTY-LOCAL\nc\n');
          await writeFile(path.join(pair.ours, 'file.txt'), 'a\nDIRTY-LOCAL\nc\n');

          // Act
          const { data, peerStderr } = await expectCoRefusal();

          // Assert — structured shape + reconstructed prose matches the peer.
          expect(data.localChanges).toEqual(['file.txt']);
          expect(data.untracked).toEqual([]);
          expect(peerStderr).toContain(localChangesBlock(['file.txt']));
          expect(await read(pair.ours, 'file.txt')).toBe('a\nDIRTY-LOCAL\nc\n');
        });
      });
    });

    // ── M1: two tracked-dirty conflict paths, ascending sort ──────────────────

    describe('Given three tracked files with content conflicts added out of order (M1)', () => {
      describe('When both tools merge', () => {
        it('Then both refuse with localChanges sorted ascending, not add order', async () => {
          // Arrange — add order zebra, alpha, mango; all conflict + dirty.
          await writeBoth('zebra.txt', 'z\nb\nz\n');
          await writeBoth('alpha.txt', 'a\nb\na\n');
          await writeBoth('mango.txt', 'm\nb\nm\n');
          await commitBoth('base', ['zebra.txt', 'alpha.txt', 'mango.txt']);
          await branchBoth('theirs');
          await writeBoth('zebra.txt', 'z\nY\nz\n');
          await writeBoth('alpha.txt', 'a\nY\na\n');
          await writeBoth('mango.txt', 'm\nY\nm\n');
          await commitBoth('theirs-edit', ['zebra.txt', 'alpha.txt', 'mango.txt']);
          await checkoutBoth('main');
          await writeBoth('zebra.txt', 'z\nX\nz\n');
          await writeBoth('alpha.txt', 'a\nX\na\n');
          await writeBoth('mango.txt', 'm\nX\nm\n');
          await commitBoth('ours-edit', ['zebra.txt', 'alpha.txt', 'mango.txt']);
          for (const f of ['zebra.txt', 'alpha.txt', 'mango.txt']) {
            await writeFile(path.join(pair.peer, f), 'DIRTY\n');
            await writeFile(path.join(pair.ours, f), 'DIRTY\n');
          }

          // Act
          const { data, peerStderr } = await expectCoRefusal();

          // Assert — sorted ascending.
          expect(data.localChanges).toEqual(['alpha.txt', 'mango.txt', 'zebra.txt']);
          expect(data.untracked).toEqual([]);
          expect(peerStderr).toContain(localChangesBlock(['alpha.txt', 'mango.txt', 'zebra.txt']));
        });
      });
    });

    // ── M2 / CL1: clean-but-changed (theirs-only) path that is dirty ──────────

    describe('Given a clean theirs-only change is dirty during an otherwise-conflicting merge (M2/CL1)', () => {
      describe('When both tools merge', () => {
        it('Then both refuse on the clean path with no conflict materialised and no MERGE_HEAD', async () => {
          // Arrange — f1 conflicts; f2 changes on theirs only (clean merge of f2),
          // f2 drifted dirty.
          await writeBoth('f1.txt', 'a\nb\nc\n');
          await writeBoth('f2.txt', 'orig\n');
          await commitBoth('base', ['f1.txt', 'f2.txt']);
          await branchBoth('theirs');
          await writeBoth('f1.txt', 'a\nY\nc\n');
          await writeBoth('f2.txt', 'theirs-only\n');
          await commitBoth('theirs-edit', ['f1.txt', 'f2.txt']);
          await checkoutBoth('main');
          await writeBoth('f1.txt', 'a\nX\nc\n');
          await commitBoth('ours-edit', ['f1.txt']);
          await writeFile(path.join(pair.peer, 'f2.txt'), 'DIRTY\n');
          await writeFile(path.join(pair.ours, 'f2.txt'), 'DIRTY\n');

          // Act
          const { data, peerStderr } = await expectCoRefusal();

          // Assert — f2 in localChanges; no markers in f1, dirty f2 preserved.
          expect(data.localChanges).toEqual(['f2.txt']);
          expect(data.untracked).toEqual([]);
          expect(peerStderr).toContain(localChangesBlock(['f2.txt']));
          expect(await read(pair.ours, 'f1.txt')).not.toContain('<<<<<<<');
          expect(await read(pair.ours, 'f2.txt')).toBe('DIRTY\n');
        });
      });
    });

    // ── M3: dirty path untouched by the merge — no refusal ────────────────────

    describe('Given a dirty file untouched by either side during a conflicting merge (M3)', () => {
      describe('When both tools merge', () => {
        it('Then neither refuses; both materialise the conflict and write MERGE_HEAD', async () => {
          // Arrange — f1 conflicts; f3 unchanged on both sides, drifted dirty.
          await writeBoth('f1.txt', 'a\nb\nc\n');
          await writeBoth('f3.txt', 'keep\n');
          await commitBoth('base', ['f1.txt', 'f3.txt']);
          await branchBoth('theirs');
          await writeBoth('f1.txt', 'a\nY\nc\n');
          await commitBoth('theirs-edit', ['f1.txt']);
          await checkoutBoth('main');
          await writeBoth('f1.txt', 'a\nX\nc\n');
          await commitBoth('ours-edit', ['f1.txt']);
          await writeFile(path.join(pair.peer, 'f3.txt'), 'DRIFTED\n');
          await writeFile(path.join(pair.ours, 'f3.txt'), 'DRIFTED\n');

          // Act
          const peerResult = peerMerge();
          const result = await repo.merge.run({ rev: 'theirs', message: 'm', author: AUTHOR });

          // Assert — both conflict (exit 1, not a refusal) and write MERGE_HEAD.
          expect(peerResult.ok).toBe(false);
          expect(peerResult.stderr).not.toContain('would be overwritten by merge');
          expect(result.kind).toBe('conflict');
          expect(hasMergeHead(pair.ours)).toBe(true);
          expect(hasMergeHead(pair.peer)).toBe(true);
          // The untouched path's dirty bytes survive on both tools, byte-for-byte.
          expect(await read(pair.ours, 'f3.txt')).toBe(await read(pair.peer, 'f3.txt'));
          expect(await read(pair.ours, 'f3.txt')).toBe('DRIFTED\n');
        });
      });
    });

    // ── TC1: distinct-types conflict at a tracked-dirty path ──────────────────

    describe('Given a distinct-types conflict path is tracked-dirty (TC1)', () => {
      describe('When both tools merge', () => {
        it('Then both refuse with the conflict path as a local change', async () => {
          // Arrange — distinct-types at p; ours' regular p drifted dirty.
          await distinctTypesGraph();
          await writeFile(path.join(pair.peer, 'p'), 'DIRTY-OURS\n');
          await writeFile(path.join(pair.ours, 'p'), 'DIRTY-OURS\n');

          // Act
          const { data, peerStderr } = await expectCoRefusal();

          // Assert — p reported as a local change.
          expect(data.localChanges).toContain('p');
          expect(data.untracked).toEqual([]);
          expect(peerStderr).toContain('Your local changes to the following files');
          expect(await read(pair.ours, 'p')).toBe('DIRTY-OURS\n');
        });
      });
    });

    // ── S7: untracked file squats a theirs-only add ──────────────────────────

    describe('Given an untracked file squats a theirs-only add during a conflicting merge (S7)', () => {
      describe('When both tools merge', () => {
        it('Then both refuse with the squat path as untracked and localChanges empty', async () => {
          // Arrange — file.txt conflicts; theirs also adds g; untracked g squats.
          await writeBoth('file.txt', 'a\nb\nc\n');
          await commitBoth('base', ['file.txt']);
          await branchBoth('theirs');
          await writeBoth('file.txt', 'a\nY\nc\n');
          await writeBoth('g', 'theirs-g\n');
          await commitBoth('theirs-edit-add', ['file.txt', 'g']);
          await checkoutBoth('main');
          await writeBoth('file.txt', 'a\nX\nc\n');
          await commitBoth('ours-edit', ['file.txt']);
          await writeFile(path.join(pair.peer, 'g'), 'untracked\n');
          await writeFile(path.join(pair.ours, 'g'), 'untracked\n');

          // Act
          const { data, peerStderr } = await expectCoRefusal();

          // Assert — g reported as untracked.
          expect(data.untracked).toEqual(['g']);
          expect(data.localChanges).toEqual([]);
          expect(peerStderr).toContain(untrackedBlock(['g']));
          expect(await read(pair.ours, 'g')).toBe('untracked\n');
        });
      });
    });

    // ── S7b: untracked file squats a distinct-types rename target ─────────────

    describe('Given an untracked file squats a distinct-types rename target (S7b)', () => {
      describe('When both tools merge', () => {
        it('Then both refuse with the rename target as untracked', async () => {
          // Arrange — distinct-types at p; untracked p~HEAD squats the rename target.
          await distinctTypesGraph();
          await writeFile(path.join(pair.peer, 'p~HEAD'), 'untracked-blocker\n');
          await writeFile(path.join(pair.ours, 'p~HEAD'), 'untracked-blocker\n');

          // Act
          const { data, peerStderr } = await expectCoRefusal();

          // Assert — p~HEAD reported as untracked.
          expect(data.untracked).toContain('p~HEAD');
          expect(data.localChanges).toEqual([]);
          expect(peerStderr).toContain('The following untracked working tree files');
          expect(await read(pair.ours, 'p~HEAD')).toBe('untracked-blocker\n');
        });
      });
    });

    // ── ORD1: tracked-dirty conflict path AND non-overlapping untracked squat ─

    describe('Given a tracked-dirty conflict path and a non-overlapping untracked squat (ORD1)', () => {
      describe('When both tools merge', () => {
        it('Then both refuse with both arrays populated, local-changes block first', async () => {
          // Arrange — file.txt conflicts + dirty; theirs adds g; untracked g squats.
          await writeBoth('file.txt', 'a\nb\nc\n');
          await commitBoth('base', ['file.txt']);
          await branchBoth('theirs');
          await writeBoth('file.txt', 'a\nY\nc\n');
          await writeBoth('g', 'theirs-g\n');
          await commitBoth('theirs-edit-add', ['file.txt', 'g']);
          await checkoutBoth('main');
          await writeBoth('file.txt', 'a\nX\nc\n');
          await commitBoth('ours-edit', ['file.txt']);
          await writeFile(path.join(pair.peer, 'file.txt'), 'a\nDIRTY\nc\n');
          await writeFile(path.join(pair.ours, 'file.txt'), 'a\nDIRTY\nc\n');
          await writeFile(path.join(pair.peer, 'g'), 'untracked\n');
          await writeFile(path.join(pair.ours, 'g'), 'untracked\n');

          // Act
          const { data, peerStderr } = await expectCoRefusal();

          // Assert — both arrays populated; reconstructed stderr local-changes first.
          expect(data.localChanges).toEqual(['file.txt']);
          expect(data.untracked).toEqual(['g']);
          const reconstructed = `${localChangesBlock(['file.txt'])}\n${untrackedBlock(['g'])}`;
          expect(peerStderr).toContain(reconstructed);
        });
      });
    });

    // ── ORD2: tracked-dirty conflict path overlapping a rename target ─────────

    describe('Given a tracked-dirty conflict path that overlaps a distinct-types rename target (ORD2)', () => {
      describe('When both tools merge', () => {
        it('Then both refuse with the path in localChanges only and untracked empty', async () => {
          // Arrange — distinct-types at p with ours regular p drifted dirty; the
          // overlapping path lands in localChanges, never untracked.
          await distinctTypesGraph();
          await writeFile(path.join(pair.peer, 'p'), 'DIRTY-OURS\n');
          await writeFile(path.join(pair.ours, 'p'), 'DIRTY-OURS\n');

          // Act
          const { data, peerStderr } = await expectCoRefusal();

          // Assert — p in localChanges only.
          expect(data.localChanges).toContain('p');
          expect(data.untracked).toEqual([]);
          expect(peerStderr).toContain('Your local changes to the following files');
          expect(peerStderr).not.toContain('untracked working tree files');
        });
      });
    });

    // ── DG1: untracked dangling symlink squats a rename target ────────────────

    describe('Given an untracked dangling symlink squats a distinct-types rename target (DG1)', () => {
      describe('When both tools merge', () => {
        it('Then both refuse with the dangling path as untracked via the lstat probe', async () => {
          // Arrange — distinct-types at p; p~HEAD is a dangling symlink (its
          // target does not exist, so realpath/exists fail but lstat sees it).
          await distinctTypesGraph();
          await symlink('/nonexistent/target', path.join(pair.peer, 'p~HEAD'));
          await symlink('/nonexistent/target', path.join(pair.ours, 'p~HEAD'));

          // Act
          const { data, peerStderr } = await expectCoRefusal();

          // Assert — p~HEAD flagged as untracked despite being dangling.
          expect(data.untracked).toContain('p~HEAD');
          expect(data.localChanges).toEqual([]);
          expect(peerStderr).toContain('The following untracked working tree files');
        });
      });
    });

    // ── SP1: sparse-excluded conflict path — no refusal ──────────────────────

    describe('Given a conflict path is sparse-excluded (SP1)', () => {
      describe('When both tools merge', () => {
        it('Then neither refuses; the conflict materialises and MERGE_HEAD is written', async () => {
          // Arrange — inside/f.txt conflicts; cone sparse-checkout keeps only
          // outside/, so inside/f.txt is absent from disk → never dirty.
          for (const dir of [pair.peer, pair.ours]) {
            await mkdir(path.join(dir, 'outside'), { recursive: true });
            await mkdir(path.join(dir, 'inside'), { recursive: true });
          }
          await writeBoth('outside/keep.txt', 'keep\n');
          await writeBoth('inside/f.txt', 'a\nb\nc\n');
          await commitBoth('base', ['outside/keep.txt', 'inside/f.txt']);
          await branchBoth('theirs');
          await writeBoth('inside/f.txt', 'a\nY\nc\n');
          await commitBoth('theirs-edit', ['inside/f.txt']);
          await checkoutBoth('main');
          await writeBoth('inside/f.txt', 'a\nX\nc\n');
          await commitBoth('ours-edit', ['inside/f.txt']);

          // Cone sparse-checkout limited to outside/ on both tools.
          runGit(['-C', pair.peer, 'sparse-checkout', 'init', '--cone']);
          runGit(['-C', pair.peer, 'sparse-checkout', 'set', 'outside']);
          await writeFile(
            path.join(pair.ours, '.git', 'info', 'sparse-checkout'),
            '/*\n!/*/\noutside/\n',
          );
          await writeFile(path.join(pair.ours, '.git', 'config'), await sparseConfig());

          // Act
          const peerResult = peerMerge();
          const result = await repo.merge.run({ rev: 'theirs', message: 'm', author: AUTHOR });

          // Assert — both materialise the conflict (no refusal), MERGE_HEAD written.
          expect(peerResult.ok).toBe(false);
          expect(peerResult.stderr).not.toContain('would be overwritten by merge');
          expect(result.kind).toBe('conflict');
          expect(hasMergeHead(pair.ours)).toBe(true);
          expect(hasMergeHead(pair.peer)).toBe(true);
        });
      });
    });

    // ── FD1: ours holds an edited file the merged branch replaces by a directory ──

    /** base `b`; theirs adds directory `f/`; ours commits file `f`. */
    const fileDirectoryGraph = async (): Promise<void> => {
      await writeBoth('b', 'b\n');
      await commitBoth('base', ['b']);
      await branchBoth('theirs');
      await mkdir(path.join(pair.peer, 'f'));
      await mkdir(path.join(pair.ours, 'f'));
      await writeBoth('f/x', 'x\n');
      await commitBoth('theirs-directory', ['f/x']);
      await checkoutBoth('main');
      await writeBoth('f', 'file\n');
      await commitBoth('ours-file', ['f']);
      await writeBoth('f', 'LOCAL-EDIT\n');
    };

    describe('Given ours holds file f with an unstaged edit and theirs adds directory f/ (FD1)', () => {
      describe('When both tools merge', () => {
        it('Then both refuse naming f and keep the edited file', async () => {
          // Arrange
          await fileDirectoryGraph();

          // Act
          const { data, peerStderr } = await expectCoRefusal();

          // Assert
          expect(data.localChanges).toEqual(['f']);
          expect(data.untracked).toEqual([]);
          expect(peerStderr).toContain(localChangesBlock(['f']));
          expect(await read(pair.ours, 'f')).toBe('LOCAL-EDIT\n');
          expect(await read(pair.peer, 'f')).toBe('LOCAL-EDIT\n');
        });
      });
    });

    describe('Given ours holds file f with an unstaged edit and the picked commit adds directory f/ (FD2)', () => {
      describe('When both tools cherry-pick', () => {
        it('Then both refuse naming f and keep the edited file, HEAD and index', async () => {
          // Arrange
          await fileDirectoryGraph();
          const stageBefore = lsStage(pair.ours);
          const headBefore = headOf(pair.ours);

          // Act
          const peerResult = tryRunGit(['-C', pair.peer, 'cherry-pick', 'theirs'], {
            env: COMMIT_ENV,
          });
          let data: WorkingTreeDirtyData | undefined;
          try {
            await repo.cherryPick.run({ commits: ['theirs'] });
          } catch (err) {
            data = (err as { data?: WorkingTreeDirtyData }).data;
          }

          // Assert
          expect(peerResult.ok).toBe(false);
          expect(peerResult.stderr).toContain(localChangesBlock(['f']));
          expect(data?.code).toBe('WORKING_TREE_DIRTY');
          expect(data?.localChanges).toEqual(['f']);
          expect(await read(pair.ours, 'f')).toBe('LOCAL-EDIT\n');
          expect(await read(pair.peer, 'f')).toBe('LOCAL-EDIT\n');
          expect(headOf(pair.ours)).toBe(headBefore);
          expect(lsStage(pair.ours)).toBe(stageBefore);
          expect(headOf(pair.peer)).toBe(headBefore);
          expect(lsStage(pair.peer)).toBe(stageBefore);
        });
      });
    });

    /** Append `core.sparseCheckout=true` to tsgit's repo config for the SP1 row. */
    const sparseConfig = async (): Promise<string> => {
      const current = await read(pair.ours, path.join('.git', 'config'));
      return current.includes('sparseCheckout')
        ? current
        : `${current}[core]\n\tsparseCheckout = true\n`;
    };
  },
);

const BOB: AuthorIdentity = {
  name: 'Bob',
  email: 'bob@example.com',
  timestamp: 1_700_000_100,
  timezoneOffset: '+0000',
};

const SPLIT_ENV: NodeJS.ProcessEnv = {
  ...COMMIT_ENV,
  GIT_COMMITTER_NAME: BOB.name,
  GIT_COMMITTER_EMAIL: BOB.email,
  GIT_COMMITTER_DATE: `${BOB.timestamp} ${BOB.timezoneOffset}`,
};

type Graph =
  | 'diverged'
  | 'descendant'
  | 'conflicting'
  | 'two-sided'
  | 'beyond-symlink'
  | 'tracked-f'
  | 'tracked-f-two-sided';
type LocalState =
  | 'modified'
  | 'clean'
  | 'untracked'
  | 'touched'
  | 'untracked-and-modified'
  | 'directory-over-f'
  | 'modified-and-directory-over-f';
type Outcome = 'ok' | 'conflict' | 'refused';

interface SnapshotRow {
  readonly id: string;
  readonly graph: Graph;
  readonly local: LocalState;
  readonly git: ReadonlyArray<string>;
  readonly input: Record<string, unknown>;
  readonly outcome: Outcome;
  readonly snapshot: boolean;
  readonly detached?: boolean;
  /** The tools add the same unreachable objects, blobs and trees included. */
  readonly sameObjects?: boolean;
}

const MERGE_T = { rev: 't' };
const SNAPSHOT_ROWS: ReadonlyArray<SnapshotRow> = [
  {
    id: 'Q1',
    graph: 'diverged',
    local: 'modified',
    git: ['t'],
    input: MERGE_T,
    outcome: 'ok',
    snapshot: true,
  },
  {
    id: 'Q2',
    graph: 'diverged',
    local: 'clean',
    git: ['t'],
    input: MERGE_T,
    outcome: 'ok',
    snapshot: false,
  },
  {
    id: 'Q5',
    graph: 'diverged',
    local: 'untracked',
    git: ['t'],
    input: MERGE_T,
    outcome: 'ok',
    snapshot: false,
  },
  {
    id: 'Q6',
    graph: 'diverged',
    local: 'touched',
    git: ['t'],
    input: MERGE_T,
    outcome: 'ok',
    snapshot: false,
  },
  {
    id: 'Q7',
    graph: 'descendant',
    local: 'modified',
    git: ['t'],
    input: MERGE_T,
    outcome: 'ok',
    snapshot: false,
  },
  {
    id: 'Q8',
    graph: 'diverged',
    local: 'modified',
    git: ['--squash', 't'],
    input: { rev: 't', squash: true },
    outcome: 'ok',
    snapshot: true,
  },
  {
    id: 'Q9',
    graph: 'descendant',
    local: 'modified',
    git: ['--squash', 't'],
    input: { rev: 't', squash: true },
    outcome: 'ok',
    snapshot: false,
  },
  {
    id: 'Q10',
    graph: 'diverged',
    local: 'modified',
    git: ['--no-commit', 't'],
    input: { rev: 't', commit: false },
    outcome: 'ok',
    snapshot: true,
  },
  {
    id: 'Q11',
    graph: 'diverged',
    local: 'modified',
    git: ['-s', 'ours', '-s', 'ort', 't'],
    input: { rev: 't', strategy: ['ours', 'ort'] },
    outcome: 'ok',
    snapshot: true,
  },
  {
    id: 'Q12',
    graph: 'diverged',
    local: 'modified',
    git: ['-s', 'octopus', '-s', 'ort', 't'],
    input: { rev: 't', strategy: ['octopus', 'ort'] },
    outcome: 'ok',
    snapshot: true,
    sameObjects: true,
  },
  {
    id: 'Q14',
    graph: 'tracked-f',
    local: 'directory-over-f',
    git: ['-s', 'octopus', '-s', 'ort', 't'],
    input: { rev: 't', strategy: ['octopus', 'ort'] },
    outcome: 'ok',
    snapshot: true,
    sameObjects: true,
  },
  {
    id: 'Q16',
    graph: 'tracked-f',
    local: 'modified-and-directory-over-f',
    git: ['t'],
    input: MERGE_T,
    outcome: 'refused',
    snapshot: true,
    sameObjects: true,
  },
  {
    id: 'Q25',
    graph: 'tracked-f',
    local: 'directory-over-f',
    git: ['-s', 'ort', '-s', 'ort', 't'],
    input: { rev: 't', strategy: ['ort', 'ort'] },
    outcome: 'ok',
    snapshot: true,
    sameObjects: true,
  },
  {
    id: 'Q27',
    graph: 'tracked-f',
    local: 'modified-and-directory-over-f',
    git: ['--no-commit', 't'],
    input: { rev: 't', commit: false },
    outcome: 'refused',
    snapshot: true,
    sameObjects: true,
  },
  {
    id: 'Q28',
    graph: 'tracked-f',
    local: 'modified-and-directory-over-f',
    git: ['--squash', 't'],
    input: { rev: 't', squash: true },
    outcome: 'refused',
    snapshot: true,
    sameObjects: true,
  },
  {
    id: 'Q29',
    graph: 'tracked-f-two-sided',
    local: 'directory-over-f',
    git: ['-s', 'resolve', 't'],
    input: { rev: 't', strategy: 'resolve' },
    outcome: 'refused',
    snapshot: true,
  },
  {
    id: 'Q33',
    graph: 'tracked-f',
    local: 'modified-and-directory-over-f',
    git: ['-s', 'resolve', 't'],
    input: { rev: 't', strategy: 'resolve' },
    outcome: 'refused',
    snapshot: true,
  },
  {
    id: 'Q13',
    graph: 'diverged',
    local: 'modified',
    git: ['-s', 'resolve', 't'],
    input: { rev: 't', strategy: 'resolve' },
    outcome: 'ok',
    snapshot: false,
  },
  {
    id: 'Q15',
    graph: 'diverged',
    local: 'modified',
    git: ['t'],
    input: MERGE_T,
    outcome: 'ok',
    snapshot: true,
    detached: true,
  },
  {
    id: 'Q17',
    graph: 'conflicting',
    local: 'modified',
    git: ['t'],
    input: MERGE_T,
    outcome: 'conflict',
    snapshot: true,
  },
  {
    id: 'Q18',
    graph: 'diverged',
    local: 'untracked-and-modified',
    git: ['t'],
    input: MERGE_T,
    outcome: 'ok',
    snapshot: true,
  },
  {
    id: 'Q19',
    graph: 'diverged',
    local: 'modified',
    git: ['--ff-only', 't'],
    input: { rev: 't', fastForward: 'only' },
    outcome: 'refused',
    snapshot: false,
  },
  {
    id: 'Q20',
    graph: 'two-sided',
    local: 'modified',
    git: ['-s', 'resolve', 't'],
    input: { rev: 't', strategy: 'resolve' },
    outcome: 'ok',
    snapshot: true,
  },
  {
    id: 'Q23',
    graph: 'diverged',
    local: 'modified',
    git: ['t', 't2'],
    input: { rev: ['t', 't2'] },
    outcome: 'ok',
    snapshot: true,
  },
  {
    id: 'S3a /same',
    graph: 'beyond-symlink',
    local: 'clean',
    git: ['t'],
    input: MERGE_T,
    outcome: 'refused',
    snapshot: true,
  },
  {
    id: 'S3a /same with dirty',
    graph: 'beyond-symlink',
    local: 'modified',
    git: ['t'],
    input: MERGE_T,
    outcome: 'refused',
    snapshot: true,
  },
];

const outcomeOfExit = (exitCode: number): Outcome => {
  if (exitCode === 0) return 'ok';
  return exitCode === 1 ? 'conflict' : 'refused';
};

describe.skipIf(!GIT_AVAILABLE)(
  'merge interop — snapshot of local changes before the strategies',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository;

    beforeEach(async () => {
      pair = await makePeerPair('merge-snapshot');
      runGit(['init', '-q', '-b', 'main', pair.peer]);
      repo = await openRepository({ cwd: pair.ours });
      await repo.init();
    });

    afterEach(async () => {
      vi.useRealTimers();
      await repo.dispose();
      await pair.dispose();
    });

    const writeBoth = async (rel: string, content: string): Promise<void> => {
      for (const dir of [pair.peer, pair.ours]) {
        await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
        await writeFile(path.join(dir, rel), content);
      }
    };

    const commitBoth = async (message: string, paths: ReadonlyArray<string>): Promise<void> => {
      runGit(['-C', pair.peer, 'add', ...paths]);
      await repo.add(paths);
      runGit(['-C', pair.peer, 'commit', '-q', '-m', message], { env: SPLIT_ENV });
      await repo.commit({ message, author: AUTHOR, committer: BOB });
    };

    const branchBoth = async (name: string): Promise<void> => {
      runGit(['-C', pair.peer, 'checkout', '-q', '-b', name]);
      await repo.branch.create({ name });
      await repo.checkout({ rev: name });
    };

    const checkoutBoth = async (rev: string): Promise<void> => {
      runGit(['-C', pair.peer, 'checkout', '-q', rev]);
      await repo.checkout({ rev });
    };

    const TWO_SIDED_BASE = '1\n2\n3\n4\n5\n6\n7\n8\n9\n';

    const buildGraph = async (graph: Graph): Promise<void> => {
      const tracksF = graph === 'tracked-f' || graph === 'tracked-f-two-sided';
      const twoSided = graph === 'two-sided' || graph === 'tracked-f-two-sided';
      await writeBoth('dirty', 'base\n');
      await writeBoth('keep', 'k0\n');
      await writeBoth('two', TWO_SIDED_BASE);
      await writeBoth('d/x', 'x\n');
      if (tracksF) await writeBoth('f', 'v1\n');
      await commitBoth('base', ['dirty', 'keep', 'two', 'd/x', ...(tracksF ? ['f'] : [])]);
      await branchBoth('t2');
      await writeBoth('t2-file', 't2\n');
      await commitBoth('t2', ['t2-file']);
      await checkoutBoth('main');
      await branchBoth('t');
      if (graph === 'conflicting') await writeBoth('keep', 'kT\n');
      if (twoSided) await writeBoth('two', TWO_SIDED_BASE.replace('1\n', 'T\n'));
      if (tracksF) await writeBoth('f', 'v2\n');
      await writeBoth('t-file', 't\n');
      await commitBoth('t', ['t-file', 'keep', 'two', ...(tracksF ? ['f'] : [])]);
      await checkoutBoth('main');
      if (graph === 'descendant') return;
      if (graph === 'conflicting') await writeBoth('keep', 'kO\n');
      if (twoSided) await writeBoth('two', TWO_SIDED_BASE.replace('9\n', 'O\n'));
      await writeBoth('o-file', 'o\n');
      await commitBoth('o', ['o-file', 'keep', 'two']);
    };

    const applyLocal = async (local: LocalState): Promise<void> => {
      if (local === 'directory-over-f' || local === 'modified-and-directory-over-f') {
        for (const dir of [pair.peer, pair.ours]) await rm(path.join(dir, 'f'));
        await writeBoth('f/u', 'untracked\n');
      }
      if (
        local === 'modified' ||
        local === 'untracked-and-modified' ||
        local === 'modified-and-directory-over-f'
      ) {
        await writeBoth('dirty', 'LOCAL\n');
      }
      if (local === 'untracked' || local === 'untracked-and-modified') {
        await writeBoth('stray', 'stray\n');
      }
      if (local === 'touched') await writeBoth('dirty', 'base\n');
    };

    const unreachable = (dir: string): ReadonlySet<string> => {
      const all = runGit(['-C', dir, 'cat-file', '--batch-all-objects', '--batch-check']);
      const reached = new Set(
        runGit(['-C', dir, 'rev-list', '--objects', '--all'])
          .split('\n')
          .map((line) => line.split(' ')[0]),
      );
      return new Set(
        all
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => line.split(' ')[0] as string)
          .filter((id) => !reached.has(id)),
      );
    };

    const created = (before: ReadonlySet<string>, after: ReadonlySet<string>): string[] =>
      [...after].filter((id) => !before.has(id)).sort();

    const commitsOf = (dir: string, ids: ReadonlyArray<string>): string[] =>
      ids.filter((id) => runGit(['-C', dir, 'cat-file', '-t', id]).trim() === 'commit');

    const messagesOf = (dir: string, ids: ReadonlyArray<string>): string[] =>
      commitsOf(dir, ids)
        .map((id) =>
          runGit(['-C', dir, 'cat-file', 'commit', id]).split('\n\n').slice(1).join('\n\n'),
        )
        .sort();

    const tsgitOutcome = async (
      input: Record<string, unknown>,
    ): Promise<{ outcome: Outcome; code?: string | undefined }> => {
      try {
        const result = await repo.merge.run({
          message: 'm',
          author: AUTHOR,
          committer: BOB,
          ...input,
        } as Parameters<Repository['merge']['run']>[0]);
        return { outcome: result.kind === 'conflict' ? 'conflict' : 'ok' };
      } catch (error) {
        return { outcome: 'refused', code: (error as { data?: { code?: string } }).data?.code };
      }
    };

    const statusOf = (dir: string): string =>
      runGit(['-C', dir, 'status', '--porcelain', '--untracked-files=all']);

    describe.each(SNAPSHOT_ROWS)('Row $id', (row) => {
      describe('When both tools merge', () => {
        it('Then the outcome, index, work tree and unreachable objects match', async () => {
          // Arrange
          await buildGraph(row.graph);
          if (row.detached === true) {
            runGit(['-C', pair.peer, 'checkout', '-q', '--detach']);
            await repo.checkout({ rev: runGit(['-C', pair.ours, 'rev-parse', 'HEAD']).trim() });
          }
          if (row.graph === 'beyond-symlink') {
            for (const dir of [pair.peer, pair.ours]) {
              await rm(path.join(dir, 'd'), { recursive: true });
              await symlink('nowhere', path.join(dir, 'd'));
            }
          }
          await applyLocal(row.local);
          const peerBefore = unreachable(pair.peer);
          const oursBefore = unreachable(pair.ours);

          // Act
          const peer = tryRunGitWithExit(['-C', pair.peer, 'merge', '-m', 'm', ...row.git], {
            env: SPLIT_ENV,
          });
          const ours = await tsgitOutcome(row.input);

          // Assert
          const peerNew = created(peerBefore, unreachable(pair.peer));
          const oursNew = created(oursBefore, unreachable(pair.ours));
          expect(ours.outcome).toBe(outcomeOfExit(peer.exitCode));
          expect(ours.outcome).toBe(row.outcome);
          expect(messagesOf(pair.ours, oursNew)).toEqual(messagesOf(pair.peer, peerNew));
          expect(commitsOf(pair.ours, oursNew).length > 0).toBe(row.snapshot);
          expect(commitsOf(pair.ours, oursNew)).toEqual(commitsOf(pair.peer, peerNew));
          if (row.sameObjects === true) expect(oursNew).toEqual(peerNew);
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
          expect(listing(pair.ours)).toEqual(listing(pair.peer));
          expect(statusOf(pair.ours)).toBe(statusOf(pair.peer));
          expect(headOf(pair.ours)).toBe(headOf(pair.peer));
        });
      });
    });

    describe('Given a beyond-symlink refusal', () => {
      describe('When tsgit merges', () => {
        it('Then it names the path beyond the symbolic link', async () => {
          // Arrange
          await buildGraph('beyond-symlink');
          for (const dir of [pair.ours]) {
            await rm(path.join(dir, 'd'), { recursive: true });
            await symlink('nowhere', path.join(dir, 'd'));
          }

          // Act
          const sut = await tsgitOutcome(MERGE_T);

          // Assert
          expect(sut).toEqual({ outcome: 'refused', code: 'PATHSPEC_BEYOND_SYMLINK' });
        });
      });
    });

    describe.each([
      ['SHA1', async () => writeBoth('dirty', 'LOCAL\n')],
      [
        'SHA2',
        async () => {
          await writeBoth('dirty', 'STAGED\n');
          runGit(['-C', pair.peer, 'add', 'dirty']);
          await repo.add(['dirty']);
          await writeBoth('dirty', 'LOCAL\n');
        },
      ],
    ])('Row %s', (_id, arrangeLocal) => {
      describe('When git stash create and tsgit stash push share one identity', () => {
        it('Then both write the same WIP commit', async () => {
          // Arrange
          await buildGraph('descendant');
          await arrangeLocal();
          await appendFile(
            path.join(pair.ours, '.git', 'config'),
            `[user]\n\tname = ${AUTHOR.name}\n\temail = ${AUTHOR.email}\n`,
          );
          vi.useFakeTimers({ toFake: ['Date'] });
          vi.setSystemTime(AUTHOR.timestamp * 1000);

          // Act
          const peerStash = runGit(['-C', pair.peer, 'stash', 'create'], {
            env: COMMIT_ENV,
          }).trim();
          await repo.stash.push();

          // Assert
          vi.useRealTimers();
          expect(runGit(['-C', pair.ours, 'rev-parse', 'stash@{0}']).trim()).toBe(peerStash);
        });
      });
    });

    const headOf = (dir: string): string => runGit(['-C', dir, 'rev-parse', 'HEAD']).trim();
  },
);

interface MergeResultShape {
  readonly kind: 'ok' | 'conflict' | 'beyond-symlink' | 'refused' | `crash ${string}`;
  readonly localChanges: ReadonlyArray<string>;
  readonly untracked: ReadonlyArray<string>;
}

const sortedShape = (shape: MergeResultShape): MergeResultShape => ({
  ...shape,
  localChanges: [...shape.localChanges].sort(),
  untracked: [...shape.untracked].sort(),
});

const NONE = { localChanges: [], untracked: [] } as const;

const gitMergeShape = (dir: string, extra: ReadonlyArray<string>): MergeResultShape => {
  const result = tryRunGitWithExit(['-C', dir, 'merge', '-m', 'm', ...extra, 't'], {
    env: SPLIT_ENV,
  });
  if (result.exitCode === 0) return { kind: 'ok', ...NONE };
  if (result.exitCode === 1) return { kind: 'conflict', ...NONE };
  if (result.exitCode === 128 && result.stderr.includes('beyond a symbolic link')) {
    return { kind: 'beyond-symlink', ...NONE };
  }
  if (result.exitCode !== 2)
    throw new Error(`unexpected exit ${result.exitCode}: ${result.stderr}`);
  const { localChanges, untracked } = outcomeOfGitStderr(result.stderr);
  return sortedShape({ kind: 'refused', localChanges, untracked });
};

const tsgitMergeShape = async (repo: Repository): Promise<MergeResultShape> => {
  try {
    const result = await repo.merge.run({ rev: 't', message: 'm', author: AUTHOR, committer: BOB });
    return { kind: result.kind === 'conflict' ? 'conflict' : 'ok', ...NONE };
  } catch (error) {
    const data = (error as { data?: Record<string, unknown> }).data ?? {};
    if (data.code === 'PATHSPEC_BEYOND_SYMLINK') return { kind: 'beyond-symlink', ...NONE };
    if (data.code !== 'WORKING_TREE_DIRTY') return { kind: `crash ${String(data.code)}`, ...NONE };
    return sortedShape({
      kind: 'refused',
      localChanges: data.localChanges as ReadonlyArray<string>,
      untracked: data.untracked as ReadonlyArray<string>,
    });
  }
};

const MERGE_KINDS = [
  { label: 'non-ff', stopped: { keepMain: 'keep\n' } },
  { label: 'non-ff, conflicting', stopped: {} },
] as const;

const MATRIX = ABORT_ROWS.flatMap((row) =>
  row.variants.flatMap((variant) =>
    MERGE_KINDS.map((kind) => ({
      id: `${row.shape}/${variant} merge t (${kind.label})`,
      row,
      variant,
      stopped: kind.stopped,
    })),
  ),
);

describe.skipIf(!GIT_AVAILABLE)(
  'merge interop — occupants in the rewind between strategies',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository | undefined;

    beforeEach(async () => {
      pair = await makePeerPair('merge-rewind-occupant');
      initBothRepos(pair.peer, pair.ours);
      repo = undefined;
    });

    afterEach(async () => {
      await repo?.dispose();
      await pair.dispose();
    });

    const withSide = (entries: ReturnType<typeof entriesOf>): ReturnType<typeof entriesOf> => ({
      base: [...entries.base, regular('side', 'base\n')],
      main: [...entries.main, regular('side', 'base\n')],
      theirs: [...entries.theirs, regular('side', 'base\n')],
    });

    describe.each(MATRIX)('Given $id', ({ row, variant, stopped }) => {
      describe('When both tools merge', () => {
        it('Then the outcome, work tree, index and HEAD match git', async () => {
          // Arrange
          for (const dir of [pair.peer, pair.ours]) {
            buildStoppedMerge(dir, withSide(entriesOf(variant, row)), stopped);
            row.occupant(dir);
            await writeFile(path.join(dir, 'side'), 's\n');
          }
          repo = await openRepository({ cwd: pair.ours });

          // Act
          const expected = gitMergeShape(pair.peer, []);
          const result = await tsgitMergeShape(repo);

          // Assert
          expect(result).toEqual(expected);
          expect(listing(pair.ours)).toEqual(listing(pair.peer));
          expect(indexState(pair.ours)).toEqual(indexState(pair.peer));
          expect(runGit(['-C', pair.ours, 'rev-parse', 'HEAD'])).toBe(
            runGit(['-C', pair.peer, 'rev-parse', 'HEAD']),
          );
        });
      });
    });
  },
);
