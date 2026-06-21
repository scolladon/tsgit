/**
 * Cross-tool interop — type-change (`T`) for all reachable leaf-kind pairs.
 *
 * Builds one shared repository with canonical git (deterministic dates, signing
 * off) containing a commit pair for every combination of the three leaf kinds
 * (file / symlink / gitlink) in both directions, plus a leaf↔directory negative
 * (blob `x` → `x/inner` subtree). Opens the SAME repo through `openRepository`
 * and proves tsgit's structured `TreeDiff` is byte-faithful to
 * `git diff-tree --raw` and `git diff --name-status` on every surface:
 *
 *   1. `type-change` is emitted with the correct `oldMode` / `newMode` / oids.
 *   2. Reconstructed `--raw` `T` line equals live git (`git diff-tree -r --raw`).
 *   3. `--name-status` `T\t<path>` equals live git.
 *   4. Leaf↔directory NEGATIVE: blob-`x` → `x/inner`-subtree yields `D`+`A`,
 *      never `T` (pinning git's tree-entry sort-order faithfulness).
 *
 * Gitlink entries are built via `update-index --cacheinfo 160000` — no real
 * submodule is needed (the oid is arbitrary 40-hex).
 *
 * @proves
 *   surface:        diff
 *   bucket:         cross-tool-interop
 *   unique:         type-change T line reconstructs git raw for all three leaf-kind pairs + directory negative
 *   interopSurface: diff
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DiffChange, TreeDiff } from '../../src/domain/diff/index.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const ZERO_OID = '0'.repeat(40);

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
} as const;

const GITLINK_OID = '1'.repeat(40);

const dateEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  ...IDENTITY,
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

/** Reconstruct git's `--raw` line for one structured change. */
const rawLine = (c: DiffChange): string => {
  switch (c.type) {
    case 'add':
      return `:000000 ${c.newMode} ${ZERO_OID} ${c.newId} A\t${c.newPath}`;
    case 'delete':
      return `:${c.oldMode} 000000 ${c.oldId} ${ZERO_OID} D\t${c.oldPath}`;
    case 'modify':
      return `:${c.oldMode} ${c.newMode} ${c.oldId} ${c.newId} M\t${c.path}`;
    case 'type-change':
      return `:${c.oldMode} ${c.newMode} ${c.oldId} ${c.newId} T\t${c.path}`;
    case 'rename':
      return `:${c.oldMode} ${c.newMode} ${c.oldId} ${c.newId} R100\t${c.oldPath}\t${c.newPath}`;
    case 'copy':
      return `:${c.oldMode} ${c.newMode} ${c.oldId} ${c.newId} C100\t${c.oldPath}\t${c.newPath}`;
  }
};

/** git's own raw lines for a commit pair (recursive -r, full oids, no rename detection). */
const gitRawLines = (dir: string, from: string, to: string): ReadonlyArray<string> =>
  git(dir, 'diff-tree', '-r', '--no-commit-id', '--abbrev=40', '--no-ext-diff', from, to)
    .split('\n')
    .filter((l) => l.length > 0);

/** git's name-status lines for a commit pair. */
const gitNameStatus = (dir: string, from: string, to: string): string =>
  git(dir, 'diff', '--no-ext-diff', '--name-status', from, to).trim();

/** Derive name-status string from a TreeDiff. */
const nameStatusFrom = (treeDiff: TreeDiff): string =>
  treeDiff.changes
    .map((c) => {
      if (c.type === 'modify') return `M\t${c.path}`;
      if (c.type === 'add') return `A\t${c.newPath}`;
      if (c.type === 'delete') return `D\t${c.oldPath}`;
      if (c.type === 'rename') return `R100\t${c.oldPath}\t${c.newPath}`;
      if (c.type === 'copy') return `C100\t${c.oldPath}\t${c.newPath}`;
      return `T\t${c.path}`;
    })
    .join('\n');

// --- Shared fixture repo state ---

let dir = '';
let repo: Awaited<ReturnType<typeof openRepository>>;

interface CommitPair {
  readonly from: string;
  readonly to: string;
}

let fileToSymlink: CommitPair;
let symlinkToFile: CommitPair;
let fileToGitlink: CommitPair;
let gitlinkToFile: CommitPair;
let symlinkToGitlink: CommitPair;
let gitlinkToSymlink: CommitPair;
let blobToDirectory: CommitPair;

describe.skipIf(!GIT_AVAILABLE)('diff type-change interop', () => {
  beforeAll(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-diff-typechange-')));
    runGit(['init', '-q', '-b', 'main', dir]);

    let epoch = 1_700_010_000;
    const nextEpoch = (): number => (epoch += 1);

    const doCommit = (message: string): string => {
      runGit(['-C', dir, 'commit', '-q', '-m', message], { env: dateEnv(nextEpoch()) });
      return git(dir, 'rev-parse', 'HEAD').trim();
    };

    // Seed commit so the repo is non-empty
    await writeFile(path.join(dir, '_seed'), 'seed\n');
    git(dir, 'add', '_seed');
    doCommit('seed');

    // 1. file → symlink  (path: fs)
    await writeFile(path.join(dir, 'fs'), 'regular content\n');
    git(dir, 'add', 'fs');
    const fsFile = doCommit('fs: regular file');
    git(dir, 'rm', '-q', '--cached', 'fs');
    await rm(path.join(dir, 'fs'));
    await symlink('target', path.join(dir, 'fs'));
    git(dir, 'add', 'fs');
    const fsSymlink = doCommit('fs: symlink');
    fileToSymlink = { from: fsFile, to: fsSymlink };

    // 2. symlink → file  (path: sf)
    await symlink('target', path.join(dir, 'sf'));
    git(dir, 'add', 'sf');
    const sfSymlink = doCommit('sf: symlink');
    git(dir, 'rm', '-q', '--cached', 'sf');
    await rm(path.join(dir, 'sf'));
    await writeFile(path.join(dir, 'sf'), 'regular content\n');
    git(dir, 'add', 'sf');
    const sfFile = doCommit('sf: regular file');
    symlinkToFile = { from: sfSymlink, to: sfFile };

    // 3. file → gitlink  (path: fg)
    await writeFile(path.join(dir, 'fg'), 'regular content\n');
    git(dir, 'add', 'fg');
    const fgFile = doCommit('fg: regular file');
    git(dir, 'rm', '-q', '--cached', 'fg');
    await rm(path.join(dir, 'fg'));
    runGit(['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${GITLINK_OID},fg`]);
    const fgGitlink = doCommit('fg: gitlink');
    fileToGitlink = { from: fgFile, to: fgGitlink };

    // 4. gitlink → file  (path: gf)
    runGit(['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${GITLINK_OID},gf`]);
    const gfGitlink = doCommit('gf: gitlink');
    git(dir, 'rm', '-q', '--cached', 'gf');
    await writeFile(path.join(dir, 'gf'), 'regular content\n');
    git(dir, 'add', 'gf');
    const gfFile = doCommit('gf: regular file');
    gitlinkToFile = { from: gfGitlink, to: gfFile };

    // 5. symlink → gitlink  (path: sg)
    await symlink('target', path.join(dir, 'sg'));
    git(dir, 'add', 'sg');
    const sgSymlink = doCommit('sg: symlink');
    git(dir, 'rm', '-q', '--cached', 'sg');
    await rm(path.join(dir, 'sg'));
    runGit(['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${GITLINK_OID},sg`]);
    const sgGitlink = doCommit('sg: gitlink');
    symlinkToGitlink = { from: sgSymlink, to: sgGitlink };

    // 6. gitlink → symlink  (path: gs)
    runGit(['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${GITLINK_OID},gs`]);
    const gsGitlink = doCommit('gs: gitlink');
    git(dir, 'rm', '-q', '--cached', 'gs');
    await symlink('target', path.join(dir, 'gs'));
    git(dir, 'add', 'gs');
    const gsSymlink = doCommit('gs: symlink');
    gitlinkToSymlink = { from: gsGitlink, to: gsSymlink };

    // 7. blob x → x/inner subtree  (NEGATIVE: D + A, never T)
    await writeFile(path.join(dir, 'x'), 'blob content\n');
    git(dir, 'add', 'x');
    const xBlob = doCommit('x: blob');
    git(dir, 'rm', '-q', 'x');
    await mkdir(path.join(dir, 'x'));
    await writeFile(path.join(dir, 'x', 'inner'), 'nested\n');
    git(dir, 'add', path.join('x', 'inner'));
    const xDir = doCommit('x: directory with inner');
    blobToDirectory = { from: xBlob, to: xDir };

    repo = await openRepository({ cwd: dir });
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await repo.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  describe('Given file → symlink (100644 → 120000)', () => {
    describe('When diff called', () => {
      it('Then emits type-change with correct modes and oids', async () => {
        // Arrange
        const { from, to } = fileToSymlink;

        // Act
        const result = await repo.diff({ from, to });

        // Assert
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change?.type).toBe('type-change');
        if (change?.type !== 'type-change') return;
        expect(change.path).toBe('fs');
        expect(change.oldMode).toBe('100644');
        expect(change.newMode).toBe('120000');
        expect(change.oldId).toHaveLength(40);
        expect(change.newId).toHaveLength(40);
      });

      it('Then reconstructed raw line matches git diff-tree', async () => {
        // Arrange
        const { from, to } = fileToSymlink;
        const peer = gitRawLines(dir, from, to);

        // Act
        const result = await repo.diff({ from, to });
        const ours = result.changes.map(rawLine);

        // Assert
        expect(ours).toEqual(peer);
      });

      it('Then name-status T line matches git diff --name-status', async () => {
        // Arrange
        const { from, to } = fileToSymlink;
        const peer = gitNameStatus(dir, from, to);

        // Act
        const result = await repo.diff({ from, to });
        const ours = nameStatusFrom(result);

        // Assert
        expect(ours).toBe(peer);
      });
    });
  });

  describe('Given symlink → file (120000 → 100644)', () => {
    describe('When diff called', () => {
      it('Then emits type-change with correct modes and oids', async () => {
        // Arrange
        const { from, to } = symlinkToFile;

        // Act
        const result = await repo.diff({ from, to });

        // Assert
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change?.type).toBe('type-change');
        if (change?.type !== 'type-change') return;
        expect(change.path).toBe('sf');
        expect(change.oldMode).toBe('120000');
        expect(change.newMode).toBe('100644');
      });

      it('Then reconstructed raw line matches git diff-tree', async () => {
        // Arrange
        const { from, to } = symlinkToFile;
        const peer = gitRawLines(dir, from, to);

        // Act
        const result = await repo.diff({ from, to });
        const ours = result.changes.map(rawLine);

        // Assert
        expect(ours).toEqual(peer);
      });

      it('Then name-status T line matches git diff --name-status', async () => {
        // Arrange
        const { from, to } = symlinkToFile;
        const peer = gitNameStatus(dir, from, to);

        // Act
        const result = await repo.diff({ from, to });
        const ours = nameStatusFrom(result);

        // Assert
        expect(ours).toBe(peer);
      });
    });
  });

  describe('Given file → gitlink (100644 → 160000)', () => {
    describe('When diff called', () => {
      it('Then emits type-change with correct modes and oids', async () => {
        // Arrange
        const { from, to } = fileToGitlink;

        // Act
        const result = await repo.diff({ from, to });

        // Assert
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change?.type).toBe('type-change');
        if (change?.type !== 'type-change') return;
        expect(change.path).toBe('fg');
        expect(change.oldMode).toBe('100644');
        expect(change.newMode).toBe('160000');
        expect(change.newId).toBe(GITLINK_OID as ObjectId);
      });

      it('Then reconstructed raw line matches git diff-tree', async () => {
        // Arrange
        const { from, to } = fileToGitlink;
        const peer = gitRawLines(dir, from, to);

        // Act
        const result = await repo.diff({ from, to });
        const ours = result.changes.map(rawLine);

        // Assert
        expect(ours).toEqual(peer);
      });

      it('Then name-status T line matches git diff --name-status', async () => {
        // Arrange
        const { from, to } = fileToGitlink;
        const peer = gitNameStatus(dir, from, to);

        // Act
        const result = await repo.diff({ from, to });
        const ours = nameStatusFrom(result);

        // Assert
        expect(ours).toBe(peer);
      });
    });
  });

  describe('Given gitlink → file (160000 → 100644)', () => {
    describe('When diff called', () => {
      it('Then emits type-change with correct modes and oids', async () => {
        // Arrange
        const { from, to } = gitlinkToFile;

        // Act
        const result = await repo.diff({ from, to });

        // Assert
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change?.type).toBe('type-change');
        if (change?.type !== 'type-change') return;
        expect(change.path).toBe('gf');
        expect(change.oldMode).toBe('160000');
        expect(change.newMode).toBe('100644');
        expect(change.oldId).toBe(GITLINK_OID as ObjectId);
      });

      it('Then reconstructed raw line matches git diff-tree', async () => {
        // Arrange
        const { from, to } = gitlinkToFile;
        const peer = gitRawLines(dir, from, to);

        // Act
        const result = await repo.diff({ from, to });
        const ours = result.changes.map(rawLine);

        // Assert
        expect(ours).toEqual(peer);
      });

      it('Then name-status T line matches git diff --name-status', async () => {
        // Arrange
        const { from, to } = gitlinkToFile;
        const peer = gitNameStatus(dir, from, to);

        // Act
        const result = await repo.diff({ from, to });
        const ours = nameStatusFrom(result);

        // Assert
        expect(ours).toBe(peer);
      });
    });
  });

  describe('Given symlink → gitlink (120000 → 160000)', () => {
    describe('When diff called', () => {
      it('Then emits type-change with correct modes and oids', async () => {
        // Arrange
        const { from, to } = symlinkToGitlink;

        // Act
        const result = await repo.diff({ from, to });

        // Assert
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change?.type).toBe('type-change');
        if (change?.type !== 'type-change') return;
        expect(change.path).toBe('sg');
        expect(change.oldMode).toBe('120000');
        expect(change.newMode).toBe('160000');
        expect(change.newId).toBe(GITLINK_OID as ObjectId);
      });

      it('Then reconstructed raw line matches git diff-tree', async () => {
        // Arrange
        const { from, to } = symlinkToGitlink;
        const peer = gitRawLines(dir, from, to);

        // Act
        const result = await repo.diff({ from, to });
        const ours = result.changes.map(rawLine);

        // Assert
        expect(ours).toEqual(peer);
      });

      it('Then name-status T line matches git diff --name-status', async () => {
        // Arrange
        const { from, to } = symlinkToGitlink;
        const peer = gitNameStatus(dir, from, to);

        // Act
        const result = await repo.diff({ from, to });
        const ours = nameStatusFrom(result);

        // Assert
        expect(ours).toBe(peer);
      });
    });
  });

  describe('Given gitlink → symlink (160000 → 120000)', () => {
    describe('When diff called', () => {
      it('Then emits type-change with correct modes and oids', async () => {
        // Arrange
        const { from, to } = gitlinkToSymlink;

        // Act
        const result = await repo.diff({ from, to });

        // Assert
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change?.type).toBe('type-change');
        if (change?.type !== 'type-change') return;
        expect(change.path).toBe('gs');
        expect(change.oldMode).toBe('160000');
        expect(change.newMode).toBe('120000');
        expect(change.oldId).toBe(GITLINK_OID as ObjectId);
      });

      it('Then reconstructed raw line matches git diff-tree', async () => {
        // Arrange
        const { from, to } = gitlinkToSymlink;
        const peer = gitRawLines(dir, from, to);

        // Act
        const result = await repo.diff({ from, to });
        const ours = result.changes.map(rawLine);

        // Assert
        expect(ours).toEqual(peer);
      });

      it('Then name-status T line matches git diff --name-status', async () => {
        // Arrange
        const { from, to } = gitlinkToSymlink;
        const peer = gitNameStatus(dir, from, to);

        // Act
        const result = await repo.diff({ from, to });
        const ours = nameStatusFrom(result);

        // Assert
        expect(ours).toBe(peer);
      });
    });
  });

  describe('Given blob x replaced by x/inner subtree (leaf↔directory NEGATIVE)', () => {
    describe('When diff called', () => {
      it('Then emits delete + add (never type-change) and raw lines match git', async () => {
        // Arrange — git sorts blob `x` and dir `x/` as distinct tree keys because
        // directory entries are compared with a virtual trailing slash, so they
        // never reach classifySamePath and pair as D + A instead of T.
        const { from, to } = blobToDirectory;
        const peer = gitRawLines(dir, from, to);

        // Act — recursive so tsgit expands `x/` into `x/inner`, matching git -r
        const result = await repo.diff({ from, to, recursive: true });

        // Assert — no type-change; must be a delete + add pair
        const types = result.changes.map((c) => c.type);
        expect(types).not.toContain('type-change');
        expect(types).toContain('delete');
        expect(types).toContain('add');
        // Raw-line reconstruction must still match git byte-for-byte
        expect(result.changes.map(rawLine)).toEqual(peer);
      });
    });
  });
});
