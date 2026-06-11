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
import { symlinkSync, writeFileSync } from 'node:fs';
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

      // Back to main: replace p with ours' shape
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
  },
);
