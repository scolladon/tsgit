/**
 * Cross-tool interop — a loose object whose header size disagrees with its
 * body, against real git.
 *
 * @proves
 *   surface:        readObject, catFile, streamBlob
 *   bucket:         cross-tool-interop
 *   unique:         a loose object whose header size disagrees with its body, against git 2.55.0
 *   interopSurface: readObject, catFile, streamBlob
 */
import { createHash } from 'node:crypto';
import { chmod, cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { archive } from '../../src/application/commands/archive.js';
import { catFile } from '../../src/application/commands/cat-file.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { diff } from '../../src/application/commands/diff.js';
import { show } from '../../src/application/commands/show.js';
import { status } from '../../src/application/commands/status.js';
import { readObject } from '../../src/application/primitives/read-object.js';
import { streamBlob } from '../../src/application/primitives/stream-blob.js';
import { writeObject } from '../../src/application/primitives/write-object.js';
import { tarArchive } from '../../src/domain/archive/tar.js';
import type { StatTreeDiff } from '../../src/domain/diff/index.js';
import { TsgitError } from '../../src/domain/error.js';
import type { Blob, ObjectId } from '../../src/domain/objects/index.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  runGitBytes,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const EPOCH = 1_700_000_000;

const datedEnv = (): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: `${EPOCH} +0000`,
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_COMMITTER_DATE: `${EPOCH} +0000`,
});

const loosePath = (dir: string, id: string): string =>
  path.join(dir, '.git', 'objects', id.slice(0, 2), id.slice(2));

/** The raw stored content behind a HONEST loose object at `id` — the bytes
 *  after its `<type> <size>\0` header, read straight off disk (never
 *  through `cat-file -p`, whose tree/commit renderings diverge from the
 *  raw stored form). */
const honestContent = async (dir: string, id: string): Promise<Buffer> => {
  const compressed = await readFile(loosePath(dir, id));
  const inflated = inflateSync(compressed);
  const nul = inflated.indexOf(0);
  return inflated.subarray(nul + 1);
};

/** Overwrites the loose object at `id` with a header whose size claim is
 *  `claim` instead of `body`'s real length — a size-lying loose object at
 *  the id's real (honest) path. */
/**
 * How far past the real body an over-long size claim reaches. Only the
 * DIRECTION is load-bearing: git zero-fills the residual whatever its width,
 * so its accepting verbs read the commit and its verifying ones refuse on the
 * hash. Measured across claims of +1, +5, +10, +100, +283, +284 and +1000 —
 * the same split verdict every time — so the exact width below is arbitrary.
 */
const OVER_CLAIM_BYTES = 283;

const forgeLoose = async (
  dir: string,
  id: string,
  type: string,
  claim: number | string,
  body: Buffer,
): Promise<void> => {
  const target = loosePath(dir, id);
  await chmod(target, 0o644);
  const header = Buffer.from(`${type} ${claim}\0`);
  await writeFile(target, deflateSync(Buffer.concat([header, body])));
};

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

const SMALL_CONTENT = Buffer.from('hello world\n'); // 12 bytes
const mediumLines = Array.from({ length: 40 }, (_, i) => `${'x'.repeat(45)}${i % 10}`);
const MEDIUM_CONTENT = Buffer.from(`${mediumLines.join('\n')}\n`); // 40 * 47 = 1880 bytes

describe.skipIf(!GIT_AVAILABLE)('loose-object header size lying interop', () => {
  let baseDir = '';
  let smallId = '';
  let mediumId = '';
  let treeId = '';
  let commitId = '';
  const caseRoots: string[] = [];

  beforeAll(async () => {
    baseDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-loose-size-interop-base-'));
    runGit(['init', '-q', '-b', 'main', baseDir]);
    git(baseDir, 'config', 'user.name', 'Ada');
    git(baseDir, 'config', 'user.email', 'ada@example.com');
    git(baseDir, 'config', 'commit.gpgsign', 'false');
    disableAutoMaintenance(baseDir);
    await writeFile(path.join(baseDir, 'small.txt'), SMALL_CONTENT);
    await writeFile(path.join(baseDir, 'medium.txt'), MEDIUM_CONTENT);
    git(baseDir, 'add', '-A');
    runGit(['-C', baseDir, 'commit', '-q', '-m', 'base'], { env: datedEnv() });
    smallId = git(baseDir, 'rev-parse', 'HEAD:small.txt').trim();
    mediumId = git(baseDir, 'rev-parse', 'HEAD:medium.txt').trim();
    treeId = git(baseDir, 'rev-parse', 'HEAD^{tree}').trim();
    commitId = git(baseDir, 'rev-parse', 'HEAD').trim();
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
    await Promise.all(
      caseRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  /** Every row gets its own copy of the shared base repo — both git and
   *  tsgit read the same forged bytes by construction. */
  const caseDir = async (slug: string): Promise<string> => {
    const root = await mkdtemp(path.join(os.tmpdir(), `tsgit-loose-size-interop-${slug}-`));
    caseRoots.push(root);
    const target = path.join(root, 'repo');
    await cp(baseDir, target, { recursive: true });
    return target;
  };

  /** A medium-blob overrun case (claim 500, past git's 32-byte header
   *  window) with a second commit that replaces `medium.txt`'s content —
   *  the fixture every overrun-diff row shares. */
  const caseDirWithOverrunSecondCommit = async (slug: string): Promise<string> => {
    const dir = await caseDir(slug);
    await forgeLoose(dir, mediumId, 'blob', 500, MEDIUM_CONTENT);
    await writeFile(path.join(dir, 'medium.txt'), 'replacement content\n');
    git(dir, 'add', '-A');
    runGit(['-C', dir, 'commit', '-q', '-m', 'second'], { env: datedEnv() });
    return dir;
  };

  describe('Given a small blob whose header claims a size disagreeing with its 12-byte body, When git and tsgit both read it', () => {
    it.each([
      { label: 'claim 20 (larger than body)', claim: 20 },
      { label: 'claim 104857600 (far larger than body)', claim: 104_857_600 },
    ])(
      'Then git reports the claim as size and streams the real body ($label), and tsgit agrees',
      async ({ claim }) => {
        // Arrange
        const dir = await caseDir(`small-${claim}`);
        await forgeLoose(dir, smallId, 'blob', claim, SMALL_CONTENT);
        const ctx = createNodeContext({ workDir: dir });
        const id = smallId as ObjectId;

        // Act — git side
        const gitSize = git(dir, 'cat-file', '-s', smallId).trim();
        const gitBody = runGit(['-C', dir, 'cat-file', '-p', smallId]);

        // Act — tsgit side
        const { entries } = await catFile(ctx, { ids: [id] });
        const object = await readObject(ctx, id);
        const streamed = await collect(await streamBlob(ctx, id));

        // Assert — git's observed answer
        expect(gitSize).toBe(String(claim));
        expect(Buffer.from(gitBody, 'utf8')).toEqual(SMALL_CONTENT);

        // Assert — tsgit's observed answer
        const entry = entries[0];
        if (entry?.ok !== true) throw new Error('expected an ok entry');
        expect(entry.size).toBe(claim);
        expect(Buffer.from((entry.object as Blob).content)).toEqual(SMALL_CONTENT);
        expect(object.type).toBe('blob');
        expect(Buffer.from((object as Blob).content)).toEqual(SMALL_CONTENT);
        expect(streamed).toEqual(SMALL_CONTENT);
      },
    );
  });

  describe("Given a small blob whose header claims 5 bytes but its body is the real 12 bytes, staying inside git's 32-byte header window", () => {
    describe('When readObject and git archive both take the buffered tier', () => {
      it("Then readObject truncates to the 5-byte claim, matching tsgit's own tar serializer reconstruction of git's archive bytes", async () => {
        // Arrange — header (7 bytes) + body (12 bytes) = 19 ≤ 32: the whole
        // object fits git's header window, so the buffered tier silently
        // truncates to the claim rather than serving the real body.
        const dir = await caseDir('small-claim5-buffered');
        await forgeLoose(dir, smallId, 'blob', 5, SMALL_CONTENT);
        const ctx = createNodeContext({ workDir: dir });
        const id = smallId as ObjectId;

        // Act — git side: archive also takes the buffered tier, so it
        // truncates identically to readObject.
        const gitTarBytes = runGitBytes(['-C', dir, 'archive', '--format=tar', 'HEAD'], {
          env: runGitEnv(),
        });

        // Act — tsgit side
        const object = await readObject(ctx, id);
        const result = await archive(ctx, { treeish: 'HEAD' });
        const tarStream = tarArchive(result, {
          umask: 0o0002,
          uname: 'root',
          gname: 'root',
          ...(result.commitTime !== undefined ? { mtime: result.commitTime } : {}),
        });
        const ourTarBytes = await collect(tarStream);

        // Assert
        expect(object.type).toBe('blob');
        expect(Buffer.from((object as Blob).content)).toEqual(SMALL_CONTENT.subarray(0, 5));
        expect(new Uint8Array(ourTarBytes)).toEqual(gitTarBytes);
      });
    });
  });

  describe("Given a second commit replacing the truncated small blob's content, When git diff --numstat and tsgit diff({ withStat: true }) both compare", () => {
    it('Then both report a truncated 5-byte old side against the new 6-byte content', async () => {
      // Arrange
      const dir = await caseDir('small-claim5-numstat');
      await forgeLoose(dir, smallId, 'blob', 5, SMALL_CONTENT);
      await writeFile(path.join(dir, 'small.txt'), 'other\n');
      git(dir, 'add', '-A');
      runGit(['-C', dir, 'commit', '-q', '-m', 'second'], { env: datedEnv() });
      const ctx = createNodeContext({ workDir: dir });

      // Act
      const gitNumstat = git(dir, 'diff', '--no-ext-diff', '--numstat', 'HEAD~1', 'HEAD').trim();
      const result = await diff(ctx, { from: 'HEAD~1', to: 'HEAD', withStat: true });

      // Assert — git: truncated 'hello' (no trailing LF) vs 'other\n' is a
      // one-line-removed, one-line-added change.
      expect(gitNumstat).toBe('1\t1\tsmall.txt');
      const change = (result as StatTreeDiff).changes.find(
        (c) => 'path' in c && c.path === 'small.txt',
      );
      expect(change).toMatchObject({ type: 'modify', added: 1, deleted: 1 });
    });
  });

  describe('Given a medium (1880-byte) blob whose header claim under-runs its body (claim 4000), When git and tsgit both read it — the recorded residual', () => {
    it('Then git and tsgit both serve the real 1880-byte body', async () => {
      // Arrange — an under-run (claim 4000 > 1880) never trips the buffered
      // read's cap: the whole body is inflated and served, not truncated or
      // zero-padded (residual: git's own buffered blob consumers zero-pad).
      const claim = 4000;
      const dir = await caseDir(`medium-${claim}`);
      await forgeLoose(dir, mediumId, 'blob', claim, MEDIUM_CONTENT);
      const ctx = createNodeContext({ workDir: dir });
      const id = mediumId as ObjectId;

      // Act
      const gitBody = runGit(['-C', dir, 'cat-file', '-p', mediumId]);
      const object = await readObject(ctx, id);

      // Assert
      expect(Buffer.byteLength(gitBody, 'utf8')).toBe(1880);
      expect(object.type).toBe('blob');
      expect((object as Blob).content).toHaveLength(1880);
      expect(Buffer.from((object as Blob).content)).toEqual(MEDIUM_CONTENT);
    });
  });

  describe("Given a medium (1880-byte) blob whose header claim of 500 overruns git's 32-byte header window, When a second commit modifies it", () => {
    it('Then git diff --numstat refuses corrupt loose object and tsgit diff({ withStat: true }) refuses INVALID_OBJECT_HEADER', async () => {
      // Arrange
      const dir = await caseDirWithOverrunSecondCommit('medium-overrun-numstat');
      const ctx = createNodeContext({ workDir: dir });

      // Act
      const gitResult = tryRunGitWithExit([
        '-C',
        dir,
        'diff',
        '--no-ext-diff',
        '--numstat',
        'HEAD~1',
        'HEAD',
      ]);
      let caught: unknown;
      try {
        await diff(ctx, { from: 'HEAD~1', to: 'HEAD', withStat: true });
        expect.unreachable();
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(gitResult.exitCode).toBe(128);
      expect(gitResult.stderr).toContain('corrupt loose object');
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('INVALID_OBJECT_HEADER');
    });

    it('Then git diff -B --name-status refuses corrupt loose object (should_break reads both blobs in full) and tsgit break-rewrite detection refuses too', async () => {
      // Arrange
      const dir = await caseDirWithOverrunSecondCommit('medium-overrun-break');
      const ctx = createNodeContext({ workDir: dir });

      // Act
      const gitResult = tryRunGitWithExit([
        '-C',
        dir,
        'diff',
        '--no-ext-diff',
        '-B',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ]);
      let caught: unknown;
      try {
        await diff(ctx, {
          from: 'HEAD~1',
          to: 'HEAD',
          detectRenames: true,
          renameOptions: { breakRewrites: { score: 30_000, merge: 36_000 } },
        });
        expect.unreachable();
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(gitResult.exitCode).toBe(128);
      expect(gitResult.stderr).toContain('corrupt loose object');
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('INVALID_OBJECT_HEADER');
    });
  });

  describe('Given a medium blob header claim of 500, When git archive and tsgit archive both read it', () => {
    it('Then both refuse — git corrupt loose object, tsgit INVALID_OBJECT_HEADER', async () => {
      // Arrange
      const dir = await caseDir('medium-overrun-archive');
      await forgeLoose(dir, mediumId, 'blob', 500, MEDIUM_CONTENT);
      const ctx = createNodeContext({ workDir: dir });

      // Act
      const gitResult = tryRunGitWithExit(['-C', dir, 'archive', 'HEAD', '--', 'medium.txt']);
      let caught: unknown;
      try {
        const { entries } = await archive(ctx, { treeish: 'HEAD' });
        for await (const _entry of entries) {
          // Drain — the refusal fires while the walk reaches the lying blob.
        }
        expect.unreachable();
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(gitResult.exitCode).toBe(128);
      expect(gitResult.stderr).toContain('corrupt loose object');
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('INVALID_OBJECT_HEADER');
    });
  });

  describe('Given a medium blob header claim of 500 deleted and a near-copy added, When git -M and tsgit detectRenames both compare', () => {
    it('Then neither treats the pair as a rename — the size prefilter never opens the liar', async () => {
      // Arrange — 15 unrelated filler adds push the diff's unique-blob count
      // past tsgit's own size-gate floor (16, `SIZE_GATE_MIN_IDS`), so this
      // row actually exercises the size prefilter rather than the small-diff
      // shortcut that fingerprints every candidate directly.
      const dir = await caseDir('medium-overrun-rename-prefilter');
      await forgeLoose(dir, mediumId, 'blob', 500, MEDIUM_CONTENT);
      await unlink(path.join(dir, 'medium.txt'));
      const nearCopyLines = mediumLines.slice();
      nearCopyLines[0] = 'CHANGED-FIRST-LINE';
      await writeFile(path.join(dir, 'medium2.txt'), `${nearCopyLines.join('\n')}\n`);
      for (let i = 0; i < 15; i += 1) {
        await writeFile(path.join(dir, `filler-${i}.txt`), `filler content ${i}\n`);
      }
      git(dir, 'add', '-A');
      runGit(['-C', dir, 'commit', '-q', '-m', 'second'], { env: datedEnv() });
      const ctx = createNodeContext({ workDir: dir });

      // Act
      const gitResult = git(
        dir,
        'diff',
        '--no-ext-diff',
        '-M',
        '--name-status',
        'HEAD~1',
        'HEAD',
      ).trim();
      const result = await diff(ctx, { from: 'HEAD~1', to: 'HEAD', detectRenames: true });

      // Assert — git agrees: the size prefilter (claim 500 against ~1880)
      // rejects the pair before either tool ever opens the liar.
      expect(gitResult).not.toContain('R1');
      expect(gitResult).toContain('D\tmedium.txt');
      expect(gitResult).toContain('A\tmedium2.txt');
      const relevant = result.changes.filter(
        (c) =>
          ('oldPath' in c && c.oldPath === 'medium.txt') ||
          ('newPath' in c && c.newPath === 'medium2.txt') ||
          ('path' in c && c.path === 'medium.txt'),
      );
      expect(relevant.map((c) => c.type).sort()).toEqual(['add', 'delete']);
    });
  });

  describe('Given a medium blob header claim of 500, When git show and tsgit show both read it', () => {
    it("Then both serve the real 1880-byte body — show stays on git's streaming tier", async () => {
      // Arrange
      const dir = await caseDir('medium-overrun-show');
      await forgeLoose(dir, mediumId, 'blob', 500, MEDIUM_CONTENT);
      const ctx = createNodeContext({ workDir: dir });

      // Act
      const gitBody = runGit(['-C', dir, 'show', mediumId]);
      const result = await show(ctx, mediumId);

      // Assert
      expect(Buffer.byteLength(gitBody, 'utf8')).toBe(1880);
      expect(result.kind).toBe('blob');
      if (result.kind === 'blob') {
        expect(Buffer.from(result.content)).toEqual(MEDIUM_CONTENT);
      }
    });
  });

  describe('Given the lying small blob and its working-tree file removed, When git checkout and tsgit checkout both run', () => {
    it('Then both git checkout and tsgit checkout restore the real 12-byte file', async () => {
      // Arrange — twin copies: one git mutates, one tsgit mutates.
      const gitDir = await caseDir('checkout-git');
      const tsgitDir = await caseDir('checkout-tsgit');
      await forgeLoose(gitDir, smallId, 'blob', 3, SMALL_CONTENT);
      await forgeLoose(tsgitDir, smallId, 'blob', 3, SMALL_CONTENT);
      await unlink(path.join(gitDir, 'small.txt'));
      await unlink(path.join(tsgitDir, 'small.txt'));
      const ctx = createNodeContext({ workDir: tsgitDir });

      // Act
      runGit(['-C', gitDir, 'checkout', '--', 'small.txt']);
      await checkout(ctx, { paths: ['small.txt'] });

      // Assert
      const gitFile = await readFile(path.join(gitDir, 'small.txt'));
      const tsgitFile = await readFile(path.join(tsgitDir, 'small.txt'));
      expect(gitFile).toEqual(SMALL_CONTENT);
      expect(tsgitFile).toEqual(SMALL_CONTENT);
    });
  });

  describe('Given a lying small blob, When the header-only surfaces are asked for its type and size', () => {
    it.each([{ claim: 5 }, { claim: 20 }, { claim: 104_857_600 }])(
      'Then every git surface reports the claim for $claim and tsgit reports the same number',
      async ({ claim }) => {
        // Arrange
        const dir = await caseDir(`header-only-${claim}`);
        await forgeLoose(dir, smallId, 'blob', claim, SMALL_CONTENT);
        const ctx = createNodeContext({ workDir: dir });

        // Act — git's three header-only surfaces, then tsgit's one structured field
        const gitType = git(dir, 'cat-file', '-t', smallId).trim();
        const gitExists = tryRunGitWithExit(['-C', dir, 'cat-file', '-e', smallId]);
        const batchCheck = runGit(['-C', dir, 'cat-file', '--batch-check'], { input: smallId });
        const lsTree = git(dir, 'ls-tree', '-l', 'HEAD', 'small.txt');
        const { entries } = await catFile(ctx, { ids: [smallId as ObjectId] });

        // Assert
        const entry = entries[0];
        if (entry?.ok !== true) throw new Error('expected an ok entry');
        expect(gitType).toBe('blob');
        expect(gitExists.exitCode).toBe(0);
        expect(batchCheck).toBe(`${smallId} blob ${claim}\n`);
        expect(lsTree.split(/\s+/)[3]).toBe(String(claim));
        expect(entry.type).toBe('blob');
        expect(entry.size).toBe(claim);
      },
    );
  });

  describe('Given a lying small blob, When git cat-file --batch prints it', () => {
    it('Then the record rebuilt from tsgit’s fields matches git’s stream byte for byte', async () => {
      // Arrange — git's record is the claimed header followed by the REAL
      // body: the two tiers disagree inside one command's own output.
      const dir = await caseDir('batch-record');
      await forgeLoose(dir, smallId, 'blob', 20, SMALL_CONTENT);
      const ctx = createNodeContext({ workDir: dir });

      // Act
      const gitBatch = runGit(['-C', dir, 'cat-file', '--batch'], { input: smallId });
      const { entries } = await catFile(ctx, { ids: [smallId as ObjectId] });

      // Assert
      const entry = entries[0];
      if (entry?.ok !== true) throw new Error('expected an ok entry');
      const rebuilt = Buffer.concat([
        Buffer.from(`${smallId} ${entry.type} ${entry.size}\n`),
        Buffer.from((entry.object as Blob).content),
        Buffer.from('\n'),
      ]);
      expect(Buffer.from(gitBatch, 'utf8')).toEqual(rebuilt);
    });
  });

  describe('Given the lying medium blob and its working-tree file removed, When git checkout and tsgit checkout both run', () => {
    it('Then both restore the real 1880-byte file, never the claimed length', async () => {
      // Arrange
      const gitDir = await caseDir('checkout-medium-git');
      const tsgitDir = await caseDir('checkout-medium-tsgit');
      await forgeLoose(gitDir, mediumId, 'blob', 500, MEDIUM_CONTENT);
      await forgeLoose(tsgitDir, mediumId, 'blob', 500, MEDIUM_CONTENT);
      await unlink(path.join(gitDir, 'medium.txt'));
      await unlink(path.join(tsgitDir, 'medium.txt'));
      const ctx = createNodeContext({ workDir: tsgitDir });

      // Act
      runGit(['-C', gitDir, 'checkout', '--', 'medium.txt']);
      await checkout(ctx, { paths: ['medium.txt'] });

      // Assert
      const gitFile = await readFile(path.join(gitDir, 'medium.txt'));
      const tsgitFile = await readFile(path.join(tsgitDir, 'medium.txt'));
      expect(gitFile).toEqual(MEDIUM_CONTENT);
      expect(tsgitFile).toEqual(gitFile);
    });
  });

  describe('Given a lying loose blob whose working-tree file is unchanged, When git status and tsgit status both run', () => {
    it('Then both report the repository clean — neither reads the blob back', async () => {
      // Arrange — the index entry is stat-clean and the working-tree bytes
      // are hashed directly, so this row pins that the forged blob is never
      // read; the commit and tree rows below are where status does read.
      const dir = await caseDir('status-blob');
      await forgeLoose(dir, smallId, 'blob', 3, SMALL_CONTENT);
      const ctx = createNodeContext({ workDir: dir });

      // Act
      const gitPorcelain = git(dir, 'status', '--porcelain');
      const result = await status(ctx);

      // Assert
      expect(gitPorcelain).toBe('');
      expect(result.clean).toBe(true);
    });
  });

  describe('Given the HEAD commit itself forged with a short size claim', () => {
    describe('When git status and tsgit status both run', () => {
      it('Then both refuse — status resolves HEAD through the forged object', async () => {
        // Arrange
        const dir = await caseDir('status-commit');
        const body = await honestContent(dir, commitId);
        const claim = body.byteLength - 10;
        await forgeLoose(dir, commitId, 'commit', claim, body);
        const ctx = createNodeContext({ workDir: dir });

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);
        let caught: unknown;
        try {
          await status(ctx);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(gitResult.stderr).toContain('corrupt loose object');
        expect((caught as TsgitError).data.code).toBe('INVALID_OBJECT_HEADER');
      });
    });
  });

  describe('Given the HEAD tree forged with a short size claim', () => {
    describe('When git ls-tree, git status and tsgit both read it', () => {
      it('Then every surface refuses on both tools', async () => {
        // Arrange
        const dir = await caseDir('status-tree');
        const body = await honestContent(dir, treeId);
        const claim = body.byteLength - 10;
        await forgeLoose(dir, treeId, 'tree', claim, body);
        const ctx = createNodeContext({ workDir: dir });

        // Act
        const gitLsTree = tryRunGitWithExit(['-C', dir, 'ls-tree', 'HEAD']);
        const gitStatus = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);
        let caught: unknown;
        try {
          await status(ctx);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(gitLsTree.exitCode).toBe(128);
        expect(gitStatus.exitCode).toBe(128);
        expect((caught as TsgitError).data.code).toBe('INVALID_OBJECT_HEADER');
      });
    });
  });

  describe('Given the HEAD commit forged with an over-long size claim — the recorded residual', () => {
    describe('When the verbs that tolerate a zero-padded commit body run', () => {
      it('Then git accepts them while its verifying verbs refuse, and tsgit refuses throughout', async () => {
        // Arrange
        const dir = await caseDir('commit-underrun-verbs');
        const body = await honestContent(dir, commitId);
        await forgeLoose(dir, commitId, 'commit', body.byteLength + OVER_CLAIM_BYTES, body);
        const ctx = createNodeContext({ workDir: dir });

        // Act — git's accepting verbs, then its verifying ones
        const gitLog = tryRunGitWithExit(['-C', dir, 'log', '--format=%H', '-1']);
        const gitStatus = tryRunGitWithExit(['-C', dir, 'status', '--porcelain']);
        const gitRevParse = tryRunGitWithExit(['-C', dir, 'rev-parse', 'HEAD^{tree}']);
        const gitFsck = tryRunGitWithExit(['-C', dir, 'fsck', '--full']);
        let caught: unknown;
        try {
          await status(ctx);
        } catch (error) {
          caught = error;
        }

        // Assert — git's split verdict
        expect(gitLog.exitCode).toBe(0);
        expect(gitLog.stdout.trim()).toBe(commitId);
        expect(gitStatus.exitCode).toBe(0);
        expect(gitRevParse.exitCode).toBe(128);
        expect(gitRevParse.stderr).toContain('hash mismatch');
        expect(gitFsck.exitCode).toBe(3);

        // Assert — tsgit refuses on every one of them
        expect((caught as TsgitError).data.code).toBe('INVALID_OBJECT_HEADER');
      });
    });
  });

  describe('Given a lying small blob, When git fsck runs and tsgit reads it with hash verification', () => {
    it('Then git fsck reports a hash-path mismatch and tsgit refuses OBJECT_HASH_MISMATCH', async () => {
      // Arrange
      const dir = await caseDir('verify');
      await forgeLoose(dir, smallId, 'blob', 5, SMALL_CONTENT);
      const ctx = createNodeContext({ workDir: dir });
      const id = smallId as ObjectId;

      // Act — git side
      const fsck = tryRunGitWithExit(['-C', dir, 'fsck', '--full']);

      // Act — tsgit side
      let readError: unknown;
      let streamError: unknown;
      try {
        await readObject(ctx, id, { verifyHash: true });
      } catch (error) {
        readError = error;
      }
      try {
        await collect(await streamBlob(ctx, id, { verifyHash: true }));
      } catch (error) {
        streamError = error;
      }

      // Assert — git's observed answer
      expect(fsck.exitCode).toBe(3);
      expect(fsck.stderr).toContain('hash-path mismatch');

      // Assert — tsgit's observed answer. readObject's buffered read
      // truncates to the 5-byte claim (inside git's header window), so the
      // hash it verifies against — and reports as `actual` — is over the
      // TRUNCATED header+content, computed here independently.
      const expectedActual = createHash('sha1')
        .update(Buffer.concat([Buffer.from('blob 5\0'), SMALL_CONTENT.subarray(0, 5)]))
        .digest('hex');
      expect(readError).toBeInstanceOf(TsgitError);
      const readData = (readError as TsgitError).data;
      expect(readData.code).toBe('OBJECT_HASH_MISMATCH');
      if (readData.code === 'OBJECT_HASH_MISMATCH') {
        expect(readData.expected).toBe(id);
        expect(readData.actual).toBe(expectedActual);
      }
      expect(streamError).toBeInstanceOf(TsgitError);
      const streamData = (streamError as TsgitError).data;
      expect(streamData.code).toBe('OBJECT_HASH_MISMATCH');
      if (streamData.code === 'OBJECT_HASH_MISMATCH') {
        expect(streamData.expected).toBe(id);
      }
    });
  });

  describe('Given a commit whose header claim is smaller than its real body (over-run), When git and tsgit both read it', () => {
    it('Then git refuses corrupt loose object and tsgit refuses INVALID_OBJECT_HEADER', async () => {
      // Arrange
      const dir = await caseDir('commit-overrun');
      const body = await honestContent(dir, commitId);
      const claim = body.byteLength - 10;
      await forgeLoose(dir, commitId, 'commit', claim, body);
      const ctx = createNodeContext({ workDir: dir });
      const id = commitId as ObjectId;

      // Act — git side
      const gitResult = tryRunGitWithExit(['-C', dir, 'cat-file', '-p', commitId]);

      // Act — tsgit side
      let caught: unknown;
      try {
        await readObject(ctx, id);
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(gitResult.exitCode).toBe(128);
      expect(gitResult.stderr).toContain('corrupt loose object');
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('INVALID_OBJECT_HEADER');
      if (data.code === 'INVALID_OBJECT_HEADER') {
        // git's buffered tier never inflates past header + claim, so the
        // refusal reason is now the declared size, not the (never-computed)
        // actual content length.
        expect(data.reason).toBe(`content exceeds declared size ${claim}`);
      }
    });
  });

  describe('Given a commit whose header claim is larger than its real body (under-run), When git and tsgit both read it — the recorded residual', () => {
    it('Then git zero-pads and accepts it (log/cat-file succeed) but tsgit still refuses INVALID_OBJECT_HEADER', async () => {
      // Arrange
      const dir = await caseDir('commit-underrun');
      const body = await honestContent(dir, commitId);
      const claim = body.byteLength + 253;
      await forgeLoose(dir, commitId, 'commit', claim, body);
      const ctx = createNodeContext({ workDir: dir });
      const id = commitId as ObjectId;

      // Act — git side
      const gitSize = git(dir, 'cat-file', '-s', commitId).trim();
      const gitLog = git(dir, 'log', '--format=%H', '-1', commitId).trim();

      // Act — tsgit side
      let caught: unknown;
      try {
        await readObject(ctx, id);
      } catch (error) {
        caught = error;
      }

      // Assert — git accepts the padded buffer
      expect(gitSize).toBe(String(claim));
      expect(gitLog).toBe(commitId);

      // Assert — tsgit still refuses (documented divergence)
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('INVALID_OBJECT_HEADER');
      if (data.code === 'INVALID_OBJECT_HEADER') {
        expect(data.reason).toBe(
          `size mismatch: header says ${claim}, actual content is ${body.byteLength}`,
        );
      }
    });
  });

  describe('Given a tree whose header claim disagrees with its real body, When git and tsgit both read it', () => {
    it.each([
      // Overrun past git's 32-byte header window: the buffered read never
      // inflates past header + claim, so the refusal names the claim, never
      // the (never-computed) actual content length.
      { label: 'claim smaller than the body', delta: -10, reasonNamesClaim: true },
      // Under-run: the whole body is inflated, so the refusal still names
      // the real content length alongside the claim.
      { label: 'claim larger than the body', delta: 125, reasonNamesClaim: false },
    ])(
      'Then git refuses ($label) and tsgit refuses INVALID_OBJECT_HEADER',
      async ({ delta, reasonNamesClaim }) => {
        // Arrange
        const dir = await caseDir(`tree-${delta}`);
        const body = await honestContent(dir, treeId);
        const claim = body.byteLength + delta;
        await forgeLoose(dir, treeId, 'tree', claim, body);
        const ctx = createNodeContext({ workDir: dir });
        const id = treeId as ObjectId;

        // Act — git side
        const gitResult = tryRunGitWithExit(['-C', dir, 'ls-tree', treeId]);

        // Act — tsgit side
        let caught: unknown;
        try {
          await readObject(ctx, id);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('INVALID_OBJECT_HEADER');
        if (data.code === 'INVALID_OBJECT_HEADER') {
          expect(data.reason).toBe(
            reasonNamesClaim
              ? `content exceeds declared size ${claim}`
              : `size mismatch: header says ${claim}, actual content is ${body.byteLength}`,
          );
        }
      },
    );
  });

  describe('Given a blob header claim of 9007199254740993 (2^53 + 1), When git and tsgit both read it — the recorded residual', () => {
    it('Then git prints the claim verbatim and streams the real body, but tsgit refuses an unrepresentable size', async () => {
      // Arrange
      const dir = await caseDir('claim-2pow53plus1');
      await forgeLoose(dir, smallId, 'blob', '9007199254740993', SMALL_CONTENT);
      const ctx = createNodeContext({ workDir: dir });
      const id = smallId as ObjectId;

      // Act — git side
      const gitSize = git(dir, 'cat-file', '-s', smallId).trim();
      const gitBody = runGit(['-C', dir, 'cat-file', '-p', smallId]);

      // Act — tsgit side
      let caught: unknown;
      try {
        await readObject(ctx, id);
      } catch (error) {
        caught = error;
      }

      // Assert — git's observed answer
      expect(gitSize).toBe('9007199254740993');
      expect(Buffer.from(gitBody, 'utf8')).toEqual(SMALL_CONTENT);

      // Assert — tsgit's observed answer
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('INVALID_OBJECT_HEADER');
      if (data.code === 'INVALID_OBJECT_HEADER') {
        expect(data.reason).toBe('invalid size: 9007199254740993');
      }
    });
  });

  describe('Given a blob header claim of 18446744073709551615 (2^64 - 1), When git and tsgit both read it — the recorded residual', () => {
    it('Then git prints the claim verbatim and streams the real body, but tsgit refuses an unrepresentable size', async () => {
      // Arrange — the largest value git's size_t still holds; the claim is
      // reported as typed and the stream tier ignores it entirely.
      const dir = await caseDir('claim-2pow64minus1');
      await forgeLoose(dir, smallId, 'blob', '18446744073709551615', SMALL_CONTENT);
      const ctx = createNodeContext({ workDir: dir });
      const id = smallId as ObjectId;

      // Act — git side
      const gitSize = git(dir, 'cat-file', '-s', smallId).trim();
      const gitBody = runGit(['-C', dir, 'cat-file', '-p', smallId]);

      // Act — tsgit side
      let caught: unknown;
      try {
        await readObject(ctx, id);
      } catch (error) {
        caught = error;
      }

      // Assert — git's observed answer
      expect(gitSize).toBe('18446744073709551615');
      expect(Buffer.from(gitBody, 'utf8')).toEqual(SMALL_CONTENT);

      // Assert — tsgit's observed answer
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('INVALID_OBJECT_HEADER');
      if (data.code === 'INVALID_OBJECT_HEADER') {
        expect(data.reason).toBe('invalid size: 18446744073709551615');
      }
    });
  });

  describe('Given a tag object stored without the tagger line git itself would write', () => {
    describe('When git cat-file -s and tsgit catFile both report its size', () => {
      it('Then both report the stored length, which no canonical rewrite could produce', async () => {
        // Arrange — git's own tag builder refuses this body, so it is written
        // literally; a reader that measured a canonicalised re-serialisation
        // would have to invent a tagger line and report a longer size.
        const dir = await caseDir('tag-stored-size');
        const raw = Buffer.from(`object ${treeId}\ntype tree\ntag no-tagger\n\nno tagger here\n`);
        const oddId = runGit(
          ['-C', dir, 'hash-object', '-w', '-t', 'tag', '--literally', '--stdin'],
          { input: raw },
        ).trim();
        const ctx = createNodeContext({ workDir: dir });

        // Act
        const gitSize = git(dir, 'cat-file', '-s', oddId).trim();
        const { entries } = await catFile(ctx, { ids: [oddId as ObjectId] });

        // Assert
        const entry = entries[0];
        if (entry?.ok !== true) throw new Error('expected an ok entry');
        expect(entry.type).toBe('tag');
        expect(entry.size).toBe(Number(gitSize));
        expect(entry.size).toBe(raw.byteLength);
        // The parsed object still writes back to the same oid: tsgit keeps
        // the stored bytes rather than normalising the missing header away.
        expect(await writeObject(ctx, entry.object)).toBe(oddId);
      });
    });
  });

  describe('Given a blob header claim of 18446744073709551616 (2^64), When git and tsgit both read it', () => {
    it('Then git itself refuses size_t overflow and tsgit refuses an unrepresentable size', async () => {
      // Arrange
      const dir = await caseDir('claim-2pow64');
      await forgeLoose(dir, smallId, 'blob', '18446744073709551616', SMALL_CONTENT);
      const ctx = createNodeContext({ workDir: dir });
      const id = smallId as ObjectId;

      // Act — git side
      const gitResult = tryRunGitWithExit(['-C', dir, 'cat-file', '-s', smallId]);

      // Act — tsgit side
      let caught: unknown;
      try {
        await readObject(ctx, id);
      } catch (error) {
        caught = error;
      }

      // Assert — git's observed answer
      expect(gitResult.exitCode).toBe(128);
      expect(gitResult.stderr).toContain('size_t overflow');

      // Assert — tsgit's observed answer
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data;
      expect(data.code).toBe('INVALID_OBJECT_HEADER');
      if (data.code === 'INVALID_OBJECT_HEADER') {
        expect(data.reason).toBe('invalid size: 18446744073709551616');
      }
    });
  });
});
