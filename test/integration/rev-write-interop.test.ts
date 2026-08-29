/**
 * Cross-tool interop — the reverse-index (`.rev`) write surface, pinned
 * against real git. git's `.rev` is a PURE FUNCTION of the pack:
 * `git index-pack -o <stem>.idx <stem>.pack`, run outside any repository on
 * a copy of a tsgit-written `.pack`, regenerates the byte-identical `.rev`
 * repeatably — that regeneration is the oracle X1/X2 compare against.
 * X3/X4 cross-check acceptance from BOTH fsck implementations over the same
 * on-disk pack dir. X5/X6/X7/X7b pin the `pack.writeReverseIndex` gate —
 * X7 is a FAITHFULNESS row (both tools now refuse `=maybe`), not a
 * divergence row. X8/X9 cover the other write surfaces (a real network
 * fetch, and `outputDirectory` mode). X10 and the scaled case close the
 * read-side loop: tsgit's own freshly written `.rev` is usable by tsgit's
 * own reader, both for a small pack and at a scale large enough to prove the
 * accelerator holds under load, not just for a tiny fixture.
 *
 * @proves
 *   surface:        packRevIndex
 *   bucket:         cross-tool-interop
 *   unique:         tsgit-written pack reverse index byte-compared against git index-pack
 *   interopSurface: packRevIndex
 */
import { existsSync, readdirSync } from 'node:fs';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { fsck } from '../../src/application/commands/fsck.js';
import { packObjects } from '../../src/application/commands/pack-objects.js';
import { buildPack } from '../../src/application/primitives/build-pack.js';
import { loadPackRevIndex } from '../../src/application/primitives/internal/pack-artefact-source.js';
import {
  packPositionMap,
  revIndexPositions,
} from '../../src/application/primitives/internal/pack-positions.js';
import { writePackArtifacts } from '../../src/application/primitives/internal/write-pack-artifacts.js';
import { commonGitDir, packsDir } from '../../src/application/primitives/path-layout.js';
import { disposePackRegistry, readObject } from '../../src/application/primitives/read-object.js';
import { writeObject } from '../../src/application/primitives/write-object.js';
import { TsgitError } from '../../src/domain/error.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import { parsePackIndex, REV_HEADER_SIZE } from '../../src/domain/storage/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Context } from '../../src/ports/context.js';
import { startGitHttpBackend } from '../bench/support/http-backend-server.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';
import { DIGEST_LENGTH, packArtefactPaths } from './rev-bitmap-fixture-helpers.js';

// Mirrors the fsck command's internal pack-rev-index exit bit — not
// re-exported from its public surface, so pinned locally rather than
// reaching into an internal module for one bit constant.
const EXIT_PACK_REV_INDEX = 64;

const ENCODER = new TextEncoder();

const SEED_FILES: Readonly<Record<string, string>> = {
  'a.txt': 'alpha\n',
  'b.txt': 'bravo\n',
  'c.txt': 'charlie\n',
};

// ---------------------------------------------------------------------------
// Fixture + context plumbing — collapsed here per the plan's REFACTOR step;
// promoted to `interop-helpers.ts`/`rev-bitmap-fixture-helpers.ts` only if a
// second file ever needs it.
// ---------------------------------------------------------------------------

const roots: string[] = [];

async function newRoot(slug: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-rev-write-${slug}-`));
  roots.push(dir);
  return dir;
}

/** A plain, git-init'd repo — identity + no signing + no background gc, so a
 *  `git commit` spawned against it cannot race a fixture assertion. */
async function freshRepo(slug: string): Promise<string> {
  const dir = await newRoot(slug);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  disableAutoMaintenance(dir);
  return dir;
}

/** Delete every loose-object fanout dir so reads must come from packs. */
async function removeLooseObjectDirs(dir: string): Promise<void> {
  const objectsDir = path.join(dir, '.git', 'objects');
  const fanout = readdirSync(objectsDir).filter((name) => /^[0-9a-f]{2}$/.test(name));
  await Promise.all(
    fanout.map((name) => rm(path.join(objectsDir, name), { recursive: true, force: true })),
  );
}

// A fixed author/committer date, not the wall clock: the commit id feeds
// directly into the oid-ascending .idx order that X2's permutation check
// reads, and a wall-clock timestamp would make that permutation (and thus
// the row's pass/fail) depend on the second the test happened to run in —
// a real, if rare (1-in-N!), flake this pins away entirely.
const FIXED_COMMIT_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

async function commitFiles(
  dir: string,
  files: Readonly<Record<string, string>>,
  message: string,
): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content);
  }
  git(dir, 'add', '-A');
  runGit(['-C', dir, 'commit', '-q', '-m', message], { env: FIXED_COMMIT_ENV });
}

/** Every context a row builds is disposed after the row — packed reads open
 *  persistent FileHandles, and an undisposed registry surfaces as the
 *  GC-close warning the handle-lifecycle work treats as its leak oracle. */
const liveContexts: Context[] = [];
function trackedNodeContext(dir: string, logger?: Context['logger']): Context {
  const base = createNodeContext({ workDir: dir });
  const ctx = logger === undefined ? base : { ...base, logger };
  liveContexts.push(ctx);
  return ctx;
}
afterEach(async () => {
  await Promise.all(liveContexts.splice(0).map((ctx) => disposePackRegistry(ctx)));
});

/** The `.idx` path with its suffix replaced — never a name derived from the
 *  pack checksum (the design's own load-bearing note on how git names it). */
function revPathFor(idxPath: string): string {
  return idxPath.replace(/\.idx$/, '.rev');
}

/** git's own oracle: `index-pack -o` on a copy of a pack, run in a plain
 *  scratch dir outside any repository, regenerates a byte-identical `.rev`. */
async function buildGitRevOracle(scratchDir: string, packBytes: Uint8Array): Promise<Uint8Array> {
  const packPath = path.join(scratchDir, 'oracle.pack');
  const idxPath = path.join(scratchDir, 'oracle.idx');
  await writeFile(packPath, packBytes);
  git(scratchDir, 'index-pack', '-o', idxPath, packPath);
  return readFile(revPathFor(idxPath));
}

/** The pack dir's raw entry list — `[]` for a dir that was never created,
 *  which is exactly the state a refused `pack.writeReverseIndex` leaves
 *  (the config gate runs before `writePackArtifacts`'s own `mkdir`). */
function packDirEntries(dir: string): string[] {
  const packDir = path.join(dir, '.git', 'objects', 'pack');
  return existsSync(packDir) ? readdirSync(packDir) : [];
}

function firstDiffOffset(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : len;
}

function hexWindow(bytes: Uint8Array, center: number, radius = 8): string {
  const start = Math.max(0, center - radius);
  const end = Math.min(bytes.length, center + radius);
  return Buffer.from(bytes.subarray(start, end)).toString('hex');
}

/** Byte-equal assertion with a readable failure: offset + hex windows on
 *  both sides — a real mismatch here is a defect in the writer, and the
 *  diff needs to be legible without a debugger. */
function assertRevBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  const equal =
    actual.length === expected.length && Buffer.from(actual).equals(Buffer.from(expected));
  if (equal) return;
  const offset = firstDiffOffset(actual, expected);
  throw new Error(
    [
      `.rev byte mismatch at offset ${offset}`,
      `  actual.length=${actual.length}, expected.length=${expected.length}`,
      `  expected: …${hexWindow(expected, offset)}…`,
      `  actual:   …${hexWindow(actual, offset)}…`,
    ].join('\n'),
  );
}

/** Reads a `.rev` body straight out of raw bytes — the permutation-control
 *  check deliberately does not go through `parsePackRevIndex` so it stays
 *  independent of the parser under test elsewhere in this change. */
function revBodyPositions(bytes: Uint8Array, objectCount: number): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: objectCount }, (_, i) => view.getUint32(REV_HEADER_SIZE + i * 4));
}

function isIdentityPermutation(positions: ReadonlyArray<number>): boolean {
  return positions.every((value, index) => value === index);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!GIT_AVAILABLE)('.rev write surface, against real git', () => {
  let cleanPackBytes: Uint8Array;

  beforeAll(async () => {
    const cleanDir = await freshRepo('clean');
    await commitFiles(cleanDir, SEED_FILES, 'seed');
    git(cleanDir, 'repack', '-adq');
    cleanPackBytes = await readFile(packArtefactPaths(cleanDir).pack);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  // ---------------------------------------------------------------------
  // X1 / X2 — the byte compares
  // ---------------------------------------------------------------------

  describe('Given a tsgit-written pack copied into a scratch dir, When git index-pack -o regenerates its own .rev (X1)', () => {
    it("Then tsgit's .rev is byte-identical to git's", async () => {
      // Arrange
      const dir = await freshRepo('x1');
      await commitFiles(dir, SEED_FILES, 'seed');
      const sut = trackedNodeContext(dir);
      await packObjects(sut, { wants: ['HEAD'] });
      const artefacts = packArtefactPaths(dir);
      const packBytes = await readFile(artefacts.pack);
      const tsgitRevBytes = await readFile(artefacts.rev);
      const scratch = await newRoot('x1-scratch');

      // Act
      const oracleRevBytes = await buildGitRevOracle(scratch, packBytes);

      // Assert
      assertRevBytesEqual(tsgitRevBytes, oracleRevBytes);
    });
  });

  describe('Given a fixture whose oid and offset orders are non-monotonically correlated, When both tools build its .rev (X2)', () => {
    it("Then the body is a non-trivial permutation, not [0, 1, …, N−1], and still matches git's bytes", async () => {
      // Arrange
      const dir = await freshRepo('x2');
      await commitFiles(dir, SEED_FILES, 'seed');
      const sut = trackedNodeContext(dir);
      const written = await packObjects(sut, { wants: ['HEAD'] });
      const artefacts = packArtefactPaths(dir);
      const packBytes = await readFile(artefacts.pack);
      const tsgitRevBytes = await readFile(artefacts.rev);
      const scratch = await newRoot('x2-scratch');

      // Act
      const oracleRevBytes = await buildGitRevOracle(scratch, packBytes);

      // Assert
      assertRevBytesEqual(tsgitRevBytes, oracleRevBytes);
      expect(written.objectCount).toBeGreaterThanOrEqual(3);
      const body = revBodyPositions(oracleRevBytes, written.objectCount);
      expect(isIdentityPermutation(body)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------
  // X3 / X4 — acceptance by both fsck implementations
  // ---------------------------------------------------------------------

  describe('Given a repo whose pack dir tsgit wrote, When git verify-pack -v and git fsck --strict run (X3)', () => {
    it('Then both exit 0', async () => {
      // Arrange
      const dir = await freshRepo('x3');
      await commitFiles(dir, SEED_FILES, 'seed');
      const sut = trackedNodeContext(dir);
      await packObjects(sut, { wants: ['HEAD'] });
      const artefacts = packArtefactPaths(dir);

      // Act
      const verifyResult = tryRunGitWithExit(['verify-pack', '-v', artefacts.idx]);
      const fsckResult = tryRunGitWithExit(['-C', dir, 'fsck', '--strict']);

      // Assert
      expect(verifyResult.exitCode).toBe(0);
      expect(fsckResult.exitCode).toBe(0);
    });
  });

  describe('Given the same repo, When tsgit fsck runs (X4)', () => {
    it('Then exit bit 64 is clear with no rev-index finding', async () => {
      // Arrange
      const dir = await freshRepo('x4');
      await commitFiles(dir, SEED_FILES, 'seed');
      const writeCtx = trackedNodeContext(dir);
      await packObjects(writeCtx, { wants: ['HEAD'] });
      // Precondition — the fsck rev pass skips an ABSENT .rev without a
      // finding, so a green bit 64 only proves anything when the file exists.
      expect(existsSync(packArtefactPaths(dir).rev)).toBe(true);
      const sut = trackedNodeContext(dir);

      // Act
      const result = await fsck(sut);

      // Assert
      expect(result.exitCode & EXIT_PACK_REV_INDEX).toBe(0);
      expect(result.findings.filter((f) => f.type.startsWith('pack-rev-index'))).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // X5 / X6 — the config gate's absent/valueless arms
  // ---------------------------------------------------------------------

  describe('Given pack.writeReverseIndex=false in the local config, When packObjects runs (X5)', () => {
    it('Then no .rev is written and git fsck --strict stays clean', async () => {
      // Arrange
      const dir = await freshRepo('x5');
      git(dir, 'config', 'pack.writeReverseIndex', 'false');
      await commitFiles(dir, SEED_FILES, 'seed');
      const sut = trackedNodeContext(dir);

      // Act
      await packObjects(sut, { wants: ['HEAD'] });
      const fsckResult = tryRunGitWithExit(['-C', dir, 'fsck', '--strict']);

      // Assert
      const artefacts = packArtefactPaths(dir);
      expect(existsSync(artefacts.pack)).toBe(true);
      expect(existsSync(artefacts.idx)).toBe(true);
      expect(existsSync(artefacts.rev)).toBe(false);
      expect(fsckResult.exitCode).toBe(0);
    });
  });

  describe('Given pack.writeReverseIndex valueless in the local config, When packObjects runs (X6)', () => {
    it('Then .rev is written', async () => {
      // Arrange — git's CLI cannot emit a valueless entry; the config file is
      // written directly.
      const dir = await freshRepo('x6');
      await appendFile(path.join(dir, '.git', 'config'), '[pack]\n\twriteReverseIndex\n');
      await commitFiles(dir, SEED_FILES, 'seed');
      const sut = trackedNodeContext(dir);

      // Act
      await packObjects(sut, { wants: ['HEAD'] });

      // Assert
      expect(existsSync(packArtefactPaths(dir).rev)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // X7 / X7b — the refusal and the accepted integer arm, both tools
  // ---------------------------------------------------------------------

  describe('Given pack.writeReverseIndex=maybe, When the same repo state is handed to both tools (X7)', () => {
    it('Then git exits 128 and tsgit throws CONFIG_BAD_BOOLEAN_VALUE, neither writing new artefacts', async () => {
      // Arrange
      const dir = await freshRepo('x7');
      git(dir, 'config', 'pack.writeReverseIndex', 'maybe');
      await commitFiles(dir, SEED_FILES, 'seed');
      const scratch = await newRoot('x7-scratch');
      const scratchPackPath = path.join(scratch, 'probe.pack');
      const scratchIdxPath = path.join(scratch, 'probe.idx');
      await writeFile(scratchPackPath, cleanPackBytes);
      const sut = trackedNodeContext(dir);

      // Act
      const gitResult = tryRunGitWithExit([
        '-C',
        dir,
        'index-pack',
        '-o',
        scratchIdxPath,
        scratchPackPath,
      ]);
      let caught: unknown;
      try {
        await packObjects(sut, { wants: ['HEAD'] });
        expect.unreachable('packObjects should have thrown CONFIG_BAD_BOOLEAN_VALUE');
      } catch (err) {
        caught = err;
      }

      // Assert — git
      expect(gitResult.exitCode).toBe(128);
      expect(gitResult.stderr).toContain(
        "bad boolean config value 'maybe' for 'pack.writereverseindex'",
      );
      expect(existsSync(scratchIdxPath)).toBe(false);
      expect(existsSync(revPathFor(scratchIdxPath))).toBe(false);
      // Assert — tsgit
      expect(caught).toBeInstanceOf(TsgitError);
      const data = (caught as TsgitError).data as {
        readonly code: string;
        readonly key: string;
        readonly value: string;
      };
      expect(data.code).toBe('CONFIG_BAD_BOOLEAN_VALUE');
      expect(data.key).toBe('pack.writereverseindex');
      expect(data.value).toBe('maybe');
      expect(packDirEntries(dir)).toEqual([]);

      // Over-refusal negative — the key is consumed ONLY on the pack-write
      // path, so with the malformed value still in place both tools' read
      // surfaces keep working. A tsgit that hoisted this gate into the
      // repository pre-flight would fail here while X7 stayed green.
      const gitStatus = tryRunGitWithExit(['-C', dir, 'status', '--short']);
      expect(gitStatus.exitCode).toBe(0);
      const repo = await openRepository({ cwd: dir });
      const statusResult = await repo.status();
      expect(statusResult.clean).toBe(true);
      const logResult = await repo.log({ limit: 1 });
      expect(logResult).toHaveLength(1);
    });
  });

  describe.each([
    { value: '2', expectRev: true },
    { value: '0', expectRev: false },
  ])(
    'Given pack.writeReverseIndex=$value, When the same repo state is handed to both tools (X7b)',
    ({ value, expectRev }) => {
      it(`Then both tools accept it, .rev present: ${String(expectRev)}`, async () => {
        // Arrange
        const dir = await freshRepo(`x7b-${value}`);
        git(dir, 'config', 'pack.writeReverseIndex', value);
        await commitFiles(dir, SEED_FILES, 'seed');
        const scratch = await newRoot(`x7b-scratch-${value}`);
        const scratchPackPath = path.join(scratch, 'probe.pack');
        const scratchIdxPath = path.join(scratch, 'probe.idx');
        await writeFile(scratchPackPath, cleanPackBytes);
        const sut = trackedNodeContext(dir);

        // Act
        const gitResult = tryRunGitWithExit([
          '-C',
          dir,
          'index-pack',
          '-o',
          scratchIdxPath,
          scratchPackPath,
        ]);
        await packObjects(sut, { wants: ['HEAD'] });

        // Assert — git
        expect(gitResult.exitCode).toBe(0);
        expect(existsSync(revPathFor(scratchIdxPath))).toBe(expectRev);
        // Assert — tsgit
        expect(existsSync(packArtefactPaths(dir).rev)).toBe(expectRev);
      });
    },
  );

  // ---------------------------------------------------------------------
  // X8 / X9 — the other write surfaces
  // ---------------------------------------------------------------------

  describe('Given a fresh clone against a local git peer over git-http-backend, When repo.clone runs (X8)', () => {
    it('Then the fetched pack dir has all three artefacts and git reads objects out of it', async () => {
      // Arrange
      const projectRoot = await newRoot('x8-project');
      runGit(['init', '-q', '--bare', '-b', 'main', path.join(projectRoot, 'origin.git')]);
      const seedDir = await newRoot('x8-seed');
      git(seedDir, 'clone', '-q', path.join(projectRoot, 'origin.git'), '.');
      git(seedDir, 'config', 'user.name', 'Ada');
      git(seedDir, 'config', 'user.email', 'ada@example.com');
      await writeFile(path.join(seedDir, 'a.txt'), 'alpha\n');
      git(seedDir, 'add', 'a.txt');
      git(seedDir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed');
      git(seedDir, 'push', '-q', 'origin', 'HEAD:main');
      const server = await startGitHttpBackend({ projectRoot });

      try {
        const workDir = await newRoot('x8-clone');
        const url = `http://127.0.0.1:${server.port}/origin.git`;
        const sut = await openRepository({
          cwd: workDir,
          allowInsecureHttp: true,
          config: {
            allowInsecure: true,
            allowPrivateNetworks: true,
            dnsResolver: async () => ['127.0.0.1'],
          },
        });

        // Act
        await sut.clone({ url });
        await sut.dispose();

        // Assert
        const artefacts = packArtefactPaths(workDir);
        expect(existsSync(artefacts.pack)).toBe(true);
        expect(existsSync(artefacts.idx)).toBe(true);
        expect(existsSync(artefacts.rev)).toBe(true);
        const gitResult = tryRunGitWithExit(['-C', workDir, 'cat-file', '-p', 'HEAD:a.txt']);
        expect(gitResult.exitCode).toBe(0);
        expect(gitResult.stdout).toBe('alpha\n');
      } finally {
        await server.close();
      }
    }, 30_000);
  });

  describe('Given packObjects targets an outputDirectory outside the repo pack dir, When it runs (X9)', () => {
    it('Then the outside directory holds all three artefacts', async () => {
      // Arrange — "outside the repo" means outside `.git/objects/pack`, the
      // same shape the unit suite's own `outputDirectory` fixture uses; the
      // adapter's containment policy scopes every write under the context's
      // own workDir root, so the directory is a sibling under it, not a
      // wholly separate filesystem root.
      const dir = await freshRepo('x9');
      await commitFiles(dir, SEED_FILES, 'seed');
      const outputDirectory = path.join(dir, 'custom-packs');
      const sut = trackedNodeContext(dir);

      // Act
      const written = await packObjects(sut, { wants: ['HEAD'], outputDirectory });

      // Assert — `outputDirectory` is a plain directory, not a `.git`-rooted
      // repo, so the artefact paths are composed directly rather than
      // through `packArtefactPaths`'s repo-shaped lookup.
      const stem = path.join(outputDirectory, `pack-${written.packId}`);
      expect(existsSync(`${stem}.pack`)).toBe(true);
      expect(existsSync(`${stem}.idx`)).toBe(true);
      expect(existsSync(`${stem}.rev`)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // X10 — the self-read, at the always-on scale
  // ---------------------------------------------------------------------

  describe('Given a small tsgit-written pack, When tsgit re-reads its own .rev via loadPackRevIndex (X10)', () => {
    it('Then it reports usable and revIndexPositions matches packPositionMap', async () => {
      // Arrange
      const dir = await freshRepo('x10');
      await commitFiles(dir, SEED_FILES, 'seed');
      const sut = trackedNodeContext(dir);
      const written = await packObjects(sut, { wants: ['HEAD'] });
      const artefacts = packArtefactPaths(dir);
      const idxBytes = await readFile(artefacts.idx);
      const parsedIdx = parsePackIndex(idxBytes, 20);

      // Act
      const load = await loadPackRevIndex(
        sut,
        artefacts.rev,
        true,
        DIGEST_LENGTH,
        written.objectCount,
      );

      // Assert
      expect(load.kind).toBe('usable');
      if (load.kind !== 'usable') throw new Error('unreachable: load.kind was not usable');
      const positions = revIndexPositions(load.value, written.objectCount);
      expect(positions).toEqual(packPositionMap(parsedIdx));
    });
  });

  // ---------------------------------------------------------------------
  // Scaled read-side pickup — the accelerator arm actually fires
  // ---------------------------------------------------------------------

  const SCALE_OBJECTS = 5_000;

  describe('Given a tsgit-written pack at scale, When tsgit reads one of its own packed objects back', () => {
    it('Then the accelerator answers lazily from the freshly written .rev and never warns', async () => {
      // Arrange — built via the domain primitives directly (writeObject +
      // buildPack + writePackArtifacts, the same building blocks packObjects
      // itself composes), so 5,000 objects costs no git subprocess spawns.
      const dir = await freshRepo('scale');
      const writeCtx = trackedNodeContext(dir);
      const oids: ObjectId[] = [];
      for (let i = 0; i < SCALE_OBJECTS; i += 1) {
        const id = await writeObject(writeCtx, {
          type: 'blob',
          id: '' as ObjectId,
          content: ENCODER.encode(`scale blob ${i}\n`),
        });
        oids.push(id);
      }
      const pack = await buildPack(writeCtx, { oids });
      const indexEntries = oids.map((id, i) => ({
        id,
        crc32: pack.entries[i]!.crc32,
        offset: pack.entries[i]!.offset,
      }));
      const written = await writePackArtifacts(writeCtx, {
        packDir: packsDir(commonGitDir(writeCtx)),
        packBytes: pack.bytes,
        entries: indexEntries,
        packSha: pack.sha,
        promisor: false,
      });
      // Remove every loose copy: the object resolver probes loose storage
      // BEFORE the pack registry, so with the loose objects present this test
      // would pass without ever opening the pack, let alone the .rev.
      await removeLooseObjectDirs(dir);
      // Positive oracle at scale: the 5,000-object .rev itself is usable and
      // agrees with the .idx-derived position map.
      const parsedIdx = parsePackIndex(new Uint8Array(await readFile(written.idxPath)), 20);
      const revPath = `${written.packPath.slice(0, -'.pack'.length)}.rev`;
      const scaleCtx = trackedNodeContext(dir);
      const load = await loadPackRevIndex(
        scaleCtx,
        revPath,
        true,
        DIGEST_LENGTH,
        written.objectCount,
      );
      expect(load.kind).toBe('usable');
      if (load.kind !== 'usable') throw new Error('unreachable: load.kind was not usable');
      expect(revIndexPositions(load.value, written.objectCount)).toEqual(
        packPositionMap(parsedIdx),
      );
      const warnCalls: Array<{
        readonly message: string;
        readonly context: Readonly<Record<string, unknown>> | undefined;
      }> = [];
      const sut = trackedNodeContext(dir, {
        warn: (message, context) => {
          warnCalls.push({ message, context });
        },
      });

      // Act — the read now MUST come through the pack (no loose copies left).
      const object = await readObject(sut, oids[0] as ObjectId);

      // Assert
      expect(object.id).toBe(oids[0]);
      expect(warnCalls).toHaveLength(0);

      // Control — corrupt the .rev's magic and re-read through a fresh
      // context: the accelerator's refusal arm warns, proving the empty
      // warnCalls above is a live assertion, not a path never taken.
      const revBytes = new Uint8Array(await readFile(revPath));
      revBytes[0] = 0x00;
      await writeFile(revPath, revBytes);
      const controlWarns: string[] = [];
      const controlCtx = trackedNodeContext(dir, {
        warn: (message) => {
          controlWarns.push(message);
        },
      });
      const reread = await readObject(controlCtx, oids[0] as ObjectId);
      expect(reread.id).toBe(oids[0]);
      expect(controlWarns).toContain('packRegistry: discarding unusable pack reverse index');
    }, 60_000);
  });
});
