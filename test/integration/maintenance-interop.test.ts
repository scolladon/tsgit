/**
 * Cross-tool interop — the `gc` task's loose-object lifecycle. "tsgit on
 * one, real git on its clone" is the shape every row uses: each scenario
 * builds ONE repository with real git, copies it into two independent
 * twins, then runs `git gc` on one and tsgit's `maintenance` on the other.
 *
 * Pack-internal byte layout is NOT compared (tsgit's packer is non-delta;
 * git's is not — both are valid, and the design explicitly excludes pack
 * bytes from the faithfulness surface). What IS compared: which objects
 * live in which file class, the `.mtimes` sidecar's own bytes, file naming
 * and siblings, refusal conditions, and the expiry arithmetic.
 *
 * @proves
 *   surface:        gc
 *   bucket:         cross-tool-interop
 *   unique:         tsgit's cruft-pack lifecycle agrees with `git gc` on object placement, `.mtimes` bytes and the expiry boundary
 *   interopSurface: gc
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { maintenance } from '../../src/application/commands/maintenance.js';
import { commonGitDir, packsDir } from '../../src/application/primitives/path-layout.js';
import { disposePackRegistry } from '../../src/application/primitives/read-object.js';
import { TsgitError } from '../../src/domain/error.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import { parseCruftMtimes, parsePackIndex } from '../../src/domain/storage/index.js';
import { allObjectIds } from '../../src/domain/storage/pack-index.js';
import { openRepository } from '../../src/index.node.js';
import type { Context } from '../../src/ports/context.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;

const tmpDir = (slug: string): Promise<string> =>
  mkdtemp(path.join(os.tmpdir(), `tsgit-gc-${slug}-`));

async function initRepo(slug: string, extraInitArgs: readonly string[] = []): Promise<string> {
  const dir = await tmpDir(slug);
  git(dir, 'init', '-q', '-b', 'main', ...extraInitArgs);
  git(dir, 'config', 'user.name', 'A U Thor');
  git(dir, 'config', 'user.email', 'author@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  disableAutoMaintenance(dir);
  return dir;
}

async function addCommit(dir: string, name: string): Promise<string> {
  await writeFile(path.join(dir, `${name}.txt`), `${name}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', name);
  return git(dir, 'rev-parse', 'HEAD').trim();
}

/** `git hash-object -w --stdin` — an unreferenced loose blob, the cruft
 *  candidate every scenario needs. */
function writeLooseBlobGit(dir: string, content: string): string {
  const out = execFileSync('git', ['-C', dir, 'hash-object', '-w', '--stdin'], {
    input: content,
    encoding: 'utf8',
    env: runGitEnv(),
  });
  return out.trim();
}

const looseGitPath = (dir: string, oid: string): string =>
  path.join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2));

async function forceMtime(filePath: string, epochSeconds: number): Promise<void> {
  const date = new Date(epochSeconds * 1000);
  await utimes(filePath, date, date);
}

/** `tmp_`-prefixed litter names planted in each of the three scan-scope
 *  locations by `plantTempLitter` — a `stale`/`fresh` pair per location, so
 *  a survivor-set comparison proves both the removal AND the age gate. */
const TEMP_LITTER_NAMES = {
  rootStale: 'tmp_root_stale',
  rootFresh: 'tmp_root_fresh',
  fanoutStale: 'tmp_obj_stale',
  fanoutFresh: 'tmp_obj_fresh',
  packStale: 'tmp_pack_stale',
  packFresh: 'tmp_pack_fresh',
} as const;

/**
 * Plants an identical stale+fresh `tmp_` litter pair in `objects/` root, the
 * `ab/` fanout dir (created if the repo has no object with that prefix
 * yet), and `objects/pack/` — the exact three scan-scope locations the gc
 * task's removal step covers. `staleEpochSeconds` backdates only the
 * `*Stale` names; the `*Fresh` names keep their real write-time mtime.
 */
async function plantTempLitter(dir: string, staleEpochSeconds: number): Promise<void> {
  const objectsDir = path.join(dir, '.git', 'objects');
  const fanoutDir = path.join(objectsDir, 'ab');
  const packDir = path.join(objectsDir, 'pack');
  await mkdir(fanoutDir, { recursive: true });
  await mkdir(packDir, { recursive: true });
  await writeFile(path.join(objectsDir, TEMP_LITTER_NAMES.rootStale), '');
  await writeFile(path.join(objectsDir, TEMP_LITTER_NAMES.rootFresh), '');
  await writeFile(path.join(fanoutDir, TEMP_LITTER_NAMES.fanoutStale), '');
  await writeFile(path.join(fanoutDir, TEMP_LITTER_NAMES.fanoutFresh), '');
  await writeFile(path.join(packDir, TEMP_LITTER_NAMES.packStale), '');
  await writeFile(path.join(packDir, TEMP_LITTER_NAMES.packFresh), '');
  await forceMtime(path.join(objectsDir, TEMP_LITTER_NAMES.rootStale), staleEpochSeconds);
  await forceMtime(path.join(fanoutDir, TEMP_LITTER_NAMES.fanoutStale), staleEpochSeconds);
  await forceMtime(path.join(packDir, TEMP_LITTER_NAMES.packStale), staleEpochSeconds);
}

/** Every `tmp_`-prefixed name still present across the three scan-scope
 *  locations, sorted — real pack/idx/mtimes artefacts never start with
 *  `tmp_`, so this reads as exactly the surviving litter regardless of
 *  which tool (git or tsgit) produced the rest of `objects/pack/`. */
async function tempLitterSurvivors(dir: string): Promise<ReadonlyArray<string>> {
  const objectsDir = path.join(dir, '.git', 'objects');
  const fanoutDir = path.join(objectsDir, 'ab');
  const packDir = path.join(objectsDir, 'pack');
  const [rootEntries, fanoutEntries, packEntries] = await Promise.all([
    readdir(objectsDir),
    readdir(fanoutDir),
    readdir(packDir),
  ]);
  return [...rootEntries, ...fanoutEntries, ...packEntries]
    .filter((name) => name.startsWith('tmp_'))
    .sort();
}

interface Twin {
  readonly peerDir: string;
  readonly oursDir: string;
}

async function makeTwin(baseDir: string, slug: string): Promise<Twin> {
  const peerDir = await tmpDir(`${slug}-peer`);
  const oursDir = await tmpDir(`${slug}-ours`);
  // `preserveTimestamps` is load-bearing: mtime is the cruft lifecycle's own
  // provenance signal, and a plain copy resets it to "now" on both twins,
  // silently destroying every forced-mtime fixture upstream of this call.
  await cp(baseDir, peerDir, { recursive: true, preserveTimestamps: true });
  await cp(baseDir, oursDir, { recursive: true, preserveTimestamps: true });
  return { peerDir, oursDir };
}

async function disposeTwin(twin: Twin): Promise<void> {
  await rm(twin.peerDir, { recursive: true, force: true });
  await rm(twin.oursDir, { recursive: true, force: true });
}

// Every Context a row builds is disposed after the row — packed reads open
// persistent FileHandles, and an undisposed registry surfaces as the
// GC-close warning the handle-lifecycle work treats as its leak oracle.
const liveContexts: Context[] = [];
function trackedNodeContext(oursDir: string, algorithm: 'sha1' | 'sha256'): Context {
  const ctx = createNodeContext({ workDir: oursDir, algorithm });
  liveContexts.push(ctx);
  return ctx;
}
afterEach(async () => {
  await Promise.all(liveContexts.splice(0).map((ctx) => disposePackRegistry(ctx)));
});

async function runOursGc(
  oursDir: string,
  algorithm: 'sha1' | 'sha256' = 'sha1',
): Promise<{ readonly ctx: Context; readonly result: Awaited<ReturnType<typeof maintenance>> }> {
  const ctx = trackedNodeContext(oursDir, algorithm);
  const result = await maintenance(ctx, { tasks: ['gc'] });
  return { ctx, result };
}

const runPeerGc = (dir: string, extraConfig: readonly string[] = []): void => {
  const configArgs = extraConfig.flatMap((kv) => ['-c', kv]);
  git(dir, ...configArgs, 'gc');
};

/**
 * Appends `gc.<key>=<value>` pairs (the same `-c gc.key=value` shape
 * `runPeerGc`'s `extraConfig` takes) to `oursDir`'s own `.git/config` —
 * `-c` has no tsgit equivalent, so parity requires writing the setting into
 * the file tsgit actually reads.
 */
async function setOursGcConfig(oursDir: string, extraConfig: readonly string[]): Promise<void> {
  if (extraConfig.length === 0) return;
  const configPath = path.join(oursDir, '.git', 'config');
  const existing = await readFile(configPath, 'utf8');
  const body = extraConfig
    .map((kv) => kv.slice('gc.'.length))
    .map((entry) => {
      const eq = entry.indexOf('=');
      return `\t${entry.slice(0, eq)} = ${entry.slice(eq + 1)}\n`;
    })
    .join('');
  await writeFile(configPath, `${existing}\n[gc]\n${body}`);
}

/** Runs `git gc` on the peer and tsgit's `maintenance` gc task on `ours`,
 *  with the identical `gc.*` config applied to both. */
async function runBothGc(
  twin: Twin,
  extraConfig: readonly string[] = [],
  algorithm: 'sha1' | 'sha256' = 'sha1',
): Promise<{ readonly ctx: Context; readonly result: Awaited<ReturnType<typeof maintenance>> }> {
  runPeerGc(twin.peerDir, extraConfig);
  await setOursGcConfig(twin.oursDir, extraConfig);
  return runOursGc(twin.oursDir, algorithm);
}

function catFileExists(dir: string, oid: string): boolean {
  return tryRunGitWithExit(['-C', dir, 'cat-file', '-e', oid]).exitCode === 0;
}

async function packDirEntries(dir: string): Promise<ReadonlyArray<string>> {
  return readdir(path.join(dir, '.git', 'objects', 'pack'));
}

async function readOursMtimesMap(
  ctx: Context,
  cruftPackId: ObjectId,
): Promise<ReadonlyMap<ObjectId, number>> {
  const dir = packsDir(commonGitDir(ctx));
  const idxBytes = await readFile(`${dir}/pack-${cruftPackId}.idx`);
  const index = parsePackIndex(new Uint8Array(idxBytes), ctx.hashConfig.digestLength);
  const oidsInIndexOrder = allObjectIds(index);
  const mtimesBytes = await readFile(`${dir}/pack-${cruftPackId}.mtimes`);
  return parseCruftMtimes(new Uint8Array(mtimesBytes), oidsInIndexOrder);
}

/** Every oid a tsgit-written pack carries, straight off its own `.idx`. */
async function readOursPackOids(ctx: Context, packId: ObjectId): Promise<ReadonlySet<ObjectId>> {
  const dir = packsDir(commonGitDir(ctx));
  const idxBytes = await readFile(`${dir}/pack-${packId}.idx`);
  const index = parsePackIndex(new Uint8Array(idxBytes), ctx.hashConfig.digestLength);
  return new Set(allObjectIds(index));
}

/** Every `.pack` file under `dir` whose contents include `oid`, read via
 *  `git verify-pack -v` — the only way to attribute a raw oid to a SPECIFIC
 *  pack among several, needed to prove git itself duplicates a reachable
 *  promisor-pack object into more than one pack. */
async function peerPackNamesContaining(dir: string, oid: string): Promise<ReadonlyArray<string>> {
  const packDir = path.join(dir, '.git', 'objects', 'pack');
  const idxFiles = (await readdir(packDir)).filter((name) => name.endsWith('.idx'));
  const hits: string[] = [];
  for (const idx of idxFiles) {
    const out = execFileSync('git', ['-C', dir, 'verify-pack', '-v', path.join(packDir, idx)], {
      encoding: 'utf8',
      env: runGitEnv(),
    });
    if (out.includes(oid)) hits.push(idx.replace(/\.idx$/, '.pack'));
  }
  return hits;
}

/**
 * Builds a pack from exactly `oids` via `git pack-objects` and marks it with
 * `suffix` (`.promisor`, `.keep`, …) — the same manual-construction shape
 * the existing `*.keep` fixture above uses: real `git gc` keys a pack's
 * class off its sibling MARKER FILE alone, never off remote/partial-clone
 * config, so a bare `.promisor` touch reproduces a partial clone's
 * placement rules without the protocol negotiation a real
 * `--filter=blob:none` clone would need.
 */
async function buildMarkedPack(
  dir: string,
  oids: ReadonlyArray<string>,
  suffix: string,
): Promise<string> {
  const packSha = execFileSync(
    'git',
    ['-C', dir, 'pack-objects', '--non-empty', path.join(dir, '.git', 'objects', 'pack', 'pack')],
    { input: `${oids.join('\n')}\n`, encoding: 'utf8', env: runGitEnv() },
  ).trim();
  await writeFile(path.join(dir, '.git', 'objects', 'pack', `pack-${packSha}${suffix}`), '');
  return packSha;
}

describe.skipIf(!GIT_AVAILABLE)('gc interop', () => {
  describe('Given a reachable commit and one unreachable, fresh loose blob, When gc runs on both twins', () => {
    let baseDir: string;
    let danglingId: string;

    beforeAll(async () => {
      baseDir = await initRepo('creation');
      await addCommit(baseDir, 'c0');
      danglingId = writeLooseBlobGit(baseDir, 'dangling');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then both tools park it in a cruft pack: readable, fsck-dangling, counted in-pack', async () => {
      // Arrange
      const twin = await makeTwin(baseDir, 'creation');
      const { result } = await runBothGc(twin);

      // Assert
      expect(result.cruftPackId).toBeDefined();
      expect(catFileExists(twin.peerDir, danglingId)).toBe(true);
      expect(catFileExists(twin.oursDir, danglingId)).toBe(true);
      const peerFsck = git(twin.peerDir, 'fsck');
      const oursFsck = git(twin.oursDir, 'fsck');
      expect(peerFsck).toContain(`dangling blob ${danglingId}`);
      expect(oursFsck).toContain(`dangling blob ${danglingId}`);
      const oursEntries = await packDirEntries(twin.oursDir);
      expect(oursEntries.some((n) => n.endsWith('.mtimes'))).toBe(true);
      expect(oursEntries.some((n) => n.endsWith('.bitmap'))).toBe(false);
      await disposeTwin(twin);
    });
  });

  describe('Given the same forced mtime on the same unreachable blob on both twins, When gc runs on both', () => {
    let baseDir: string;
    let blobId: string;
    const FORCED_MTIME = 1_780_000_000;

    beforeAll(async () => {
      baseDir = await initRepo('mtimes-format');
      await addCommit(baseDir, 'c0');
      blobId = writeLooseBlobGit(baseDir, 'aged-dangler');
      await forceMtime(looseGitPath(baseDir, blobId), FORCED_MTIME);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then the .mtimes sidecar records the identical mtime on both sides, in the same header/body/trailer shape', async () => {
      // Arrange
      const twin = await makeTwin(baseDir, 'mtimes-format');
      const { ctx, result } = await runBothGc(twin, ['gc.pruneExpire=never']);

      // Act
      const peerEntries = await packDirEntries(twin.peerDir);
      const peerCruftName = peerEntries.find((n) => n.endsWith('.mtimes'));
      expect(peerCruftName).toBeDefined();
      const peerSha = (peerCruftName as string).slice('pack-'.length, -'.mtimes'.length);
      const peerIdxBytes = await readFile(
        path.join(twin.peerDir, '.git', 'objects', 'pack', `pack-${peerSha}.idx`),
      );
      const peerIndex = parsePackIndex(new Uint8Array(peerIdxBytes), 20);
      const peerOidsInOrder = allObjectIds(peerIndex);
      const peerMtimesBytes = await readFile(
        path.join(twin.peerDir, '.git', 'objects', 'pack', `pack-${peerSha}.mtimes`),
      );
      const peerMtimes = parseCruftMtimes(new Uint8Array(peerMtimesBytes), peerOidsInOrder);

      const oursMtimes = await readOursMtimesMap(ctx, result.cruftPackId as ObjectId);

      // Assert — same magic-derived structure (both parse successfully) and
      // the identical recorded mtime for the identical object.
      expect(peerMtimes.get(blobId as ObjectId)).toBe(FORCED_MTIME);
      expect(oursMtimes.get(blobId as ObjectId)).toBe(FORCED_MTIME);
      await disposeTwin(twin);
    });
  });

  describe('Given three unreachable blobs at cutoff-1, cutoff and cutoff+1, When gc runs at that cutoff on both twins', () => {
    let baseDir: string;
    let below: string;
    let atCutoff: string;
    let above: string;
    const CUTOFF = 1_787_500_000;

    beforeAll(async () => {
      baseDir = await initRepo('boundary');
      await addCommit(baseDir, 'c0');
      below = writeLooseBlobGit(baseDir, 'below');
      atCutoff = writeLooseBlobGit(baseDir, 'at-cutoff');
      above = writeLooseBlobGit(baseDir, 'above');
      await forceMtime(looseGitPath(baseDir, below), CUTOFF - 1);
      await forceMtime(looseGitPath(baseDir, atCutoff), CUTOFF);
      await forceMtime(looseGitPath(baseDir, above), CUTOFF + 1);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then both tools destroy at and below the cutoff and keep only above it', async () => {
      // Arrange
      const twin = await makeTwin(baseDir, 'boundary');
      await runBothGc(twin, [`gc.pruneExpire=@${CUTOFF}`]);

      // Assert
      for (const dir of [twin.peerDir, twin.oursDir]) {
        expect(catFileExists(dir, below)).toBe(false);
        expect(catFileExists(dir, atCutoff)).toBe(false);
        expect(catFileExists(dir, above)).toBe(true);
      }
      await disposeTwin(twin);
    });
  });

  describe('Given gc.pruneExpire=never with an aged unreachable blob, When gc runs on both twins', () => {
    let baseDir: string;
    let blobId: string;

    beforeAll(async () => {
      baseDir = await initRepo('prune-never');
      await addCommit(baseDir, 'c0');
      blobId = writeLooseBlobGit(baseDir, 'ancient');
      await forceMtime(looseGitPath(baseDir, blobId), 1);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then both tools keep it forever in a cruft pack', async () => {
      // Arrange
      const twin = await makeTwin(baseDir, 'prune-never');
      const { result } = await runBothGc(twin, ['gc.pruneExpire=never']);

      // Assert
      expect(catFileExists(twin.peerDir, blobId)).toBe(true);
      expect(catFileExists(twin.oursDir, blobId)).toBe(true);
      expect(result.cruftPackId).toBeDefined();
      await disposeTwin(twin);
    });
  });

  describe('Given gc.pruneExpire=now with a freshly-written unreachable blob, When gc runs on both twins', () => {
    let baseDir: string;
    let blobId: string;

    beforeAll(async () => {
      baseDir = await initRepo('prune-now');
      await addCommit(baseDir, 'c0');
      blobId = writeLooseBlobGit(baseDir, 'fresh-but-doomed');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then both tools destroy it outright, with no cruft pack at all', async () => {
      // Arrange
      const twin = await makeTwin(baseDir, 'prune-now');
      const { result } = await runBothGc(twin, ['gc.pruneExpire=now']);

      // Assert
      expect(catFileExists(twin.peerDir, blobId)).toBe(false);
      expect(catFileExists(twin.oursDir, blobId)).toBe(false);
      expect(result.cruftPackId).toBeUndefined();
      const peerEntries = await packDirEntries(twin.peerDir);
      const oursEntries = await packDirEntries(twin.oursDir);
      expect(peerEntries.some((n) => n.endsWith('.mtimes'))).toBe(false);
      expect(oursEntries.some((n) => n.endsWith('.mtimes'))).toBe(false);
      await disposeTwin(twin);
    });
  });

  describe('Given an existing cruft pack, When new unreachable garbage appears before a second gc', () => {
    let baseDir: string;
    let genOneId: string;
    let genTwoId: string;

    beforeAll(async () => {
      baseDir = await initRepo('rewrite');
      await addCommit(baseDir, 'c0');
      genOneId = writeLooseBlobGit(baseDir, 'gen1');
      await forceMtime(looseGitPath(baseDir, genOneId), 1_900_000_000);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then both tools rewrite the cruft pack under a new sha, carrying gen1 and adding gen2', async () => {
      // Arrange
      const twin = await makeTwin(baseDir, 'rewrite');
      await runBothGc(twin, ['gc.pruneExpire=never']);
      const peerFirstEntries = await packDirEntries(twin.peerDir);
      const oursFirstEntries = await packDirEntries(twin.oursDir);
      const peerFirstCruft = peerFirstEntries.find((n) => n.endsWith('.mtimes'));
      const oursFirstCruft = oursFirstEntries.find((n) => n.endsWith('.mtimes'));

      // Act
      genTwoId = writeLooseBlobGit(twin.peerDir, 'gen2');
      writeLooseBlobGit(twin.oursDir, 'gen2');
      await forceMtime(looseGitPath(twin.peerDir, genTwoId), 1_950_000_000);
      await forceMtime(looseGitPath(twin.oursDir, genTwoId), 1_950_000_000);
      const { ctx, result: second } = await runBothGc(twin, ['gc.pruneExpire=never']);
      const peerSecondEntries = await packDirEntries(twin.peerDir);
      const peerSecondCruft = peerSecondEntries.find((n) => n.endsWith('.mtimes'));
      const oursSecondEntries = await packDirEntries(twin.oursDir);

      // Assert — both rewrote under a new name, both carry both generations.
      // `oursFirstCruft`/`second.cruftPackId` are asserted defined FIRST:
      // an undefined `cruftPackId` would otherwise make the template
      // literal below `"pack-undefined.mtimes"`, which trivially differs
      // from any real first-generation name without proving a rewrite
      // happened at all.
      expect(peerFirstCruft).toBeDefined();
      expect(peerSecondCruft).not.toBe(peerFirstCruft);
      expect(oursFirstCruft).toBeDefined();
      expect(second.cruftPackId).toBeDefined();
      const oursSecondCruftName = `pack-${second.cruftPackId}.mtimes`;
      expect(oursSecondCruftName).not.toBe(oursFirstCruft);
      expect(oursSecondEntries).toContain(oursSecondCruftName);
      const oursMtimes = await readOursMtimesMap(ctx, second.cruftPackId as ObjectId);
      expect(oursMtimes.has(genOneId as ObjectId)).toBe(true);
      expect(oursMtimes.has(genTwoId as ObjectId)).toBe(true);
      expect(catFileExists(twin.peerDir, genOneId)).toBe(true);
      expect(catFileExists(twin.peerDir, genTwoId)).toBe(true);
      expect(catFileExists(twin.oursDir, genOneId)).toBe(true);
      expect(catFileExists(twin.oursDir, genTwoId)).toBe(true);
      await disposeTwin(twin);
    });
  });

  describe('Given an unreachable object crufted by gc, When it is made reachable before the next gc', () => {
    let baseDir: string;
    let blobId: string;

    beforeAll(async () => {
      baseDir = await initRepo('resurrection');
      await addCommit(baseDir, 'c0');
      blobId = writeLooseBlobGit(baseDir, 'resurrected');
      await forceMtime(looseGitPath(baseDir, blobId), 1_900_000_000);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then both tools drop the cruft pack and keep the object only in a normal pack', async () => {
      // Arrange
      const twin = await makeTwin(baseDir, 'resurrection');
      // `gc.packRefs=false`: a blob-headed branch is unusual but not
      // malformed (exactly what gc's own retention-roots probe constructs)
      // — git's `pack-refs` sub-step refuses it outright, a divergence
      // from the cruft lifecycle this row is pinning, so it is turned off
      // on both.
      await runBothGc(twin, ['gc.pruneExpire=never', 'gc.packRefs=false']);

      // Act — a plain ref-file write, bypassing `update-ref`'s commit-only
      // type check.
      await writeFile(path.join(twin.peerDir, '.git', 'refs', 'heads', 'keep'), `${blobId}\n`);
      await writeFile(path.join(twin.oursDir, '.git', 'refs', 'heads', 'keep'), `${blobId}\n`);
      const { result: second } = await runBothGc(twin, [
        'gc.pruneExpire=never',
        'gc.packRefs=false',
      ]);

      // Assert
      expect(second.cruftPackId).toBeUndefined();
      const peerEntries = await packDirEntries(twin.peerDir);
      const oursEntries = await packDirEntries(twin.oursDir);
      expect(peerEntries.some((n) => n.endsWith('.mtimes'))).toBe(false);
      expect(oursEntries.some((n) => n.endsWith('.mtimes'))).toBe(false);
      expect(catFileExists(twin.peerDir, blobId)).toBe(true);
      expect(catFileExists(twin.oursDir, blobId)).toBe(true);
      await disposeTwin(twin);
    });
  });

  describe('Given an index-only blob and a reflog-only commit, When gc runs on both twins', () => {
    let baseDir: string;
    let stagedId: string;
    let reflogOnlyId: string;

    beforeAll(async () => {
      baseDir = await initRepo('retention-roots');
      await addCommit(baseDir, 'c0');
      await writeFile(path.join(baseDir, 'staged.txt'), 'staged-only\n');
      git(baseDir, 'add', 'staged.txt');
      stagedId = git(baseDir, 'rev-parse', ':staged.txt').trim();
      git(baseDir, 'checkout', '-q', '-b', 'gone');
      reflogOnlyId = await addCommit(baseDir, 'gone-commit');
      git(baseDir, 'checkout', '-q', 'main');
      git(baseDir, 'branch', '-D', 'gone');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then both tools keep the index-only blob and the reflog-only commit reachable', async () => {
      // Arrange
      const twin = await makeTwin(baseDir, 'retention-roots');
      await runBothGc(twin);

      // Assert
      expect(catFileExists(twin.peerDir, stagedId)).toBe(true);
      expect(catFileExists(twin.oursDir, stagedId)).toBe(true);
      expect(catFileExists(twin.peerDir, reflogOnlyId)).toBe(true);
      expect(catFileExists(twin.oursDir, reflogOnlyId)).toBe(true);
      await disposeTwin(twin);
    });
  });

  describe("Given a repository with refs and a reflog, When tsgit's gc runs", () => {
    let baseDir: string;

    beforeAll(async () => {
      baseDir = await initRepo('no-ref-mutation');
      await addCommit(baseDir, 'c0');
      writeLooseBlobGit(baseDir, 'garbage');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it("Then tsgit's gc leaves refs and reflogs byte-identical, unlike git's own pack-refs side effect", async () => {
      // Arrange
      const oursDir = await tmpDir('no-ref-mutation-ours');
      await cp(baseDir, oursDir, { recursive: true });
      const refPath = path.join(oursDir, '.git', 'refs', 'heads', 'main');
      const reflogPath = path.join(oursDir, '.git', 'logs', 'refs', 'heads', 'main');
      const refBefore = await readFile(refPath);
      const reflogBefore = await readFile(reflogPath);

      // Act
      await runOursGc(oursDir);

      // Assert — the loose ref and reflog files are untouched.
      expect(Buffer.compare(refBefore, await readFile(refPath))).toBe(0);
      expect(Buffer.compare(reflogBefore, await readFile(reflogPath))).toBe(0);
      await rm(oursDir, { recursive: true, force: true });
    });
  });

  describe('Given a --object-format=sha256 repository with an unreachable blob, When gc runs on both twins', () => {
    let baseDir: string;
    let blobId: string;

    beforeAll(async () => {
      baseDir = await initRepo('sha256', ['--object-format=sha256']);
      await addCommit(baseDir, 'c0');
      blobId = writeLooseBlobGit(baseDir, 'sha256-dangler');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then the cruft sidecar uses hash id 2 with 32-byte trailers on both tools', async () => {
      // Arrange
      const twin = await makeTwin(baseDir, 'sha256');
      const { ctx, result } = await runBothGc(twin, ['gc.pruneExpire=never'], 'sha256');

      // Assert
      expect(result.cruftPackId).toBeDefined();
      expect(catFileExists(twin.peerDir, blobId)).toBe(true);
      expect(catFileExists(twin.oursDir, blobId)).toBe(true);
      const dir = packsDir(commonGitDir(ctx));
      const mtimesBytes = await readFile(`${dir}/pack-${result.cruftPackId}.mtimes`);
      expect(mtimesBytes.length).toBe(12 + 4 * 1 + 32 + 32);
      const view = new DataView(mtimesBytes.buffer, mtimesBytes.byteOffset, mtimesBytes.byteLength);
      expect(view.getUint32(8)).toBe(2);
      await disposeTwin(twin);
    });
  });

  describe('Given an unparseable gc.pruneExpire value, When gc runs on both twins', () => {
    let baseDir: string;

    beforeAll(async () => {
      baseDir = await initRepo('malformed-expiry');
      await addCommit(baseDir, 'c0');
      writeLooseBlobGit(baseDir, 'irrelevant');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then both tools refuse rather than silently defaulting the cutoff', async () => {
      // Arrange
      const twin = await makeTwin(baseDir, 'malformed-expiry');
      const peerResult = tryRunGitWithExit([
        '-C',
        twin.peerDir,
        '-c',
        'gc.pruneExpire=not-a-date',
        'gc',
      ]);

      // Act — config is written BEFORE the Context is built, matching
      // every other row's ordering (`runBothGc`'s own `setOursGcConfig`
      // call precedes `runOursGc`'s Context construction).
      let oursCaught: unknown;
      try {
        await setOursGcConfig(twin.oursDir, ['gc.pruneExpire=not-a-date']);
        const ctx = trackedNodeContext(twin.oursDir, 'sha1');
        await maintenance(ctx, { tasks: ['gc'] });
      } catch (error) {
        oursCaught = error;
      }

      // Assert — both refuse; git with a non-zero exit, tsgit with a typed error.
      expect(peerResult.exitCode).not.toBe(0);
      expect(oursCaught).toBeInstanceOf(TsgitError);
      expect((oursCaught as TsgitError).data.code).toBe('CONFIG_BAD_DATE_VALUE');
      await disposeTwin(twin);
    });
  });

  // ---------------------------------------------------------------------
  // Consolidation — pre-existing packs
  // ---------------------------------------------------------------------

  describe('Given three separate reachable packs plus loose content, When gc runs on both twins', () => {
    let baseDir: string;

    beforeAll(async () => {
      baseDir = await initRepo('consolidate');
      await addCommit(baseDir, 'p1');
      git(baseDir, 'repack', '-q', '-d'); // pack #1
      await addCommit(baseDir, 'p2');
      git(baseDir, 'repack', '-q', '-d'); // pack #2
      await addCommit(baseDir, 'p3');
      git(baseDir, 'repack', '-q', '-d'); // pack #3
      await addCommit(baseDir, 'loose'); // stays loose going into gc
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then every reachable object ends up in exactly one new pack on both twins, and every predecessor is gone', async () => {
      // Arrange
      const twin = await makeTwin(baseDir, 'consolidate');
      const entriesBefore = await packDirEntries(twin.oursDir);
      const packCountBefore = entriesBefore.filter((n) => n.endsWith('.pack')).length;
      expect(packCountBefore).toBe(3); // p1/p2/p3, loose still loose

      // Act
      const { result } = await runBothGc(twin);

      // Assert — one surviving pack on each twin, and the predecessors are gone.
      const peerEntries = await packDirEntries(twin.peerDir);
      const oursEntries = await packDirEntries(twin.oursDir);
      expect(peerEntries.filter((n) => n.endsWith('.pack')).length).toBe(1);
      expect(oursEntries.filter((n) => n.endsWith('.pack')).length).toBe(1);
      expect(result.packId).toBeDefined();
      expect(oursEntries).toContain(`pack-${result.packId}.pack`);
      expect(result.cruftPackId).toBeUndefined(); // nothing unreachable in this fixture
      expect(result.packsRetired).toBe(3);
      await disposeTwin(twin);
    });
  });

  describe('Given an object packed while reachable, then made unreachable, When gc runs on both twins', () => {
    let baseDir: string;
    let doomedId: string;

    beforeAll(async () => {
      baseDir = await initRepo('migrate-source-mtime');
      await addCommit(baseDir, 'c0');
      git(baseDir, 'checkout', '-q', '-b', 'doomed');
      doomedId = await addCommit(baseDir, 'doomed');
      git(baseDir, 'checkout', '-q', 'main');
      git(baseDir, 'repack', '-q', '-d'); // packs c0 AND doomed's commit together
      git(baseDir, 'branch', '-q', '-D', 'doomed');
      git(baseDir, 'reflog', 'expire', '--expire=now', '--all');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then it migrates to the cruft pack on both twins, and stays fsck-dangling', async () => {
      // Arrange
      const twin = await makeTwin(baseDir, 'migrate-source-mtime');

      // Act
      const { result } = await runBothGc(twin);

      // Assert
      expect(result.cruftPackId).toBeDefined();
      expect(catFileExists(twin.peerDir, doomedId)).toBe(true);
      expect(catFileExists(twin.oursDir, doomedId)).toBe(true);
      const peerFsck = git(twin.peerDir, 'fsck');
      expect(peerFsck).toContain(`dangling commit ${doomedId}`);
      // Two packs survive: the reachable-only normal pack (c0's own commit,
      // tree and blob) and the cruft pack (doomed's commit, tree and blob,
      // migrated out of the pack that used to hold all six together).
      const oursEntries = await packDirEntries(twin.oursDir);
      expect(oursEntries.filter((n) => n.endsWith('.pack')).length).toBe(2);
      await disposeTwin(twin);
    });
  });

  describe('Given a *.keep-marked pack with an unreachable member, plus other reachable content, When gc runs on both twins', () => {
    let baseDir: string;
    let keptPackName: string;
    let keptUnreachableId: string;

    beforeAll(async () => {
      baseDir = await initRepo('keep-survives');
      await addCommit(baseDir, 'c0');
      keptUnreachableId = writeLooseBlobGit(baseDir, 'kept-dangling');
      // `git repack -d` alone only packs REACHABLE objects — the dangling
      // blob would stay loose, defeating this fixture. `pack-objects` over
      // an explicit oid list forces both into the SAME pack; the loose
      // copies it duplicates are left in place deliberately (gc's own
      // prune-packable unlink is what should remove them).
      const revListOut = execFileSync('git', ['-C', baseDir, 'rev-list', '--objects', 'main'], {
        encoding: 'utf8',
        env: runGitEnv(),
      });
      const reachableOids = revListOut
        .split('\n')
        .map((line) => line.split(' ')[0])
        .filter((oid): oid is string => Boolean(oid));
      const packSha = execFileSync(
        'git',
        [
          '-C',
          baseDir,
          'pack-objects',
          '--non-empty',
          path.join(baseDir, '.git', 'objects', 'pack', 'pack'),
        ],
        {
          input: `${[...reachableOids, keptUnreachableId].join('\n')}\n`,
          encoding: 'utf8',
          env: runGitEnv(),
        },
      ).trim();
      keptPackName = `pack-${packSha}.pack`;
      await writeFile(path.join(baseDir, '.git', 'objects', 'pack', `pack-${packSha}.keep`), '');
      await addCommit(baseDir, 'c1'); // more reachable content, left loose
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then the kept pack survives byte-identical, and its unreachable member is never crufted', async () => {
      // Arrange
      const twin = await makeTwin(baseDir, 'keep-survives');
      const keptPackPath = path.join(twin.oursDir, '.git', 'objects', 'pack', keptPackName);
      const keptBytesBefore = await readFile(keptPackPath);

      // Act
      const { result } = await runBothGc(twin);
      const keptBytesAfter = await readFile(keptPackPath);

      // Assert — bytes unchanged; still present under its own name; its
      // dangling member is neither duplicated into the new pack nor crufted.
      expect(Buffer.compare(keptBytesBefore, keptBytesAfter)).toBe(0);
      expect(catFileExists(twin.oursDir, keptUnreachableId)).toBe(true);
      expect(catFileExists(twin.peerDir, keptUnreachableId)).toBe(true);
      const oursEntries = await packDirEntries(twin.oursDir);
      expect(oursEntries).toContain(keptPackName);
      expect(oursEntries.some((n) => n.endsWith('.mtimes'))).toBe(false);
      expect(result.cruftPackId).toBeUndefined();
      await disposeTwin(twin);
    });
  });

  describe('Given exactly one normal pack and nothing loose, When gc runs a second time on ours', () => {
    let baseDir: string;

    beforeAll(async () => {
      baseDir = await initRepo('single-pack-no-op');
      await addCommit(baseDir, 'c0');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then it still writes a pack — behaviour, not sha equality, since tsgit is base-only and git is deltified', async () => {
      // Arrange
      const twin = await makeTwin(baseDir, 'single-pack-no-op');
      const { ctx: firstCtx, result: first } = await runOursGc(twin.oursDir);
      const packPathOf = (id: ObjectId) =>
        path.join(twin.oursDir, '.git', 'objects', 'pack', `pack-${id}.pack`);
      const bytesBefore = await readFile(packPathOf(first.packId as ObjectId));

      // Act — a second, independent gc run against the SAME unchanged tree.
      const second = await maintenance(firstCtx, { tasks: ['gc'] });
      const bytesAfter = await readFile(packPathOf(second.packId as ObjectId));

      // Assert — same content reproduced under the same sha; a pack was
      // genuinely written both times (no "already consolidated" skip — the
      // no-op boundary reproduces the same sha, never a skipped rewrite).
      expect(second.packId).toBe(first.packId);
      expect(Buffer.compare(bytesBefore, bytesAfter)).toBe(0);
      await disposeTwin(twin);
    });
  });

  describe('Given a multi-pack-index naming a pack gc retires, When gc runs on ours', () => {
    let baseDir: string;

    beforeAll(async () => {
      baseDir = await initRepo('midx-expiry');
      await addCommit(baseDir, 'c0');
      git(baseDir, 'repack', '-q', '-d');
      git(baseDir, 'multi-pack-index', 'write');
      await addCommit(baseDir, 'c1');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then the multi-pack-index is deleted, matching git', async () => {
      // Arrange
      const twin = await makeTwin(baseDir, 'midx-expiry');
      const midxPath = (dir: string) =>
        path.join(dir, '.git', 'objects', 'pack', 'multi-pack-index');
      const midxPathExisted = await readFile(midxPath(twin.oursDir))
        .then(() => true)
        .catch(() => false);
      expect(midxPathExisted).toBe(true);

      // Act
      runPeerGc(twin.peerDir);
      await runOursGc(twin.oursDir);

      // Assert — both tools remove the midx once it names a retired pack.
      const peerMidxGone = await readFile(midxPath(twin.peerDir))
        .then(() => false)
        .catch(() => true);
      const oursMidxGone = await readFile(midxPath(twin.oursDir))
        .then(() => false)
        .catch(() => true);
      expect(peerMidxGone).toBe(true);
      expect(oursMidxGone).toBe(true);
      await disposeTwin(twin);
    });
  });

  // ---------------------------------------------------------------------
  // Promisor packs — consolidated in their own class, never merged
  // ---------------------------------------------------------------------

  describe('Given a partial-clone-shaped repository — a .promisor-marked pack, a normal pack and loose content, When gc runs on both twins', () => {
    let baseDir: string;
    let oldPromisorPackName: string;
    let promisorOid: string;

    beforeAll(async () => {
      baseDir = await initRepo('promisor-rebuild');
      // p0's commit+tree+blob repacked together — a manually-marked
      // multi-object pack, not a single blob: tsgit's base-only packer and
      // git's own can otherwise reproduce byte-identical output for a
      // trivial one-object pack, which would make the "old pack gone"
      // assertion below pass or fail on a coincidence rather than the
      // property under test.
      promisorOid = await addCommit(baseDir, 'p0');
      git(baseDir, 'repack', '-q', '-d');
      const packDir = path.join(baseDir, '.git', 'objects', 'pack');
      const packFile = (await readdir(packDir)).find((name) => name.endsWith('.pack'));
      if (packFile === undefined) {
        throw new Error('promisor-rebuild fixture: repack produced no pack');
      }
      oldPromisorPackName = packFile;
      await writeFile(path.join(packDir, packFile.replace(/\.pack$/, '.promisor')), '');
      await addCommit(baseDir, 'p1'); // more reachable content, left loose
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then exactly two new packs exist and the reachable promisor oid is duplicated into BOTH', async () => {
      // Arrange
      const twin = await makeTwin(baseDir, 'promisor-rebuild');

      // Act
      const { ctx, result } = await runBothGc(twin);

      // Assert — placement parity, asserted by oid membership, never by a
      // pack count alone: a count passes an implementation that writes two
      // packs with the wrong objects in them. Pinned against git 2.55.0: a
      // REACHABLE promisor-pack object duplicates into the ordinary pack
      // too — promisor membership is not a normal-pack exclusion the way
      // `.keep` is.
      expect(result.promisorPackId).toBeDefined();
      expect(result.packId).toBeDefined();
      const promisorOids = await readOursPackOids(ctx, result.promisorPackId as ObjectId);
      const normalOids = await readOursPackOids(ctx, result.packId as ObjectId);
      expect(promisorOids.has(promisorOid as ObjectId)).toBe(true);
      expect(normalOids.has(promisorOid as ObjectId)).toBe(true);

      // tsgit's own retirement is deterministic (its packer is base-only,
      // never delta, so a 3-object rebuild cannot coincidentally reproduce
      // git's differently-encoded original bytes/sha) — the old pack name
      // is reliably gone on this side.
      const oursEntries = await packDirEntries(twin.oursDir);
      expect(oursEntries.filter((n) => n.endsWith('.pack')).length).toBe(2);
      expect(oursEntries).not.toContain(oldPromisorPackName);
      expect(oursEntries.some((n) => n.endsWith('.promisor'))).toBe(true);

      // Peer parity: git also produces exactly two packs, carrying the SAME
      // duplication — the oid attributes to both. Not asserted here: which
      // NAME the promisor pack lands under. git's own delta/window search is
      // thread-scheduling-sensitive under system load, so a fresh rebuild of
      // this fixture's tiny 3-object set can occasionally reproduce the
      // ORIGINAL pack's exact bytes/sha (observed directly: pack count still
      // 2, the pre-existing name still present, `.promisor` still on it, the
      // oid still duplicated into the sibling normal pack) — a legitimate
      // git behavior this suite does not control, not a divergence to chase.
      const peerEntries = await packDirEntries(twin.peerDir);
      expect(peerEntries.filter((n) => n.endsWith('.pack')).length).toBe(2);
      expect(peerEntries.some((n) => n.endsWith('.promisor'))).toBe(true);
      const peerPacksWithOid = await peerPackNamesContaining(twin.peerDir, promisorOid);
      expect(peerPacksWithOid.length).toBe(2);
      await disposeTwin(twin);
    });
  });

  describe('Given a pack carrying both .keep and .promisor markers, When gc runs on both twins', () => {
    let baseDir: string;
    let keptPackName: string;
    let keptOid: string;

    beforeAll(async () => {
      baseDir = await initRepo('keep-over-promisor');
      await addCommit(baseDir, 'c0');
      keptOid = writeLooseBlobGit(baseDir, 'kept-and-promisor');
      const packSha = await buildMarkedPack(baseDir, [keptOid], '.keep');
      await writeFile(
        path.join(baseDir, '.git', 'objects', 'pack', `pack-${packSha}.promisor`),
        '',
      );
      keptPackName = `pack-${packSha}.pack`;
      await addCommit(baseDir, 'c1');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then .keep wins on both tools: the pack survives byte-identical and contributes no promisor output', async () => {
      // Arrange
      const twin = await makeTwin(baseDir, 'keep-over-promisor');
      const keptPackPath = path.join(twin.oursDir, '.git', 'objects', 'pack', keptPackName);
      const keptBytesBefore = await readFile(keptPackPath);

      // Act
      const { result } = await runBothGc(twin);
      const keptBytesAfter = await readFile(keptPackPath);

      // Assert
      expect(Buffer.compare(keptBytesBefore, keptBytesAfter)).toBe(0);
      expect(result.promisorPackId).toBeUndefined();
      const oursEntries = await packDirEntries(twin.oursDir);
      expect(oursEntries).toContain(keptPackName);
      expect(oursEntries.some((n) => n.endsWith('.mtimes'))).toBe(false);
      const peerEntries = await packDirEntries(twin.peerDir);
      expect(peerEntries).toContain(keptPackName);
      await disposeTwin(twin);
    });
  });

  describe('Given an ordinary repository with no promisor packs, When gc runs on both twins', () => {
    let baseDir: string;

    beforeAll(async () => {
      baseDir = await initRepo('no-promisor-output');
      await addCommit(baseDir, 'c0');
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then neither tool writes any .promisor artefact', async () => {
      // Arrange
      const twin = await makeTwin(baseDir, 'no-promisor-output');

      // Act
      const { result } = await runBothGc(twin);

      // Assert
      expect(result.promisorPackId).toBeUndefined();
      const peerEntries = await packDirEntries(twin.peerDir);
      const oursEntries = await packDirEntries(twin.oursDir);
      expect(peerEntries.some((n) => n.endsWith('.promisor'))).toBe(false);
      expect(oursEntries.some((n) => n.endsWith('.promisor'))).toBe(false);
      await disposeTwin(twin);
    });
  });

  describe('Given a linked worktree holding a commit reachable only from its own detached HEAD, When gc runs on both twins', () => {
    let baseDir: string;
    let wtCommitId: string;

    beforeAll(async () => {
      baseDir = await initRepo('worktree-retention');
      const c0 = await addCommit(baseDir, 'c0');
      const c1 = await addCommit(baseDir, 'wt-only');
      wtCommitId = c1;
      // `main` moves back to c0 — c1 (and its tree/blob) is now reachable
      // ONLY through the linked worktree's own detached HEAD, never through
      // any ref or reflog in the main checkout.
      git(baseDir, 'reset', '-q', '--hard', c0);
      git(baseDir, 'worktree', 'add', '--detach', '-q', 'wt1', c1);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it("Then both tools keep it — gc roots every worktree's own HEAD, not just the one it runs from", async () => {
      // Arrange
      const twin = await makeTwin(baseDir, 'worktree-retention');

      // Act — the twins' `.git/worktrees/wt1/gitdir` pointer still names the
      // ORIGINAL `baseDir/wt1` path (a plain recursive copy doesn't rewrite
      // it, and real git's own gc doesn't need it resolvable either — it
      // reads `.git/worktrees/wt1/HEAD` directly), so this deliberately runs
      // WITHOUT `git worktree repair` on either twin.
      await runBothGc(twin, ['gc.pruneExpire=now']);

      // Assert
      expect(catFileExists(twin.peerDir, wtCommitId)).toBe(true);
      expect(catFileExists(twin.oursDir, wtCommitId)).toBe(true);
      await disposeTwin(twin);
    });
  });

  describe('Given a linked worktree holding a commit reachable only from its own HEAD reflog, When gc runs on both twins', () => {
    let baseDir: string;
    let wtCommitId: string;

    beforeAll(async () => {
      baseDir = await initRepo('worktree-reflog-retention');
      const c0 = await addCommit(baseDir, 'c0');
      // A linked worktree, DETACHED at c0 — no branch ref, so every HEAD
      // movement records ONLY in `.git/worktrees/wt1/logs/HEAD` (per-worktree,
      // admin-dir-local). A branch checkout (`-b wt1`) would instead log to
      // the SHARED `logs/refs/heads/wt1` under the common dir — a channel
      // `ctx`'s own top-level reflog scan already walks regardless of this
      // row, which would root the commit for the WRONG reason and leave this
      // row unable to prove the worktree-scoped reflog path is load-bearing.
      git(baseDir, 'worktree', 'add', '--detach', '-q', 'wt1', c0);
      const wtDir = path.join(baseDir, 'wt1');
      wtCommitId = await addCommit(wtDir, 'wt-reflog-only');
      // wt1's own detached HEAD moves back to c0 — the commit (and its
      // tree/blob) is now reachable ONLY through wt1's own HEAD reflog (a
      // discarded `oldId`), never through any ref, and never through the
      // main checkout's own reflog nor any shared commonDir reflog either.
      git(wtDir, 'reset', '-q', '--hard', c0);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it("Then both tools keep it — gc roots every worktree's own reflog, not just the current one", async () => {
      // Arrange
      const twin = await makeTwin(baseDir, 'worktree-reflog-retention');

      // Act
      await runBothGc(twin, ['gc.pruneExpire=now']);

      // Assert
      expect(catFileExists(twin.peerDir, wtCommitId)).toBe(true);
      expect(catFileExists(twin.oursDir, wtCommitId)).toBe(true);
      await disposeTwin(twin);
    });
  });

  describe('Given the main worktree holding a commit reachable only from its own detached HEAD, When gc runs from a linked worktree', () => {
    let baseDir: string;
    let mainCommitId: string;

    beforeAll(async () => {
      baseDir = await initRepo('main-worktree-retention-from-linked');
      const c0 = await addCommit(baseDir, 'c0');
      // `commit-tree` leaves NO ref or reflog trail anywhere — unlike
      // `checkout`/`branch -f`, which would append an entry to a SHARED
      // reflog (`refs/heads/main`'s, or `logs/HEAD` swept in as part of
      // `listReflogs`'s whole-commonDir walk) and incidentally root the
      // commit through a path this row does not intend to exercise.
      const treeOid = git(baseDir, 'rev-parse', `${c0}^{tree}`).trim();
      mainCommitId = git(baseDir, 'commit-tree', treeOid, '-p', c0, '-m', 'main-only').trim();
      // Overwrite the main worktree's own HEAD directly — bypasses
      // `checkout`, so no reflog entry is written anywhere either. The
      // commit is now reachable ONLY through the raw HEAD file's own value.
      await writeFile(path.join(baseDir, '.git', 'HEAD'), `${mainCommitId}\n`);
      // A linked worktree, detached at c0 — independent of the commit above.
      git(baseDir, 'worktree', 'add', '-q', '--detach', 'wt1', c0);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then both tools keep it — gc roots the main worktree regardless of which worktree it runs from', async () => {
      // Arrange
      const twin = await makeTwin(baseDir, 'main-worktree-retention-from-linked');
      const extraConfig = ['gc.pruneExpire=now'];
      // A plain recursive copy does NOT rewrite `wt1/.git`'s own `gitdir:`
      // pointer — it still names the ORIGINAL `baseDir`'s absolute admin-dir
      // path. Every OTHER row in this file sidesteps that by running gc from
      // the main checkout root and reading `.git/worktrees/wt1/HEAD`
      // directly (a path that never needs resolving). This row instead runs
      // FROM `wt1` on both twins, which DOES need that pointer resolved —
      // `git worktree repair` re-links both twins' copies to themselves.
      git(twin.peerDir, 'worktree', 'repair', 'wt1');
      git(twin.oursDir, 'worktree', 'repair', 'wt1');

      // Act — git gc from the peer's linked worktree; tsgit's maintenance
      // via `openRepository({ cwd })`, the ONLY entry point that discovers a
      // linked worktree's `gitdir:` pointer and commondir — `createNodeContext`
      // (every other row's `runOursGc`) assumes `workDir/.git` is a plain
      // directory and cannot open a worktree path at all.
      runPeerGc(path.join(twin.peerDir, 'wt1'), extraConfig);
      await setOursGcConfig(twin.oursDir, extraConfig);
      const repo = await openRepository({ cwd: path.join(twin.oursDir, 'wt1') });
      await repo.maintenance({ tasks: ['gc'] });
      await repo.dispose();

      // Assert
      expect(catFileExists(twin.peerDir, mainCommitId)).toBe(true);
      expect(catFileExists(twin.oursDir, mainCommitId)).toBe(true);
      await disposeTwin(twin);
    });
  });

  describe('Given stale and fresh tmp_ litter planted in objects root, a fanout dir, and objects/pack, When gc runs on both twins', () => {
    let baseDir: string;
    const STALE_EPOCH = 1_600_000_000; // far older than the default 2-week gc.pruneExpire cutoff

    beforeAll(async () => {
      baseDir = await initRepo('tmp-litter-default-cutoff');
      await addCommit(baseDir, 'c0');
      await plantTempLitter(baseDir, STALE_EPOCH);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then both tools remove exactly the stale names and keep exactly the fresh ones', async () => {
      // Arrange
      const twin = await makeTwin(baseDir, 'tmp-litter-default-cutoff');

      // Act
      await runBothGc(twin);

      // Assert — identical survivor set on both twins, and it is exactly
      // the three *Fresh names (the *Stale trio is gone from both).
      const peerSurvivors = await tempLitterSurvivors(twin.peerDir);
      const oursSurvivors = await tempLitterSurvivors(twin.oursDir);
      const expectedSurvivors = [
        TEMP_LITTER_NAMES.fanoutFresh,
        TEMP_LITTER_NAMES.packFresh,
        TEMP_LITTER_NAMES.rootFresh,
      ].sort();
      expect(peerSurvivors).toEqual(expectedSurvivors);
      expect(oursSurvivors).toEqual(expectedSurvivors);
      await disposeTwin(twin);
    });
  });

  describe('Given gc.pruneExpire=never with stale and fresh tmp_ litter planted in all three locations, When gc runs on both twins', () => {
    let baseDir: string;
    const STALE_EPOCH = 1; // as old as a mtime can meaningfully be

    beforeAll(async () => {
      baseDir = await initRepo('tmp-litter-prune-never');
      await addCommit(baseDir, 'c0');
      await plantTempLitter(baseDir, STALE_EPOCH);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('Then both tools keep every planted name — removal is disabled entirely', async () => {
      // Arrange
      const twin = await makeTwin(baseDir, 'tmp-litter-prune-never');

      // Act
      await runBothGc(twin, ['gc.pruneExpire=never']);

      // Assert — the full six-name set survives, identically, on both twins.
      const peerSurvivors = await tempLitterSurvivors(twin.peerDir);
      const oursSurvivors = await tempLitterSurvivors(twin.oursDir);
      const expectedSurvivors = Object.values(TEMP_LITTER_NAMES).slice().sort();
      expect(peerSurvivors).toEqual(expectedSurvivors);
      expect(oursSurvivors).toEqual(expectedSurvivors);
      await disposeTwin(twin);
    });
  });
});
