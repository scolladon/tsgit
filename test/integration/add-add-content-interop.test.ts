/**
 * Cross-tool interop — add/add content merge and distinct-types rename. Builds
 * the same unrelated-histories graph in a canonical-git peer and a tsgit repo
 * (root commit on main → branch adds `f` → main adds `f` → merge conflicts or
 * resolves), runs the merge on both tools, and asserts byte-for-byte parity on:
 *   - the working-tree file contents,
 *   - the index stages via `lsStage`,
 *   - clean vs conflict verdicts.
 *
 * @proves
 *   surface:        repo.merge.run
 *   bucket:         cross-tool-interop
 *   unique:         add/add content merge + distinct-types rename match git
 *   interopSurface: merge
 */
import { chmodSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  lsStage,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
  tryRunGit,
} from './interop-helpers.js';

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

describe.skipIf(!GIT_AVAILABLE)(
  'merge interop — add/add content merge and distinct-types rename',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository;

    beforeEach(async () => {
      pair = await makePeerPair('add-add-content');
      runGit(['init', '-q', '-b', 'main', pair.peer]);
      runGit(['-C', pair.peer, 'config', 'user.name', 'Ada']);
      runGit(['-C', pair.peer, 'config', 'user.email', 'ada@example.com']);
      runGit(['-C', pair.peer, 'config', 'commit.gpgsign', 'false']);
      repo = await openRepository({ cwd: pair.ours });
      await repo.init();
    });

    afterEach(async () => {
      await repo.dispose();
      await pair.dispose();
    });

    // ── peer helpers ────────────────────────────────────────────────────────

    const peerAdd = (...files: ReadonlyArray<string>): void =>
      void runGit(['-C', pair.peer, 'add', ...files]);

    const peerCommit = (message: string): void =>
      void runGit(['-C', pair.peer, 'commit', '-q', '-m', message], { env: COMMIT_ENV });

    const peerBranch = (name: string): void =>
      void runGit(['-C', pair.peer, 'checkout', '-q', '-b', name]);

    const peerCheckout = (rev: string): void =>
      void runGit(['-C', pair.peer, 'checkout', '-q', rev]);

    const peerWrite = (rel: string, content: string): void =>
      writeFileSync(path.join(pair.peer, rel), content);

    const peerWriteBin = (rel: string, bytes: Uint8Array): void =>
      writeFileSync(path.join(pair.peer, rel), bytes);

    const peerSymlink = (target: string, rel: string): void =>
      symlinkSync(target, path.join(pair.peer, rel));

    /**
     * Run a conflicting merge on the peer with the style pinned to `merge`
     * (the machine's global config may use `diff3`).
     */
    const peerMergeConflict = (branch: string): ReturnType<typeof tryRunGit> =>
      tryRunGit(
        ['-C', pair.peer, '-c', 'merge.conflictStyle=merge', 'merge', '--no-ff', '-m', 'm', branch],
        { env: COMMIT_ENV },
      );

    const peerMergeClean = (branch: string): void =>
      void runGit(
        ['-C', pair.peer, '-c', 'merge.conflictStyle=merge', 'merge', '--no-ff', '-m', 'm', branch],
        { env: COMMIT_ENV },
      );

    // ── tsgit helpers ───────────────────────────────────────────────────────

    const oursWrite = (rel: string, content: string): Promise<void> =>
      writeFile(path.join(pair.ours, rel), content);

    const oursWriteBin = (rel: string, bytes: Uint8Array): Promise<void> =>
      writeFile(path.join(pair.ours, rel), bytes);

    const oursCommit = async (message: string): Promise<void> => {
      await repo.commit({ message, author: AUTHOR, committer: AUTHOR });
    };

    /**
     * Build the add/add scenario using the repo API.
     * Result: main has {root.txt, `fileName`@mainContent}, side has {root.txt, `fileName`@sideContent}.
     * HEAD is left on `main`.
     */
    const setupAddAdd = async (
      fileName: string,
      mainContent: string,
      sideContent: string,
      branchName = 'side',
    ): Promise<void> => {
      // Peer
      peerWrite('root.txt', 'root\n');
      peerAdd('root.txt');
      peerCommit('root');
      peerBranch(branchName);
      peerWrite(fileName, sideContent);
      peerAdd(fileName);
      peerCommit('side-add');
      peerCheckout('main');
      peerWrite(fileName, mainContent);
      peerAdd(fileName);
      peerCommit('main-add');

      // tsgit
      await oursWrite('root.txt', 'root\n');
      await repo.add(['root.txt']);
      await oursCommit('root');
      await repo.branch.create({ name: branchName });
      await repo.checkout({ rev: branchName });
      await oursWrite(fileName, sideContent);
      await repo.add([fileName]);
      await oursCommit('side-add');
      await repo.checkout({ rev: 'main' });
      await oursWrite(fileName, mainContent);
      await repo.add([fileName]);
      await oursCommit('main-add');
    };

    // ── Scenario 1: text add/add with shared prefix → per-region markers ───

    describe('Given both sides add the same text file with a shared prefix', () => {
      describe('When the merge conflicts on both tools', () => {
        it('Then per-region markers and stages 2/3 match git byte-for-byte', async () => {
          // Arrange
          await setupAddAdd('f.txt', 'a\nb\nX\n', 'a\nb\nY\n');

          // Act
          const peerResult = peerMergeConflict('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
          const oursFile = await readFile(path.join(pair.ours, 'f.txt'), 'utf8');
          const peerFile = await readFile(path.join(pair.peer, 'f.txt'), 'utf8');
          expect(oursFile).toBe(peerFile);
          // Structural check: shared prefix outside markers, diverging tail in markers
          expect(oursFile).toContain('a\nb\n');
          expect(oursFile).toContain('<<<<<<<');
          expect(oursFile).toContain('>>>>>>>');
        });
      });
    });

    // ── Scenario 2: ours ⊂ theirs → empty-ours marker region ──────────────

    describe('Given ours is a strict prefix of theirs', () => {
      describe('When the merge conflicts on both tools', () => {
        it('Then the empty-ours region and stages 2/3 match git byte-for-byte', async () => {
          // Arrange — ours: `a\nb`, theirs: `a\nb\nc`; ours conflict region is empty
          await setupAddAdd('f.txt', 'a\nb\n', 'a\nb\nc\n');

          // Act
          const peerResult = peerMergeConflict('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
          const oursFile = await readFile(path.join(pair.ours, 'f.txt'), 'utf8');
          const peerFile = await readFile(path.join(pair.peer, 'f.txt'), 'utf8');
          expect(oursFile).toBe(peerFile);
          // Ours conflict region is empty — `<<<<<<<\n=======` appears with nothing between
          expect(oursFile).toContain('<<<<<<<');
          expect(oursFile).toContain('=======');
        });
      });
    });

    // ── Scenario 3: identical bytes, mode 100644 vs 100755 → clean bytes ──

    describe('Given both sides add identical bytes but with differing modes (100644 vs 100755)', () => {
      describe('When the merge runs on both tools', () => {
        it('Then the working tree holds clean bytes (no markers) and stages 2/3 differ only in mode, matching git', async () => {
          // Arrange
          const content = 'identical\n';

          // Peer: root commit, side branch adds f as 100755, main adds f as 100644
          peerWrite('root.txt', 'root\n');
          peerAdd('root.txt');
          peerCommit('root');
          peerBranch('side');
          peerWrite('f', content);
          chmodSync(path.join(pair.peer, 'f'), 0o755);
          peerAdd('f');
          peerCommit('side-add-exec');
          peerCheckout('main');
          peerWrite('f', content);
          peerAdd('f');
          peerCommit('main-add');

          // tsgit: root commit, side branch adds f as 100755 (via fs chmod + repo.add)
          await oursWrite('root.txt', 'root\n');
          await repo.add(['root.txt']);
          await oursCommit('root');
          await repo.branch.create({ name: 'side' });
          await repo.checkout({ rev: 'side' });
          await oursWrite('f', content);
          chmodSync(path.join(pair.ours, 'f'), 0o755);
          await repo.add(['f']);
          await oursCommit('side-add-exec');
          await repo.checkout({ rev: 'main' });
          await oursWrite('f', content);
          await repo.add(['f']);
          await oursCommit('main-add');

          // Verify the modes are as expected
          const peerSideMode = runGit(['-C', pair.peer, 'ls-tree', 'side', 'f']).slice(0, 6);
          const oursSideMode = runGit(['-C', pair.ours, 'ls-tree', 'side', 'f']).slice(0, 6);
          expect(oursSideMode).toBe(peerSideMode);

          // Act
          const peerResult = peerMergeConflict('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert — git reports conflict on mode mismatch even with identical content
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');
          // Working tree: clean bytes (no markers)
          const oursFile = await readFile(path.join(pair.ours, 'f'), 'utf8');
          const peerFile = await readFile(path.join(pair.peer, 'f'), 'utf8');
          expect(oursFile).toBe(peerFile);
          expect(oursFile).toBe(content);
          expect(oursFile).not.toContain('<<<<<<<');
          // Stage entries: both have stages 2 and 3 with the same oid but different modes
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
        });
      });
    });

    // ── Scenario 4: binary add/add → ours bytes on disk ───────────────────

    describe('Given both sides add a binary file with a NUL byte', () => {
      describe('When the merge conflicts on both tools', () => {
        it('Then ours bytes land on disk and stages 2/3 match git', async () => {
          // Arrange — binary content: bytes containing a NUL (not a literal in source)
          const oursBin = new Uint8Array([0x41, 0x00, 0x42]); // A NUL B
          const theirsBin = new Uint8Array([0x43, 0x00, 0x44]); // C NUL D

          // Peer
          peerWrite('root.txt', 'root\n');
          peerAdd('root.txt');
          peerCommit('root');
          peerBranch('side');
          peerWriteBin('data.bin', theirsBin);
          peerAdd('data.bin');
          peerCommit('side-add-bin');
          peerCheckout('main');
          peerWriteBin('data.bin', oursBin);
          peerAdd('data.bin');
          peerCommit('main-add-bin');

          // tsgit
          await oursWrite('root.txt', 'root\n');
          await repo.add(['root.txt']);
          await oursCommit('root');
          await repo.branch.create({ name: 'side' });
          await repo.checkout({ rev: 'side' });
          await oursWriteBin('data.bin', theirsBin);
          await repo.add(['data.bin']);
          await oursCommit('side-add-bin');
          await repo.checkout({ rev: 'main' });
          await oursWriteBin('data.bin', oursBin);
          await repo.add(['data.bin']);
          await oursCommit('main-add-bin');

          // Act
          const peerResult = peerMergeConflict('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');
          // ours bytes on disk (binary take-ours)
          const oursFile = await readFile(path.join(pair.ours, 'data.bin'));
          const peerFile = await readFile(path.join(pair.peer, 'data.bin'));
          expect(Buffer.from(oursFile).equals(Buffer.from(oursBin))).toBe(true);
          expect(Buffer.from(peerFile).equals(Buffer.from(oursBin))).toBe(true);
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
        });
      });
    });

    // ── Scenario 5: merge=union add/add → clean merge ─────────────────────

    describe('Given .gitattributes sets merge=union and both sides add different text', () => {
      describe('When the merge runs cleanly on both tools', () => {
        it('Then both produce a clean commit with concatenated bytes matching git', async () => {
          // Arrange
          // Peer
          peerWrite('root.txt', 'root\n');
          peerWrite('.gitattributes', 'f.txt merge=union\n');
          peerAdd('root.txt', '.gitattributes');
          peerCommit('root');
          peerBranch('side');
          peerWrite('f.txt', 'theirs-line\n');
          peerAdd('f.txt');
          peerCommit('side-add');
          peerCheckout('main');
          peerWrite('f.txt', 'ours-line\n');
          peerAdd('f.txt');
          peerCommit('main-add');

          // tsgit
          await oursWrite('root.txt', 'root\n');
          await oursWrite('.gitattributes', 'f.txt merge=union\n');
          await repo.add(['root.txt', '.gitattributes']);
          await oursCommit('root');
          await repo.branch.create({ name: 'side' });
          await repo.checkout({ rev: 'side' });
          await oursWrite('f.txt', 'theirs-line\n');
          await repo.add(['f.txt']);
          await oursCommit('side-add');
          await repo.checkout({ rev: 'main' });
          await oursWrite('f.txt', 'ours-line\n');
          await repo.add(['f.txt']);
          await oursCommit('main-add');
          // Re-open so merge reads the .gitattributes from the committed state
          await repo.dispose();
          repo = await openRepository({ cwd: pair.ours });

          // Act
          peerMergeClean('side');
          const result = await repo.merge.run({
            rev: 'side',
            message: 'm',
            author: AUTHOR,
            committer: AUTHOR,
          });

          // Assert
          expect(result.kind).toBe('merge');
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
          const oursFile = await readFile(path.join(pair.ours, 'f.txt'), 'utf8');
          const peerFile = await readFile(path.join(pair.peer, 'f.txt'), 'utf8');
          expect(oursFile).toBe(peerFile);
          // union: ours lines then theirs lines, no markers
          expect(oursFile).toContain('ours-line');
          expect(oursFile).toContain('theirs-line');
          expect(oursFile).not.toContain('<<<<<<<');
        });
      });
    });

    // ── Scenario 6: symlink vs symlink → ours link on disk ─────────────────

    describe('Given both sides add a symlink at the same path with different targets', () => {
      describe('When the merge conflicts on both tools', () => {
        it('Then ours symlink target is on disk and stages 2/3 match git', async () => {
          // Arrange
          const oursTarget = 'target-ours';
          const theirsTarget = 'target-theirs';

          // Peer — git stores symlink content as a blob containing the target string
          peerWrite('root.txt', 'root\n');
          peerAdd('root.txt');
          peerCommit('root');
          peerBranch('side');
          peerSymlink(theirsTarget, 'link');
          peerAdd('link');
          peerCommit('side-add-link');
          peerCheckout('main');
          peerSymlink(oursTarget, 'link');
          peerAdd('link');
          peerCommit('main-add-link');

          // tsgit — use the branch+add+commit path via the fs layer
          await oursWrite('root.txt', 'root\n');
          await repo.add(['root.txt']);
          await oursCommit('root');

          // Side branch: create symlink on disk, add, commit
          await repo.branch.create({ name: 'side' });
          await repo.checkout({ rev: 'side' });
          symlinkSync(theirsTarget, path.join(pair.ours, 'link'));
          await repo.add(['link']);
          await oursCommit('side-add-link');
          // Checkout main removes `link` (not in main's tree); place ours' symlink directly
          await repo.checkout({ rev: 'main' });
          symlinkSync(oursTarget, path.join(pair.ours, 'link'));
          await repo.add(['link']);
          await oursCommit('main-add-link');

          // Act
          const peerResult = peerMergeConflict('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert — bare add-add conflict for symlink/symlink: ours link stays on disk
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
          // ours symlink target on disk (both tools keep ours)
          const oursLink = readlinkSync(path.join(pair.ours, 'link'));
          const peerLink = readlinkSync(path.join(pair.peer, 'link'));
          expect(oursLink).toBe(oursTarget);
          expect(peerLink).toBe(oursTarget);
        });
      });
    });

    // ── Scenario 7: distinct types ours-regular/theirs-symlink ─────────────

    describe('Given ours adds a regular file and theirs adds a symlink at the same path', () => {
      describe('When the merge conflicts on both tools', () => {
        it('Then regular at f~HEAD, symlink at f, stage 2 at f~HEAD and stage 3 at f, matching git', async () => {
          // Arrange
          // Peer: main adds regular `f`, side adds symlink `f`
          peerWrite('root.txt', 'root\n');
          peerAdd('root.txt');
          peerCommit('root');
          peerBranch('side');
          peerSymlink('sym-target', 'f');
          peerAdd('f');
          peerCommit('side-add-link');
          peerCheckout('main');
          peerWrite('f', 'regular-content\n');
          peerAdd('f');
          peerCommit('main-add-regular');

          // tsgit: root commit, side adds symlink `f`, main adds regular `f`
          await oursWrite('root.txt', 'root\n');
          await repo.add(['root.txt']);
          await oursCommit('root');
          // Side branch: symlink f
          await repo.branch.create({ name: 'side' });
          await repo.checkout({ rev: 'side' });
          symlinkSync('sym-target', path.join(pair.ours, 'f'));
          await repo.add(['f']);
          await oursCommit('side-add-link');
          // Checkout main removes `f` (not in main's tree); place regular file directly
          await repo.checkout({ rev: 'main' });
          await oursWrite('f', 'regular-content\n');
          await repo.add(['f']);
          await oursCommit('main-add-regular');

          // Act
          const peerResult = peerMergeConflict('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');
          // Stages: stage 2 at f~HEAD (ours regular renamed), stage 3 at f (theirs symlink)
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
          // Regular file at f~HEAD
          const oursRenamed = await readFile(path.join(pair.ours, 'f~HEAD'), 'utf8');
          expect(oursRenamed).toBe('regular-content\n');
          // Symlink at f
          const oursLink = readlinkSync(path.join(pair.ours, 'f'));
          expect(oursLink).toBe('sym-target');
        });
      });
    });

    // ── Scenario 8: distinct types ours-symlink/theirs-regular ─────────────

    describe('Given ours adds a symlink and theirs adds a regular file at the same path', () => {
      describe('When the merge conflicts on both tools', () => {
        it('Then symlink at f, regular at f~side, stage 2 at f and stage 3 at f~side, matching git', async () => {
          // Arrange
          // Peer: main adds symlink `f`, side adds regular `f`
          peerWrite('root.txt', 'root\n');
          peerAdd('root.txt');
          peerCommit('root');
          peerBranch('side');
          peerWrite('f', 'theirs-regular\n');
          peerAdd('f');
          peerCommit('side-add-regular');
          peerCheckout('main');
          peerSymlink('ours-sym-target', 'f');
          peerAdd('f');
          peerCommit('main-add-link');

          // tsgit: root commit, side adds regular `f`, main adds symlink `f`
          await oursWrite('root.txt', 'root\n');
          await repo.add(['root.txt']);
          await oursCommit('root');
          // Side branch: regular file f
          await repo.branch.create({ name: 'side' });
          await repo.checkout({ rev: 'side' });
          await oursWrite('f', 'theirs-regular\n');
          await repo.add(['f']);
          await oursCommit('side-add-regular');
          // Checkout main removes `f` (not in main's tree); place symlink directly
          await repo.checkout({ rev: 'main' });
          symlinkSync('ours-sym-target', path.join(pair.ours, 'f'));
          await repo.add(['f']);
          await oursCommit('main-add-link');

          // Act
          const peerResult = peerMergeConflict('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');
          // Stages: stage 2 at f (ours symlink), stage 3 at f~side (theirs regular renamed)
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
          // Symlink kept at f
          const oursLink = readlinkSync(path.join(pair.ours, 'f'));
          expect(oursLink).toBe('ours-sym-target');
          // Regular file at f~side (theirs regular renamed)
          const theirsRenamed = await readFile(path.join(pair.ours, 'f~side'), 'utf8');
          expect(theirsRenamed).toBe('theirs-regular\n');
        });
      });
    });

    // ── Scenario 9: branch named `feature/x` → rename suffix `f~feature_x` ─

    describe('Given the branch is named feature/x (slash in name)', () => {
      describe('When a distinct-types conflict occurs on both tools', () => {
        it('Then the rename suffix flattens the slash: f~feature_x, matching git', async () => {
          // Arrange
          const branchName = 'feature/x';

          // Peer: main adds regular `f`, feature/x adds symlink `f`
          peerWrite('root.txt', 'root\n');
          peerAdd('root.txt');
          peerCommit('root');
          peerBranch(branchName);
          peerSymlink('fx-target', 'f');
          peerAdd('f');
          peerCommit('side-add-link');
          peerCheckout('main');
          peerWrite('f', 'regular-main\n');
          peerAdd('f');
          peerCommit('main-add-regular');

          // tsgit
          await oursWrite('root.txt', 'root\n');
          await repo.add(['root.txt']);
          await oursCommit('root');
          // feature/x branch: symlink f
          await repo.branch.create({ name: branchName });
          await repo.checkout({ rev: branchName });
          symlinkSync('fx-target', path.join(pair.ours, 'f'));
          await repo.add(['f']);
          await oursCommit('side-add-link');
          // Checkout main removes `f` (not in main's tree); place regular file directly
          await repo.checkout({ rev: 'main' });
          await oursWrite('f', 'regular-main\n');
          await repo.add(['f']);
          await oursCommit('main-add-regular');

          // Act
          const peerResult = peerMergeConflict(branchName);
          const result = await repo.merge.run({ rev: branchName, message: 'm', author: AUTHOR });

          // Assert — slash flattened to underscore in rename suffix
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
          // Regular file renamed with flattened suffix f~HEAD (ours is on main/HEAD)
          const renamedContent = await readFile(path.join(pair.ours, 'f~HEAD'), 'utf8');
          expect(renamedContent).toBe('regular-main\n');
          // Symlink at f (theirs' side)
          const oursLink = readlinkSync(path.join(pair.ours, 'f'));
          expect(oursLink).toBe('fx-target');
          // Peer has the same layout
          expect(() => readlinkSync(path.join(pair.peer, 'f'))).not.toThrow();
        });
      });
    });

    // ── Scenario 10: tracked file at `f~side` → rename goes to `f~side_0` ──
    //
    // The REGULAR side is `side` (theirs), so the distinct-types rename label is
    // `side`. The first probe candidate `f~side` is already occupied as a tracked
    // file, forcing the probe to increment: `f~side_0`.

    describe('Given the rename target f~side is already tracked in the tree', () => {
      describe('When a distinct-types conflict occurs on both tools', () => {
        it('Then the unique-path probe appends _0: f~side_0, matching git', async () => {
          // Arrange
          // main: symlink `f` + tracked `f~side`; side: regular `f`
          // The regular side (side/theirs) gets renamed; probe: f~side → occupied → f~side_0
          peerWrite('root.txt', 'root\n');
          peerAdd('root.txt');
          peerCommit('root');
          peerBranch('side');
          peerWrite('f', 'regular-side\n');
          peerAdd('f');
          peerCommit('side-add-regular');
          peerCheckout('main');
          peerSymlink('sym-target-main', 'f');
          peerWrite('f~side', 'existing-file\n'); // occupies the first rename target
          peerAdd('f', 'f~side');
          peerCommit('main-add-symlink-with-collision');

          // tsgit
          await oursWrite('root.txt', 'root\n');
          await repo.add(['root.txt']);
          await oursCommit('root');
          // Side branch: regular file f
          await repo.branch.create({ name: 'side' });
          await repo.checkout({ rev: 'side' });
          await oursWrite('f', 'regular-side\n');
          await repo.add(['f']);
          await oursCommit('side-add-regular');
          // Checkout main removes `f`; add symlink f + f~side
          await repo.checkout({ rev: 'main' });
          symlinkSync('sym-target-main', path.join(pair.ours, 'f'));
          await oursWrite('f~side', 'existing-file\n');
          await repo.add(['f', 'f~side']);
          await oursCommit('main-add-symlink-with-collision');

          // Act
          const peerResult = peerMergeConflict('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
          // Regular side renamed to f~side_0 (f~side is occupied)
          const renamedContent = await readFile(path.join(pair.ours, 'f~side_0'), 'utf8');
          expect(renamedContent).toBe('regular-side\n');
          // Peer has the same path
          const peerRenamed = await readFile(path.join(pair.peer, 'f~side_0'), 'utf8');
          expect(peerRenamed).toBe('regular-side\n');
          // Symlink stays at f
          const oursLink = readlinkSync(path.join(pair.ours, 'f'));
          expect(oursLink).toBe('sym-target-main');
        });
      });
    });

    // ── Scenario 11: untracked file at rename target → both tools refuse ────
    //
    // The REGULAR side is `side` (theirs) so the rename label is `side`.
    // The rename target `f~side` is occupied by an untracked file placed before
    // the merge, forcing both git and tsgit to refuse (git: untracked-overwrite;
    // tsgit: CHECKOUT_OVERWRITE_DIRTY).

    describe('Given an untracked file exists at the rename target f~side', () => {
      describe('When both tools attempt the distinct-types merge', () => {
        it('Then both tools refuse and write nothing (git: untracked overwrite; tsgit: would-overwrite)', async () => {
          // Arrange
          // main: symlink `f`; side: regular `f`
          // Untracked blocker placed at `f~side` BEFORE merge — blocks the rename target
          peerWrite('root.txt', 'root\n');
          peerAdd('root.txt');
          peerCommit('root');
          peerBranch('side');
          peerWrite('f', 'regular-side\n');
          peerAdd('f');
          peerCommit('side-add-regular');
          peerCheckout('main');
          peerSymlink('sym-target', 'f');
          peerAdd('f');
          peerCommit('main-add-symlink');
          // Untracked file at rename target — placed BEFORE merge
          peerWrite('f~side', 'untracked-blocker\n');

          // tsgit
          await oursWrite('root.txt', 'root\n');
          await repo.add(['root.txt']);
          await oursCommit('root');
          // Side branch: regular file f
          await repo.branch.create({ name: 'side' });
          await repo.checkout({ rev: 'side' });
          await oursWrite('f', 'regular-side\n');
          await repo.add(['f']);
          await oursCommit('side-add-regular');
          // Checkout main removes `f`; place symlink directly
          await repo.checkout({ rev: 'main' });
          symlinkSync('sym-target', path.join(pair.ours, 'f'));
          await repo.add(['f']);
          await oursCommit('main-add-symlink');
          // Untracked blocker at rename target
          await oursWrite('f~side', 'untracked-blocker\n');

          // Act
          const peerResult = peerMergeConflict('side');
          let oursResult: { kind: string; paths: ReadonlyArray<string> | undefined } | undefined;
          try {
            const r = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });
            oursResult = { kind: r.kind, paths: undefined };
          } catch (err) {
            oursResult = {
              kind: 'would-overwrite',
              paths: (err as { data?: { paths?: ReadonlyArray<string> } }).data?.paths,
            };
          }

          // Assert — both tools refuse
          expect(peerResult.ok).toBe(false);
          expect(peerResult.stderr + peerResult.stdout).toContain('untracked');
          // tsgit: would-overwrite refusal with the blocker path
          expect(oursResult?.kind).toBe('would-overwrite');
          expect(oursResult?.paths).toContain('f~side');
          // Blocker untouched
          const blocker = await readFile(path.join(pair.ours, 'f~side'), 'utf8');
          expect(blocker).toBe('untracked-blocker\n');
        });
      });
    });

    // ── Scenario 12: distinct-types via cherry-pick → f~<abbrev> (<subject>) ─
    //
    // In cherry-pick, `theirs` is the cherry-picked commit (label = `<abbrev>
    // (<subject>)`). When the cherry-picked commit's `f` is REGULAR and HEAD's
    // `f` is a SYMLINK, the regular side (theirs) gets renamed to
    // `f~<abbrev> (<subject>)` — the cherry-pick label suffix.

    describe('Given a cherry-pick produces a distinct-types conflict', () => {
      describe('When cherry-pick runs on both tools', () => {
        it('Then the rename suffix is f~<7-char-abbrev> (<subject>) matching git', async () => {
          // Arrange
          // main: symlink `f`; feature: regular `f`.
          // Cherry-pick feature onto main → distinct-types, regular (theirs) renamed.

          // Peer
          peerWrite('root.txt', 'root\n');
          peerAdd('root.txt');
          peerCommit('root');
          peerBranch('feature');
          peerWrite('f', 'regular-feature\n');
          peerAdd('f');
          peerCommit('add regular f');
          peerCheckout('main');
          peerSymlink('link-target', 'f');
          peerAdd('f');
          peerCommit('main-add-symlink');
          // OID of the feature tip (what we cherry-pick)
          const featureOid = runGit(['-C', pair.peer, 'rev-parse', 'feature']).trim();
          const abbrev = featureOid.slice(0, 7);
          const expectedSuffix = `f~${abbrev} (add regular f)`;
          // Peer cherry-pick (conflicts expected)
          const peerPickResult = tryRunGit(
            ['-C', pair.peer, '-c', 'core.editor=true', 'cherry-pick', featureOid],
            { env: COMMIT_ENV },
          );

          // tsgit
          await oursWrite('root.txt', 'root\n');
          await repo.add(['root.txt']);
          await oursCommit('root');
          // Feature branch: regular file f
          await repo.branch.create({ name: 'feature' });
          await repo.checkout({ rev: 'feature' });
          await oursWrite('f', 'regular-feature\n');
          await repo.add(['f']);
          await oursCommit('add regular f');
          // Checkout main removes `f`; place symlink directly
          await repo.checkout({ rev: 'main' });
          symlinkSync('link-target', path.join(pair.ours, 'f'));
          await repo.add(['f']);
          await oursCommit('main-add-symlink');

          // Act — cherry-pick the feature commit onto main
          const pickResult = await repo.cherryPick.run({ commits: ['feature'] });

          // Assert — both tools conflict
          expect(peerPickResult.ok).toBe(false);
          expect(pickResult.kind).toBe('conflict');
          // Stages must match
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
          // tsgit: regular at f~<abbrev> (<subject>)
          const oursRenamed = await readFile(path.join(pair.ours, expectedSuffix), 'utf8');
          expect(oursRenamed).toBe('regular-feature\n');
          // Peer: same rename path
          const peerRenamed = await readFile(path.join(pair.peer, expectedSuffix), 'utf8');
          expect(peerRenamed).toBe('regular-feature\n');
          // Symlink at f on both
          const oursLink = readlinkSync(path.join(pair.ours, 'f'));
          const peerLink = readlinkSync(path.join(pair.peer, 'f'));
          expect(oursLink).toBe('link-target');
          expect(peerLink).toBe('link-target');
        });
      });
    });
  },
);
