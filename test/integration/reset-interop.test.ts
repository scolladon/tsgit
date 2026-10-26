/**
 * Cross-tool interop — `reset` porcelain. Seeds two commits with a pinned
 * identity (so their SHAs match canonical git — proven by
 * `commit-interop.test.ts`), then resets to the first commit in each mode via
 * `repo.reset` and `git reset --<mode>`, asserting HEAD (`git rev-parse`),
 * index (`git ls-files --stage`), and working tree agree.
 *
 * @proves
 *   surface:        reset
 *   bucket:         cross-tool-interop
 *   unique:         reset porcelain HEAD+index+worktree matches canonical git reset
 *   interopSurface: reset
 */
import { rmSync } from 'node:fs';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TsgitError } from '../../src/domain/error.js';
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
  topReflogSubject,
  tryRunGitWithExit,
} from './interop-helpers.js';
import {
  assumingUnchanged,
  buildHistory,
  chmodAt,
  copiedBehindLink,
  danglingLinkAt,
  directoryHolding,
  emptyDirectoryAt,
  type FileIdentity,
  fileAt,
  fileWith,
  flagListing,
  gitlink,
  indexState,
  link1,
  linkAt,
  modeListing,
  movedBehindLink,
  type Occupant,
  regular,
  replacing,
  rewrittenPaths,
  settleIndex,
  skipWorktreeAt,
  staleEntries,
  statSnapshot,
  type TreeEntry,
  touchedAt,
  unmergedAbsentAt,
  unmergedAt,
  v1,
} from './occupant-displacement-fixtures.js';

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

/** A full-width object id no object in either repository carries. */
const ABSENT_OID = '1234567890123456789012345678901234567890';

interface SeedFile {
  readonly path: string;
  readonly content: string;
}

interface ResetSnapshot {
  readonly head: string;
  readonly stage: string;
  readonly a: string | null;
  readonly bExists: boolean;
}

describe.skipIf(!GIT_AVAILABLE)('reset porcelain interop', () => {
  let pair: PeerPair;
  let repo: Repository;

  beforeEach(async () => {
    pair = await makePeerPair('reset');
    runGit(['init', '-q', '-b', 'main', pair.peer]);
    repo = await openRepository({ cwd: pair.ours });
    await repo.init();
  });

  afterEach(async () => {
    await repo.dispose();
    await pair.dispose();
  });

  const writeBoth = async (file: SeedFile): Promise<void> => {
    await writeFile(path.join(pair.peer, file.path), file.content);
    await writeFile(path.join(pair.ours, file.path), file.content);
  };

  const commitBoth = async (message: string, files: ReadonlyArray<SeedFile>): Promise<string> => {
    for (const file of files) await writeBoth(file);
    const paths = files.map((file) => file.path);
    runGit(['-C', pair.peer, 'add', ...paths]);
    // whitespace cleanup so the peer commit id matches tsgit's
    runGit(['-C', pair.peer, '-c', 'commit.cleanup=whitespace', 'commit', '-q', '-m', message], {
      env: COMMIT_ENV,
    });
    await repo.add(paths);
    const { id } = await repo.commit({ message, author: AUTHOR, committer: AUTHOR });
    return id;
  };

  const seedTwoCommits = async (): Promise<{ readonly c0: string }> => {
    const c0 = await commitBoth('c0', [{ path: 'a.txt', content: 'v0\n' }]);
    await commitBoth('c1', [
      { path: 'a.txt', content: 'v1\n' },
      { path: 'b.txt', content: 'b\n' },
    ]);
    return { c0 };
  };

  const pathExists = async (dir: string, rel: string): Promise<boolean> => {
    try {
      await stat(path.join(dir, rel));
      return true;
    } catch {
      return false;
    }
  };

  const readMaybe = async (dir: string, rel: string): Promise<string | null> => {
    try {
      return await readFile(path.join(dir, rel), 'utf8');
    } catch {
      return null;
    }
  };

  const snapshot = async (dir: string): Promise<ResetSnapshot> => ({
    head: runGit(['-C', dir, 'rev-parse', 'HEAD']).trim(),
    stage: lsStage(dir),
    a: await readMaybe(dir, 'a.txt'),
    bExists: await pathExists(dir, 'b.txt'),
  });

  describe('Given two commits with the second adding a file and editing another', () => {
    describe('When repo.reset --soft moves HEAD back like git reset --soft', () => {
      it('Then HEAD moves but index and working tree match git', async () => {
        // Arrange
        const { c0 } = await seedTwoCommits();

        // Act
        await repo.reset({ mode: 'soft', rev: c0 });
        runGit(['-C', pair.peer, 'reset', '--soft', c0]);
        const result = await snapshot(pair.ours);

        // Assert
        expect(result).toEqual(await snapshot(pair.peer));
        expect(result.head).toBe(c0);
      });
    });

    describe('When repo.reset --mixed rewinds the index like git reset --mixed', () => {
      it('Then HEAD and index rewind but the working tree is untouched, like git', async () => {
        // Arrange
        const { c0 } = await seedTwoCommits();

        // Act
        await repo.reset({ mode: 'mixed', rev: c0 });
        runGit(['-C', pair.peer, 'reset', '--mixed', c0]);
        const result = await snapshot(pair.ours);

        // Assert
        expect(result).toEqual(await snapshot(pair.peer));
        expect(result.head).toBe(c0);
        expect(result.bExists).toBe(true);
      });
    });

    describe('When repo.reset --hard rewinds everything like git reset --hard', () => {
      it('Then HEAD, index, and working tree all rewind identically to git', async () => {
        // Arrange
        const { c0 } = await seedTwoCommits();

        // Act
        await repo.reset({ mode: 'hard', rev: c0 });
        runGit(['-C', pair.peer, 'reset', '--hard', c0]);
        const result = await snapshot(pair.ours);

        // Assert
        expect(result).toEqual(await snapshot(pair.peer));
        expect(result.head).toBe(c0);
        expect(result.a).toBe('v0\n');
        expect(result.bExists).toBe(false);
      });
    });
  });

  describe('Given a detached HEAD at the tip', () => {
    const detachBoth = async (tip: string): Promise<void> => {
      runGit(['-C', pair.peer, 'checkout', '--detach', tip]);
      await repo.checkout({ rev: tip, detach: true });
    };

    describe('When reset --hard HEAD is a no-move on both tools', () => {
      it('Then neither git nor tsgit appends a HEAD reflog entry', async () => {
        // Arrange — seed, detach to the tip on both, snapshot each HEAD reflog top.
        await seedTwoCommits();
        const tip = runGit(['-C', pair.peer, 'rev-parse', 'HEAD']).trim();
        await detachBoth(tip);
        const peerBefore = topReflogSubject(pair.peer, 'HEAD');
        const oursBefore = topReflogSubject(pair.ours, 'HEAD');

        // Act — reset to the same oid: a detached direct-ref no-move writes nothing.
        runGit(['-C', pair.peer, 'reset', '--hard', 'HEAD']);
        await repo.reset({ mode: 'hard', rev: 'HEAD' });

        // Assert — each tool's HEAD reflog top is unchanged by the reset. The
        // before/after-per-tool form isolates the gate from any checkout-message
        // formatting difference between the tools.
        expect(topReflogSubject(pair.peer, 'HEAD')).toBe(peerBefore);
        expect(topReflogSubject(pair.ours, 'HEAD')).toBe(oursBefore);
      });
    });

    describe('When reset --hard <c0> moves the detached HEAD on both tools', () => {
      it('Then both append the identical `reset: moving to <c0>` HEAD entry', async () => {
        // Arrange — seed, detach to the tip on both.
        const { c0 } = await seedTwoCommits();
        const tip = runGit(['-C', pair.peer, 'rev-parse', 'HEAD']).trim();
        await detachBoth(tip);

        // Act — a real move records the faithful message on both tools.
        runGit(['-C', pair.peer, 'reset', '--hard', c0]);
        await repo.reset({ mode: 'hard', rev: c0 });

        // Assert — guards the routing from over-skipping a real move.
        const result = topReflogSubject(pair.ours, 'HEAD');
        expect(result).toBe(`reset: moving to ${c0}`);
        expect(result).toBe(topReflogSubject(pair.peer, 'HEAD'));
      });
    });
  });

  describe('Given an empty-tree commit and no index file', () => {
    describe('When git and tsgit reset --hard HEAD', () => {
      it('Then both write the same index bytes', async () => {
        // Arrange
        const indexBytes = async (dir: string): Promise<Buffer> =>
          readFile(path.join(dir, '.git', 'index'));
        for (const dir of [pair.peer, pair.ours]) {
          const emptyTree = runGit(['-C', dir, 'mktree'], { input: '' }).trim();
          const id = runGit(['-C', dir, 'commit-tree', '-m', 'empty', emptyTree], {
            env: COMMIT_ENV,
          }).trim();
          runGit(['-C', dir, 'update-ref', 'refs/heads/main', id]);
          await rm(path.join(dir, '.git', 'index'), { force: true });
        }

        // Act
        runGit(['-C', pair.peer, 'reset', '-q', '--hard', 'HEAD']);
        await repo.reset({ mode: 'hard', rev: 'HEAD' });

        // Assert
        const expected = await indexBytes(pair.peer);
        expect(expected.length).toBe(65);
        expect((await indexBytes(pair.ours)).equals(expected)).toBe(true);
      });
    });
  });

  describe.each([
    {
      rev: ABSENT_OID,
      mode: 'soft' as const,
      stderr: `fatal: Could not parse object '${ABSENT_OID}'.`,
      data: { code: 'OBJECT_NOT_FOUND', id: ABSENT_OID },
    },
    {
      rev: ABSENT_OID,
      mode: 'hard' as const,
      stderr: `fatal: Could not parse object '${ABSENT_OID}'.`,
      data: { code: 'OBJECT_NOT_FOUND', id: ABSENT_OID },
    },
    {
      rev: `${ABSENT_OID}~1`,
      mode: 'mixed' as const,
      stderr: `fatal: ambiguous argument '${ABSENT_OID}~1': unknown revision`,
      data: { code: 'REVPARSE_UNRESOLVED', expression: `${ABSENT_OID}~1` },
    },
  ])('Given a full-width object id naming no object ($rev)', ({ rev, mode, stderr, data }) => {
    describe(`When git and tsgit reset --${mode} to it`, () => {
      it('Then both refuse with the matching failure and leave HEAD alone', async () => {
        // Arrange
        await seedTwoCommits();
        const peerHead = runGit(['-C', pair.peer, 'rev-parse', 'HEAD']).trim();
        const sut = repo.reset;

        // Act
        const gitResult = tryRunGitWithExit(['-C', pair.peer, 'reset', `--${mode}`, rev]);
        const failure = await sut({ mode, rev }).then(
          () => undefined,
          (error: unknown) => (error as TsgitError).data,
        );

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toContain(stderr);
        expect(failure).toEqual(data);
        expect(runGit(['-C', pair.ours, 'rev-parse', 'HEAD']).trim()).toBe(peerHead);
      });
    });
  });

  const stagedAt =
    (rel: string, content: string): Occupant =>
    (dir) => {
      fileWith(rel, content)(dir);
      runGit(['-C', dir, 'add', rel]);
    };

  interface WorkTreeShape {
    readonly tracked: ReadonlyArray<TreeEntry>;
    readonly plant: Occupant;
  }

  const shapes: Readonly<Record<string, WorkTreeShape>> = {
    C: { tracked: [v1('f')], plant: () => undefined },
    E: { tracked: [v1('f')], plant: fileWith('f', 'edited\n') },
    T: { tracked: [v1('f')], plant: touchedAt('f') },
    M: { tracked: [v1('f')], plant: chmodAt('f') },
    Dw: { tracked: [v1('f')], plant: (dir) => rmSync(path.join(dir, 'f')) },
    AU: { tracked: [v1('f')], plant: assumingUnchanged('f', fileWith('f', 'edited\n')) },
    SW: { tracked: [v1('f')], plant: skipWorktreeAt('f', fileWith('f', 'edited\n')) },
    S3a: { tracked: [v1('a/payload')], plant: replacing('a/payload', danglingLinkAt('a')) },
    S3g: { tracked: [v1('a/payload')], plant: copiedBehindLink('a', 'held') },
    S3i: { tracked: [v1('a/payload')], plant: movedBehindLink('a', 'held') },
    S1: { tracked: [v1('d/x')], plant: replacing('d/x', fileAt('d')) },
    S2: { tracked: [v1('f')], plant: replacing('f', directoryHolding('f', 'u')) },
    S2e: { tracked: [v1('f')], plant: replacing('f', emptyDirectoryAt('f')) },
    S3b: { tracked: [v1('f')], plant: replacing('f', danglingLinkAt('f')) },
    LF: { tracked: [v1('f'), v1('g')], plant: linkAt('f', 'g') },
    S3f: { tracked: [link1('l')], plant: replacing('l', fileWith('l', 't-v1')) },
    S3c: { tracked: [link1('l')], plant: replacing('l', directoryHolding('l', 'u')) },
    S3d: { tracked: [link1('d/l')], plant: replacing('d/l', fileAt('d')) },
    LR: { tracked: [link1('l')], plant: linkAt('l', 'elsewhere') },
    GL: { tracked: [gitlink('s')], plant: () => undefined },
    GLf: { tracked: [gitlink('s')], plant: replacing('s', fileAt('s')) },
    ST: { tracked: [v1('f')], plant: stagedAt('f', 'staged\n') },
    SA: { tracked: [v1('f')], plant: stagedAt('n', 'new\n') },
    SD: { tracked: [v1('f')], plant: (dir) => void runGit(['-C', dir, 'rm', '-q', 'f']) },
    SDk: {
      tracked: [v1('f')],
      plant: (dir) => void runGit(['-C', dir, 'rm', '-q', '--cached', 'f']),
    },
    U: { tracked: [v1('f')], plant: fileWith('u', 'untracked\n') },
    UM: { tracked: [v1('f')], plant: unmergedAt('f') },
    UMn: { tracked: [v1('f')], plant: unmergedAbsentAt('n') },
  };

  interface Observed {
    readonly work: string[];
    readonly index: string[];
    readonly flags: string;
    readonly stale: string[];
    readonly rewritten: string[];
  }

  const observe = (dir: string, before: ReadonlyMap<string, FileIdentity>): Observed => ({
    work: modeListing(dir),
    index: indexState(dir),
    flags: flagListing(dir),
    stale: staleEntries(dir),
    rewritten: rewrittenPaths(before, statSnapshot(dir)),
  });

  describe.each(Object.entries(shapes))(
    'Given the work tree shape %s over a settled index',
    (_name, shape) => {
      describe('When git and tsgit reset --hard HEAD', () => {
        it('Then the work tree, the index, its flags and the stale and rewritten sets match git', async () => {
          // Arrange
          for (const dir of [pair.peer, pair.ours]) {
            buildHistory(dir, [...shape.tracked, regular('other')], shape.tracked);
            settleIndex(dir);
            shape.plant(dir);
          }
          const peerBefore = statSnapshot(pair.peer);
          const oursBefore = statSnapshot(pair.ours);

          // Act
          runGit(['-C', pair.peer, 'reset', '-q', '--hard', 'HEAD']);
          await repo.reset({ mode: 'hard', rev: 'HEAD' });

          // Assert
          expect(observe(pair.ours, oursBefore)).toEqual(observe(pair.peer, peerBefore));
        });
      });
    },
  );
});
