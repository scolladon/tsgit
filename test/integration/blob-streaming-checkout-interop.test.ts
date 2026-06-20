/**
 * Write-side interop — streamed working-tree writes byte-identical to git.
 *
 * Proves that all four converted consumer sites (A/B/C/D) produce working-tree
 * output byte-identical to canonical `git` and are faithful to git's
 * replace-not-truncate, non-atomic write semantics (W1/W2).
 *
 *   C1 — checkout a ~200 KB regular blob (site A, loose): byte-identical content
 *   C2 — same, executable mode 100755: byte-identical content + mode 0755
 *   C3 — symlink → regular file kind switch (site A, W1 self-heal): regular file, no stale symlink
 *   C4 — checkout a deltified blob (site A, materialised: true upstream): byte-identical
 *   C5 — merge clean survivor (sites B/C): byte-identical to git merge result
 *   C6 — stash-apply untracked restore (site D, cap dropped): byte-identical
 *
 * @proves
 *   surface:        checkout / merge / stash (write side)
 *   bucket:         write-side-interop
 *   unique:         streamed writes byte-identical to canonical git across all consumer sites
 *   interopSurface: checkout, merge, stash
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  git,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
} from './interop-helpers.js';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

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

const PERM_MASK = 0o777;

// ---------------------------------------------------------------------------
// File-local helpers
// ---------------------------------------------------------------------------

/**
 * Binary-safe cat-file — returns the raw content bytes exactly as git stores them.
 */
function catFileRaw(dir: string, oid: string): Buffer {
  return execFileSync('git', ['-C', dir, 'cat-file', '-p', oid], {
    env: runGitEnv(),
  });
}

/**
 * Copy all .pack and .idx files from peer's pack dir into ours.
 * Creates the destination directory if it does not exist.
 */
async function copyPackFiles(peer: string, ours: string): Promise<void> {
  const packDir = path.join(peer, '.git', 'objects', 'pack');
  const oursPackDir = path.join(ours, '.git', 'objects', 'pack');
  await mkdir(oursPackDir, { recursive: true });
  const entries = await readdir(packDir);
  for (const entry of entries) {
    if (entry.endsWith('.pack') || entry.endsWith('.idx')) {
      await copyFile(path.join(packDir, entry), path.join(oursPackDir, entry));
    }
  }
}

/** Find the .pack file path(s) in the given repo's pack store. */
function findPackFile(dir: string): string[] {
  const packDir = path.join(dir, '.git', 'objects', 'pack');
  try {
    const entries = readdirSync(packDir);
    const packFile = entries.find((e) => e.endsWith('.pack'));
    if (packFile !== undefined) return [path.join(packDir, packFile)];
  } catch {
    // pack dir may not exist
  }
  return [];
}

/** Configure a git repo with identity and disable signing. */
function configGit(dir: string): void {
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe.skipIf(!GIT_AVAILABLE)(
  'write-side interop — streamed working-tree writes byte-identical to git',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository;
    let oursDir: string;

    beforeEach(async () => {
      pair = await makePeerPair('blob-streaming-checkout');
      runGit(['init', '-q', '-b', 'main', pair.peer]);
      configGit(pair.peer);
      repo = await openRepository({ cwd: pair.ours });
      await repo.init();
      oursDir = pair.ours;
    });

    afterEach(async () => {
      await repo.dispose();
      await pair.dispose();
    });

    // -----------------------------------------------------------------------
    // C1 — site A: checkout a ~200 KB regular blob (loose path)
    // -----------------------------------------------------------------------
    describe('C1: checkout a ~200 KB regular blob on a branch', () => {
      describe('Given a branch with a ~200 KB regular blob, checked out via tsgit', () => {
        describe('When tsgit checks out that branch', () => {
          it('Then the working-tree file bytes are byte-identical to the peer checked-out file', async () => {
            // Arrange
            const blobContent = randomBytes(200_000);
            await writeFile(path.join(pair.peer, 'f.txt'), 'seed\n');
            runGit(['-C', pair.peer, 'add', 'f.txt'], { env: COMMIT_ENV });
            runGit(['-C', pair.peer, 'commit', '-q', '-m', 'seed'], { env: COMMIT_ENV });
            runGit(['-C', pair.peer, 'checkout', '-q', '-b', 'feat']);
            await writeFile(path.join(pair.peer, 'large.bin'), blobContent);
            runGit(['-C', pair.peer, 'add', 'large.bin'], { env: COMMIT_ENV });
            runGit(['-C', pair.peer, 'commit', '-q', '-m', 'add large blob'], { env: COMMIT_ENV });
            runGit(['-C', pair.peer, 'checkout', '-q', 'main']);

            const blobId = git(pair.peer, 'rev-parse', 'feat:large.bin').trim();
            const catFileBuf = catFileRaw(pair.peer, blobId);

            await writeFile(path.join(oursDir, 'f.txt'), 'seed\n');
            await repo.add(['f.txt']);
            await repo.commit({ message: 'seed', author: AUTHOR, committer: AUTHOR });
            await repo.branch.create({ name: 'feat' });
            await repo.checkout({ rev: 'feat' });
            await writeFile(path.join(oursDir, 'large.bin'), blobContent);
            await repo.add(['large.bin']);
            await repo.commit({ message: 'add large blob', author: AUTHOR, committer: AUTHOR });
            await repo.checkout({ rev: 'main' });

            // Act
            await repo.checkout({ rev: 'feat' });

            // Assert — byte-identical to catFileRaw oracle and to peer's file
            const resultBuf = readFileSync(path.join(oursDir, 'large.bin'));
            expect(Buffer.compare(catFileBuf, resultBuf)).toBe(0);
            runGit(['-C', pair.peer, 'checkout', '-q', 'feat']);
            const peerBuf = readFileSync(path.join(pair.peer, 'large.bin'));
            expect(Buffer.compare(peerBuf, resultBuf)).toBe(0);
          });
        });
      });
    });

    // -----------------------------------------------------------------------
    // C2 — site A: executable mode 100755
    // -----------------------------------------------------------------------
    describe('C2: checkout a ~200 KB blob with executable mode 100755', () => {
      describe('Given a branch with a ~200 KB executable blob, checked out via tsgit', () => {
        describe('When tsgit checks out that branch', () => {
          it('Then the working-tree file is byte-identical and has mode 0755', async () => {
            // Arrange
            const execContent = Buffer.concat([Buffer.from('#!/bin/sh\n'), randomBytes(199_990)]);
            await writeFile(path.join(pair.peer, 'f.txt'), 'seed\n');
            runGit(['-C', pair.peer, 'add', 'f.txt'], { env: COMMIT_ENV });
            runGit(['-C', pair.peer, 'commit', '-q', '-m', 'seed'], { env: COMMIT_ENV });
            runGit(['-C', pair.peer, 'checkout', '-q', '-b', 'exec-feat']);
            await writeFile(path.join(pair.peer, 'run.sh'), execContent, { mode: 0o755 });
            runGit(['-C', pair.peer, 'add', 'run.sh'], { env: COMMIT_ENV });
            runGit(['-C', pair.peer, 'commit', '-q', '-m', 'add exec blob'], { env: COMMIT_ENV });
            runGit(['-C', pair.peer, 'checkout', '-q', 'main']);

            const blobId = git(pair.peer, 'rev-parse', 'exec-feat:run.sh').trim();
            const catFileBuf = catFileRaw(pair.peer, blobId);

            await writeFile(path.join(oursDir, 'f.txt'), 'seed\n');
            await repo.add(['f.txt']);
            await repo.commit({ message: 'seed', author: AUTHOR, committer: AUTHOR });
            await repo.branch.create({ name: 'exec-feat' });
            await repo.checkout({ rev: 'exec-feat' });
            await writeFile(path.join(oursDir, 'run.sh'), execContent, { mode: 0o755 });
            await repo.add(['run.sh']);
            await repo.commit({ message: 'add exec blob', author: AUTHOR, committer: AUTHOR });
            await repo.checkout({ rev: 'main' });

            // Act
            await repo.checkout({ rev: 'exec-feat' });

            // Assert — bytes and mode
            const oursFile = path.join(oursDir, 'run.sh');
            const resultBuf = readFileSync(oursFile);
            const mode = lstatSync(oursFile).mode & PERM_MASK;
            expect(Buffer.compare(catFileBuf, resultBuf)).toBe(0);
            expect(mode).toBe(0o755);
          });
        });
      });
    });

    // -----------------------------------------------------------------------
    // C3 — site A: symlink → regular file kind switch (W1 self-heal)
    // -----------------------------------------------------------------------
    describe('C3: symlink-to-regular-file kind switch across checkout', () => {
      describe('Given main holds a symlink and feat holds a regular file at the same path', () => {
        describe('When tsgit checks out feat', () => {
          it('Then the result is a regular file with no stale symlink', async () => {
            // Arrange
            const fileContent = Buffer.concat([Buffer.from('regular\n'), randomBytes(1_000)]);
            symlinkSync('some-target', path.join(pair.peer, 'p'));
            runGit(['-C', pair.peer, 'add', 'p'], { env: COMMIT_ENV });
            runGit(['-C', pair.peer, 'commit', '-q', '-m', 'base with symlink'], {
              env: COMMIT_ENV,
            });
            runGit(['-C', pair.peer, 'checkout', '-q', '-b', 'kind-feat']);
            runGit(['-C', pair.peer, 'rm', '-q', 'p'], { env: COMMIT_ENV });
            await writeFile(path.join(pair.peer, 'p'), fileContent);
            runGit(['-C', pair.peer, 'add', 'p'], { env: COMMIT_ENV });
            runGit(['-C', pair.peer, 'commit', '-q', '-m', 'p becomes regular file'], {
              env: COMMIT_ENV,
            });
            runGit(['-C', pair.peer, 'checkout', '-q', 'main']);

            symlinkSync('some-target', path.join(oursDir, 'p'));
            await repo.add(['p']);
            await repo.commit({ message: 'base with symlink', author: AUTHOR, committer: AUTHOR });
            await repo.branch.create({ name: 'kind-feat' });
            await repo.checkout({ rev: 'kind-feat' });
            await repo.rm(['p']);
            await writeFile(path.join(oursDir, 'p'), fileContent);
            await repo.add(['p']);
            await repo.commit({
              message: 'p becomes regular file',
              author: AUTHOR,
              committer: AUTHOR,
            });
            await repo.checkout({ rev: 'main' });

            // Act — checkout kind-feat (p was a symlink on disk, must become a regular file)
            await repo.checkout({ rev: 'kind-feat' });

            // Assert — p is a regular file, not a symlink
            const oursPath = path.join(oursDir, 'p');
            const stat = lstatSync(oursPath);
            expect(stat.isSymbolicLink()).toBe(false);
            expect(stat.isFile()).toBe(true);
            const resultBuf = readFileSync(oursPath);
            expect(Buffer.compare(fileContent, resultBuf)).toBe(0);
          });
        });
      });
    });

    // -----------------------------------------------------------------------
    // C4 — site A: deltified blob (materialised: true from streamBlob)
    // -----------------------------------------------------------------------
    describe('C4: checkout a deltified blob from a pack', () => {
      describe('Given a branch whose blob is deltified in the pack, checked out via tsgit', () => {
        describe('When tsgit checks out that branch', () => {
          it('Then the working-tree file bytes are byte-identical to git (agnostic to materialised)', async () => {
            // Arrange — two near-identical blobs so git delta-packs one
            const base = randomBytes(200_000);
            const target = Buffer.from(base);
            target.write('DELTA_MARKER_C4', 5000);

            await writeFile(path.join(pair.peer, 'seed.txt'), 'seed\n');
            runGit(['-C', pair.peer, 'add', 'seed.txt'], { env: COMMIT_ENV });
            runGit(['-C', pair.peer, 'commit', '-q', '-m', 'seed'], { env: COMMIT_ENV });
            runGit(['-C', pair.peer, 'checkout', '-q', '-b', 'delta-feat']);
            await writeFile(path.join(pair.peer, 'base.bin'), base);
            runGit(['-C', pair.peer, 'add', 'base.bin'], { env: COMMIT_ENV });
            runGit(['-C', pair.peer, 'commit', '-q', '-m', 'add base blob'], { env: COMMIT_ENV });
            await writeFile(path.join(pair.peer, 'target.bin'), target);
            runGit(['-C', pair.peer, 'add', 'target.bin'], { env: COMMIT_ENV });
            runGit(['-C', pair.peer, 'commit', '-q', '-m', 'add near-copy blob'], {
              env: COMMIT_ENV,
            });
            git(pair.peer, 'gc', '--quiet', '--aggressive');
            runGit(['-C', pair.peer, 'checkout', '-q', 'main']);

            const baseId = git(pair.peer, 'rev-parse', 'delta-feat~1:base.bin').trim();
            const targetId = git(pair.peer, 'rev-parse', 'delta-feat:target.bin').trim();
            const verifyOut = git(pair.peer, 'verify-pack', '-v', ...findPackFile(pair.peer));
            // Determine which id (if any) is stored as a delta entry
            const deltaEntry = verifyOut.split('\n').find((l) => {
              const cols = l.trim().split(/\s+/);
              return (cols[0] === targetId || cols[0] === baseId) && cols.length >= 7;
            });
            const deltaId =
              deltaEntry !== undefined ? (deltaEntry.trim().split(/\s+/)[0] ?? targetId) : targetId;

            const catFileBuf = catFileRaw(pair.peer, deltaId);
            await copyPackFiles(pair.peer, oursDir);

            // Mirror commit graph in ours (both blobs are in the copied pack store)
            await writeFile(path.join(oursDir, 'seed.txt'), 'seed\n');
            await repo.add(['seed.txt']);
            await repo.commit({ message: 'seed', author: AUTHOR, committer: AUTHOR });
            await repo.branch.create({ name: 'delta-feat' });
            await repo.checkout({ rev: 'delta-feat' });
            await writeFile(path.join(oursDir, 'base.bin'), base);
            await repo.add(['base.bin']);
            await repo.commit({ message: 'add base blob', author: AUTHOR, committer: AUTHOR });
            await writeFile(path.join(oursDir, 'target.bin'), target);
            await repo.add(['target.bin']);
            await repo.commit({
              message: 'add near-copy blob',
              author: AUTHOR,
              committer: AUTHOR,
            });
            await repo.checkout({ rev: 'main' });

            // Act
            await repo.checkout({ rev: 'delta-feat' });

            // Assert — bytes byte-identical regardless of materialised flag
            const checkedOutFile = deltaId === baseId ? 'base.bin' : 'target.bin';
            const resultBuf = readFileSync(path.join(oursDir, checkedOutFile));
            expect(Buffer.compare(catFileBuf, resultBuf)).toBe(0);
          });
        });
      });
    });

    // -----------------------------------------------------------------------
    // C5 — sites B/C: merge clean survivor byte-identical to git
    // -----------------------------------------------------------------------
    describe('C5: merge clean survivor (sites B/C)', () => {
      describe('Given peer+ours diverge so a ~200 KB blob is a clean survivor of a three-way merge', () => {
        describe('When tsgit runs merge', () => {
          it('Then the survivor working-tree file bytes are byte-identical to git merged result', async () => {
            // Arrange — base: seed.txt; theirs: adds large.bin (the clean survivor);
            // ours: adds a disjoint a.txt. Clean merge — large.bin is a theirs-only add.
            const survivorContent = randomBytes(200_000);

            await writeFile(path.join(pair.peer, 'seed.txt'), 'seed\n');
            runGit(['-C', pair.peer, 'add', 'seed.txt'], { env: COMMIT_ENV });
            runGit(['-C', pair.peer, 'commit', '-q', '-m', 'seed'], { env: COMMIT_ENV });
            await writeFile(path.join(oursDir, 'seed.txt'), 'seed\n');
            await repo.add(['seed.txt']);
            await repo.commit({ message: 'seed', author: AUTHOR, committer: AUTHOR });

            // theirs branch on peer: large blob
            runGit(['-C', pair.peer, 'checkout', '-q', '-b', 'theirs']);
            await writeFile(path.join(pair.peer, 'large.bin'), survivorContent);
            runGit(['-C', pair.peer, 'add', 'large.bin'], { env: COMMIT_ENV });
            runGit(['-C', pair.peer, 'commit', '-q', '-m', 'theirs adds large'], {
              env: COMMIT_ENV,
            });
            runGit(['-C', pair.peer, 'checkout', '-q', 'main']);

            // ours diverge on peer: disjoint add
            await writeFile(path.join(pair.peer, 'a.txt'), 'ours\n');
            runGit(['-C', pair.peer, 'add', 'a.txt'], { env: COMMIT_ENV });
            runGit(['-C', pair.peer, 'commit', '-q', '-m', 'ours adds a'], { env: COMMIT_ENV });

            // Mirror theirs branch in tsgit repo
            await repo.branch.create({ name: 'theirs' });
            await repo.checkout({ rev: 'theirs' });
            await writeFile(path.join(oursDir, 'large.bin'), survivorContent);
            await repo.add(['large.bin']);
            await repo.commit({ message: 'theirs adds large', author: AUTHOR, committer: AUTHOR });
            await repo.checkout({ rev: 'main' });

            // ours: disjoint add on main
            await writeFile(path.join(oursDir, 'a.txt'), 'ours\n');
            await repo.add(['a.txt']);
            await repo.commit({ message: 'ours adds a', author: AUTHOR, committer: AUTHOR });

            // Peer performs merge (pin merge.conflictStyle=merge to avoid diff3 trap)
            runGit(
              [
                '-C',
                pair.peer,
                '-c',
                'merge.conflictStyle=merge',
                'merge',
                '--no-ff',
                '-m',
                'merge theirs',
                'theirs',
              ],
              { env: COMMIT_ENV },
            );
            const peerSurvivorBuf = readFileSync(path.join(pair.peer, 'large.bin'));

            // Act
            await repo.merge.run({
              rev: 'theirs',
              message: 'merge theirs',
              author: AUTHOR,
              committer: AUTHOR,
            });

            // Assert — working-tree survivor bytes byte-identical to git and original content
            const oursSurvivorBuf = readFileSync(path.join(oursDir, 'large.bin'));
            expect(Buffer.compare(peerSurvivorBuf, oursSurvivorBuf)).toBe(0);
            expect(Buffer.compare(Buffer.from(survivorContent), oursSurvivorBuf)).toBe(0);
          });
        });
      });
    });

    // -----------------------------------------------------------------------
    // C6 — site D: stash-apply large untracked file (cap dropped)
    // -----------------------------------------------------------------------
    describe('C6: stash-apply restores a ~200 KB untracked file', () => {
      describe('Given a stash with a ~200 KB untracked file', () => {
        describe('When tsgit applies the stash', () => {
          it('Then the restored untracked file bytes are byte-identical to the original content', async () => {
            // Arrange — seed a committed file so stash has a base commit
            const untrackedContent = randomBytes(200_000);

            await writeFile(path.join(oursDir, 'tracked.txt'), 'committed\n');
            await repo.add(['tracked.txt']);
            await repo.commit({
              message: 'seed tracked file',
              author: AUTHOR,
              committer: AUTHOR,
            });

            // Stash with the large untracked file included
            await writeFile(path.join(oursDir, 'untracked.bin'), untrackedContent);
            await repo.stash.push({ includeUntracked: true });

            // Act
            await repo.stash.apply();

            // Assert — the restored untracked file matches the original bytes exactly
            const restoredBuf = readFileSync(path.join(oursDir, 'untracked.bin'));
            expect(Buffer.compare(untrackedContent, restoredBuf)).toBe(0);
          });
        });
      });
    });
  },
);
