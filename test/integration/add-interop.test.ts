/**
 * Cross-tool interop — `add` porcelain. Stages the same paths via `repo.add`
 * (through the `openRepository` facade) and via canonical `git add` on a peer
 * repo, then asserts the resulting index (`git ls-files --stage`) and tree
 * (`git write-tree`) agree. Pins the staging *command* — pathspec expansion,
 * blob hashing, mode bits — to canonical git, beyond the index byte-format
 * proof (`index-interop.test.ts`) that uses add only as a vehicle.
 *
 * @proves
 *   surface:        add
 *   bucket:         cross-tool-interop
 *   unique:         add porcelain index+tree state matches canonical git add
 *   interopSurface: add
 */
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  hashBlob,
  indexExtensionOf,
  lsStage,
  makePeerPair,
  type PeerPair,
  runGit,
  writeTreeOf,
} from './interop-helpers.js';

interface StagedRow {
  readonly stage: 0 | 1 | 2 | 3;
  readonly path: string | Uint8Array;
}

const REGULAR_MODE = '100644';
const TREE_FILES: ReadonlyArray<string> = ['a/b', 'a/c', 'a/x/y', 'real/b', 'top'];
const LOSSY_PATH = Uint8Array.of(0x61, 0x2f, 0xff);
const UNMERGED_STAGES: ReadonlyArray<StagedRow['stage']> = [1, 2, 3];
const HAS_UNMERGED_STAGE = /\s[123]\t/;

type Replacement = 'symlink' | 'file';

interface ReplacedRow {
  readonly title: string;
  readonly replacement: Replacement;
  readonly replaced?: string;
  readonly paths: ReadonlyArray<string>;
  readonly prepare?: (dir: string) => void;
  readonly removed: ReadonlyArray<string>;
  readonly modified?: ReadonlyArray<string>;
}

const stageRows = (dir: string, rows: ReadonlyArray<StagedRow>): void => {
  const oid = hashBlob(dir, 'staged\n');
  const chunks = rows.flatMap(({ stage, path: rowPath }) => [
    Buffer.from(`${REGULAR_MODE} ${oid} ${stage}\t`),
    typeof rowPath === 'string' ? Buffer.from(rowPath) : Buffer.from(rowPath),
    Buffer.alloc(1),
  ]);
  runGit(['-C', dir, 'update-index', '-z', '--index-info'], { input: Buffer.concat(chunks) });
};

const unmergedBeneath = (dir: string): void => {
  runGit(['-C', dir, 'update-index', '--force-remove', 'a/b']);
  stageRows(
    dir,
    UNMERGED_STAGES.map((stage) => ({ stage, path: 'a/b' })),
  );
};

const unmergedAtDirectory = (dir: string): void =>
  stageRows(
    dir,
    UNMERGED_STAGES.map((stage) => ({ stage, path: 'a' })),
  );

const REPLACED_ROWS: ReadonlyArray<ReplacedRow> = [
  {
    title: 'a symlink named a',
    replacement: 'symlink',
    paths: ['a'],
    removed: ['a/b', 'a/c', 'a/x/y'],
  },
  {
    title: 'a regular file named a',
    replacement: 'file',
    paths: ['a'],
    removed: ['a/b', 'a/c', 'a/x/y'],
  },
  {
    title: 'a symlink named ./a',
    replacement: 'symlink',
    paths: ['./a'],
    removed: ['a/b', 'a/c', 'a/x/y'],
  },
  {
    title: 'a symlink named a beside the unchanged top',
    replacement: 'symlink',
    paths: ['top', 'a'],
    removed: ['a/b', 'a/c', 'a/x/y'],
  },
  {
    title: 'a nested symlink named a/x',
    replacement: 'symlink',
    replaced: 'a/x',
    paths: ['a/x'],
    removed: ['a/x/y'],
  },
  {
    title: 'a regular file named a with a/b excluded',
    replacement: 'file',
    paths: ['a', '!a/b'],
    removed: ['a/c', 'a/x/y'],
  },
  {
    title: 'a symlink named a over a skip-worktree a/b',
    replacement: 'symlink',
    paths: ['a'],
    prepare: (dir) => runGit(['-C', dir, 'update-index', '--skip-worktree', 'a/b']),
    removed: ['a/c', 'a/x/y'],
  },
  {
    title: 'a symlink named a over a lossy a/\\xff',
    replacement: 'symlink',
    paths: ['a'],
    prepare: (dir) => stageRows(dir, [{ stage: 0, path: LOSSY_PATH }]),
    removed: ['a/b', 'a/c', 'a/x/y', 'a/\uFFFD'],
  },
  {
    title: 'a symlink named a over an unmerged a/b',
    replacement: 'symlink',
    paths: ['a'],
    prepare: unmergedBeneath,
    removed: ['a/b', 'a/c', 'a/x/y'],
  },
  {
    title: 'a regular file named a over an unmerged a/b with a/b excluded by name',
    replacement: 'file',
    paths: ['a', '!a/b'],
    prepare: unmergedBeneath,
    removed: ['a/b', 'a/c', 'a/x/y'],
  },
  {
    title: 'a regular file named a over an unmerged a/b with a/b excluded by glob',
    replacement: 'file',
    paths: ['a', '!a/b*'],
    prepare: unmergedBeneath,
    removed: ['a/c', 'a/x/y'],
  },
  {
    title: 'a regular file named a that was unmerged',
    replacement: 'file',
    paths: ['a'],
    prepare: unmergedAtDirectory,
    removed: [],
    modified: ['a'],
  },
  {
    title: 'a symlink named a that was unmerged',
    replacement: 'symlink',
    paths: ['a'],
    prepare: unmergedAtDirectory,
    removed: [],
    modified: ['a'],
  },
  {
    title: 'a regular file named a that was unmerged, staged beside top',
    replacement: 'file',
    paths: ['a', 'top'],
    prepare: unmergedAtDirectory,
    removed: [],
    modified: ['a'],
  },
];

const gitPathspec = (spec: string): string => (spec.startsWith('!') ? `:${spec}` : spec);

interface SeedFile {
  readonly path: string;
  readonly content: string;
}

interface StateSnapshot {
  readonly stage: string;
  readonly tree: string;
}

describe.skipIf(!GIT_AVAILABLE)('add porcelain interop', () => {
  let pair: PeerPair;
  let repo: Repository;

  beforeEach(async () => {
    pair = await makePeerPair('add');
    runGit(['init', '-q', '-b', 'main', pair.peer]);
    repo = await openRepository({ cwd: pair.ours });
    await repo.init();
  });

  afterEach(async () => {
    await repo.dispose();
    await pair.dispose();
  });

  const writeBoth = async (file: SeedFile): Promise<void> => {
    const parent = path.dirname(file.path);
    if (parent !== '.') {
      await mkdir(path.join(pair.peer, parent), { recursive: true });
      await mkdir(path.join(pair.ours, parent), { recursive: true });
    }
    await writeFile(path.join(pair.peer, file.path), file.content);
    await writeFile(path.join(pair.ours, file.path), file.content);
  };

  const snapshot = (dir: string): StateSnapshot => ({
    stage: lsStage(dir),
    tree: writeTreeOf(dir),
  });

  describe('Given a single untracked file in both repos', () => {
    describe('When repo.add stages it like git add', () => {
      it('Then the index and tree match canonical git', async () => {
        // Arrange
        await writeBoth({ path: 'a.txt', content: 'hello\n' });

        // Act
        const added = await repo.add(['a.txt']);
        runGit(['-C', pair.peer, 'add', 'a.txt']);
        const result = snapshot(pair.ours);

        // Assert
        const peer = snapshot(pair.peer);
        expect(result.stage).toBe(peer.stage);
        expect(result.tree).toBe(peer.tree);
        expect(added.added).toEqual(['a.txt']);
      });
    });
  });

  describe('Given a subdirectory of untracked files in both repos', () => {
    describe('When repo.add stages the directory pathspec like git add', () => {
      it('Then every file under it is staged identically to git', async () => {
        // Arrange
        await writeBoth({ path: 'sub/one.txt', content: '1\n' });
        await writeBoth({ path: 'sub/nested/two.txt', content: '2\n' });

        // Act
        await repo.add(['sub']);
        runGit(['-C', pair.peer, 'add', 'sub']);
        const result = snapshot(pair.ours);

        // Assert
        const peer = snapshot(pair.peer);
        expect(result.stage).toBe(peer.stage);
        expect(result.tree).toBe(peer.tree);
      });
    });
  });

  describe('Given a staged file whose working copy is then edited', () => {
    describe('When repo.add re-stages it like git add', () => {
      it('Then the index advances to the new blob identically to git', async () => {
        // Arrange
        await writeBoth({ path: 'a.txt', content: 'first\n' });
        await repo.add(['a.txt']);
        runGit(['-C', pair.peer, 'add', 'a.txt']);
        await writeBoth({ path: 'a.txt', content: 'second\n' });

        // Act
        await repo.add(['a.txt']);
        runGit(['-C', pair.peer, 'add', 'a.txt']);
        const result = snapshot(pair.ours);

        // Assert
        const peer = snapshot(pair.peer);
        expect(result.stage).toBe(peer.stage);
        expect(result.tree).toBe(peer.tree);
      });
    });
  });

  describe.each([['.'], ['*.log'], ['a.log']])(
    'Given an ignored tracked file deleted from disk and pathspec %s',
    (spec) => {
      describe('When repo.add stages it like git add', () => {
        it('Then the deletion is staged identically to git', async () => {
          // Arrange
          for (const dir of [pair.ours, pair.peer]) {
            await writeFile(path.join(dir, '.gitignore'), '*.log\n');
            await writeFile(path.join(dir, 'a.log'), 'x\n');
          }
          await repo.add(['a.log']);
          runGit(['-C', pair.peer, 'add', '-f', 'a.log']);
          await repo.add(['.gitignore']);
          runGit(['-C', pair.peer, 'add', '.gitignore']);
          for (const dir of [pair.ours, pair.peer]) await rm(path.join(dir, 'a.log'));

          // Act
          const added = await repo.add([spec]);
          runGit(['-C', pair.peer, 'add', '--', spec]);
          const result = snapshot(pair.ours);

          // Assert
          const peer = snapshot(pair.peer);
          expect(added.removed).toEqual(['a.log']);
          expect(result.stage).toBe(peer.stage);
          expect(result.tree).toBe(peer.tree);
        });
      });
    },
  );

  describe('Given a tracked directory replaced by a symlink to a directory holding the same file name', () => {
    describe('When repo.add({ all }) stages it like git add -A', () => {
      it('Then the index and tree match git and keep no path beyond the link', async () => {
        // Arrange
        for (const dir of [pair.ours, pair.peer]) {
          await mkdir(path.join(dir, 'a'));
          await mkdir(path.join(dir, 'real'));
          await writeFile(path.join(dir, 'a', 'b'), 'one\n');
          await writeFile(path.join(dir, 'real', 'b'), 'two\n');
        }
        await repo.add(['.']);
        runGit(['-C', pair.peer, 'add', '.']);
        for (const dir of [pair.ours, pair.peer]) {
          await rm(path.join(dir, 'a'), { recursive: true });
          await symlink('real', path.join(dir, 'a'));
        }

        // Act
        const added = await repo.add([], { all: true });
        runGit(['-C', pair.peer, 'add', '-A']);
        const result = snapshot(pair.ours);

        // Assert
        const peer = snapshot(pair.peer);
        expect(added.removed).toEqual(['a/b']);
        expect(result.stage).toBe(peer.stage);
        expect(result.tree).toBe(peer.tree);
      });
    });
  });

  describe.each(REPLACED_ROWS)('Given a tracked directory replaced by $title', (row) => {
    describe('When repo.add stages it like git add', () => {
      it('Then the index, resolve-undo and report match canonical git', async () => {
        // Arrange
        for (const dir of [pair.ours, pair.peer]) {
          for (const file of TREE_FILES) {
            await mkdir(path.join(dir, path.dirname(file)), { recursive: true });
            await writeFile(path.join(dir, file), `${file}\n`);
          }
          runGit(['-C', dir, 'add', '-A']);
          row.prepare?.(dir);
          const replaced = path.join(dir, row.replaced ?? 'a');
          await rm(replaced, { recursive: true });
          if (row.replacement === 'symlink') await symlink('real', replaced);
          else await writeFile(replaced, 'now a file\n');
        }

        // Act
        const added = await repo.add([...row.paths]);
        runGit(['-C', pair.peer, 'add', ...row.paths.map(gitPathspec)]);
        const stage = lsStage(pair.ours);

        // Assert
        expect(added.removed).toEqual(row.removed);
        expect(added.modified).toEqual(row.modified ?? []);
        expect(stage).toBe(lsStage(pair.peer));
        if (!HAS_UNMERGED_STAGE.test(stage)) {
          expect(writeTreeOf(pair.ours)).toBe(writeTreeOf(pair.peer));
        }
        expect(await indexExtensionOf(pair.ours, 'REUC')).toEqual(
          await indexExtensionOf(pair.peer, 'REUC'),
        );
      });
    });
  });
});
