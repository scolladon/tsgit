/**
 * Cross-tool interop — `fsck`'s multi-pack-index pass, pinned against real
 * git. `git fsck` never verifies a midx inline: it spawns
 * `git multi-pack-index verify --object-dir <dir> --no-progress` as a child
 * and folds a non-zero child exit into bit 32. Every row records both
 * commands' exit codes and asserts the invariant that connects them
 * (`verify` non-zero iff `fsck` gains bit 32, whenever the parent survives),
 * plus tsgit's structured `FsckResult` from the identical on-disk state.
 *
 * Chain layers are git-written `0444`; every layer mutation goes through
 * `mutateMidxOrThrow`, which chmods the target writable first and throws on
 * a failed write rather than returning silently — the earlier trap this
 * suite's fixtures were built to avoid (a silently-unwritten mutation
 * measures a healthy repo and reports it as whatever tier the row expected).
 *
 * Every row builds its tsgit `Context` AFTER the last `git` subprocess has
 * written, and gets its own fresh repo — never a shared, progressively-
 * mutated one — per the fixture recipes in `midx-fixture-helpers.ts`.
 *
 * @proves
 *   surface:        fsck.multiPackIndex
 *   bucket:         cross-tool-interop
 *   unique:         fsck multi-pack-index findings and exit bits match canonical git
 *   interopSurface: multi-pack-index
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import type { FsckFinding, FsckOptions } from '../../src/application/commands/fsck.js';
import { fsck } from '../../src/application/commands/fsck.js';
import { disposePackRegistry } from '../../src/application/primitives/read-object.js';
import { TsgitError } from '../../src/domain/error.js';
import { parseMultiPackIndex } from '../../src/domain/storage/index.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, tryRunGitWithExit } from './interop-helpers.js';
import {
  type BaseFixture,
  buildBaseFixture,
  buildChainFixture,
  type ChainFixture,
  chainLayerPath,
  chunkTableRowOffset,
  craftLoffMidx,
  DIGEST_LENGTH,
  midxPaths,
  mutateMidxOrThrow,
} from './midx-fixture-helpers.js';

// ---------------------------------------------------------------------------
// git-invocation helpers
// ---------------------------------------------------------------------------

function gitFsck(dir: string, ...flags: string[]): ReturnType<typeof tryRunGitWithExit> {
  return tryRunGitWithExit(['-C', dir, 'fsck', ...flags]);
}

function gitVerify(dir: string): ReturnType<typeof tryRunGitWithExit> {
  return tryRunGitWithExit([
    '-C',
    dir,
    'multi-pack-index',
    'verify',
    '--object-dir',
    path.join(dir, '.git', 'objects'),
    '--no-progress',
  ]);
}

// ---------------------------------------------------------------------------
// tsgit-side helpers
// ---------------------------------------------------------------------------

// Every context a row builds is disposed after the row — packed reads open
// persistent FileHandles, and an undisposed registry surfaces as the
// GC-close warning the handle-lifecycle work treats as its leak oracle.
const liveContexts: Context[] = [];
function trackedNodeContext(workDir: string): Context {
  const ctx = createNodeContext({ workDir });
  liveContexts.push(ctx);
  return ctx;
}
afterEach(async () => {
  await Promise.all(liveContexts.splice(0).map((ctx) => disposePackRegistry(ctx)));
});

function findingsOfType<T extends FsckFinding['type']>(
  findings: ReadonlyArray<FsckFinding>,
  type: T,
): ReadonlyArray<Extract<FsckFinding, { type: T }>> {
  return findings.filter(
    (finding): finding is Extract<FsckFinding, { type: T }> => finding.type === type,
  );
}

/** Asserts `fsck` rejects with `INVALID_MULTI_PACK_INDEX` and the given `check`, and returns no partial result. */
async function expectFsckRejects(ctx: Context, check: string): Promise<void> {
  let caught: unknown;
  try {
    await fsck(ctx);
    expect.unreachable('expected fsck to reject');
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  const data = (caught as TsgitError).data;
  expect(data.code).toBe('INVALID_MULTI_PACK_INDEX');
  expect((data as { readonly check: string }).check).toBe(check);
}

/**
 * The Pin N mapping, asserted on every non-reject row: a non-zero `verify`
 * exit sets bit 32 on `fsck`'s exit, and only that — proven by masking every
 * other bit out of both sides before comparing.
 */
function expectVerifyInvariant(fsckExit: number, verifyExit: number): void {
  expect((fsckExit & 32) !== 0).toBe(verifyExit !== 0);
}

/** Pokes one `OIDF` fanout entry directly, breaking monotonicity at `index`. */
function pokeFanoutEntry(bytes: Buffer, index: number, value: number): Buffer {
  const parsed = parseMultiPackIndex(bytes, DIGEST_LENGTH);
  bytes.writeUInt32BE(value, parsed.oidFanoutOffset + index * 4);
  return bytes;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!GIT_AVAILABLE)('fsck multi-pack-index reporting, against real git', () => {
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function newRoot(slug: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-midx-fsck-interop-${slug}-`));
    roots.push(dir);
    return dir;
  }

  async function freshBase(slug: string): Promise<BaseFixture> {
    const dir = await newRoot(slug);
    return buildBaseFixture(dir, 'repo');
  }

  async function freshChain(slug: string): Promise<ChainFixture> {
    const dir = await newRoot(slug);
    return buildChainFixture(dir, 'repo');
  }

  // -------------------------------------------------------------------------
  // Pin O — a flat midx over the BASE fixture
  // -------------------------------------------------------------------------

  describe('Pin O — git fsck over a flat midx (BASE)', () => {
    describe('Given a healthy BASE repo (row O1, control), When fsck runs', () => {
      it('Then both tools exit 0 with no midx finding', async () => {
        // Arrange
        const fixture = await freshBase('o1');
        const gitResult = gitFsck(fixture.dir);
        const verifyResult = gitVerify(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(verifyResult.exitCode).toBe(0);
        expect(result.exitCode & 32).toBe(0);
        expect(result.findings.filter((finding) => finding.type.startsWith('midx-'))).toHaveLength(
          0,
        );
        expectVerifyInvariant(result.exitCode, verifyResult.exitCode);
      });
    });

    describe('Given a BASE repo with no midx at all (row O2, control), When fsck runs', () => {
      it('Then both tools exit 0 with no midx finding', async () => {
        // Arrange
        const fixture = await freshBase('o2');
        await rm(midxPaths(fixture.dir).flat, { force: true });
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(result.exitCode & 32).toBe(0);
        expect(result.findings.filter((finding) => finding.type.startsWith('midx-'))).toHaveLength(
          0,
        );
      });
    });

    describe('Given a flat midx restamped to version 2 (row O6, accepted), When fsck runs', () => {
      it('Then both tools accept it, exit 0, with no midx finding', async () => {
        // Arrange
        const fixture = await freshBase('o6');
        mutateMidxOrThrow(midxPaths(fixture.dir).flat, (bytes) => {
          bytes.writeUInt8(2, 4);
          return bytes;
        });
        const gitResult = gitFsck(fixture.dir);
        const verifyResult = gitVerify(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(verifyResult.exitCode).toBe(0);
        expect(result.exitCode & 32).toBe(0);
        expectVerifyInvariant(result.exitCode, verifyResult.exitCode);
      });
    });

    // --- Tier A: the parent's own load dies; fsck rejects, no FsckResult ---

    const PARENT_DIES_ROWS: ReadonlyArray<{
      readonly label: string;
      readonly check: string;
      readonly mutate: (bytes: Buffer) => Buffer;
    }> = [
      {
        label: 'O3 signature 4th byte flipped',
        check: 'signature',
        mutate: (bytes) => {
          bytes[3] = (bytes[3] ?? 0) ^ 0xff;
          return bytes;
        },
      },
      {
        label: 'O4 version restamped to 3',
        check: 'version',
        mutate: (bytes) => {
          bytes.writeUInt8(3, 4);
          return bytes;
        },
      },
      {
        label: 'O5 version restamped to 0',
        check: 'version',
        mutate: (bytes) => {
          bytes.writeUInt8(0, 4);
          return bytes;
        },
      },
      {
        label: 'O11 numPacks inflated past the PNAM chunk',
        check: 'pack-names',
        mutate: (bytes) => {
          bytes.writeUInt32BE(99, 8);
          return bytes;
        },
      },
      {
        label: 'O13 PNAM chunk id clobbered',
        check: 'required-chunk',
        mutate: (bytes) => {
          const rowStart = chunkTableRowOffset(bytes, 'PNAM');
          bytes.write('ZZZZ', rowStart, 'ascii');
          return bytes;
        },
      },
      {
        label: 'O14 OIDF chunk id clobbered',
        check: 'required-chunk',
        mutate: (bytes) => {
          const rowStart = chunkTableRowOffset(bytes, 'OIDF');
          bytes.write('ZZZZ', rowStart, 'ascii');
          return bytes;
        },
      },
      {
        label: 'O15 OIDF non-monotonic',
        check: 'fanout',
        // The last fanout entry is the object count, always > 0 for a
        // non-empty midx — dropping it to 0 guarantees it reads back lower
        // than its predecessor without depending on any oid's first byte.
        mutate: (bytes) => pokeFanoutEntry(bytes, 255, 0),
      },
    ];

    describe.each(PARENT_DIES_ROWS)(
      'Given a BASE repo with $label, When fsck runs',
      ({ label, check, mutate }) => {
        it(`Then git dies at exit 128 and fsck rejects with check "${check}"`, async () => {
          // Arrange
          const slug = label.split(' ')[0]?.toLowerCase() ?? 'row';
          const fixture = await freshBase(slug);
          mutateMidxOrThrow(midxPaths(fixture.dir).flat, mutate);
          const gitResult = gitFsck(fixture.dir);
          const verifyResult = gitVerify(fixture.dir);
          const sut = trackedNodeContext(fixture.dir);

          // Act + Assert
          expect(gitResult.exitCode).toBe(128);
          expect(verifyResult.exitCode).toBe(128);
          await expectFsckRejects(sut, check);
        });
      },
    );

    // `pack-int-id` is resolved lazily, per entry, at the first lookup that
    // needs it (never at parse time) — unlike the checks above, which the
    // parent's own object enumeration always settles up front. Over BASE,
    // every pack stays independently `.idx`-scannable, so enumeration never
    // needs the midx's own pack routing, and the fault is first reached
    // inside the health pass's own walk of every entry the midx lists — the
    // same contained shape a bad large-offset row reaches (below).
    describe('Given a BASE repo with numPacks understated below a referenced pack index (row O12), When fsck runs', () => {
      it('Then git dies at exit 128, and tsgit contains the fault as one midx-unusable finding with bit 32', async () => {
        // Arrange
        const fixture = await freshBase('o12');
        mutateMidxOrThrow(midxPaths(fixture.dir).flat, (bytes) => {
          bytes.writeUInt32BE(1, 8);
          return bytes;
        });
        const gitResult = gitFsck(fixture.dir);
        const verifyResult = gitVerify(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(verifyResult.exitCode).toBe(128);
        expect(result.exitCode & 32).toBe(32);
        expect(findingsOfType(result.findings, 'midx-unusable')).toHaveLength(1);
      });
    });

    // --- Tier B: the flat midx is discarded; fsck reports midx-unusable ---

    const MIDX_UNUSABLE_ROWS: ReadonlyArray<{
      readonly label: string;
      readonly mutate: (bytes: Buffer) => Buffer;
    }> = [
      {
        label: 'O7 hashVersion 2 in a SHA-1 repo',
        mutate: (bytes) => {
          bytes.writeUInt8(2, 5);
          return bytes;
        },
      },
      {
        label: 'O9 truncated mid-OIDL',
        mutate: (bytes) => bytes.subarray(0, bytes.length - DIGEST_LENGTH - 4),
      },
      {
        label: 'O16 numChunks byte set to 0',
        mutate: (bytes) => {
          bytes.writeUInt8(0, 6);
          return bytes;
        },
      },
      {
        label: 'O17 zero-length file',
        mutate: () => Buffer.alloc(0),
      },
    ];

    describe.each(MIDX_UNUSABLE_ROWS)(
      'Given a BASE repo with $label, When fsck runs',
      ({ label, mutate }) => {
        it('Then git verify exits non-zero, fsck gains bit 32, and tsgit reports one midx-unusable finding', async () => {
          // Arrange
          const slug = label.split(' ')[0]?.toLowerCase() ?? 'row';
          const fixture = await freshBase(slug);
          mutateMidxOrThrow(midxPaths(fixture.dir).flat, mutate);
          const gitResult = gitFsck(fixture.dir);
          const verifyResult = gitVerify(fixture.dir);
          const sut = trackedNodeContext(fixture.dir);

          // Act
          const result = await fsck(sut);

          // Assert
          expect(gitResult.exitCode & 32).toBe(32);
          expect(verifyResult.exitCode).not.toBe(0);
          expect(result.exitCode & 32).toBe(32);
          expect(findingsOfType(result.findings, 'midx-unusable')).toHaveLength(1);
          expectVerifyInvariant(result.exitCode, verifyResult.exitCode);
        });
      },
    );

    describe('Given a BASE repo with the flat midx truncated to 8 bytes (row O8), When fsck runs', () => {
      it('Then git verify exits non-zero, fsck gains bit 32, and tsgit reports one midx-unusable finding', async () => {
        // Arrange
        const fixture = await freshBase('o8');
        mutateMidxOrThrow(midxPaths(fixture.dir).flat, (bytes) => bytes.subarray(0, 8));
        const gitResult = gitFsck(fixture.dir);
        const verifyResult = gitVerify(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode & 32).toBe(32);
        expect(verifyResult.exitCode).not.toBe(0);
        expect(result.exitCode & 32).toBe(32);
        expect(findingsOfType(result.findings, 'midx-unusable')).toHaveLength(1);
      });
    });

    describe('Given a BASE repo with the flat midx made unreadable via chmod 000 (row O18, node tier only), When fsck runs', () => {
      it('Then git verify exits non-zero, fsck gains bit 32, and tsgit reports one midx-unusable finding', async () => {
        // Arrange
        const fixture = await freshBase('o18');
        chmodSync(midxPaths(fixture.dir).flat, 0o000);
        const gitResult = gitFsck(fixture.dir);
        const verifyResult = gitVerify(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode & 32).toBe(32);
        expect(verifyResult.exitCode).not.toBe(0);
        expect(result.exitCode & 32).toBe(32);
        expect(findingsOfType(result.findings, 'midx-unusable')).toHaveLength(1);
      });
    });

    describe('Given a signature-flipped midx AND core.multiPackIndex=false (row O19), When fsck runs', () => {
      it("Then git's config hatch spawns no child and exits 0, while tsgit — with no such config — still rejects (documented divergence, out of scope)", async () => {
        // Arrange
        const fixture = await freshBase('o19');
        mutateMidxOrThrow(midxPaths(fixture.dir).flat, (bytes) => {
          bytes[3] = (bytes[3] ?? 0) ^ 0xff;
          return bytes;
        });
        const gitResult = tryRunGitWithExit([
          '-C',
          fixture.dir,
          '-c',
          'core.multiPackIndex=false',
          'fsck',
        ]);
        const verifyResult = gitVerify(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act + Assert — git's own gate hides the fault entirely
        expect(gitResult.exitCode).toBe(0);
        // Assert — verify run by hand (no config hatch of its own) still dies
        expect(verifyResult.exitCode).toBe(128);
        // Assert — tsgit has no equivalent config key, so it still rejects
        await expectFsckRejects(sut, 'signature');
      });
    });

    describe('Given a BASE repo with the trailer digest flipped (row O10), When fsck runs', () => {
      it('Then git verify reports incorrect checksum, fsck gains bit 32, and tsgit reports one midx-checksum-mismatch finding', async () => {
        // Arrange
        const fixture = await freshBase('o10');
        const flat = midxPaths(fixture.dir).flat;
        const bytes = Buffer.from(readFileSync(flat));
        bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
        chmodSync(flat, 0o644);
        writeFileSync(flat, bytes);
        const gitResult = gitFsck(fixture.dir);
        const verifyResult = gitVerify(fixture.dir);
        expect(verifyResult.stderr).toContain('incorrect checksum');
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode & 32).toBe(32);
        expect(verifyResult.exitCode).not.toBe(0);
        expect(result.exitCode & 32).toBe(32);
        expect(findingsOfType(result.findings, 'midx-checksum-mismatch')).toHaveLength(1);
        expect(findingsOfType(result.findings, 'midx-unusable')).toHaveLength(0);
      });
    });

    describe('Given a BASE repo with numBaseFiles = 1 (row O20, ignored), When fsck runs', () => {
      it('Then both tools ignore the byte: exit 0, no midx finding', async () => {
        // Arrange
        const fixture = await freshBase('o20');
        mutateMidxOrThrow(midxPaths(fixture.dir).flat, (bytes) => {
          bytes.writeUInt8(1, 7);
          return bytes;
        });
        const gitResult = gitFsck(fixture.dir);
        const verifyResult = gitVerify(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(verifyResult.exitCode).toBe(0);
        expect(result.exitCode & 32).toBe(0);
        expect(result.findings.filter((finding) => finding.type.startsWith('midx-'))).toHaveLength(
          0,
        );
      });
    });

    describe('Given numBaseFiles = 1 AND a midx-named pack deleted (row O21, byte-identical to O23), When fsck runs', () => {
      it('Then the numBaseFiles byte changes nothing: same finding shape as the plain staleness row', async () => {
        // Arrange
        const fixture = await freshBase('o21');
        mutateMidxOrThrow(midxPaths(fixture.dir).flat, (bytes) => {
          bytes.writeUInt8(1, 7);
          return bytes;
        });
        const packDir = path.join(fixture.dir, '.git', 'objects', 'pack');
        const flatBytes = readFileSync(midxPaths(fixture.dir).flat);
        const parsed = parseMultiPackIndex(flatBytes, DIGEST_LENGTH);
        const targetName = parsed.packNames[0]?.slice(0, -'.idx'.length);
        if (targetName === undefined) throw new Error('o21: no pack name in PNAM');
        await rm(path.join(packDir, `${targetName}.pack`), { force: true });
        await rm(path.join(packDir, `${targetName}.idx`), { force: true });
        await rm(path.join(packDir, `${targetName}.rev`), { force: true });
        const gitResult = gitFsck(fixture.dir);
        const verifyResult = gitVerify(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode & 32).toBe(32);
        expect(verifyResult.exitCode).not.toBe(0);
        expect(result.exitCode & 32).toBe(32);
        expect(findingsOfType(result.findings, 'midx-pack-unresolved')).toHaveLength(1);
        expect(findingsOfType(result.findings, 'midx-entry-unresolved').length).toBeGreaterThan(0);
      });
    });

    describe('Given PNAM[0] renamed to a name no file has (row O22, staleness), When fsck runs', () => {
      it('Then both report the position unresolved and every one of its oids unresolved', async () => {
        // Arrange
        const fixture = await freshBase('o22');
        const flat = midxPaths(fixture.dir).flat;
        const before = readFileSync(flat);
        const parsedBefore = parseMultiPackIndex(before, DIGEST_LENGTH);
        const targetName = parsedBefore.packNames[0];
        if (targetName === undefined) throw new Error('o22: no pack name in PNAM');
        mutateMidxOrThrow(flat, (bytes) => {
          const nameBytes = Buffer.from(targetName, 'ascii');
          // Overwrite in place: same length, so no chunk table shift needed.
          // Replaced with an all-'0' name — no on-disk pack carries it, and
          // '0' sorts before every real hex-named pack, so replacing the
          // already-first PNAM[0] entry with it keeps v1's lex order intact.
          const idx = bytes.indexOf(nameBytes);
          if (idx < 0) throw new Error('o22: target pack name not found in PNAM bytes');
          bytes.write('0'.repeat(nameBytes.length), idx, 'ascii');
          return bytes;
        });
        const gitResult = gitFsck(fixture.dir);
        const verifyResult = gitVerify(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode & 32).toBe(32);
        expect(verifyResult.exitCode).not.toBe(0);
        expect(result.exitCode & 32).toBe(32);
        expect(findingsOfType(result.findings, 'midx-pack-unresolved')).toHaveLength(1);
        expect(findingsOfType(result.findings, 'midx-pack-unresolved')[0]?.position).toBe(0);
        expect(findingsOfType(result.findings, 'midx-entry-unresolved').length).toBeGreaterThan(0);
      });
    });

    describe('Given a midx-named pack fully deleted (.pack + .idx + .rev) (row O23), When fsck runs', () => {
      it('Then both report it unresolved plus the ordinary connectivity fallout', async () => {
        // Arrange
        const fixture = await freshBase('o23');
        const flatBytes = readFileSync(midxPaths(fixture.dir).flat);
        const parsed = parseMultiPackIndex(flatBytes, DIGEST_LENGTH);
        const targetName = parsed.packNames[0]?.slice(0, -'.idx'.length);
        if (targetName === undefined) throw new Error('o23: no pack name in PNAM');
        const packDir = path.join(fixture.dir, '.git', 'objects', 'pack');
        await rm(path.join(packDir, `${targetName}.pack`), { force: true });
        await rm(path.join(packDir, `${targetName}.idx`), { force: true });
        await rm(path.join(packDir, `${targetName}.rev`), { force: true });
        const gitResult = gitFsck(fixture.dir);
        const verifyResult = gitVerify(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode & 32).toBe(32);
        expect(verifyResult.exitCode).not.toBe(0);
        expect(result.exitCode & 32).toBe(32);
        expect(findingsOfType(result.findings, 'midx-pack-unresolved')).toHaveLength(1);
        expect(findingsOfType(result.findings, 'midx-entry-unresolved').length).toBeGreaterThan(0);
        expect(
          result.findings.some(
            (finding) => finding.type === 'missing' || finding.type === 'broken-link',
          ),
        ).toBe(true);
      });
    });

    describe("Given a midx-named pack's .pack deleted, .idx kept (row O24, identical to O23), When fsck runs", () => {
      it('Then both report it unresolved the same way', async () => {
        // Arrange
        const fixture = await freshBase('o24');
        const flatBytes = readFileSync(midxPaths(fixture.dir).flat);
        const parsed = parseMultiPackIndex(flatBytes, DIGEST_LENGTH);
        const targetName = parsed.packNames[0]?.slice(0, -'.idx'.length);
        if (targetName === undefined) throw new Error('o24: no pack name in PNAM');
        const packDir = path.join(fixture.dir, '.git', 'objects', 'pack');
        await rm(path.join(packDir, `${targetName}.pack`), { force: true });
        const gitResult = gitFsck(fixture.dir);
        const verifyResult = gitVerify(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode & 32).toBe(32);
        expect(verifyResult.exitCode).not.toBe(0);
        expect(result.exitCode & 32).toBe(32);
        expect(findingsOfType(result.findings, 'midx-pack-unresolved')).toHaveLength(1);
        expect(findingsOfType(result.findings, 'midx-entry-unresolved').length).toBeGreaterThan(0);
      });
    });

    describe("Given a midx-named pack's .idx deleted, .pack kept (row O25), When fsck runs", () => {
      it('Then tsgit reports it unresolved the same way O23/O24 do — pack discovery itself requires the sibling .idx to exist, so an .idx-less pack never becomes a candidate for the pack-layer pass either', async () => {
        // Arrange
        const fixture = await freshBase('o25');
        const flatBytes = readFileSync(midxPaths(fixture.dir).flat);
        const parsed = parseMultiPackIndex(flatBytes, DIGEST_LENGTH);
        const targetName = parsed.packNames[0]?.slice(0, -'.idx'.length);
        if (targetName === undefined) throw new Error('o25: no pack name in PNAM');
        const packDir = path.join(fixture.dir, '.git', 'objects', 'pack');
        await rm(path.join(packDir, `${targetName}.idx`), { force: true });
        const gitResult = gitFsck(fixture.dir);
        const verifyResult = gitVerify(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode & 32).toBe(32);
        expect(verifyResult.exitCode).not.toBe(0);
        expect(result.exitCode & 32).toBe(32);
        expect(findingsOfType(result.findings, 'midx-pack-unresolved')).toHaveLength(1);
        expect(findingsOfType(result.findings, 'midx-entry-unresolved').length).toBeGreaterThan(0);
        expect(findingsOfType(result.findings, 'pack-index-unusable')).toHaveLength(0);
        expect(findingsOfType(result.findings, 'pack-rev-index-unusable')).toHaveLength(0);
      });
    });

    describe('Given the SAME O23 repo with the midx removed instead (row O26, differential control), When fsck runs', () => {
      it("Then bit 32 and both midx findings vanish — the difference isolates the midx's own contribution", async () => {
        // Arrange — one repository, run twice: with the midx (O23 shape) and
        // with it removed, the pack deletion held constant
        const fixture = await freshBase('o26');
        const flatBytes = readFileSync(midxPaths(fixture.dir).flat);
        const parsed = parseMultiPackIndex(flatBytes, DIGEST_LENGTH);
        const targetName = parsed.packNames[0]?.slice(0, -'.idx'.length);
        if (targetName === undefined) throw new Error('o26: no pack name in PNAM');
        const packDir = path.join(fixture.dir, '.git', 'objects', 'pack');
        await rm(path.join(packDir, `${targetName}.pack`), { force: true });
        await rm(path.join(packDir, `${targetName}.idx`), { force: true });
        await rm(path.join(packDir, `${targetName}.rev`), { force: true });
        const withMidxGit = gitFsck(fixture.dir);
        const withMidxCtx = trackedNodeContext(fixture.dir);
        const withMidxResult = await fsck(withMidxCtx);

        await rm(midxPaths(fixture.dir).flat, { force: true });
        const withoutMidxGit = gitFsck(fixture.dir);
        const withoutMidxCtx = trackedNodeContext(fixture.dir);

        // Act
        const withoutMidxResult = await fsck(withoutMidxCtx);

        // Assert — the midx-removed repo loses exactly bit 32 and both midx findings
        expect(withMidxGit.exitCode & 32).toBe(32);
        expect(withoutMidxGit.exitCode & 32).toBe(0);
        expect(withMidxResult.exitCode & 32).toBe(32);
        expect(withoutMidxResult.exitCode & 32).toBe(0);
        expect(withoutMidxResult.exitCode).toBe(withMidxResult.exitCode & ~32);
        expect(
          withoutMidxResult.findings.filter((finding) => finding.type.startsWith('midx-')),
        ).toHaveLength(0);
        expect(
          withMidxResult.findings.filter((finding) => !finding.type.startsWith('midx-')),
        ).toEqual(withoutMidxResult.findings);
      });
    });

    describe('Given a LOFF chunk with the target row in range (row O27, accepted), When fsck runs', () => {
      it('Then both tools accept it: exit 0, every object still enumerates', async () => {
        // Arrange
        const fixture = await freshBase('o27');
        const flat = midxPaths(fixture.dir).flat;
        const before = readFileSync(flat);
        const crafted = craftLoffMidx(Buffer.from(before), { row: 0, count: 1 });
        writeFileSync(flat, crafted);
        const gitResult = gitFsck(fixture.dir);
        const verifyResult = gitVerify(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(verifyResult.exitCode).toBe(0);
        expect(result.exitCode & 32).toBe(0);
        expect(result.findings.filter((finding) => finding.type.startsWith('midx-'))).toHaveLength(
          0,
        );
      });
    });

    describe('Given a LOFF chunk with the target row out of range (row O28), When fsck runs', () => {
      it('Then git dies with the large-offset fatal, and tsgit still contains the fault as one midx-unusable finding with bit 32', async () => {
        // Arrange — the crafted row targets midx entry 0, which in BASE is a
        // reachable packed object (BASE has no dangling packed object to aim
        // at instead): both tools' own content/connectivity walk touches it
        // ahead of the dedicated midx pass, so here — unlike Pin N's
        // --connectivity-only illustration of the same split — git's PARENT
        // dies too, at the same exit as every other Tier-A row. tsgit's own
        // content-validation pass absorbs the identical fault as a
        // `bad-object` finding for that entry, and the midx-health pass's
        // independent walk still reaches and reports it as `midx-unusable`.
        const fixture = await freshBase('o28');
        const flat = midxPaths(fixture.dir).flat;
        const before = readFileSync(flat);
        const crafted = craftLoffMidx(Buffer.from(before), { row: 5, count: 1 });
        writeFileSync(flat, crafted);
        const gitResult = gitFsck(fixture.dir);
        const verifyResult = gitVerify(fixture.dir);
        expect(gitResult.stderr).toContain('multi-pack-index large offset out of bounds');
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(128);
        expect(verifyResult.exitCode).toBe(128);
        expect(result.exitCode & 32).toBe(32);
        expect(findingsOfType(result.findings, 'midx-unusable')).toHaveLength(1);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Pin N — the mode table: bit 32 is ungated
  // -------------------------------------------------------------------------

  describe('Pin N — mode is not a gate for the multi-pack-index pass', () => {
    const MODES: ReadonlyArray<{ readonly label: string; readonly opts: FsckOptions }> = [
      { label: 'default', opts: {} },
      { label: 'connectivityOnly', opts: { connectivityOnly: true } },
      { label: 'full:false', opts: { full: false } },
      { label: 'strict', opts: { strict: true } },
    ];

    describe('Given a Tier-B flat midx (truncated), When fsck runs across modes', () => {
      it.each(MODES)('Then mode "$label" still reports bit 32', async ({ opts }) => {
        // Arrange
        const fixture = await freshBase('n-tier-b');
        mutateMidxOrThrow(midxPaths(fixture.dir).flat, (bytes) => bytes.subarray(0, 8));
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut, opts);

        // Assert
        expect(result.exitCode & 32).toBe(32);
        expect(findingsOfType(result.findings, 'midx-unusable')).toHaveLength(1);
      });
    });

    describe('Given a healthy BASE repo, When fsck runs across modes', () => {
      it.each(MODES)('Then mode "$label" reports no midx bit', async ({ opts }) => {
        // Arrange
        const fixture = await freshBase('n-healthy');
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut, opts);

        // Assert
        expect(result.exitCode & 32).toBe(0);
      });
    });

    describe('Given a healthy BASE repo, When fsck runs with core.multiPackIndex=false semantics unavailable', () => {
      it('Then tsgit has no equivalent gate — the pass is unconditional', async () => {
        // Arrange — restated as the negative: there is no FsckOptions field
        // that disables the pass, so a Tier-A midx rejects regardless of opts
        const fixture = await freshBase('n3');
        mutateMidxOrThrow(midxPaths(fixture.dir).flat, (bytes) => {
          bytes[3] = (bytes[3] ?? 0) ^ 0xff;
          return bytes;
        });
        const sut = trackedNodeContext(fixture.dir);

        // Act + Assert
        await expectFsckRejects(sut, 'signature');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Pin P — a chain over the CHAIN fixture
  // -------------------------------------------------------------------------

  describe('Pin P — git fsck over a chain (CHAIN)', () => {
    describe('Given a healthy chain (row P1, control), When fsck runs', () => {
      it('Then both tools exit 0 with no midx finding', async () => {
        // Arrange
        const fixture = await freshChain('p1');
        const gitResult = gitFsck(fixture.dir);
        const verifyResult = gitVerify(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(verifyResult.exitCode).toBe(0);
        expect(result.exitCode & 32).toBe(0);
        expect(result.findings.filter((finding) => finding.type.startsWith('midx-'))).toHaveLength(
          0,
        );
      });
    });

    // --- A dropped chain is a non-event on the exit axis (P2-P7) ---

    describe('Given a dropped chain (rows P2-P7), When fsck runs', () => {
      const DROPPED_CHAIN_ROWS: ReadonlyArray<{
        readonly label: string;
        readonly arrange: (fixture: ChainFixture) => Promise<void>;
      }> = [
        {
          label: 'P2 base layer .midx deleted',
          arrange: async (fixture) => {
            await rm(chainLayerPath(fixture.dir, fixture.layerDigests[0]), { force: true });
          },
        },
        {
          label: 'P3 newest layer .midx deleted',
          arrange: async (fixture) => {
            await rm(chainLayerPath(fixture.dir, fixture.layerDigests[1]), { force: true });
          },
        },
        {
          label: 'P4 base layer chmod 000',
          arrange: async (fixture) => {
            chmodSync(chainLayerPath(fixture.dir, fixture.layerDigests[0]), 0o000);
          },
        },
        {
          label: 'P5 bogus 40-hex digest appended to the chain file',
          arrange: async (fixture) => {
            const chainFile = midxPaths(fixture.dir).chainFile;
            chmodSync(chainFile, 0o644);
            const before = readFileSync(chainFile, 'utf8');
            writeFileSync(chainFile, `${before}${'a'.repeat(40)}\n`);
          },
        },
        {
          label: 'P6 chain file deleted, layers remain',
          arrange: async (fixture) => {
            await rm(midxPaths(fixture.dir).chainFile, { force: true });
          },
        },
        {
          label: 'P7 chain file emptied',
          arrange: async (fixture) => {
            const chainFile = midxPaths(fixture.dir).chainFile;
            chmodSync(chainFile, 0o644);
            writeFileSync(chainFile, '');
          },
        },
      ];

      it.each(DROPPED_CHAIN_ROWS)(
        'Then $label exits 0 with no midx finding',
        async ({ arrange }) => {
          // Arrange
          const fixture = await freshChain('p2-p7');
          await arrange(fixture);
          const gitResult = gitFsck(fixture.dir);
          const sut = trackedNodeContext(fixture.dir);

          // Act
          const result = await fsck(sut);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(result.exitCode & 32).toBe(0);
          expect(
            result.findings.filter((finding) => finding.type.startsWith('midx-')),
          ).toHaveLength(0);
        },
      );
    });

    describe('Given the base layer truncated to 8 bytes (row P8, Tier-B, dropped), When fsck runs', () => {
      it('Then git prints an error line with no exit bit, and tsgit reports no midx finding', async () => {
        // Arrange
        const fixture = await freshChain('p8');
        mutateMidxOrThrow(chainLayerPath(fixture.dir, fixture.layerDigests[0]), (bytes) =>
          bytes.subarray(0, 8),
        );
        const gitResult = gitFsck(fixture.dir);
        const verifyResult = gitVerify(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert — an error: line with no exit bit at all (git's own quirk)
        expect(gitResult.exitCode).toBe(0);
        expect(verifyResult.exitCode).toBe(0);
        expect(result.exitCode & 32).toBe(0);
        expect(result.findings.filter((finding) => finding.type.startsWith('midx-'))).toHaveLength(
          0,
        );
      });
    });

    // --- Tier A on a chain layer still kills the whole run ---

    describe('Given a Tier-A fault on a chain layer (rows P9-P11), When fsck runs', () => {
      const CHAIN_TIER_A_ROWS: ReadonlyArray<{
        readonly label: string;
        readonly check: string;
        readonly layer: 'base' | 'newest';
        readonly mutate: (bytes: Buffer) => Buffer;
      }> = [
        {
          label: 'P9 base layer bad signature',
          check: 'signature',
          layer: 'base',
          mutate: (bytes) => {
            bytes[3] = (bytes[3] ?? 0) ^ 0xff;
            return bytes;
          },
        },
        {
          label: 'P10 newest layer bad signature',
          check: 'signature',
          layer: 'newest',
          mutate: (bytes) => {
            bytes[3] = (bytes[3] ?? 0) ^ 0xff;
            return bytes;
          },
        },
        {
          label: 'P11 base layer version 3',
          check: 'version',
          layer: 'base',
          mutate: (bytes) => {
            bytes.writeUInt8(3, 4);
            return bytes;
          },
        },
      ];

      it.each(CHAIN_TIER_A_ROWS)(
        'Then $label dies at git exit 128 and fsck rejects with check "$check"',
        async ({ layer, mutate, check }) => {
          // Arrange
          const fixture = await freshChain('p9-p11');
          const digest = layer === 'base' ? fixture.layerDigests[0] : fixture.layerDigests[1];
          mutateMidxOrThrow(chainLayerPath(fixture.dir, digest), mutate);
          const gitResult = gitFsck(fixture.dir);
          const verifyResult = gitVerify(fixture.dir);
          const sut = trackedNodeContext(fixture.dir);

          // Act + Assert
          expect(gitResult.exitCode).toBe(128);
          expect(verifyResult.exitCode).toBe(128);
          await expectFsckRejects(sut, check);
        },
      );
    });

    describe('Given the base layer trailer flipped (row P12, silent), When fsck runs', () => {
      it('Then only the chain head is verified — base-layer corruption produces no finding', async () => {
        // Arrange
        const fixture = await freshChain('p12');
        mutateMidxOrThrow(chainLayerPath(fixture.dir, fixture.layerDigests[0]), (bytes) => {
          bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
          return bytes;
        });
        const gitResult = gitFsck(fixture.dir);
        const verifyResult = gitVerify(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(verifyResult.exitCode).toBe(0);
        expect(result.exitCode & 32).toBe(0);
        expect(result.findings.filter((finding) => finding.type.startsWith('midx-'))).toHaveLength(
          0,
        );
      });
    });

    describe('Given the newest layer trailer flipped (row P13, checksum-mismatch), When fsck runs', () => {
      it('Then the chain head IS verified — one midx-checksum-mismatch finding, bit 32', async () => {
        // Arrange
        const fixture = await freshChain('p13');
        const headPath = chainLayerPath(fixture.dir, fixture.layerDigests[1]);
        const bytes = Buffer.from(readFileSync(headPath));
        bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
        chmodSync(headPath, 0o644);
        writeFileSync(headPath, bytes);
        const gitResult = gitFsck(fixture.dir);
        const verifyResult = gitVerify(fixture.dir);
        expect(verifyResult.stderr).toContain('incorrect checksum');
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode & 32).toBe(32);
        expect(verifyResult.exitCode).not.toBe(0);
        expect(result.exitCode & 32).toBe(32);
        expect(findingsOfType(result.findings, 'midx-checksum-mismatch')).toHaveLength(1);
      });
    });

    describe('Given the newest layer PNAM unresolvable (row P14, chain-global position), When fsck runs', () => {
      it('Then tsgit reports the pack unresolved at the chain-global position past the base layer', async () => {
        // Arrange
        const fixture = await freshChain('p14');
        const baseBytes = readFileSync(chainLayerPath(fixture.dir, fixture.layerDigests[0]));
        const baseParsed = parseMultiPackIndex(baseBytes, DIGEST_LENGTH);
        const expectedPosition = baseParsed.packNames.length;
        const headPath = chainLayerPath(fixture.dir, fixture.layerDigests[1]);
        const headBefore = readFileSync(headPath);
        const headParsed = parseMultiPackIndex(headBefore, DIGEST_LENGTH);
        const targetName = headParsed.packNames[0];
        if (targetName === undefined) throw new Error('p14: newest layer has no pack name');
        mutateMidxOrThrow(headPath, (bytes) => {
          const nameBytes = Buffer.from(targetName, 'ascii');
          // All-'0' keeps v1's lex order intact — see row O22's identical reasoning.
          const idx = bytes.indexOf(nameBytes);
          if (idx < 0) throw new Error('p14: target pack name not found');
          bytes.write('0'.repeat(nameBytes.length), idx, 'ascii');
          return bytes;
        });
        const gitResult = gitFsck(fixture.dir);
        const verifyResult = gitVerify(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode & 32).toBe(32);
        expect(verifyResult.exitCode).not.toBe(0);
        expect(result.exitCode & 32).toBe(32);
        const unresolved = findingsOfType(result.findings, 'midx-pack-unresolved');
        expect(unresolved).toHaveLength(1);
        expect(unresolved[0]?.position).toBe(expectedPosition);
        expect(findingsOfType(result.findings, 'midx-entry-unresolved').length).toBeGreaterThan(0);
      });
    });

    describe('Given the base layer PNAM unresolvable (row P15, base layers are verified), When fsck runs', () => {
      it('Then tsgit reports the pack unresolved at chain-global position 0', async () => {
        // Arrange
        const fixture = await freshChain('p15');
        const basePath = chainLayerPath(fixture.dir, fixture.layerDigests[0]);
        const baseBefore = readFileSync(basePath);
        const baseParsed = parseMultiPackIndex(baseBefore, DIGEST_LENGTH);
        const targetName = baseParsed.packNames[0];
        if (targetName === undefined) throw new Error('p15: base layer has no pack name');
        mutateMidxOrThrow(basePath, (bytes) => {
          const nameBytes = Buffer.from(targetName, 'ascii');
          // All-'0' keeps v1's lex order intact — see row O22's identical reasoning.
          const idx = bytes.indexOf(nameBytes);
          if (idx < 0) throw new Error('p15: target pack name not found');
          bytes.write('0'.repeat(nameBytes.length), idx, 'ascii');
          return bytes;
        });
        const gitResult = gitFsck(fixture.dir);
        const verifyResult = gitVerify(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode & 32).toBe(32);
        expect(verifyResult.exitCode).not.toBe(0);
        expect(result.exitCode & 32).toBe(32);
        const unresolved = findingsOfType(result.findings, 'midx-pack-unresolved');
        expect(unresolved).toHaveLength(1);
        expect(unresolved[0]?.position).toBe(0);
      });
    });

    describe('Given a midx-named pack deleted, chain intact (row P16), When fsck runs', () => {
      it('Then tsgit reports it unresolved plus the ordinary connectivity fallout', async () => {
        // Arrange
        const fixture = await freshChain('p16');
        const headPath = chainLayerPath(fixture.dir, fixture.layerDigests[1]);
        const headParsed = parseMultiPackIndex(readFileSync(headPath), DIGEST_LENGTH);
        const targetName = headParsed.packNames[0]?.slice(0, -'.idx'.length);
        if (targetName === undefined) throw new Error('p16: newest layer has no pack name');
        const packDir = path.join(fixture.dir, '.git', 'objects', 'pack');
        await rm(path.join(packDir, `${targetName}.pack`), { force: true });
        await rm(path.join(packDir, `${targetName}.idx`), { force: true });
        await rm(path.join(packDir, `${targetName}.rev`), { force: true });
        const gitResult = gitFsck(fixture.dir);
        const verifyResult = gitVerify(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode & 32).toBe(32);
        expect(verifyResult.exitCode).not.toBe(0);
        expect(result.exitCode & 32).toBe(32);
        expect(findingsOfType(result.findings, 'midx-pack-unresolved')).toHaveLength(1);
        expect(findingsOfType(result.findings, 'midx-entry-unresolved').length).toBeGreaterThan(0);
      });
    });

    describe('Given a Tier-B flat midx over an intact chain (row P17, the chain is the usable midx), When fsck runs', () => {
      it('Then the chain loads and no finding is emitted for the flat fault', async () => {
        // Arrange
        const fixture = await freshChain('p17');
        // Write a Tier-B flat midx over the same repo the chain already covers.
        const flat = midxPaths(fixture.dir).flat;
        writeFileSync(flat, Buffer.alloc(8));
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert — the chain is the usable midx; the flat fault is not a finding
        expect(gitResult.exitCode & 32).toBe(0);
        expect(result.exitCode & 32).toBe(0);
        expect(result.findings.filter((finding) => finding.type.startsWith('midx-'))).toHaveLength(
          0,
        );
      });
    });

    describe('Given a Tier-A flat midx over an intact chain (row P18, flat wins outright), When fsck runs', () => {
      it('Then flat Tier A rejects the whole run — the chain is never opened', async () => {
        // Arrange
        const fixture = await freshChain('p18');
        const flat = midxPaths(fixture.dir).flat;
        const headBytes = readFileSync(chainLayerPath(fixture.dir, fixture.layerDigests[1]));
        const flatBytes = Buffer.from(headBytes);
        flatBytes[3] = (flatBytes[3] ?? 0) ^ 0xff;
        writeFileSync(flat, flatBytes);
        const gitResult = gitFsck(fixture.dir);
        const verifyResult = gitVerify(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act + Assert
        expect(gitResult.exitCode).toBe(128);
        expect(verifyResult.exitCode).toBe(128);
        await expectFsckRejects(sut, 'signature');
      });
    });

    describe('Given a broken chain AND a valid flat midx (row P19, flat suppresses the chain), When fsck runs', () => {
      it('Then completely silent — the broken layer is never opened', async () => {
        // Arrange
        const fixture = await freshChain('p19');
        mutateMidxOrThrow(chainLayerPath(fixture.dir, fixture.layerDigests[0]), (bytes) =>
          bytes.subarray(0, 8),
        );
        const flat = midxPaths(fixture.dir).flat;
        const headBytes = readFileSync(chainLayerPath(fixture.dir, fixture.layerDigests[1]));
        writeFileSync(flat, headBytes);
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode & 32).toBe(0);
        expect(result.exitCode & 32).toBe(0);
        expect(result.findings.filter((finding) => finding.type.startsWith('midx-'))).toHaveLength(
          0,
        );
      });
    });

    describe('Given a broken chain with no flat file (row P20, no verdict — gated on the flat file existing), When fsck runs', () => {
      it('Then no midx finding — only the dropped-chain shape', async () => {
        // Arrange
        const fixture = await freshChain('p20');
        mutateMidxOrThrow(chainLayerPath(fixture.dir, fixture.layerDigests[0]), (bytes) =>
          bytes.subarray(0, 8),
        );
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode & 32).toBe(0);
        expect(result.exitCode & 32).toBe(0);
        expect(result.findings.filter((finding) => finding.type.startsWith('midx-'))).toHaveLength(
          0,
        );
      });
    });

    describe('Given numBaseFiles set on a chain layer (rows P21-P23, ignored), When fsck runs', () => {
      const NUM_BASE_FILES_ROWS: ReadonlyArray<{
        readonly label: string;
        readonly layer: 'base' | 'newest';
        readonly value: number;
      }> = [
        { label: 'P21 numBaseFiles=1, newest layer', layer: 'newest', value: 1 },
        { label: 'P22 numBaseFiles=1, base layer', layer: 'base', value: 1 },
        { label: 'P23 numBaseFiles=2, newest layer', layer: 'newest', value: 2 },
      ];

      it.each(NUM_BASE_FILES_ROWS)('Then $label changes nothing', async ({ layer, value }) => {
        // Arrange
        const fixture = await freshChain('p21-p23');
        const digest = layer === 'base' ? fixture.layerDigests[0] : fixture.layerDigests[1];
        mutateMidxOrThrow(chainLayerPath(fixture.dir, digest), (bytes) => {
          bytes.writeUInt8(value, 7);
          return bytes;
        });
        const gitResult = gitFsck(fixture.dir);
        const verifyResult = gitVerify(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(verifyResult.exitCode).toBe(0);
        expect(result.exitCode & 32).toBe(0);
        expect(result.findings.filter((finding) => finding.type.startsWith('midx-'))).toHaveLength(
          0,
        );
      });
    });
  });
});
