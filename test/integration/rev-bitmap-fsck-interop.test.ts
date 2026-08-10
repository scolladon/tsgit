/**
 * Cross-tool interop — the reverse-index (`.rev`) and bitmap (`.bitmap`,
 * including the multi-pack-index's own) arms of `fsck`, pinned against real
 * git 2.55.0 before any consumption code exists, so a later parser cannot
 * quietly change an `fsck` verdict.
 *
 * Every mutation row composes `restampRevIndex`/`restampBitmap` INSIDE its
 * own mutator when it wants the trailer left valid (a RESTAMPED row) — the
 * control that isolates a structural fault from a checksum failure. Every
 * row's `<expected>`/`<stored>` position value is fixture-dependent except
 * the one WE write, so only the finding SHAPE and CARDINALITY are asserted,
 * never git's own reconstructed integer pair.
 *
 * One shared `beforeAll` per mode-control (Pins I and L), a fresh fixture
 * per row otherwise, and every tsgit `Context` is built AFTER the last `git`
 * subprocess of its row.
 *
 * @proves
 *   surface:        fsck.packArtefacts
 *   bucket:         cross-tool-interop
 *   unique:         reverse-index and bitmap fsck verdicts match canonical git
 *   interopSurface: pack-artefacts
 */
import { chmodSync, rmSync } from 'node:fs';
import { copyFile, mkdtemp, rename, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import type { FsckFinding, FsckOptions } from '../../src/application/commands/fsck.js';
import { fsck } from '../../src/application/commands/fsck.js';
import { disposePackRegistry } from '../../src/application/primitives/read-object.js';
import { REV_HEADER_SIZE } from '../../src/domain/storage/index.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git, tryRunGitWithExit } from './interop-helpers.js';
import {
  type BaseFixture,
  buildBaseFixture,
  buildBitmapFixture,
  buildMidxBitmapFixture,
  buildTwoPackFixture,
  DIGEST_LENGTH,
  mutateOrThrow,
  packArtefactPaths,
  packArtefactPathsNamed,
  restampBitmap,
  restampRevIndex,
} from './rev-bitmap-fixture-helpers.js';

// ---------------------------------------------------------------------------
// Shared helpers
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

function gitFsckWithoutMultiPackIndex(dir: string): ReturnType<typeof tryRunGitWithExit> {
  return tryRunGitWithExit(['-C', dir, '-c', 'core.multiPackIndex=false', 'fsck']);
}

/** Reads a per-mode control exit, throwing rather than trusting a `!` — a
 *  missing entry is a fixture-building defect, never a value to paper over. */
function exitForMode(map: Readonly<Record<string, number>>, label: string): number {
  const exitCode = map[label];
  if (exitCode === undefined) {
    throw new Error(`exitForMode: no control exit recorded for mode "${label}"`);
  }
  return exitCode;
}

function flipLastByte(bytes: Buffer): Buffer {
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
  return bytes;
}

function flipSignatureByte(bytes: Buffer): Buffer {
  bytes[3] = (bytes[3] ?? 0) ^ 0xff;
  return bytes;
}

/** The 4 `FsckOptions` modes this suite exercises everywhere mode-gating
 *  matters, paired with git's own equivalent flag. */
const MODES: ReadonlyArray<{
  readonly label: 'default' | 'connectivityOnly' | 'no-full' | 'strict';
  readonly flags: readonly string[];
  readonly opts: FsckOptions;
}> = [
  { label: 'default', flags: [], opts: {} },
  { label: 'connectivityOnly', flags: ['--connectivity-only'], opts: { connectivityOnly: true } },
  { label: 'no-full', flags: ['--no-full'], opts: { full: false } },
  { label: 'strict', flags: ['--strict'], opts: { strict: true } },
];

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!GIT_AVAILABLE)('fsck reverse-index and bitmap findings, against real git', () => {
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function newRoot(slug: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-rev-bitmap-fsck-${slug}-`));
    roots.push(dir);
    return dir;
  }

  async function freshBase(slug: string): Promise<BaseFixture> {
    return buildBaseFixture(await newRoot(slug), 'repo');
  }
  async function freshBitmap(slug: string): Promise<BaseFixture> {
    return buildBitmapFixture(await newRoot(slug), 'repo');
  }
  async function freshTwoPack(slug: string) {
    return buildTwoPackFixture(await newRoot(slug), 'repo');
  }
  async function freshMidxBitmap(slug: string) {
    return buildMidxBitmapFixture(await newRoot(slug), 'repo');
  }

  // -------------------------------------------------------------------------
  // Pin H — `.rev` fault matrix
  // -------------------------------------------------------------------------

  describe('Pin H — .rev fault matrix, against real git', () => {
    describe('Given a healthy BASE repo restamped with no other change (restamp control, mandatory first), When fsck runs', () => {
      it("Then both tools still exit 0 — the restamp algorithm is git's own", async () => {
        // Arrange
        const fixture = await freshBase('rev-restamp-control');
        mutateOrThrowRevControl(fixture);
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(result.exitCode).toBe(0);
        expect(findingsOfType(result.findings, 'pack-rev-index-invalid')).toHaveLength(0);
      });
    });

    describe('Given a healthy BASE repo (row R0, control), When fsck runs', () => {
      it('Then both tools exit 0 with no rev-index finding', async () => {
        // Arrange
        const fixture = await freshBase('r0');
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(result.exitCode).toBe(0);
        expect(findingsOfType(result.findings, 'pack-rev-index-invalid')).toHaveLength(0);
        expect(findingsOfType(result.findings, 'pack-rev-index-position-mismatch')).toHaveLength(0);
      });
    });

    const LOAD_FAULT_ROWS: ReadonlyArray<{
      readonly label: string;
      readonly reasonContains: string;
      readonly mutate: (bytes: Buffer) => Buffer;
    }> = [
      {
        label: 'R1 signature 4th byte flipped',
        reasonContains: 'signature',
        mutate: flipSignatureByte,
      },
      {
        label: 'R2 version set to 2',
        reasonContains: 'version',
        mutate: (bytes) => {
          bytes.writeUInt32BE(2, 4);
          return bytes;
        },
      },
      {
        label: 'R5 hashId set to 0',
        reasonContains: 'hash id',
        mutate: (bytes) => {
          bytes.writeUInt32BE(0, 8);
          return bytes;
        },
      },
      {
        label: 'R6 truncated to 8 bytes',
        reasonContains: 'too small',
        mutate: (bytes) => bytes.subarray(0, 8),
      },
      { label: 'R8 zero-length', reasonContains: 'too small', mutate: () => Buffer.alloc(0) },
      {
        label: 'R17 4 extra bytes appended, RESTAMPED',
        reasonContains: 'corrupt',
        mutate: (bytes) => restampRevIndex(Buffer.concat([bytes, Buffer.alloc(4)])),
      },
    ];

    describe.each(LOAD_FAULT_ROWS)(
      'Given a BASE repo with $label, When fsck runs',
      ({ label, reasonContains, mutate }) => {
        it(`Then both tools score bit 64, and tsgit reports one pack-rev-index-invalid finding whose reason mentions "${reasonContains}"`, async () => {
          // Arrange
          const slug = label.split(' ')[0]?.toLowerCase() ?? 'row';
          const fixture = await freshBase(slug);
          mutateOrThrowRev(fixture, mutate);
          const gitResult = gitFsck(fixture.dir);
          const sut = trackedNodeContext(fixture.dir);

          // Act
          const result = await fsck(sut);

          // Assert
          expect(gitResult.exitCode & 64).toBe(64);
          expect(result.exitCode & 64).toBe(64);
          const findings = findingsOfType(result.findings, 'pack-rev-index-invalid');
          expect(findings).toHaveLength(1);
          expect(findings[0]?.reason.toLowerCase()).toContain(reasonContains);
        });
      },
    );

    describe('Given a BASE repo with R9b own digest flipped, When fsck runs', () => {
      it('Then both tools score bit 64, and tsgit reports one pack-rev-index-invalid finding for an invalid checksum', async () => {
        // Arrange
        const fixture = await freshBase('r9b');
        mutateOrThrowRev(fixture, flipLastByte);
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode & 64).toBe(64);
        expect(result.exitCode & 64).toBe(64);
        const findings = findingsOfType(result.findings, 'pack-rev-index-invalid');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.reason).toBe('invalid checksum');
        expect(findingsOfType(result.findings, 'pack-rev-index-position-mismatch')).toHaveLength(0);
      });
    });

    describe('Given a BASE repo with R10b embedded pack checksum flipped, RESTAMPED, When fsck runs', () => {
      it('Then both tools exit 0 — git never verifies this field', async () => {
        // Arrange
        const fixture = await freshBase('r10b');
        mutateOrThrowRev(fixture, (bytes) => {
          const checksumStart = bytes.length - 2 * DIGEST_LENGTH;
          bytes[checksumStart] = (bytes[checksumStart] ?? 0) ^ 0xff;
          return restampRevIndex(bytes);
        });
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(result.exitCode).toBe(0);
        expect(findingsOfType(result.findings, 'pack-rev-index-invalid')).toHaveLength(0);
      });
    });

    describe('Given a BASE repo with R16 hashId set to 2 in a SHA-1 repo, RESTAMPED, When fsck runs', () => {
      it('Then both tools exit 0 — hashId is checked for membership, never against the repository', async () => {
        // Arrange
        const fixture = await freshBase('r16');
        mutateOrThrowRev(fixture, (bytes) => {
          bytes.writeUInt32BE(2, 8);
          return restampRevIndex(bytes);
        });
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(result.exitCode).toBe(0);
        expect(findingsOfType(result.findings, 'pack-rev-index-invalid')).toHaveLength(0);
      });
    });

    function bodyOffset(position: number): number {
      return REV_HEADER_SIZE + position * 4;
    }

    describe('Given a BASE repo with R14 body[0] set out of range, RESTAMPED, When fsck runs', () => {
      it('Then both tools score bit 64 with exactly one position-mismatch finding at position 0, without pinning the fixture-dependent expected value', async () => {
        // Arrange
        const fixture = await freshBase('r14');
        mutateOrThrowRev(fixture, (bytes) => {
          bytes.writeUInt32BE(999999, bodyOffset(0));
          return restampRevIndex(bytes);
        });
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode & 64).toBe(64);
        expect(result.exitCode & 64).toBe(64);
        const mismatches = findingsOfType(result.findings, 'pack-rev-index-position-mismatch');
        expect(mismatches).toHaveLength(1);
        expect(mismatches[0]?.position).toBe(0);
        expect(mismatches[0]?.stored).toBe(999999);
        expect(mismatches[0]?.expected).not.toBe(999999);
        expect(findingsOfType(result.findings, 'pack-rev-index-invalid')).toHaveLength(0);
      });
    });

    describe('Given a BASE repo with R15 body[0] set to body[1] (non-permutation), RESTAMPED, When fsck runs', () => {
      it('Then both tools score bit 64 with exactly one position-mismatch finding at position 0', async () => {
        // Arrange
        const fixture = await freshBase('r15');
        mutateOrThrowRev(fixture, (bytes) => {
          const duplicate = bytes.readUInt32BE(bodyOffset(1));
          bytes.writeUInt32BE(duplicate, bodyOffset(0));
          return restampRevIndex(bytes);
        });
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode & 64).toBe(64);
        expect(result.exitCode & 64).toBe(64);
        const mismatches = findingsOfType(result.findings, 'pack-rev-index-position-mismatch');
        expect(mismatches).toHaveLength(1);
        expect(mismatches[0]?.position).toBe(0);
      });
    });

    describe('Given a BASE repo with N1 two body positions wrong, RESTAMPED, When fsck runs', () => {
      it('Then git reports two invalid-rev-index-position lines under one bit-64 verdict, and tsgit reports exactly two position-mismatch findings', async () => {
        // Arrange
        const fixture = await freshBase('n1');
        mutateOrThrowRev(fixture, (bytes) => {
          bytes.writeUInt32BE(999999, bodyOffset(0));
          bytes.writeUInt32BE(999998, bodyOffset(1));
          return restampRevIndex(bytes);
        });
        const gitResult = gitFsck(fixture.dir);
        const positionLines = gitResult.stderr
          .split('\n')
          .filter((line) => line.includes('invalid rev-index position'));
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode & 64).toBe(64);
        expect(positionLines).toHaveLength(2);
        expect(result.exitCode & 64).toBe(64);
        const mismatches = findingsOfType(result.findings, 'pack-rev-index-position-mismatch');
        expect(mismatches).toHaveLength(2);
        expect(mismatches.map((mismatch) => mismatch.position).sort()).toEqual([0, 1]);
      });
    });

    describe('Given a BASE repo with R11 .rev deleted, When fsck runs', () => {
      it('Then both tools exit 0, silently', async () => {
        // Arrange
        const fixture = await freshBase('r11');
        await rm(packArtefactPaths(fixture.dir).rev, { force: true });
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(result.exitCode).toBe(0);
      });
    });

    describe('Given a BASE repo with R12 .rev made unreadable via chmod 000 (node tier only), When fsck runs', () => {
      it('Then both tools exit 0, silently', async () => {
        // Arrange
        const fixture = await freshBase('r12');
        chmodSync(packArtefactPaths(fixture.dir).rev, 0o000);
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(result.exitCode).toBe(0);
      });
    });

    describe('Given a BASE repo with R13 an extra .rev naming no pack (orphan), When fsck runs', () => {
      it('Then both tools exit 0 — a .rev with no corresponding .idx is never inspected', async () => {
        // Arrange
        const fixture = await freshBase('r13');
        const artefacts = packArtefactPaths(fixture.dir);
        const orphanPath = path.join(path.dirname(artefacts.rev), `pack-${'0'.repeat(40)}.rev`);
        await copyFile(artefacts.rev, orphanPath);
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(result.exitCode).toBe(0);
        expect(findingsOfType(result.findings, 'pack-rev-index-invalid')).toHaveLength(0);
      });
    });

    // C1/C2's `.idx` fault makes the sole pack's objects unresolvable, and
    // the fixture's own refs point directly into that pack. Real git's
    // ref-checker classifies a ref whose target it cannot resolve as an
    // "invalid sha1 pointer" and folds that into EXIT_REFS_CONTENT (bit 8)
    // ALONGSIDE the plain "missing" bit (2) — a distinct code path from the
    // "ref points to an oid that plainly doesn't exist anywhere" case
    // (`fsck-interop.test.ts`'s already-pinned matrix #9a, bit 2 only).
    // tsgit's `runRefsVerifyPass` has no notion of "in the enumerated
    // universe but its pack is inaccessible" — it only ever sees
    // `universe.has(oid) === false` and always takes the bit-2-only path, so
    // it never contributes bit 8 here. This is a PRE-EXISTING gap in
    // refs-verify.ts's pack-accessibility handling, unrelated to the
    // rev-index/bitmap health passes Parts 4/5/7 built (their own bits — 4
    // and 64 below — compose exactly as git's do); both sides are asserted
    // against their own CONFIRMED, live-measured value rather than pinning
    // one to the other.
    describe('Given a BASE repo with C1 .idx corrupted (truncated to 8 bytes), .rev intact, When fsck runs', () => {
      it("Then git's non-monotonic-index fault masks the .rev, and tsgit reports pack-index-unusable + pack-rev-index-unusable with no rev-index-invalid finding", async () => {
        // Arrange
        const fixture = await freshBase('c1');
        mutateOrThrowIdx(fixture, (bytes) => bytes.subarray(0, 8));
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert — git carries the refs-verify bit (8) this fixture's real
        // refs trigger; tsgit's own pack/rev-index bits (4|64) are intact,
        // pinned separately from the documented refs-verify gap above.
        expect(gitResult.exitCode).toBe(78);
        expect(result.exitCode).toBe(70);
        expect(findingsOfType(result.findings, 'pack-index-unusable')).toHaveLength(1);
        expect(findingsOfType(result.findings, 'pack-rev-index-unusable')).toHaveLength(1);
        expect(findingsOfType(result.findings, 'pack-rev-index-invalid')).toHaveLength(0);
        expect(findingsOfType(result.findings, 'pack-rev-index-position-mismatch')).toHaveLength(0);
      });
    });

    describe('Given a BASE repo with C2 .idx AND .rev both corrupted, When fsck runs', () => {
      it('Then the exit and finding shape are byte-identical to C1 — the .rev fault is never separately reported', async () => {
        // Arrange
        const fixture = await freshBase('c2');
        mutateOrThrowIdx(fixture, (bytes) => bytes.subarray(0, 8));
        mutateOrThrowRev(fixture, flipSignatureByte);
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert — see C1's comment: the refs-verify bit-8 gap is documented
        // there, not re-litigated here.
        expect(gitResult.exitCode).toBe(78);
        expect(result.exitCode).toBe(70);
        expect(findingsOfType(result.findings, 'pack-index-unusable')).toHaveLength(1);
        expect(findingsOfType(result.findings, 'pack-rev-index-unusable')).toHaveLength(1);
        expect(findingsOfType(result.findings, 'pack-rev-index-invalid')).toHaveLength(0);
      });
    });

    describe("Given a two-pack repo where both packs' .rev have a bad signature, When fsck runs", () => {
      it('Then git prints two unknown-signature lines under one bit-64 verdict, and tsgit reports two pack-rev-index-invalid findings', async () => {
        // Arrange
        const fixture = await freshTwoPack('composition');
        for (const name of fixture.packNames) {
          mutateOrThrow(packArtefactPathsNamed(fixture.dir, name).rev, flipSignatureByte);
        }
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(64);
        expect(result.exitCode).toBe(64);
        expect(findingsOfType(result.findings, 'pack-rev-index-invalid')).toHaveLength(2);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Pin I — `.rev` at `fsck`: mode gating and cardinality
  // -------------------------------------------------------------------------

  describe('Pin I — .rev at fsck: mode gating and cardinality', () => {
    let control: BaseFixture;
    let controlGitExit: Record<string, number>;
    let controlTsgitExit: Record<string, number>;

    beforeAll(async () => {
      control = await freshBase('mode-control');
      controlGitExit = Object.fromEntries(
        MODES.map(({ label, flags }) => [label, gitFsck(control.dir, ...flags).exitCode]),
      );
      const entries: Array<[string, number]> = [];
      for (const { label, opts } of MODES) {
        const result = await fsck(trackedNodeContext(control.dir), opts);
        entries.push([label, result.exitCode]);
      }
      controlTsgitExit = Object.fromEntries(entries);
    }, 60_000);

    describe('Given a healthy BASE repo (row M0, control), When fsck runs across modes', () => {
      it.each(MODES)('Then mode "$label" gives the same raw exit for both tools', ({ label }) => {
        // Arrange — both tools' per-mode control exits were already computed in beforeAll
        const gitExit = exitForMode(controlGitExit, label);
        const tsgitExit = exitForMode(controlTsgitExit, label);

        // Assert
        expect(tsgitExit).toBe(gitExit);
      });
    });

    interface ModeMutationRow {
      readonly label: string;
      readonly bitDelta: 0 | 64;
      readonly build: (slug: string) => Promise<{ readonly dir: string }>;
    }

    const MUTATION_ROWS: ReadonlyArray<ModeMutationRow> = [
      {
        label: 'M1 bad signature',
        bitDelta: 64,
        build: async (slug) => {
          const fixture = await freshBase(slug);
          mutateOrThrowRev(fixture, flipSignatureByte);
          return fixture;
        },
      },
      {
        label: 'M2 own digest flipped',
        bitDelta: 64,
        build: async (slug) => {
          const fixture = await freshBase(slug);
          mutateOrThrowRev(fixture, flipLastByte);
          return fixture;
        },
      },
      {
        label: 'M3 body out of range',
        bitDelta: 64,
        build: async (slug) => {
          const fixture = await freshBase(slug);
          mutateOrThrowRev(fixture, (bytes) => {
            bytes.writeUInt32BE(999999, REV_HEADER_SIZE);
            return restampRevIndex(bytes);
          });
          return fixture;
        },
      },
      {
        label: 'M4 .rev deleted',
        bitDelta: 0,
        build: async (slug) => {
          const fixture = await freshBase(slug);
          await rm(packArtefactPaths(fixture.dir).rev, { force: true });
          return fixture;
        },
      },
      {
        label: 'M5 .rev chmod 000 (node tier only)',
        bitDelta: 0,
        build: async (slug) => {
          const fixture = await freshBase(slug);
          chmodSync(packArtefactPaths(fixture.dir).rev, 0o000);
          return fixture;
        },
      },
      {
        label: 'M7 bad signature, .bitmap removed',
        bitDelta: 64,
        build: async (slug) => {
          const fixture = await freshBitmap(slug);
          await rm(packArtefactPaths(fixture.dir).bitmap, { force: true });
          mutateOrThrowRev(fixture, flipSignatureByte);
          return fixture;
        },
      },
      {
        label: 'M8 bad signature, midx present',
        bitDelta: 64,
        build: async (slug) => {
          const fixture = await freshBase(slug);
          git(fixture.dir, 'multi-pack-index', 'write');
          mutateOrThrowRev(fixture, flipSignatureByte);
          return fixture;
        },
      },
    ];

    describe.each(MUTATION_ROWS)(
      'Given a BASE repo with $label, When fsck runs across modes',
      ({ label, bitDelta, build }) => {
        it.each(MODES)(
          'Then mode "$label" scores exactly the per-mode control XOR the mutation\'s own bit',
          async ({ label: modeLabel, flags, opts }) => {
            // Arrange
            const slug = `${label.split(' ')[0]?.toLowerCase()}-${modeLabel}`;
            const fixture = await build(slug);
            const gitResult = gitFsck(fixture.dir, ...flags);
            const sut = trackedNodeContext(fixture.dir);

            // Act
            const result = await fsck(sut, opts);

            // Assert — bit-wise against the per-mode control, never a literal
            expect(gitResult.exitCode ^ exitForMode(controlGitExit, modeLabel)).toBe(bitDelta);
            expect(result.exitCode ^ exitForMode(controlTsgitExit, modeLabel)).toBe(bitDelta);
          },
        );
      },
    );

    describe("Given a midx+bitmap fixture with X9 one pack's .rev bad signature, When fsck runs", () => {
      it("Then bit 64 is ungated by mode for git and by every one of tsgit's own modes (documented divergence: no core.multiPackIndex equivalent)", async () => {
        // Arrange
        const fixture = await freshMidxBitmap('x9');
        mutateOrThrow(
          packArtefactPathsNamed(fixture.dir, fixture.bitmapPackName).rev,
          flipSignatureByte,
        );
        const fullResult = gitFsck(fixture.dir);
        const connResult = gitFsck(fixture.dir, '--connectivity-only');
        const noFullResult = gitFsck(fixture.dir, '--no-full');
        const gateResult = gitFsckWithoutMultiPackIndex(fixture.dir);

        // Act
        const tsgitResults = await Promise.all(
          MODES.map(({ opts }) => fsck(trackedNodeContext(fixture.dir), opts)),
        );

        // Assert — git
        expect(fullResult.exitCode & 64).toBe(64);
        expect(connResult.exitCode & 64).toBe(64);
        expect(noFullResult.exitCode & 64).toBe(64);
        expect(gateResult.exitCode & 64).toBe(64);
        // Assert — tsgit: ungated in every one of its own modes
        for (const result of tsgitResults) {
          expect(result.exitCode & 64).toBe(64);
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // Pin J — `.bitmap` fault matrix: `fsck` checks the checksum and nothing else
  // -------------------------------------------------------------------------

  describe('Pin J — .bitmap fault matrix: fsck checks the checksum and nothing else', () => {
    describe('Given a healthy bitmap fixture restamped with no other change (restamp control, mandatory first), When fsck runs', () => {
      it("Then both tools still exit 0 — the restamp algorithm is git's own", async () => {
        // Arrange
        const fixture = await freshBitmap('bitmap-restamp-control');
        mutateOrThrowBitmap(fixture, (bytes) => restampBitmap(bytes));
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(result.exitCode).toBe(0);
        expect(findingsOfType(result.findings, 'bitmap-checksum-mismatch')).toHaveLength(0);
      });
    });

    describe('Given a healthy bitmap fixture (row B0, control), When fsck runs', () => {
      it('Then both tools exit 0 with no bitmap finding', async () => {
        // Arrange
        const fixture = await freshBitmap('b0');
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(result.exitCode).toBe(0);
        expect(findingsOfType(result.findings, 'bitmap-checksum-mismatch')).toHaveLength(0);
      });
    });

    describe('Given a bitmap fixture with B1 .bitmap deleted, When fsck runs', () => {
      it('Then both tools exit 0, silently', async () => {
        // Arrange
        const fixture = await freshBitmap('b1');
        await rm(packArtefactPaths(fixture.dir).bitmap, { force: true });
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(result.exitCode).toBe(0);
      });
    });

    const CHECKSUM_MISMATCH_ROWS: ReadonlyArray<{
      readonly label: string;
      readonly mutate: (bytes: Buffer) => Buffer;
    }> = [
      { label: 'B2 magic flipped', mutate: flipSignatureByte },
      {
        label: 'B9 embedded pack checksum flipped',
        mutate: (bytes) => {
          bytes[12] = (bytes[12] ?? 0) ^ 0xff;
          return bytes;
        },
      },
    ];

    describe.each(CHECKSUM_MISMATCH_ROWS)(
      'Given a bitmap fixture with $label, When fsck runs',
      ({ label, mutate }) => {
        it('Then both tools score bit 128 with one bitmap-checksum-mismatch finding', async () => {
          // Arrange
          const slug = label.split(' ')[0]?.toLowerCase() ?? 'row';
          const fixture = await freshBitmap(slug);
          mutateOrThrowBitmap(fixture, mutate);
          const gitResult = gitFsck(fixture.dir);
          const sut = trackedNodeContext(fixture.dir);

          // Act
          const result = await fsck(sut);

          // Assert
          expect(gitResult.exitCode & 128).toBe(128);
          expect(result.exitCode & 128).toBe(128);
          const findings = findingsOfType(result.findings, 'bitmap-checksum-mismatch');
          expect(findings).toHaveLength(1);
          expect(findings[0]?.artefact).toMatch(/\.bitmap$/);
        });
      },
    );

    describe('Given a bitmap fixture with B12 .bitmap made unreadable via chmod 000 (node tier only), When fsck runs', () => {
      it('Then both tools exit 0, silently', async () => {
        // Arrange
        const fixture = await freshBitmap('b12');
        chmodSync(packArtefactPaths(fixture.dir).bitmap, 0o000);
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(result.exitCode).toBe(0);
      });
    });

    describe('Given a bitmap fixture with B23 an extra .bitmap naming no pack (orphan), When fsck runs', () => {
      it('Then both tools exit 0 — a .bitmap with no corresponding .idx is never inspected', async () => {
        // Arrange
        const fixture = await freshBitmap('b23');
        const artefacts = packArtefactPaths(fixture.dir);
        const orphanPath = path.join(
          path.dirname(artefacts.bitmap),
          `pack-${'0'.repeat(40)}.bitmap`,
        );
        await copyFile(artefacts.bitmap, orphanPath);
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(result.exitCode).toBe(0);
        expect(findingsOfType(result.findings, 'bitmap-checksum-mismatch')).toHaveLength(0);
      });
    });

    const RESTAMPED_CLEAN_ROWS: ReadonlyArray<{
      readonly label: string;
      readonly mutate: (bytes: Buffer) => Buffer;
    }> = [
      {
        label: 'B14 magic flipped, RESTAMPED',
        mutate: (bytes) => restampBitmap(flipSignatureByte(bytes)),
      },
      {
        label: 'B16 embedded pack checksum flipped, RESTAMPED',
        mutate: (bytes) => {
          bytes[12] = (bytes[12] ?? 0) ^ 0xff;
          return restampBitmap(bytes);
        },
      },
      {
        label: 'B18 truncated (kept above one digest length), RESTAMPED',
        mutate: (bytes) => restampBitmap(bytes.subarray(0, Math.floor(bytes.length / 2))),
      },
    ];

    describe.each(RESTAMPED_CLEAN_ROWS)(
      'Given a bitmap fixture with $label, When fsck runs',
      ({ label, mutate }) => {
        it("Then both tools exit 0 — the RESTAMPED trailer is git's whole obligation", async () => {
          // Arrange
          const slug = label.split(' ')[0]?.toLowerCase() ?? 'row';
          const fixture = await freshBitmap(slug);
          mutateOrThrowBitmap(fixture, mutate);
          const gitResult = gitFsck(fixture.dir);
          const sut = trackedNodeContext(fixture.dir);

          // Act
          const result = await fsck(sut);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(result.exitCode).toBe(0);
          expect(findingsOfType(result.findings, 'bitmap-checksum-mismatch')).toHaveLength(0);
        });
      },
    );

    describe('Given a bitmap fixture with B24 BOTH .rev and .bitmap corrupt, When fsck runs', () => {
      it('Then both tools score bits 64 AND 128 together (192), one finding each', async () => {
        // Arrange
        const fixture = await freshBitmap('b24');
        mutateOrThrowRev(fixture, flipSignatureByte);
        mutateOrThrowBitmap(fixture, flipSignatureByte);
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(192);
        expect(result.exitCode).toBe(192);
        expect(findingsOfType(result.findings, 'pack-rev-index-invalid')).toHaveLength(1);
        expect(findingsOfType(result.findings, 'bitmap-checksum-mismatch')).toHaveLength(1);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Pin K — the midx bitmap
  // -------------------------------------------------------------------------

  describe('Pin K — the midx bitmap', () => {
    describe('Given a healthy midx+bitmap fixture restamped with no other change (restamp control, mandatory first), When fsck runs', () => {
      it("Then both tools still show no bitmap bit — the restamp algorithm is git's own", async () => {
        // Arrange
        const fixture = await freshMidxBitmap('midx-bitmap-restamp-control');
        mutateOrThrow(fixture.midxBitmapPath, (bytes) => restampBitmap(bytes));
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode & 128).toBe(0);
        expect(result.exitCode & 128).toBe(0);
      });
    });

    describe('Given a healthy midx+bitmap fixture (row X0, control), When fsck runs', () => {
      it('Then fsck, verify, connectivity-only and strict report no bitmap bit', async () => {
        // Arrange
        const fixture = await freshMidxBitmap('x0');
        const fullResult = gitFsck(fixture.dir);
        const verifyResult = gitVerify(fixture.dir);
        const connResult = gitFsck(fixture.dir, '--connectivity-only');
        const strictResult = gitFsck(fixture.dir, '--strict');
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(fullResult.exitCode).toBe(0);
        expect(verifyResult.exitCode).toBe(0);
        expect(connResult.exitCode & 128).toBe(0);
        expect(strictResult.exitCode & 128).toBe(0);
        expect(result.exitCode).toBe(0);
        expect(findingsOfType(result.findings, 'bitmap-checksum-mismatch')).toHaveLength(0);
      });
    });

    describe('Given a midx+bitmap fixture with X1 midx bitmap magic flipped, When fsck runs', () => {
      it('Then both tools score bit 128, ungated by mode, with one bitmap-checksum-mismatch finding for the midx artefact', async () => {
        // Arrange
        const fixture = await freshMidxBitmap('x1');
        mutateOrThrow(fixture.midxBitmapPath, flipSignatureByte);
        const fullResult = gitFsck(fixture.dir);
        const connResult = gitFsck(fixture.dir, '--connectivity-only');
        const noFullResult = gitFsck(fixture.dir, '--no-full');
        const verifyResult = gitVerify(fixture.dir);
        const gateResult = gitFsckWithoutMultiPackIndex(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(fullResult.exitCode & 128).toBe(128);
        expect(connResult.exitCode & 128).toBe(128);
        expect(noFullResult.exitCode & 128).toBe(128);
        expect(verifyResult.exitCode).toBe(0);
        // The midx bitmap check IS gated by core.multiPackIndex (unlike X8's pack bitmap)
        expect(gateResult.exitCode & 128).toBe(0);
        expect(result.exitCode & 128).toBe(128);
        const midxFindings = findingsOfType(result.findings, 'bitmap-checksum-mismatch').filter(
          (finding) => finding.artefact.startsWith('multi-pack-index'),
        );
        expect(midxFindings).toHaveLength(1);
      });
    });

    describe('Given a midx+bitmap fixture with X2 midx bitmap magic flipped, RESTAMPED, When fsck runs', () => {
      it('Then both tools show no bitmap bit', async () => {
        // Arrange
        const fixture = await freshMidxBitmap('x2');
        mutateOrThrow(fixture.midxBitmapPath, (bytes) => restampBitmap(flipSignatureByte(bytes)));
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode & 128).toBe(0);
        expect(result.exitCode & 128).toBe(0);
        expect(findingsOfType(result.findings, 'bitmap-checksum-mismatch')).toHaveLength(0);
      });
    });

    describe('Given a midx+bitmap fixture with X4 midx bitmap own trailer flipped, When fsck runs', () => {
      it('Then both tools score bit 128 with one bitmap-checksum-mismatch finding for the midx artefact', async () => {
        // Arrange
        const fixture = await freshMidxBitmap('x4');
        mutateOrThrow(fixture.midxBitmapPath, flipLastByte);
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode & 128).toBe(128);
        expect(result.exitCode & 128).toBe(128);
        const midxFindings = findingsOfType(result.findings, 'bitmap-checksum-mismatch').filter(
          (finding) => finding.artefact.startsWith('multi-pack-index'),
        );
        expect(midxFindings).toHaveLength(1);
      });
    });

    describe('Given a midx+bitmap fixture with X5 midx bitmap deleted, When fsck runs', () => {
      it('Then both tools show no bitmap bit', async () => {
        // Arrange
        const fixture = await freshMidxBitmap('x5');
        await rm(fixture.midxBitmapPath, { force: true });
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode & 128).toBe(0);
        expect(result.exitCode & 128).toBe(0);
      });
    });

    describe('Given a midx+bitmap fixture with X7 midx bitmap renamed to a different hash, When fsck runs', () => {
      it('Then both tools show no bitmap bit — discovery is by the STORED trailer, and nothing composes this new name', async () => {
        // Arrange
        const fixture = await freshMidxBitmap('x7');
        const renamedPath = path.join(
          path.dirname(fixture.midxBitmapPath),
          `multi-pack-index-${'f'.repeat(40)}.bitmap`,
        );
        await rename(fixture.midxBitmapPath, renamedPath);
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode & 128).toBe(0);
        expect(result.exitCode & 128).toBe(0);
      });
    });

    describe("Given a midx+bitmap fixture with X8 the PACK bitmap's own trailer flipped (midx present), When fsck runs", () => {
      it('Then both tools score bit 128, ungated by core.multiPackIndex (unlike X1), with one finding for the pack artefact', async () => {
        // Arrange
        const fixture = await freshMidxBitmap('x8');
        const packBitmapPath = packArtefactPathsNamed(fixture.dir, fixture.bitmapPackName).bitmap;
        mutateOrThrow(packBitmapPath, flipLastByte);
        const fullResult = gitFsck(fixture.dir);
        const connResult = gitFsck(fixture.dir, '--connectivity-only');
        const noFullResult = gitFsck(fixture.dir, '--no-full');
        const gateResult = gitFsckWithoutMultiPackIndex(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(fullResult.exitCode & 128).toBe(128);
        expect(connResult.exitCode & 128).toBe(128);
        expect(noFullResult.exitCode & 128).toBe(128);
        expect(gateResult.exitCode & 128).toBe(128);
        expect(result.exitCode & 128).toBe(128);
        const findings = findingsOfType(result.findings, 'bitmap-checksum-mismatch');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.artefact).toBe(`${fixture.bitmapPackName}.bitmap`);
      });
    });

    describe("Given a midx+bitmap fixture with X10 the midx's OWN trailer flipped AND its midx bitmap magic flipped, When fsck runs", () => {
      it('Then git and tsgit both exit EXACTLY 32, never 32|128 — the wrong trailer composes a name naming no file, hiding the corrupt bitmap entirely', async () => {
        // Arrange
        const fixture = await freshMidxBitmap('x10');
        mutateOrThrow(fixture.flatMidxPath, flipLastByte);
        mutateOrThrow(fixture.midxBitmapPath, flipSignatureByte);
        const gitResult = gitFsck(fixture.dir);
        const sut = trackedNodeContext(fixture.dir);

        // Act
        const result = await fsck(sut);

        // Assert
        expect(gitResult.exitCode).toBe(32);
        expect(result.exitCode).toBe(32);
        expect(findingsOfType(result.findings, 'midx-checksum-mismatch')).toHaveLength(1);
        expect(findingsOfType(result.findings, 'bitmap-checksum-mismatch')).toHaveLength(0);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Pin L — exit-bit composition, and the interaction with pack accessibility
  // -------------------------------------------------------------------------

  describe('Pin L — exit-bit composition, and the interaction with pack accessibility', () => {
    describe('Given a healthy bitmap fixture (row Y0, control), When fsck runs across modes', () => {
      it.each(MODES)(
        'Then mode "$label" gives the same raw exit for both tools',
        async ({ label, flags, opts }) => {
          // Arrange
          const fixture = await freshBitmap(`y0-${label}`);
          const gitResult = gitFsck(fixture.dir, ...flags);
          const sut = trackedNodeContext(fixture.dir);

          // Act
          const result = await fsck(sut, opts);

          // Assert
          expect(result.exitCode).toBe(gitResult.exitCode);
        },
      );
    });

    interface CompositionRow {
      readonly label: string;
      readonly gitExit: Readonly<Record<string, number>>;
      /**
       * tsgit's own confirmed exit per mode. Equal to `gitExit` for rows
       * that never touch pack accessibility (Y1). For every row that DOES
       * (Y2/Y3/Y5/Y4/Y6), `gitExit ^ tsgitExit` isolates the SAME documented
       * refs-verify gap C1/C2 already carry a full explanation for: git's
       * ref-checker folds "target unresolvable because its pack is
       * inaccessible" into bit 8 (`invalid sha1 pointer`), which tsgit's
       * `runRefsVerifyPass` cannot currently distinguish from a plain
       * "missing" (bit 2 only) — and, additionally, ONLY under
       * `connectivityOnly` (Y2/Y3/Y5's `chmod 000` shape), tsgit's
       * `unreadable: 'classify'` mode reclassifies the same objects as
       * zero-cost `dangling unknown`, dropping bit 2 as well (never bit 4
       * or 64/128, which this part IS responsible for and which compose
       * identically to git's in every row below).
       */
      readonly tsgitExit: Readonly<Record<string, number>>;
      readonly arrange: (dir: string) => void;
    }

    const COMPOSITION_ROWS: ReadonlyArray<CompositionRow> = [
      {
        label: 'Y1 .bitmap trailer flipped',
        gitExit: { default: 128, connectivityOnly: 128, 'no-full': 130, strict: 128 },
        tsgitExit: { default: 128, connectivityOnly: 128, 'no-full': 130, strict: 128 },
        arrange: (dir) => mutateOrThrow(packArtefactPaths(dir).bitmap, flipLastByte),
      },
      {
        label: 'Y3 .pack chmod 000 (header-gate refusal), artefacts intact (node tier only)',
        gitExit: { default: 14, connectivityOnly: 10, 'no-full': 10, strict: 14 },
        tsgitExit: { default: 6, connectivityOnly: 0, 'no-full': 2, strict: 6 },
        arrange: (dir) => chmodSync(packArtefactPaths(dir).pack, 0o000),
      },
      {
        label: 'Y2 .bitmap trailer flipped + .pack chmod 000 (node tier only)',
        gitExit: { default: 142, connectivityOnly: 138, 'no-full': 138, strict: 142 },
        tsgitExit: { default: 134, connectivityOnly: 128, 'no-full': 130, strict: 134 },
        arrange: (dir) => {
          mutateOrThrow(packArtefactPaths(dir).bitmap, flipLastByte);
          chmodSync(packArtefactPaths(dir).pack, 0o000);
        },
      },
      {
        label: 'Y5 .rev bad signature + .pack chmod 000 (node tier only)',
        gitExit: { default: 78, connectivityOnly: 74, 'no-full': 74, strict: 78 },
        tsgitExit: { default: 70, connectivityOnly: 64, 'no-full': 66, strict: 70 },
        arrange: (dir) => {
          mutateOrThrow(packArtefactPaths(dir).rev, flipSignatureByte);
          chmodSync(packArtefactPaths(dir).pack, 0o000);
        },
      },
      {
        label: 'Y4 .bitmap trailer flipped + .pack deleted (.idx kept)',
        gitExit: { default: 10, connectivityOnly: 10, 'no-full': 10, strict: 10 },
        tsgitExit: { default: 2, connectivityOnly: 2, 'no-full': 2, strict: 2 },
        arrange: (dir) => {
          mutateOrThrow(packArtefactPaths(dir).bitmap, flipLastByte);
          rmSync(packArtefactPaths(dir).pack);
        },
      },
      {
        label: 'Y6 .rev bad signature + .pack deleted (.idx kept)',
        gitExit: { default: 10, connectivityOnly: 10, 'no-full': 10, strict: 10 },
        tsgitExit: { default: 2, connectivityOnly: 2, 'no-full': 2, strict: 2 },
        arrange: (dir) => {
          mutateOrThrow(packArtefactPaths(dir).rev, flipSignatureByte);
          rmSync(packArtefactPaths(dir).pack);
        },
      },
    ];

    describe.each(COMPOSITION_ROWS)(
      'Given the bitmap fixture with $label, When fsck runs across modes',
      ({ label, gitExit, tsgitExit, arrange }) => {
        it.each(MODES)(
          'Then mode "$label" gives the pinned exit for git, and tsgit\'s own confirmed exit (documented above where it differs)',
          async ({ label: modeLabel, flags, opts }) => {
            // Arrange
            const slug = `${label.split(' ')[0]?.toLowerCase()}-${modeLabel}`;
            const fixture = await freshBitmap(slug);
            arrange(fixture.dir);
            const gitResult = gitFsck(fixture.dir, ...flags);
            const sut = trackedNodeContext(fixture.dir);

            // Act
            const result = await fsck(sut, opts);

            // Assert
            expect(gitResult.exitCode).toBe(gitExit[modeLabel]);
            expect(result.exitCode).toBe(tsgitExit[modeLabel]);
          },
        );
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Row-local mutation wrappers — thin, named adapters over `mutateOrThrow` so
// each row above reads as "mutate THIS artefact" without repeating
// `packArtefactPaths(fixture.dir).rev` at every call site.
// ---------------------------------------------------------------------------

function mutateOrThrowRev(fixture: BaseFixture, op: (bytes: Buffer) => Buffer): void {
  mutateOrThrow(packArtefactPaths(fixture.dir).rev, op);
}

function mutateOrThrowRevControl(fixture: BaseFixture): void {
  mutateOrThrowRev(fixture, (bytes) => restampRevIndex(bytes));
}

function mutateOrThrowBitmap(fixture: BaseFixture, op: (bytes: Buffer) => Buffer): void {
  mutateOrThrow(packArtefactPaths(fixture.dir).bitmap, op);
}

function mutateOrThrowIdx(fixture: BaseFixture, op: (bytes: Buffer) => Buffer): void {
  mutateOrThrow(packArtefactPaths(fixture.dir).idx, op);
}
