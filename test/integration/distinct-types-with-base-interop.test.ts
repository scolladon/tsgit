/**
 * Cross-tool interop — distinct-types conflicts with a base entry. Builds the
 * same three-way graph in a canonical-git peer and a tsgit repo (base commit
 * holds `p` + `root.txt`, branch `side` commits theirs' shape, `main` commits
 * ours' shape, HEAD on main), runs the merge on both tools, and asserts
 * byte-for-byte parity on working-tree contents, index stages, and verdicts.
 *
 * @proves
 *   surface:        repo.merge.run
 *   bucket:         cross-tool-interop
 *   unique:         distinct-types with-base content-merge runs against git
 *   interopSurface: merge
 */
import {
  chmodSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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
  'merge interop — distinct-types with-base conflicts',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository;

    beforeEach(async () => {
      pair = await makePeerPair('dt-with-base');
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

    // ── peer helpers ─────────────────────────────────────────────────────────

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

    const peerSymlink = (target: string, rel: string): void =>
      symlinkSync(target, path.join(pair.peer, rel));

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

    // ── tsgit helpers ────────────────────────────────────────────────────────

    const oursWrite = (rel: string, content: string): Promise<void> =>
      writeFile(path.join(pair.ours, rel), content);

    const oursCommit = async (message: string): Promise<void> => {
      await repo.commit({ message, author: AUTHOR, committer: AUTHOR });
    };

    /**
     * KindSpec describes a single file entry in the test graph.
     * `kind: 'file'` requires `bytes`. `kind: 'symlink'` requires `target`.
     */
    type KindSpec =
      | { readonly kind: 'file'; readonly bytes: string }
      | { readonly kind: 'symlink'; readonly target: string };

    /**
     * Shared setup helper for "base holds `p`, side branch mutates to `theirs`,
     * main mutates to `ours`" — the standard with-base distinct-types graph.
     *
     * Builds the same three-commit graph on both the canonical-git peer and the
     * tsgit repo. An optional `gitattributes` string, when provided, is committed
     * as `.gitattributes` in the base commit on both tools.
     */
    const setupWithBase = async (spec: {
      readonly base: KindSpec;
      readonly ours: KindSpec;
      readonly theirs: KindSpec;
      readonly gitattributes?: string;
    }): Promise<void> => {
      // ── Peer ─────────────────────────────────────────────────────────────
      // Base commit: root.txt + p + optional .gitattributes
      peerWrite('root.txt', 'root\n');
      if (spec.base.kind === 'file') {
        peerWrite('p', spec.base.bytes);
      } else {
        peerSymlink(spec.base.target, 'p');
      }
      if (spec.gitattributes !== undefined) {
        peerWrite('.gitattributes', spec.gitattributes);
        peerAdd('.gitattributes');
      }
      peerAdd('root.txt', 'p');
      peerCommit('base');

      // Side branch: replace p with theirs' shape
      peerBranch('side');
      if (spec.theirs.kind === 'file') {
        runGit(['-C', pair.peer, 'rm', '-q', 'p']);
        peerWrite('p', spec.theirs.bytes);
        peerAdd('p');
      } else {
        runGit(['-C', pair.peer, 'rm', '-q', 'p']);
        peerSymlink(spec.theirs.target, 'p');
        peerAdd('p');
      }
      peerCommit('side-change');

      // Back to main: replace p with ours' shape
      peerCheckout('main');
      if (spec.ours.kind === 'file') {
        runGit(['-C', pair.peer, 'rm', '-q', 'p']);
        peerWrite('p', spec.ours.bytes);
        peerAdd('p');
      } else {
        runGit(['-C', pair.peer, 'rm', '-q', 'p']);
        peerSymlink(spec.ours.target, 'p');
        peerAdd('p');
      }
      peerCommit('main-change');

      // ── tsgit ─────────────────────────────────────────────────────────────
      // Base commit: root.txt + p + optional .gitattributes
      await oursWrite('root.txt', 'root\n');
      if (spec.base.kind === 'file') {
        await oursWrite('p', spec.base.bytes);
      } else {
        symlinkSync(spec.base.target, path.join(pair.ours, 'p'));
      }
      await repo.add(['root.txt', 'p']);
      if (spec.gitattributes !== undefined) {
        await oursWrite('.gitattributes', spec.gitattributes);
        await repo.add(['.gitattributes']);
      }
      await oursCommit('base');

      // Side branch: replace p with theirs' shape
      await repo.branch.create({ name: 'side' });
      await repo.checkout({ rev: 'side' });
      await repo.rm(['p']);
      if (spec.theirs.kind === 'file') {
        await oursWrite('p', spec.theirs.bytes);
        await repo.add(['p']);
      } else {
        symlinkSync(spec.theirs.target, path.join(pair.ours, 'p'));
        await repo.add(['p']);
      }
      await oursCommit('side-change');

      // Back to main: replace p with ours' shape.
      await repo.checkout({ rev: 'main' });
      await repo.rm(['p']);
      if (spec.ours.kind === 'file') {
        await oursWrite('p', spec.ours.bytes);
        await repo.add(['p']);
      } else {
        symlinkSync(spec.ours.target, path.join(pair.ours, 'p'));
        await repo.add(['p']);
      }
      await oursCommit('main-change');
    };

    // ── S9: base=symlink, ours=file, theirs=file → R4 content conflict ──────

    describe('Given base is a symlink, ours and theirs are regular files with a shared prefix (S9)', () => {
      describe('When both tools merge', () => {
        it('Then the two-way marker bytes and the symlink stage-1 entry match git', async () => {
          // Arrange
          await setupWithBase({
            base: { kind: 'symlink', target: 'base-target' },
            ours: { kind: 'file', bytes: 'shared\nours\n' },
            theirs: { kind: 'file', bytes: 'shared\ntheirs\n' },
          });

          // Act
          const peerResult = peerMergeConflict('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert — both tools report conflict
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');

          // Stage-1 entry is the symlink (120000) — pinned byte-for-byte
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));

          // Working-tree bytes match git: shared prefix outside markers
          const oursFile = await readFile(path.join(pair.ours, 'p'), 'utf8');
          const peerFile = await readFile(path.join(pair.peer, 'p'), 'utf8');
          expect(oursFile).toBe(peerFile);
          expect(oursFile).toContain('shared\n');
          expect(oursFile).toContain('<<<<<<<');
          expect(oursFile).toContain('>>>>>>>');
        });
      });
    });

    // ── S1: base=file, ours=file, theirs=symlink ─────────────────────────────
    //
    // Regular side (ours) is renamed to p~HEAD; symlink (theirs) stays at p.
    // Stage 1 (base, regular) travels with the regular renamed side → p~HEAD.
    // Expected index: 120000 <theirs> 3 p  |  100644 <base> 1 p~HEAD  |  100644 <ours> 2 p~HEAD

    describe('Given base=file, ours=file, theirs=symlink (S1)', () => {
      describe('When both tools merge', () => {
        it('Then index stage-1 is at p~HEAD (regular kind) matching git, and working tree matches', async () => {
          // Arrange
          await setupWithBase({
            base: { kind: 'file', bytes: 'base\n' },
            ours: { kind: 'file', bytes: 'ours\n' },
            theirs: { kind: 'symlink', target: 'target-b' },
          });

          // Act
          const peerResult = peerMergeConflict('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert — both tools report conflict
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');

          // Index parity — stage-1 at p~HEAD pins byte-for-byte
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));

          // Working tree: p is a symlink to target-b on both
          const oursLink = readlinkSync(path.join(pair.ours, 'p'));
          const peerLink = readlinkSync(path.join(pair.peer, 'p'));
          expect(oursLink).toBe(peerLink);
          expect(oursLink).toBe('target-b');

          // Working tree: p~HEAD is the regular file on both
          const oursRegular = await readFile(path.join(pair.ours, 'p~HEAD'), 'utf8');
          const peerRegular = await readFile(path.join(pair.peer, 'p~HEAD'), 'utf8');
          expect(oursRegular).toBe(peerRegular);
          expect(oursRegular).toBe('ours\n');
        });
      });
    });

    // ── S2: mirror — ours=symlink, theirs=file ────────────────────────────────
    //
    // Regular side (theirs) is renamed to p~B; symlink (ours) stays at p.
    // Stage 1 (base, regular) travels with the regular renamed side → p~B.
    // Expected index: 120000 <ours> 2 p  |  100644 <base> 1 p~B  |  100644 <theirs> 3 p~B

    describe('Given base=file, ours=symlink, theirs=file (S2)', () => {
      describe('When both tools merge', () => {
        it('Then index stage-1 is at p~B (regular kind) matching git, and working tree matches', async () => {
          // Arrange
          await setupWithBase({
            base: { kind: 'file', bytes: 'base\n' },
            ours: { kind: 'symlink', target: 'target-a' },
            theirs: { kind: 'file', bytes: 'theirs\n' },
          });

          // Act
          const peerResult = peerMergeConflict('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert — both tools report conflict
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');

          // Index parity — stage-1 at p~side pins byte-for-byte
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));

          // Working tree: p is a symlink to target-a on both
          const oursLink = readlinkSync(path.join(pair.ours, 'p'));
          const peerLink = readlinkSync(path.join(pair.peer, 'p'));
          expect(oursLink).toBe(peerLink);
          expect(oursLink).toBe('target-a');

          // Working tree: p~side is the regular file on both (theirs label = branch name 'side')
          const oursRegular = await readFile(path.join(pair.ours, 'p~side'), 'utf8');
          const peerRegular = await readFile(path.join(pair.peer, 'p~side'), 'utf8');
          expect(oursRegular).toBe(peerRegular);
          expect(oursRegular).toBe('theirs\n');
        });
      });
    });

    // ── S3: base=symlink, ours=symlink, theirs=file ───────────────────────────
    //
    // Regular side (theirs) renamed to p~B; symlink side (ours) + base stay at p.
    // Stage 1 (base, symlink) is at p alongside stage 2.
    // Expected index: 120000 <base> 1 p  |  120000 <ours> 2 p  |  100644 <theirs> 3 p~B

    describe('Given base=symlink, ours=symlink, theirs=file (S3)', () => {
      describe('When both tools merge', () => {
        it('Then index stage-1 is at p (symlink kind) matching git, and working tree matches', async () => {
          // Arrange
          await setupWithBase({
            base: { kind: 'symlink', target: 'base-target' },
            ours: { kind: 'symlink', target: 'ours-target' },
            theirs: { kind: 'file', bytes: 'theirs\n' },
          });

          // Act
          const peerResult = peerMergeConflict('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert — both tools report conflict
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');

          // Index parity — stage-1 at p (symlink) pins byte-for-byte
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));

          // Working tree: p is ours' symlink on both
          const oursLink = readlinkSync(path.join(pair.ours, 'p'));
          const peerLink = readlinkSync(path.join(pair.peer, 'p'));
          expect(oursLink).toBe(peerLink);
          expect(oursLink).toBe('ours-target');

          // Working tree: p~side is the regular file on both (theirs label = branch name 'side')
          const oursRegular = await readFile(path.join(pair.ours, 'p~side'), 'utf8');
          const peerRegular = await readFile(path.join(pair.peer, 'p~side'), 'utf8');
          expect(oursRegular).toBe(peerRegular);
          expect(oursRegular).toBe('theirs\n');
        });
      });
    });

    // ── S4: mirror — base=symlink, ours=file, theirs=symlink ─────────────────
    //
    // Regular side (ours) renamed to p~HEAD; symlink side (theirs) + base stay at p.
    // Stage 1 (base, symlink) is at p alongside stage 3.
    // Expected index: 120000 <base> 1 p  |  120000 <theirs> 3 p  |  100644 <ours> 2 p~HEAD

    describe('Given base=symlink, ours=file, theirs=symlink (S4)', () => {
      describe('When both tools merge', () => {
        it('Then index stage-1 is at p (symlink kind) matching git, and working tree matches', async () => {
          // Arrange
          await setupWithBase({
            base: { kind: 'symlink', target: 'base-target' },
            ours: { kind: 'file', bytes: 'ours\n' },
            theirs: { kind: 'symlink', target: 'theirs-target' },
          });

          // Act
          const peerResult = peerMergeConflict('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert — both tools report conflict
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');

          // Index parity — stage-1 at p (symlink) pins byte-for-byte
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));

          // Working tree: p is theirs' symlink on both
          const oursLink = readlinkSync(path.join(pair.ours, 'p'));
          const peerLink = readlinkSync(path.join(pair.peer, 'p'));
          expect(oursLink).toBe(peerLink);
          expect(oursLink).toBe('theirs-target');

          // Working tree: p~HEAD is the regular file on both
          const oursRegular = await readFile(path.join(pair.ours, 'p~HEAD'), 'utf8');
          const peerRegular = await readFile(path.join(pair.peer, 'p~HEAD'), 'utf8');
          expect(oursRegular).toBe(peerRegular);
          expect(oursRegular).toBe('ours\n');
        });
      });
    });

    // ── Q3: binary regular file vs symlink — content plays no role ───────────
    //
    // Distinct types renames on kind alone: a binary ours side is renamed to
    // p~HEAD exactly like a text one, with its bytes preserved verbatim.

    describe('Given base=file, ours=binary file, theirs=symlink (Q3)', () => {
      describe('When both tools merge', () => {
        it('Then the binary side is renamed like a text one with bytes preserved', async () => {
          // Arrange — ours carries NUL bytes so git classifies it binary
          const binaryBytes = 'BIN\u0000DATA\n';
          await setupWithBase({
            base: { kind: 'file', bytes: 'base\n' },
            ours: { kind: 'file', bytes: binaryBytes },
            theirs: { kind: 'symlink', target: 'target-b' },
          });

          // Act
          const peerResult = peerMergeConflict('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert — both tools report conflict
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');

          // Index parity
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));

          // Working tree: p is the symlink; p~HEAD holds the binary bytes verbatim
          expect(readlinkSync(path.join(pair.ours, 'p'))).toBe('target-b');
          expect(readlinkSync(path.join(pair.peer, 'p'))).toBe('target-b');
          const oursBinary = readFileSync(path.join(pair.ours, 'p~HEAD'));
          const peerBinary = readFileSync(path.join(pair.peer, 'p~HEAD'));
          expect(Buffer.compare(oursBinary, peerBinary)).toBe(0);
          expect(oursBinary.equals(Buffer.from(binaryBytes, 'utf8'))).toBe(true);
        });
      });
    });

    // ── S5: trivial boundary — ours unchanged, theirs=symlink ────────────────
    //
    // Ours did NOT change p (only theirs changed from file to symlink) → clean
    // merge: the changed side is taken, no conflict emitted.

    describe('Given ours unchanged, theirs changed p to a symlink (S5)', () => {
      describe('When both tools merge', () => {
        it('Then both merge clean, writeTreeOf parity, p is a symlink on both', async () => {
          // Arrange — base=file (ours did not change it); theirs=symlink
          peerWrite('root.txt', 'root\n');
          peerWrite('p', 'base\n');
          peerAdd('root.txt', 'p');
          peerCommit('base');
          peerBranch('side');
          runGit(['-C', pair.peer, 'rm', '-q', 'p']);
          peerSymlink('target-b', 'p');
          peerAdd('p');
          peerCommit('side-symlink');
          peerCheckout('main');
          // main does NOT change p — just add root2.txt to diverge
          peerWrite('root2.txt', 'extra\n');
          peerAdd('root2.txt');
          peerCommit('main-diverge');

          await oursWrite('root.txt', 'root\n');
          await oursWrite('p', 'base\n');
          await repo.add(['root.txt', 'p']);
          await oursCommit('base');
          await repo.branch.create({ name: 'side' });
          await repo.checkout({ rev: 'side' });
          await repo.rm(['p']);
          symlinkSync('target-b', path.join(pair.ours, 'p'));
          await repo.add(['p']);
          await oursCommit('side-symlink');
          await repo.checkout({ rev: 'main' });
          await oursWrite('root2.txt', 'extra\n');
          await repo.add(['root2.txt']);
          await oursCommit('main-diverge');

          // Act
          peerMergeClean('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert — clean merge on both
          expect(result.kind).not.toBe('conflict');

          // Index (stage 0) parity
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));

          // p is a symlink to target-b on both
          const oursLink = readlinkSync(path.join(pair.ours, 'p'));
          const peerLink = readlinkSync(path.join(pair.peer, 'p'));
          expect(oursLink).toBe(peerLink);
          expect(oursLink).toBe('target-b');
        });
      });
    });

    // ── S5 mirror: ours changed p to a symlink, theirs unchanged ─────────────

    describe('Given ours changed p to a symlink, theirs unchanged (S5 mirror)', () => {
      describe('When both tools merge', () => {
        it('Then both merge clean and p stays ours symlink on both', async () => {
          // Arrange — theirs only adds an unrelated file; ours converts p
          peerWrite('root.txt', 'root\n');
          peerWrite('p', 'base\n');
          peerAdd('root.txt', 'p');
          peerCommit('base');
          peerBranch('side');
          peerWrite('side.txt', 'side\n');
          peerAdd('side.txt');
          peerCommit('side-diverge');
          peerCheckout('main');
          runGit(['-C', pair.peer, 'rm', '-q', 'p']);
          peerSymlink('target-a', 'p');
          peerAdd('p');
          peerCommit('main-symlink');

          await oursWrite('root.txt', 'root\n');
          await oursWrite('p', 'base\n');
          await repo.add(['root.txt', 'p']);
          await oursCommit('base');
          await repo.branch.create({ name: 'side' });
          await repo.checkout({ rev: 'side' });
          await oursWrite('side.txt', 'side\n');
          await repo.add(['side.txt']);
          await oursCommit('side-diverge');
          await repo.checkout({ rev: 'main' });
          await repo.rm(['p']);
          symlinkSync('target-a', path.join(pair.ours, 'p'));
          await repo.add(['p']);
          await oursCommit('main-symlink');

          // Act
          peerMergeClean('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert — clean merge on both
          expect(result.kind).not.toBe('conflict');

          // Index (stage 0) parity
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));

          // p stays ours' symlink on both
          expect(readlinkSync(path.join(pair.ours, 'p'))).toBe('target-a');
          expect(readlinkSync(path.join(pair.peer, 'p'))).toBe('target-a');
        });
      });
    });

    // ── S7: untracked file squats the rename target ───────────────────────────
    //
    // S1 shape + an untracked file at p~HEAD in both worktrees before the merge.
    // Both tools must refuse without touching HEAD/index.

    describe('Given an untracked file squats the rename target p~HEAD (S7)', () => {
      describe('When both tools attempt the with-base merge', () => {
        it('Then both tools refuse and HEAD/index are untouched', async () => {
          // Arrange — S1 shape
          await setupWithBase({
            base: { kind: 'file', bytes: 'base\n' },
            ours: { kind: 'file', bytes: 'ours\n' },
            theirs: { kind: 'symlink', target: 'target-b' },
          });
          // Untracked blocker at rename target — placed BEFORE merge
          peerWrite('p~HEAD', 'untracked-blocker\n');
          await oursWrite('p~HEAD', 'untracked-blocker\n');

          // Capture pre-merge state for tsgit
          const stageBefore = lsStage(pair.ours);
          const headBefore = runGit(['-C', pair.ours, 'rev-parse', 'HEAD']).trim();

          // Act
          const peerResult = peerMergeConflict('side');
          let refusal:
            | {
                code?: string;
                localChanges?: ReadonlyArray<string>;
                untracked?: ReadonlyArray<string>;
              }
            | undefined;
          try {
            await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });
          } catch (err) {
            refusal = (
              err as {
                data?: {
                  code?: string;
                  localChanges?: ReadonlyArray<string>;
                  untracked?: ReadonlyArray<string>;
                };
              }
            ).data;
          }

          // Assert — both tools refuse with the untracked-overwrite shape
          expect(peerResult.ok).toBe(false);
          expect(peerResult.stderr + peerResult.stdout).toContain('untracked');
          expect(refusal?.code).toBe('WORKING_TREE_DIRTY');
          expect(refusal?.untracked).toContain('p~HEAD');
          expect(refusal?.localChanges).toEqual([]);

          // Blocker untouched, HEAD and index unchanged
          const blocker = await readFile(path.join(pair.ours, 'p~HEAD'), 'utf8');
          expect(blocker).toBe('untracked-blocker\n');
          expect(runGit(['-C', pair.ours, 'rev-parse', 'HEAD']).trim()).toBe(headBefore);
          expect(lsStage(pair.ours)).toBe(stageBefore);
        });
      });
    });

    // ── S8: tracked p~HEAD squats rename → probe p~HEAD_0 ────────────────────

    describe('Given tracked p~HEAD squats the rename target (S8)', () => {
      describe('When both tools merge', () => {
        it('Then index uses p~HEAD_0 for the distinct-types sides and matches git', async () => {
          // Arrange — S1 shape but p~HEAD is already tracked on both tools
          peerWrite('root.txt', 'root\n');
          peerWrite('p', 'base\n');
          peerWrite('p~HEAD', 'existing\n');
          peerAdd('root.txt', 'p', 'p~HEAD');
          peerCommit('base');
          peerBranch('side');
          runGit(['-C', pair.peer, 'rm', '-q', 'p']);
          peerSymlink('target-b', 'p');
          peerAdd('p');
          peerCommit('side-symlink');
          peerCheckout('main');
          runGit(['-C', pair.peer, 'rm', '-q', 'p']);
          peerWrite('p', 'ours\n');
          peerAdd('p');
          peerCommit('main-regular');

          await oursWrite('root.txt', 'root\n');
          await oursWrite('p', 'base\n');
          await oursWrite('p~HEAD', 'existing\n');
          await repo.add(['root.txt', 'p', 'p~HEAD']);
          await oursCommit('base');
          await repo.branch.create({ name: 'side' });
          await repo.checkout({ rev: 'side' });
          await repo.rm(['p']);
          symlinkSync('target-b', path.join(pair.ours, 'p'));
          await repo.add(['p']);
          await oursCommit('side-symlink');
          await repo.checkout({ rev: 'main' });
          await repo.rm(['p']);
          await oursWrite('p', 'ours\n');
          await repo.add(['p']);
          await oursCommit('main-regular');

          // Act
          const peerResult = peerMergeConflict('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert — conflict on both
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');

          // Index parity — p~HEAD_0 is used for the stages, not p~HEAD
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
        });
      });
    });

    // ── P1: tracked p~HEAD_0 also taken → probe p~HEAD_1 ─────────────────────

    describe('Given tracked p~HEAD and p~HEAD_0 both squat rename targets (P1)', () => {
      describe('When both tools merge', () => {
        it('Then index uses p~HEAD_1 for the distinct-types sides and matches git', async () => {
          // Arrange — S1 shape but p~HEAD and p~HEAD_0 are both tracked
          peerWrite('root.txt', 'root\n');
          peerWrite('p', 'base\n');
          peerWrite('p~HEAD', 'existing\n');
          peerWrite('p~HEAD_0', 'also-existing\n');
          peerAdd('root.txt', 'p', 'p~HEAD', 'p~HEAD_0');
          peerCommit('base');
          peerBranch('side');
          runGit(['-C', pair.peer, 'rm', '-q', 'p']);
          peerSymlink('target-b', 'p');
          peerAdd('p');
          peerCommit('side-symlink');
          peerCheckout('main');
          runGit(['-C', pair.peer, 'rm', '-q', 'p']);
          peerWrite('p', 'ours\n');
          peerAdd('p');
          peerCommit('main-regular');

          await oursWrite('root.txt', 'root\n');
          await oursWrite('p', 'base\n');
          await oursWrite('p~HEAD', 'existing\n');
          await oursWrite('p~HEAD_0', 'also-existing\n');
          await repo.add(['root.txt', 'p', 'p~HEAD', 'p~HEAD_0']);
          await oursCommit('base');
          await repo.branch.create({ name: 'side' });
          await repo.checkout({ rev: 'side' });
          await repo.rm(['p']);
          symlinkSync('target-b', path.join(pair.ours, 'p'));
          await repo.add(['p']);
          await oursCommit('side-symlink');
          await repo.checkout({ rev: 'main' });
          await repo.rm(['p']);
          await oursWrite('p', 'ours\n');
          await repo.add(['p']);
          await oursCommit('main-regular');

          // Act
          const peerResult = peerMergeConflict('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert — conflict on both
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');

          // Index parity — p~HEAD_1 is used
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
        });
      });
    });

    // ── S12: theirs branch feature/x — slash flattened to underscore ──────────
    //
    // S1 shape but theirs comes from branch `feature/x`. The suffix is the
    // flattened label → `feature_x`. Rename target is `p~feature_x`; stages 1+3
    // land there.

    describe('Given theirs branch is feature/x, base=file, ours=symlink, theirs=file (S12)', () => {
      describe('When both tools merge with a branch-label theirs', () => {
        it('Then index uses p~feature_x (slash flattened) and matches git', async () => {
          // Arrange — S2 shape (base=file, ours=symlink, theirs=file) but theirs
          // branch is named `feature/x` so the rename label is `feature_x`
          peerWrite('root.txt', 'root\n');
          peerWrite('p', 'base\n');
          peerAdd('root.txt', 'p');
          peerCommit('base');
          runGit(['-C', pair.peer, 'checkout', '-q', '-b', 'feature/x']);
          runGit(['-C', pair.peer, 'rm', '-q', 'p']);
          peerWrite('p', 'theirs\n');
          peerAdd('p');
          peerCommit('feature-change');
          runGit(['-C', pair.peer, 'checkout', '-q', 'main']);
          runGit(['-C', pair.peer, 'rm', '-q', 'p']);
          peerSymlink('target-a', 'p');
          peerAdd('p');
          peerCommit('main-symlink');

          await oursWrite('root.txt', 'root\n');
          await oursWrite('p', 'base\n');
          await repo.add(['root.txt', 'p']);
          await oursCommit('base');
          await repo.branch.create({ name: 'feature/x' });
          await repo.checkout({ rev: 'feature/x' });
          await repo.rm(['p']);
          await oursWrite('p', 'theirs\n');
          await repo.add(['p']);
          await oursCommit('feature-change');
          await repo.checkout({ rev: 'main' });
          await repo.rm(['p']);
          symlinkSync('target-a', path.join(pair.ours, 'p'));
          await repo.add(['p']);
          await oursCommit('main-symlink');

          // Act
          const peerResult = peerMergeConflict('feature/x');
          const result = await repo.merge.run({ rev: 'feature/x', message: 'm', author: AUTHOR });

          // Assert — conflict on both
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');

          // Index parity — p~feature_x carries stages 1 and 3
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));

          // Working tree: p is ours' symlink, p~feature_x is theirs' file
          const oursLink = readlinkSync(path.join(pair.ours, 'p'));
          const peerLink = readlinkSync(path.join(pair.peer, 'p'));
          expect(oursLink).toBe(peerLink);
          const oursRegular = await readFile(path.join(pair.ours, 'p~feature_x'), 'utf8');
          const peerRegular = await readFile(path.join(pair.peer, 'p~feature_x'), 'utf8');
          expect(oursRegular).toBe(peerRegular);
          expect(oursRegular).toBe('theirs\n');
        });
      });
    });

    // ── P2: S9 + .gitattributes merge=union → clean merge ───────────────────

    describe('Given base is a symlink, ours and theirs are regular files, p uses merge=union (P2)', () => {
      describe('When both tools merge', () => {
        it('Then both merges are clean and the resulting file and stage-0 index match git', async () => {
          // Arrange
          await setupWithBase({
            base: { kind: 'symlink', target: 'base-target' },
            ours: { kind: 'file', bytes: 'shared\nours\n' },
            theirs: { kind: 'file', bytes: 'shared\ntheirs\n' },
            gitattributes: 'p merge=union\n',
          });

          // Act
          peerMergeClean('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert — both tools produce a successful merge commit (no conflicts)
          expect(result.kind).not.toBe('conflict');

          // Stage 0 (clean) index matches git exactly
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));

          // Working-tree file contains ours' lines then theirs' lines
          const oursFile = await readFile(path.join(pair.ours, 'p'), 'utf8');
          const peerFile = await readFile(path.join(pair.peer, 'p'), 'utf8');
          expect(oursFile).toBe(peerFile);
          expect(oursFile).not.toContain('<<<<<<<');
        });
      });
    });

    // ── S6: with-base distinct-types via cherry-pick ──────────────────────────
    //
    // Base commit has `p` as a regular file. Feature branch changes `p` regular
    // (theirs = regular). Main changes `p` to a symlink (ours = symlink).
    // Cherry-pick feature onto main → with-base distinct-types conflict.
    // The regular side (theirs) gets renamed to `p~<abbrev> (<subject>)`.
    // MERGE_MSG # Conflicts: block must list both `p` and the renamed path.

    describe('Given base is a regular file, main makes p a symlink, cherry-pick of a regular change (S6)', () => {
      describe('When cherry-pick runs on both tools', () => {
        it('Then stages, worktree, and MERGE_MSG trailer byte-match git', async () => {
          // Arrange — peer
          peerWrite('root.txt', 'root\n');
          peerWrite('p', 'base-content\n');
          peerAdd('root.txt', 'p');
          peerCommit('base');
          // Feature branch: change p regular
          peerBranch('feature');
          peerWrite('p', 'feature-content\n');
          peerAdd('p');
          peerCommit('make p regular change');
          // Back to main: replace p with a symlink
          peerCheckout('main');
          runGit(['-C', pair.peer, 'rm', '-q', 'p']);
          peerSymlink('link-target', 'p');
          peerAdd('p');
          peerCommit('make p a symlink');
          const featureOid = runGit(['-C', pair.peer, 'rev-parse', 'feature']).trim();
          const abbrev = featureOid.slice(0, 7);
          // Peer cherry-pick with conflict
          const peerResult = tryRunGit(
            [
              '-C',
              pair.peer,
              '-c',
              'merge.conflictStyle=merge',
              '-c',
              'core.editor=true',
              'cherry-pick',
              featureOid,
            ],
            { env: COMMIT_ENV },
          );

          // Arrange — tsgit
          await oursWrite('root.txt', 'root\n');
          await oursWrite('p', 'base-content\n');
          await repo.add(['root.txt', 'p']);
          await oursCommit('base');
          // Feature branch: change p regular
          await repo.branch.create({ name: 'feature' });
          await repo.checkout({ rev: 'feature' });
          await oursWrite('p', 'feature-content\n');
          await repo.add(['p']);
          await oursCommit('make p regular change');
          // Back to main: replace p with a symlink
          await repo.checkout({ rev: 'main' });
          await repo.rm(['p']);
          symlinkSync('link-target', path.join(pair.ours, 'p'));
          await repo.add(['p']);
          await oursCommit('make p a symlink');

          // Act — cherry-pick feature onto main
          const pickResult = await repo.cherryPick.run({ commits: ['feature'] });

          // Assert — both tools conflict
          expect(peerResult.ok).toBe(false);
          expect(pickResult.kind).toBe('conflict');

          // Stages match git
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));

          // Worktree: symlink at p on both
          const oursLink = readlinkSync(path.join(pair.ours, 'p'));
          const peerLink = readlinkSync(path.join(pair.peer, 'p'));
          expect(oursLink).toBe(peerLink);

          // Regular side renamed to p~<abbrev> (make p regular change) on both
          const renamedPath = `p~${abbrev} (make p regular change)`;
          const oursRenamed = await readFile(path.join(pair.ours, renamedPath), 'utf8');
          const peerRenamed = await readFile(path.join(pair.peer, renamedPath), 'utf8');
          expect(oursRenamed).toBe(peerRenamed);

          // MERGE_MSG byte parity — trailer lists both recorded paths
          const oursMergeMsg = await readFile(path.join(pair.ours, '.git', 'MERGE_MSG'), 'utf8');
          const peerMergeMsg = await readFile(path.join(pair.peer, '.git', 'MERGE_MSG'), 'utf8');
          expect(oursMergeMsg).toBe(peerMergeMsg);
          expect(oursMergeMsg).toContain('# Conflicts:\n');
          expect(oursMergeMsg).toContain('#\tp\n');
          expect(oursMergeMsg).toContain(`#\t${renamedPath}\n`);
        });
      });
    });

    // ── S9b: base=file; both sides symlinks, differing targets ───────────────
    //
    // Content conflict: domain emits a bare `content` conflict (R5). Both stages
    // 2 and 3 are symlinks at `p`; stage 1 is the file. Worktree must hold ours'
    // symlink — no marker bytes anywhere.

    describe('Given base=file, both sides are symlinks with differing targets (S9b)', () => {
      describe('When both tools merge', () => {
        it('Then both tools UU, stages match git, and worktree p is ours symlink with no markers', async () => {
          // Arrange
          await setupWithBase({
            base: { kind: 'file', bytes: 'base-content\n' },
            ours: { kind: 'symlink', target: 'ours-target' },
            theirs: { kind: 'symlink', target: 'theirs-target' },
          });

          // Act
          const peerResult = peerMergeConflict('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert — both tools report conflict
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');

          // Stage parity — stage-1 file + stage-2/3 symlinks at p
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));

          // Worktree: p is ours' symlink on both, no markers
          const oursLink = readlinkSync(path.join(pair.ours, 'p'));
          const peerLink = readlinkSync(path.join(pair.peer, 'p'));
          expect(oursLink).toBe(peerLink);
          expect(oursLink).toBe('ours-target');
        });
      });
    });

    // ── P3: base=symlink; both sides symlinks, differing targets ─────────────
    //
    // Same shape as S9b but base is also a symlink. Still a bare `content`
    // conflict (R5): domain emits no markers; worktree keeps ours' symlink.

    describe('Given base=symlink, both sides are symlinks with differing targets (P3)', () => {
      describe('When both tools merge', () => {
        it('Then both tools UU, stages match git, and worktree p is ours symlink with no markers', async () => {
          // Arrange
          await setupWithBase({
            base: { kind: 'symlink', target: 'base-target' },
            ours: { kind: 'symlink', target: 'ours-target' },
            theirs: { kind: 'symlink', target: 'theirs-target' },
          });

          // Act
          const peerResult = peerMergeConflict('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert — both tools report conflict
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');

          // Stage parity
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));

          // Worktree: p is ours' symlink on both, no markers
          const oursLink = readlinkSync(path.join(pair.ours, 'p'));
          const peerLink = readlinkSync(path.join(pair.peer, 'p'));
          expect(oursLink).toBe(peerLink);
          expect(oursLink).toBe('ours-target');
        });
      });
    });

    // ── Q1: base=symlink; sides identical bytes, modes 100755 vs 100644 ───────
    //
    // Content conflict with a mode-only difference. Worktree file must be written
    // with ours' mode (755).

    describe('Given base=symlink, sides identical bytes but ours mode=100755 / theirs mode=100644 (Q1)', () => {
      describe('When both tools merge', () => {
        it('Then both tools UU, stages match, worktree bytes identical with ours mode 755, no markers', async () => {
          // Arrange — build the graph directly (not via setupWithBase) so we can
          // control per-commit file modes precisely.

          // ── Peer ────────────────────────────────────────────────────────────
          // Base: symlink at p
          peerSymlink('base-target', 'p');
          peerAdd('p');
          peerCommit('base');
          // side branch: p → regular file, mode 100644
          peerBranch('side');
          runGit(['-C', pair.peer, 'rm', '-q', 'p']);
          peerWrite('p', 'shared-content\n');
          peerAdd('p');
          peerCommit('theirs-644');
          // main: p → regular file, mode 100755
          peerCheckout('main');
          runGit(['-C', pair.peer, 'rm', '-q', 'p']);
          peerWrite('p', 'shared-content\n');
          chmodSync(path.join(pair.peer, 'p'), 0o755);
          runGit(['-C', pair.peer, 'add', 'p']);
          peerCommit('ours-755');

          // ── tsgit ────────────────────────────────────────────────────────────
          // Base: symlink at p
          symlinkSync('base-target', path.join(pair.ours, 'p'));
          await repo.add(['p']);
          await oursCommit('base');
          // side branch: p → regular file, mode 100644
          await repo.branch.create({ name: 'side' });
          await repo.checkout({ rev: 'side' });
          await repo.rm(['p']);
          await oursWrite('p', 'shared-content\n');
          await repo.add(['p']);
          await oursCommit('theirs-644');
          // main: p → regular file, mode 100755
          unlinkSync(path.join(pair.ours, 'p'));
          await repo.checkout({ rev: 'main' });
          await repo.rm(['p']);
          await oursWrite('p', 'shared-content\n');
          chmodSync(path.join(pair.ours, 'p'), 0o755);
          await repo.add(['p']);
          await oursCommit('ours-755');

          // Act
          const peerResult = peerMergeConflict('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert — both tools report conflict (mode difference → UU)
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');

          // Stage parity
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));

          // Worktree bytes identical (shared content, no markers)
          const oursFile = await readFile(path.join(pair.ours, 'p'), 'utf8');
          const peerFile = await readFile(path.join(pair.peer, 'p'), 'utf8');
          expect(oursFile).toBe(peerFile);
          expect(oursFile).not.toContain('<<<<<<<');

          // Worktree mode = 755 on both
          expect(lstatSync(path.join(pair.ours, 'p')).mode & 0o777).toBe(0o755);
          expect(lstatSync(path.join(pair.peer, 'p')).mode & 0o777).toBe(0o755);
        });
      });
    });

    // ── Q2: base=symlink; merge=union; ours 100755 / theirs 100644 differing text
    //
    // Union content merge (no conflict markers), UU due to mode conflict,
    // worktree carries ours' mode (755) and the merged union bytes.

    describe('Given base=symlink, merge=union, ours 100755/differing text vs theirs 100644 (Q2)', () => {
      describe('When both tools merge', () => {
        it('Then both tools UU, clean union bytes, ours mode 755, no markers', async () => {
          // Arrange — build the graph directly

          // ── Peer ────────────────────────────────────────────────────────────
          // Base: symlink at p + .gitattributes
          peerSymlink('base-target', 'p');
          peerWrite('.gitattributes', 'p merge=union\n');
          peerAdd('p', '.gitattributes');
          peerCommit('base');
          // side branch: p → regular file, mode 100644
          peerBranch('side');
          runGit(['-C', pair.peer, 'rm', '-q', 'p']);
          peerWrite('p', 'theirs-line\n');
          peerAdd('p');
          peerCommit('theirs-644');
          // main: p → regular file, mode 100755
          peerCheckout('main');
          runGit(['-C', pair.peer, 'rm', '-q', 'p']);
          peerWrite('p', 'ours-line\n');
          chmodSync(path.join(pair.peer, 'p'), 0o755);
          runGit(['-C', pair.peer, 'add', 'p']);
          peerCommit('ours-755');

          // ── tsgit ────────────────────────────────────────────────────────────
          symlinkSync('base-target', path.join(pair.ours, 'p'));
          await oursWrite('.gitattributes', 'p merge=union\n');
          await repo.add(['p', '.gitattributes']);
          await oursCommit('base');
          // side branch: p → regular file, mode 100644
          await repo.branch.create({ name: 'side' });
          await repo.checkout({ rev: 'side' });
          await repo.rm(['p']);
          await oursWrite('p', 'theirs-line\n');
          await repo.add(['p']);
          await oursCommit('theirs-644');
          // main: p → regular file, mode 100755
          unlinkSync(path.join(pair.ours, 'p'));
          await repo.checkout({ rev: 'main' });
          await repo.rm(['p']);
          await oursWrite('p', 'ours-line\n');
          chmodSync(path.join(pair.ours, 'p'), 0o755);
          await repo.add(['p']);
          await oursCommit('ours-755');

          // Act
          const peerResult = peerMergeConflict('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert — both tools conflict (UU due to mode difference)
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');

          // Stage parity
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));

          // Worktree: union bytes with no markers, matches git
          const oursFile = await readFile(path.join(pair.ours, 'p'), 'utf8');
          const peerFile = await readFile(path.join(pair.peer, 'p'), 'utf8');
          expect(oursFile).toBe(peerFile);
          expect(oursFile).not.toContain('<<<<<<<');
          expect(oursFile).toContain('ours-line\n');

          // Worktree mode = 755 on both
          expect(lstatSync(path.join(pair.ours, 'p')).mode & 0o777).toBe(0o755);
          expect(lstatSync(path.join(pair.peer, 'p')).mode & 0o777).toBe(0o755);
        });
      });
    });

    // ── Q4: control — plain modify/modify content conflict, all stages 100755 ──
    //
    // No kind change. Both sides are executable regular files. The marker file
    // written by tsgit must also be mode 755.

    describe('Given a plain content conflict where all stages are 100755 (Q4 control)', () => {
      describe('When both tools merge', () => {
        it('Then both tools UU, marker file mode is 755 on both', async () => {
          // Arrange — simple diverging edit; both ours and theirs are executable
          peerWrite('root.txt', 'root\n');
          peerWrite('p', 'base\n');
          peerAdd('root.txt', 'p');
          peerCommit('base');
          peerBranch('side');
          peerWrite('p', 'theirs-edit\n');
          peerAdd('p');
          chmodSync(path.join(pair.peer, 'p'), 0o755);
          runGit(['-C', pair.peer, 'add', 'p']);
          peerCommit('theirs-exec');
          peerCheckout('main');
          peerWrite('p', 'ours-edit\n');
          peerAdd('p');
          chmodSync(path.join(pair.peer, 'p'), 0o755);
          runGit(['-C', pair.peer, 'add', 'p']);
          peerCommit('ours-exec');

          await oursWrite('root.txt', 'root\n');
          await oursWrite('p', 'base\n');
          await repo.add(['root.txt', 'p']);
          await oursCommit('base');
          await repo.branch.create({ name: 'side' });
          await repo.checkout({ rev: 'side' });
          await oursWrite('p', 'theirs-edit\n');
          chmodSync(path.join(pair.ours, 'p'), 0o755);
          await repo.add(['p']);
          await oursCommit('theirs-exec');
          await repo.checkout({ rev: 'main' });
          await oursWrite('p', 'ours-edit\n');
          chmodSync(path.join(pair.ours, 'p'), 0o755);
          await repo.add(['p']);
          await oursCommit('ours-exec');

          // Act
          const peerResult = peerMergeConflict('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert — both tools conflict
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');

          // Stage parity
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));

          // Marker file written with mode 755 on both
          expect(lstatSync(path.join(pair.ours, 'p')).mode & 0o777).toBe(0o755);
          expect(lstatSync(path.join(pair.peer, 'p')).mode & 0o777).toBe(0o755);
        });
      });
    });

    // ── Q5: content conflict where only theirs flips the exec bit ────────────
    //
    // Three-way mode merge: ours kept the base's 644, theirs flipped to 755 —
    // git materialises the marker file with the merged 755, not ours' 644.

    describe('Given a content conflict where only theirs flipped the exec bit (Q5)', () => {
      describe('When both tools merge', () => {
        it('Then both tools UU and the marker file carries the merged 755 mode', async () => {
          // Arrange — overlapping edit; only theirs chmods to 755
          peerWrite('root.txt', 'root\n');
          peerWrite('p', 'line1\nline2\nline3\n');
          peerAdd('root.txt', 'p');
          peerCommit('base');
          peerBranch('side');
          peerWrite('p', 'line1\nTHEIRS\nline3\n');
          chmodSync(path.join(pair.peer, 'p'), 0o755);
          runGit(['-C', pair.peer, 'add', 'p']);
          peerCommit('theirs-exec');
          peerCheckout('main');
          peerWrite('p', 'line1\nOURS\nline3\n');
          peerAdd('p');
          peerCommit('ours-edit');

          await oursWrite('root.txt', 'root\n');
          await oursWrite('p', 'line1\nline2\nline3\n');
          await repo.add(['root.txt', 'p']);
          await oursCommit('base');
          await repo.branch.create({ name: 'side' });
          await repo.checkout({ rev: 'side' });
          await oursWrite('p', 'line1\nTHEIRS\nline3\n');
          chmodSync(path.join(pair.ours, 'p'), 0o755);
          await repo.add(['p']);
          await oursCommit('theirs-exec');
          await repo.checkout({ rev: 'main' });
          await oursWrite('p', 'line1\nOURS\nline3\n');
          await repo.add(['p']);
          await oursCommit('ours-edit');

          // Act
          const peerResult = peerMergeConflict('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert — both tools conflict
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');

          // Stage parity (stage 2 is 644, stage 3 is 755 on both)
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));

          // Marker file carries the merged 755 (theirs flipped, ours kept base)
          expect(lstatSync(path.join(pair.peer, 'p')).mode & 0o777).toBe(0o755);
          expect(lstatSync(path.join(pair.ours, 'p')).mode & 0o777).toBe(0o755);
        });
      });
    });

    // ── Q6: modify/delete whose surviving theirs side is a symlink ───────────
    //
    // Ours deletes the path, theirs retargets the symlink — git leaves theirs'
    // symlink in the worktree (never its target bytes as a regular file).

    describe('Given ours deletes a symlink that theirs retargets (Q6)', () => {
      describe('When both tools merge', () => {
        it('Then both tools conflict and the worktree keeps theirs symlink', async () => {
          // Arrange
          peerWrite('root.txt', 'root\n');
          peerAdd('root.txt');
          symlinkSync('old-target', path.join(pair.peer, 't'));
          runGit(['-C', pair.peer, 'add', 't']);
          peerCommit('base');
          peerBranch('side');
          unlinkSync(path.join(pair.peer, 't'));
          symlinkSync('new-target', path.join(pair.peer, 't'));
          runGit(['-C', pair.peer, 'add', 't']);
          peerCommit('theirs-retarget');
          peerCheckout('main');
          runGit(['-C', pair.peer, 'rm', '-q', 't']);
          peerCommit('ours-delete');

          await oursWrite('root.txt', 'root\n');
          await repo.add(['root.txt']);
          symlinkSync('old-target', path.join(pair.ours, 't'));
          await repo.add(['t']);
          await oursCommit('base');
          await repo.branch.create({ name: 'side' });
          await repo.checkout({ rev: 'side' });
          unlinkSync(path.join(pair.ours, 't'));
          symlinkSync('new-target', path.join(pair.ours, 't'));
          await repo.add(['t']);
          await oursCommit('theirs-retarget');
          await repo.checkout({ rev: 'main' });
          await repo.rm(['t']);
          await oursCommit('ours-delete');

          // Act
          const peerResult = peerMergeConflict('side');
          const result = await repo.merge.run({ rev: 'side', message: 'm', author: AUTHOR });

          // Assert — both tools conflict
          expect(peerResult.ok).toBe(false);
          expect(result.kind).toBe('conflict');

          // Stage parity (stage 1 base symlink + stage 3 theirs symlink)
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));

          // Worktree: t is theirs' symlink on both tools
          expect(readlinkSync(path.join(pair.peer, 't'))).toBe('new-target');
          expect(readlinkSync(path.join(pair.ours, 't'))).toBe('new-target');
        });
      });
    });

    // ── P5: with-base distinct-types via revert ──────────────────────────────
    //
    // Root commit has `p` regular. Commit A "make p a symlink". Commit B changes
    // symlink target. Revert A: base=A's tree (symlink), ours=HEAD (symlink at
    // target-b), theirs=A's parent (regular p). → distinct-types; theirs (regular)
    // renamed to `p~parent of <abbrev> (make p a symlink)`.
    // MERGE_MSG must list both `p` and the renamed path.

    describe('Given reverting a symlink-creation commit while HEAD has a changed symlink (P5)', () => {
      describe('When revert runs on both tools', () => {
        it('Then stages, worktree, and MERGE_MSG trailer byte-match git', async () => {
          // Arrange — peer
          peerWrite('root.txt', 'root\n');
          peerWrite('p', 'regular-content\n');
          peerAdd('root.txt', 'p');
          peerCommit('root');
          // Commit A: replace p with a symlink
          runGit(['-C', pair.peer, 'rm', '-q', 'p']);
          peerSymlink('target-a', 'p');
          peerAdd('p');
          peerCommit('make p a symlink');
          const commitA = runGit(['-C', pair.peer, 'rev-parse', 'HEAD']).trim();
          const abbrev = commitA.slice(0, 7);
          // Commit B: change symlink target
          runGit(['-C', pair.peer, 'rm', '-q', 'p']);
          peerSymlink('target-b', 'p');
          peerAdd('p');
          peerCommit('change symlink target');
          // Peer revert commit A
          const peerResult = tryRunGit(
            [
              '-C',
              pair.peer,
              '-c',
              'merge.conflictStyle=merge',
              '-c',
              'core.editor=true',
              'revert',
              '--no-commit',
              commitA,
            ],
            { env: COMMIT_ENV },
          );

          // Arrange — tsgit
          await oursWrite('root.txt', 'root\n');
          await oursWrite('p', 'regular-content\n');
          await repo.add(['root.txt', 'p']);
          await oursCommit('root');
          // Commit A: replace p with a symlink
          await repo.rm(['p']);
          symlinkSync('target-a', path.join(pair.ours, 'p'));
          await repo.add(['p']);
          await oursCommit('make p a symlink');
          const tsgitCommitA = runGit(['-C', pair.ours, 'rev-parse', 'HEAD']).trim();
          // Commit B: change symlink target
          unlinkSync(path.join(pair.ours, 'p'));
          symlinkSync('target-b', path.join(pair.ours, 'p'));
          await repo.add(['p']);
          await oursCommit('change symlink target');

          // Act — revert commit A
          const revertResult = await repo.revert.run({ commits: [tsgitCommitA] });

          // Assert — both tools conflict
          expect(peerResult.ok).toBe(false);
          expect(revertResult.kind).toBe('conflict');

          // Stages match git
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));

          // The rename suffix uses the theirs label: parent of <abbrev> (make p a symlink)
          const renamedPath = `p~parent of ${abbrev} (make p a symlink)`;

          // Worktree: p keeps ours' symlink; the regular side lands at the renamed path
          expect(readlinkSync(path.join(pair.ours, 'p'))).toBe('target-b');
          expect(readlinkSync(path.join(pair.peer, 'p'))).toBe('target-b');
          expect(readFileSync(path.join(pair.ours, renamedPath), 'utf8')).toBe('regular-content\n');
          expect(readFileSync(path.join(pair.peer, renamedPath), 'utf8')).toBe('regular-content\n');

          // MERGE_MSG byte parity
          const oursMergeMsg = await readFile(path.join(pair.ours, '.git', 'MERGE_MSG'), 'utf8');
          const peerMergeMsg = await readFile(path.join(pair.peer, '.git', 'MERGE_MSG'), 'utf8');
          expect(oursMergeMsg).toBe(peerMergeMsg);
          expect(oursMergeMsg).toContain('# Conflicts:\n');
          expect(oursMergeMsg).toContain('#\tp\n');
          expect(oursMergeMsg).toContain(`#\t${renamedPath}\n`);
        });
      });
    });
  },
);
