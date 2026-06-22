/**
 * Cross-tool interop — type-change (`T`) for all reachable leaf-kind pairs,
 * pure gitlink add/delete/modify patch render, and gitlink rename-detection
 * exclusion.
 *
 * Builds one shared repository with canonical git (deterministic dates, signing
 * off) containing:
 *   - a commit pair for every combination of the three leaf kinds (file /
 *     symlink / gitlink) in both directions, plus a leaf↔directory negative;
 *   - pure gitlink add, delete, and pointer-bump modify pairs;
 *   - rename/copy/break pairs exercising the gitlink exclusion.
 *
 * Opens the SAME repo through `openRepository` and proves tsgit's structured
 * `TreeDiff` is byte-faithful to live git on every surface:
 *
 *   1. `type-change` is emitted with the correct `oldMode` / `newMode` / oids.
 *   2. Reconstructed `--raw` `T` line equals live git (`git diff-tree -r --raw`).
 *   3. `--name-status` `T\t<path>` equals live git.
 *   4. Leaf↔directory NEGATIVE: blob-`x` → `x/inner`-subtree yields `D`+`A`,
 *      never `T` (pinning git's tree-entry sort-order faithfulness).
 *   5. `reconstructPatch` emits byte-faithful patch for gitlink type-changes.
 *   6. Pure gitlink add/delete/modify patches byte-match live git.
 *   7. Gitlink entries are excluded from inexact rename/copy/break detection.
 *
 * Gitlink entries are built via `update-index --cacheinfo 160000` — no real
 * submodule is needed (the oid is arbitrary 40-hex).
 *
 * @proves
 *   surface:        diff
 *   bucket:         cross-tool-interop
 *   unique:         type-change T line reconstructs git raw for all three leaf-kind pairs + directory negative + gitlink add/delete/modify patch render + gitlink rename exclusion
 *   interopSurface: diff
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { diff } from '../../src/application/commands/diff.js';
import type {
  DiffChange,
  ModifyChange,
  RenameChange,
  TreeDiff,
} from '../../src/domain/diff/index.js';
import { MAX_SCORE } from '../../src/domain/diff/index.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import { reconstructPatch } from './diff-reconstruct.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv } from './interop-helpers.js';

// Heaviest interop fixture set in the suite (15 commit-pair scenarios, ~60 git
// spawns). Under the full validate run's parallel git load the shared setup needs
// more than the 60s the lighter interop files use, so it gets the global testTimeout.
const SETUP_TIMEOUT = 120_000;
const ZERO_OID = '0'.repeat(40);

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
} as const;

const GITLINK_OID = '1'.repeat(40);
const GITLINK_OID_2 = '2'.repeat(40);

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

/** git's unified diff patch for a commit pair (no colour, no ext-diff). */
const gitDiff = (dir: string, from: string, to: string): string =>
  git(dir, 'diff', '--no-ext-diff', '--no-color', from, to);

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
let ctx: ReturnType<typeof createNodeContext>;

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

// Arm B — pure gitlink add / delete / modify
let gitlinkAdd: CommitPair;
let gitlinkDelete: CommitPair;
let gitlinkModify: CommitPair;

// Arm C — rename-detection gitlink exclusion
let r1Exact: CommitPair;
let r2DifferentOid: CommitPair;
let r3GitlinkDeleteBlobAdd: CommitPair;
let copySourceGitlink: CommitPair;
let breakGitlink: CommitPair;

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

    // 8. pure gitlink ADD (path add_sub) — absent → 160000
    // xDir HEAD already has no add_sub; use it directly as the "before" commit
    const addSubBase = git(dir, 'rev-parse', 'HEAD').trim();
    runGit(['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${GITLINK_OID},add_sub`]);
    const addSubGitlink = doCommit('add_sub gitlink added');
    gitlinkAdd = { from: addSubBase, to: addSubGitlink };

    // 9. pure gitlink DELETE (path del_sub) — 160000 → absent
    runGit(['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${GITLINK_OID},del_sub`]);
    const delSubGitlink = doCommit('del_sub gitlink present');
    git(dir, 'rm', '--cached', 'del_sub');
    const delSubBase = doCommit('del_sub gitlink removed');
    gitlinkDelete = { from: delSubGitlink, to: delSubBase };

    // 10. gitlink MODIFY / pointer bump (path bump_sub) — oid1 → oid2
    runGit(['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${GITLINK_OID},bump_sub`]);
    const bumpSubV1 = doCommit('bump_sub gitlink v1');
    runGit(['-C', dir, 'update-index', '--cacheinfo', `160000,${GITLINK_OID_2},bump_sub`]);
    const bumpSubV2 = doCommit('bump_sub gitlink v2');
    gitlinkModify = { from: bumpSubV1, to: bumpSubV2 };

    // 11. R1 — exact same-oid gitlink move (path A → B)
    runGit(['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${GITLINK_OID},r1_src`]);
    const r1From = doCommit('r1 gitlink at src');
    git(dir, 'rm', '--cached', 'r1_src');
    runGit(['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${GITLINK_OID},r1_dst`]);
    const r1To = doCommit('r1 gitlink moved to dst');
    r1Exact = { from: r1From, to: r1To };

    // 12. R2 — different-oid gitlink "move" (stays A+D)
    runGit(['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${GITLINK_OID},r2_old`]);
    const r2From = doCommit('r2 gitlink oid1 at old');
    git(dir, 'rm', '--cached', 'r2_old');
    runGit(['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${GITLINK_OID_2},r2_new`]);
    const r2To = doCommit('r2 gitlink oid2 at new');
    r2DifferentOid = { from: r2From, to: r2To };

    // 13. R3 — gitlink delete + near-similar real blob add (not cross-paired)
    runGit(['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${GITLINK_OID},r3_gone`]);
    const r3From = doCommit('r3 gitlink present');
    git(dir, 'rm', '--cached', 'r3_gone');
    await writeFile(path.join(dir, 'r3_blob'), 'line1\nline2\nline3\n');
    git(dir, 'add', 'r3_blob');
    const r3To = doCommit('r3 gitlink deleted blob added');
    r3GitlinkDeleteBlobAdd = { from: r3From, to: r3To };

    // 14. copy-source — gitlink is NOT a copy source under -C --find-copies-harder
    runGit(['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${GITLINK_OID},cs_unch`]);
    runGit(['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${GITLINK_OID},cs_mod`]);
    const csBase = doCommit('cs two gitlinks present');
    runGit(['-C', dir, 'update-index', '--cacheinfo', `160000,${GITLINK_OID_2},cs_mod`]);
    const subprojectLine = `Subproject commit ${GITLINK_OID}\n`;
    await writeFile(path.join(dir, 'cs_blob'), subprojectLine);
    git(dir, 'add', 'cs_blob');
    const csTop = doCommit('cs gitlink bumped and blob added');
    copySourceGitlink = { from: csBase, to: csTop };

    // 15. B — gitlink↔gitlink pointer bump under -B stays plain M
    runGit(['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${GITLINK_OID},bp`]);
    const bpV1 = doCommit('bp gitlink v1');
    runGit(['-C', dir, 'update-index', '--cacheinfo', `160000,${GITLINK_OID_2},bp`]);
    const bpV2 = doCommit('bp gitlink v2');
    breakGitlink = { from: bpV1, to: bpV2 };

    repo = await openRepository({ cwd: dir });
    ctx = createNodeContext({ workDir: dir });
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

      it('Then reconstructPatch emits delete+add blocks matching git diff patch bytes', async () => {
        // Arrange
        const { from, to } = fileToSymlink;
        const peer = gitDiff(dir, from, to);

        // Act
        const treeDiff = await diff(ctx, { from, to });
        const result = await reconstructPatch(ctx, treeDiff);

        // Assert
        expect(result).toBe(peer);
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

      it('Then reconstructPatch emits delete+add blocks matching git diff patch bytes', async () => {
        // Arrange
        const { from, to } = symlinkToFile;
        const peer = gitDiff(dir, from, to);

        // Act
        const treeDiff = await diff(ctx, { from, to });
        const result = await reconstructPatch(ctx, treeDiff);

        // Assert
        expect(result).toBe(peer);
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

      it('Then reconstructPatch emits delete+add blocks matching git diff patch bytes', async () => {
        // Arrange
        const { from, to } = fileToGitlink;
        const peer = gitDiff(dir, from, to);

        // Act
        const treeDiff = await diff(ctx, { from, to });
        const result = await reconstructPatch(ctx, treeDiff);

        // Assert
        expect(result).toBe(peer);
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

      it('Then reconstructPatch emits delete+add blocks matching git diff patch bytes', async () => {
        // Arrange
        const { from, to } = gitlinkToFile;
        const peer = gitDiff(dir, from, to);

        // Act
        const treeDiff = await diff(ctx, { from, to });
        const result = await reconstructPatch(ctx, treeDiff);

        // Assert
        expect(result).toBe(peer);
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

      it('Then reconstructPatch emits delete+add blocks matching git diff patch bytes', async () => {
        // Arrange
        const { from, to } = symlinkToGitlink;
        const peer = gitDiff(dir, from, to);

        // Act
        const treeDiff = await diff(ctx, { from, to });
        const result = await reconstructPatch(ctx, treeDiff);

        // Assert
        expect(result).toBe(peer);
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

      it('Then reconstructPatch emits delete+add blocks matching git diff patch bytes', async () => {
        // Arrange
        const { from, to } = gitlinkToSymlink;
        const peer = gitDiff(dir, from, to);

        // Act
        const treeDiff = await diff(ctx, { from, to });
        const result = await reconstructPatch(ctx, treeDiff);

        // Assert
        expect(result).toBe(peer);
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

  describe('Given a pure gitlink add (absent → 160000)', () => {
    describe('When diff called', () => {
      it('Then reconstructPatch emits new-file block matching git diff patch bytes', async () => {
        // Arrange
        const { from, to } = gitlinkAdd;
        const peer = gitDiff(dir, from, to);

        // Act
        const treeDiff = await diff(ctx, { from, to });
        const result = await reconstructPatch(ctx, treeDiff);

        // Assert
        expect(result).toBe(peer);
      });

      it('Then name-status A line matches git diff --name-status', async () => {
        // Arrange
        const { from, to } = gitlinkAdd;
        const peer = gitNameStatus(dir, from, to);

        // Act
        const treeDiff = await diff(ctx, { from, to });
        const result = nameStatusFrom(treeDiff);

        // Assert
        expect(result).toBe(peer);
      });

      it('Then reconstructed raw line matches git diff-tree', async () => {
        // Arrange
        const { from, to } = gitlinkAdd;
        const peer = gitRawLines(dir, from, to);

        // Act
        const treeDiff = await diff(ctx, { from, to });
        const result = treeDiff.changes.map(rawLine);

        // Assert
        expect(result).toEqual(peer);
      });
    });
  });

  describe('Given a pure gitlink delete (160000 → absent)', () => {
    describe('When diff called', () => {
      it('Then reconstructPatch emits deleted-file block matching git diff patch bytes', async () => {
        // Arrange
        const { from, to } = gitlinkDelete;
        const peer = gitDiff(dir, from, to);

        // Act
        const treeDiff = await diff(ctx, { from, to });
        const result = await reconstructPatch(ctx, treeDiff);

        // Assert
        expect(result).toBe(peer);
      });

      it('Then name-status D line matches git diff --name-status', async () => {
        // Arrange
        const { from, to } = gitlinkDelete;
        const peer = gitNameStatus(dir, from, to);

        // Act
        const treeDiff = await diff(ctx, { from, to });
        const result = nameStatusFrom(treeDiff);

        // Assert
        expect(result).toBe(peer);
      });

      it('Then reconstructed raw line matches git diff-tree', async () => {
        // Arrange
        const { from, to } = gitlinkDelete;
        const peer = gitRawLines(dir, from, to);

        // Act
        const treeDiff = await diff(ctx, { from, to });
        const result = treeDiff.changes.map(rawLine);

        // Assert
        expect(result).toEqual(peer);
      });
    });
  });

  describe('Given a gitlink pointer bump (160000 oid1 → 160000 oid2)', () => {
    describe('When diff called', () => {
      it('Then reconstructPatch emits single modify block matching git diff patch bytes', async () => {
        // Arrange
        const { from, to } = gitlinkModify;
        const peer = gitDiff(dir, from, to);

        // Act
        const treeDiff = await diff(ctx, { from, to });
        const result = await reconstructPatch(ctx, treeDiff);

        // Assert
        expect(result).toBe(peer);
      });

      it('Then name-status M line matches git diff --name-status', async () => {
        // Arrange
        const { from, to } = gitlinkModify;
        const peer = gitNameStatus(dir, from, to);

        // Act
        const treeDiff = await diff(ctx, { from, to });
        const result = nameStatusFrom(treeDiff);

        // Assert
        expect(result).toBe(peer);
      });

      it('Then reconstructed raw line matches git diff-tree', async () => {
        // Arrange
        const { from, to } = gitlinkModify;
        const peer = gitRawLines(dir, from, to);

        // Act
        const treeDiff = await diff(ctx, { from, to });
        const result = treeDiff.changes.map(rawLine);

        // Assert
        expect(result).toEqual(peer);
      });
    });
  });

  describe('Given a same-oid gitlink move (R1 — exact rename)', () => {
    describe('When diff called with detectRenames', () => {
      it('Then the move is paired as a R100 rename with score MAX_SCORE', async () => {
        // Arrange
        const { from, to } = r1Exact;

        // Act
        const sut = await diff(ctx, { from, to, detectRenames: true });

        // Assert
        expect(sut.changes).toHaveLength(1);
        const change = sut.changes[0] as RenameChange;
        expect(change.type).toBe('rename');
        expect(change.oldPath).toBe('r1_src');
        expect(change.newPath).toBe('r1_dst');
        expect(change.oldMode).toBe('160000');
        expect(change.newMode).toBe('160000');
        expect(change.similarity.score).toBe(MAX_SCORE);
      });

      it('Then reconstructPatch emits header-only rename block matching git diff -M bytes', async () => {
        // Arrange
        const { from, to } = r1Exact;
        const peer = git(dir, 'diff', '--no-ext-diff', '--no-color', '-M', from, to);

        // Act
        const treeDiff = await diff(ctx, { from, to, detectRenames: true });
        const result = await reconstructPatch(ctx, treeDiff);

        // Assert
        expect(result).toBe(peer);
      });

      it('Then name-status -M shows R100 matching git diff --name-status -M', async () => {
        // Arrange
        const { from, to } = r1Exact;
        const peer = git(dir, 'diff', '--no-ext-diff', '--name-status', '-M', from, to).trim();

        // Act
        const treeDiff = await diff(ctx, { from, to, detectRenames: true });
        const result = nameStatusFrom(treeDiff);

        // Assert
        expect(result).toBe(peer);
      });
    });
  });

  describe('Given a different-oid gitlink move (R2 — different oids)', () => {
    describe('When diff called with detectRenames at default threshold', () => {
      it('Then the gitlinks stay as separate add and delete', async () => {
        // Arrange
        const { from, to } = r2DifferentOid;

        // Act
        const sut = await diff(ctx, { from, to, detectRenames: true });

        // Assert
        const types = sut.changes.map((c) => c.type);
        expect(types).toContain('add');
        expect(types).toContain('delete');
        expect(types).not.toContain('rename');
        expect(types).not.toContain('copy');
      });

      it('Then reconstructPatch matches git diff -M bytes', async () => {
        // Arrange
        const { from, to } = r2DifferentOid;
        const peer = git(dir, 'diff', '--no-ext-diff', '--no-color', '-M', from, to);

        // Act
        const treeDiff = await diff(ctx, { from, to, detectRenames: true });
        const result = await reconstructPatch(ctx, treeDiff);

        // Assert
        expect(result).toBe(peer);
      });
    });

    describe('When diff called with detectRenames at threshold 1 (lowest)', () => {
      it('Then the gitlinks still stay as separate add and delete', async () => {
        // Arrange
        const { from, to } = r2DifferentOid;

        // Act
        const sut = await diff(ctx, {
          from,
          to,
          detectRenames: true,
          renameOptions: { threshold: 1 },
        });

        // Assert
        const types = sut.changes.map((c) => c.type);
        expect(types).toContain('add');
        expect(types).toContain('delete');
        expect(types).not.toContain('rename');
        expect(types).not.toContain('copy');
      });
    });

    describe('When diff called with copies:harder', () => {
      it('Then the gitlinks still stay as separate add and delete', async () => {
        // Arrange
        const { from, to } = r2DifferentOid;

        // Act
        const sut = await diff(ctx, {
          from,
          to,
          detectRenames: true,
          renameOptions: { copies: 'harder' },
        });

        // Assert
        const types = sut.changes.map((c) => c.type);
        expect(types).toContain('add');
        expect(types).toContain('delete');
        expect(types).not.toContain('rename');
        expect(types).not.toContain('copy');
      });
    });
  });

  describe('Given a gitlink delete and a near-similar blob add (R3)', () => {
    describe('When diff called with detectRenames', () => {
      it('Then the gitlink delete and blob add stay unpaired', async () => {
        // Arrange
        const { from, to } = r3GitlinkDeleteBlobAdd;

        // Act
        const sut = await diff(ctx, {
          from,
          to,
          detectRenames: true,
          renameOptions: { threshold: Math.floor(MAX_SCORE * 0.5) },
        });

        // Assert — both sides survive unpaired: gitlink stays a 160000 delete,
        // blob stays a 100644 add, no rename/copy
        const types = sut.changes.map((c) => c.type);
        expect(types).not.toContain('rename');
        expect(types).not.toContain('copy');
        const deleteChange = sut.changes.find((c) => c.type === 'delete');
        expect(deleteChange?.type).toBe('delete');
        if (deleteChange?.type === 'delete') {
          expect(deleteChange.oldMode).toBe('160000');
        }
        const addChange = sut.changes.find((c) => c.type === 'add');
        expect(addChange?.type).toBe('add');
        if (addChange?.type === 'add') {
          expect(addChange.newMode).toBe('100644');
        }
      });
    });
  });

  describe('Given a gitlink modify + unchanged gitlink + blob-add whose content mirrors the gitlink (copy-source)', () => {
    describe('When diff called with copies:harder', () => {
      it('Then the gitlink is NOT detected as a copy source', async () => {
        // Arrange
        const { from, to } = copySourceGitlink;

        // Act
        const sut = await diff(ctx, {
          from,
          to,
          detectRenames: true,
          renameOptions: { copies: 'harder' },
        });

        // Assert — gitlink modify stays M, blob stays pure A, no copy
        const types = sut.changes.map((c) => c.type);
        expect(types).not.toContain('copy');
        const modifyChange = sut.changes.find(
          (c): c is ModifyChange => c.type === 'modify' && c.path === 'cs_mod',
        );
        expect(modifyChange).toBeDefined();
        const addChange = sut.changes.find((c) => c.type === 'add');
        expect(addChange).toBeDefined();
      });
    });
  });

  describe('Given a gitlink↔gitlink pointer bump and forced -B (B — break rewrites)', () => {
    describe('When diff called with breakRewrites', () => {
      it('Then the gitlink modify is NOT broken into delete+add', async () => {
        // Arrange
        const { from, to } = breakGitlink;

        // Act
        const sut = await diff(ctx, {
          from,
          to,
          detectRenames: true,
          renameOptions: { breakRewrites: { score: 0, merge: 0 } },
        });

        // Assert — one ModifyChange, no synthetic delete+add
        expect(sut.changes).toHaveLength(1);
        const change = sut.changes[0] as ModifyChange;
        expect(change.type).toBe('modify');
        expect(change.oldMode).toBe('160000');
        expect(change.newMode).toBe('160000');
      });

      it('Then reconstructPatch matches git diff -B bytes', async () => {
        // Arrange
        const { from, to } = breakGitlink;
        const peer = git(dir, 'diff', '--no-ext-diff', '--no-color', '-B', from, to);

        // Act
        const treeDiff = await diff(ctx, {
          from,
          to,
          detectRenames: true,
          renameOptions: { breakRewrites: { score: 0, merge: 0 } },
        });
        const result = await reconstructPatch(ctx, treeDiff);

        // Assert
        expect(result).toBe(peer);
      });
    });
  });
});
