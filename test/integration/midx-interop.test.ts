/**
 * Cross-tool interop — multi-pack-index reads, precedence and degradation,
 * pinned against real git.
 *
 * Every row builds its tsgit `Context` AFTER the last `git` subprocess has
 * written: per-`Context` caches (the pack registry generation) are
 * invalidated only by tsgit's own writes, so a `Context` built earlier would
 * hold a memoised generation that predates the mutation under test. Every
 * row also gets its own fresh repo — never a shared, progressively-mutated
 * one — per the fixture recipes in `midx-fixture-helpers.ts`.
 *
 * @proves
 *   surface:        pack.readMultiPackIndex
 *   bucket:         cross-tool-interop
 *   unique:         multi-pack-index reads, precedence and degradation match canonical git
 *   interopSurface: multi-pack-index
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import {
  disposePackRegistry,
  getPackRegistry,
  readObject,
} from '../../src/application/primitives/read-object.js';
import { TsgitError } from '../../src/domain/error.js';
import type { GitObject } from '../../src/domain/objects/index.js';
import type { MultiPackIndex } from '../../src/domain/storage/index.js';
import { lookupMultiPackIndex, parseMultiPackIndex } from '../../src/domain/storage/index.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git, runGitEnv } from './interop-helpers.js';
import {
  type BaseFixture,
  buildBaseFixture,
  buildChainFixture,
  buildDupFixture,
  type ChainFixture,
  chainLayerPath,
  chunkTableRowOffset,
  craftLoffMidx,
  DIGEST_LENGTH,
  midxPaths,
  mutateMidxOrThrow,
  writeMultiPackIndex,
} from './midx-fixture-helpers.js';

/**
 * Swaps the first two PNAM name slots in place — only valid when both names
 * share the same length (true for this suite's uniform 40-hex pack names),
 * which is exactly what lets a v1-order violation be crafted without
 * reflowing the rest of the file. Every OOFF entry's `pack-int-id` is
 * permuted the same way (0↔1) so each object still resolves to the SAME
 * real pack it did before the swap — the only thing this mutation changes
 * is PNAM's order, never which bytes an object's offset points into.
 */
function swapFirstTwoPnamNames(bytes: Buffer): Buffer {
  const numChunks = bytes.readUInt8(6);
  const pnamStart = 12 + (numChunks + 1) * 12;
  const parsed = parseMultiPackIndex(bytes, DIGEST_LENGTH);
  const [name0, name1] = parsed.packNames;
  if (name0 === undefined || name1 === undefined) {
    throw new Error('swapFirstTwoPnamNames: fewer than 2 pack names present');
  }
  const width0 = name0.length + 1;
  const width1 = name1.length + 1;
  if (width0 !== width1) {
    throw new Error('swapFirstTwoPnamNames: pack names have different lengths');
  }
  const slot0 = bytes.subarray(pnamStart, pnamStart + width0);
  const slot1 = bytes.subarray(pnamStart + width0, pnamStart + width0 + width1);
  const tmp = Buffer.from(slot0);
  slot0.set(slot1);
  slot1.set(tmp);

  for (let i = 0; i < parsed.objectCount; i += 1) {
    const entryStart = parsed.objectOffsetsOffset + i * 8;
    const packIndex = bytes.readUInt32BE(entryStart);
    if (packIndex === 0) bytes.writeUInt32BE(1, entryStart);
    else if (packIndex === 1) bytes.writeUInt32BE(0, entryStart);
  }
  return bytes;
}

const SETUP_TIMEOUT = 60_000;

// ---------------------------------------------------------------------------
// git-invocation + output-parsing helpers
// ---------------------------------------------------------------------------

/** Binary-safe `git cat-file -p`: returns a raw Buffer so payload bytes are never mangled. */
function catFileRaw(dir: string, oid: string): Buffer {
  return execFileSync('git', ['-C', dir, 'cat-file', '-p', oid], { env: runGitEnv() });
}

/** `git cat-file --batch-check`, feeding the oid over stdin. */
function batchCheck(
  dir: string,
  oid: string,
): { readonly stdout: string; readonly stderr: string; readonly exitCode: number } {
  const result = spawnSync('git', ['-C', dir, 'cat-file', '--batch-check'], {
    input: `${oid}\n`,
    env: runGitEnv(),
    encoding: 'utf8',
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status ?? 1 };
}

/** A pack's on-disk artefact path by base name (e.g. `pack-<hex>`). */
function packFile(dir: string, packName: string, ext: 'pack' | 'idx' | 'rev'): string {
  return path.join(dir, '.git', 'objects', 'pack', `${packName}.${ext}`);
}

/** OIDL's lexicographically-first oid — "object 0" in the midx's own sort order. */
function readFirstOidInOidl(bytes: Buffer, parsed: MultiPackIndex): string {
  return bytes
    .subarray(parsed.oidLookupOffset, parsed.oidLookupOffset + parsed.digestLength)
    .toString('hex');
}

function blobContent(object: GitObject): Uint8Array {
  if (object.type !== 'blob') throw new Error(`expected a blob, got ${object.type}`);
  return object.content;
}

/** git's own exit code for a subprocess we don't need stdout/stderr from. */
function gitExit(dir: string, ...args: string[]): number {
  return spawnSync('git', ['-C', dir, ...args], { env: runGitEnv() }).status ?? 1;
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

/** Asserts `readObject` rejects with the given `INVALID_MULTI_PACK_INDEX` check. */
async function expectMidxRefusal(ctx: Context, oid: string, check: string): Promise<void> {
  let caught: unknown;
  try {
    await readObject(ctx, oid as never);
    expect.unreachable('expected readObject to reject');
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  const data = (caught as TsgitError).data;
  expect(data.code).toBe('INVALID_MULTI_PACK_INDEX');
  expect((data as { readonly check: string }).check).toBe(check);
}

/** Asserts `readObject` rejects with `OBJECT_NOT_FOUND` for `oid`. */
async function expectObjectMissing(ctx: Context, oid: string): Promise<void> {
  let caught: unknown;
  try {
    await readObject(ctx, oid as never);
    expect.unreachable('expected readObject to reject');
  } catch (error) {
    caught = error;
  }
  expect((caught as TsgitError).data).toEqual({ code: 'OBJECT_NOT_FOUND', id: oid });
}

/** Asserts `readObject` on both tools returns byte-identical content for `oid`. */
async function expectBothRead(dir: string, ctx: Context, oid: string): Promise<void> {
  const gitPayload = catFileRaw(dir, oid);
  const object = await readObject(ctx, oid as never);
  expect(Buffer.compare(gitPayload, Buffer.from(blobContent(object)))).toBe(0);
}

/** A Tier-A row must deny every read, loose included (§D4.5) — asserts this
 *  for the fixture's packed marker oid(s) and its loose oid, and the matching
 *  git-side refusal. */
async function expectTierARow(params: {
  readonly dir: string;
  readonly packedOids: ReadonlyArray<string>;
  readonly looseOid: string;
  readonly gitExitCode: number;
  readonly check: string;
}): Promise<void> {
  const { dir, packedOids, looseOid, gitExitCode, check } = params;
  const sut = trackedNodeContext(dir);

  for (const oid of [...packedOids, looseOid]) {
    const gitResult = batchCheck(dir, oid);
    expect(gitResult.exitCode).toBe(gitExitCode);
    await expectMidxRefusal(sut, oid, check);
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!GIT_AVAILABLE)(
  'multi-pack-index reads, precedence and degradation, against real git',
  () => {
    const roots: string[] = [];
    afterAll(async () => {
      await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    async function newRoot(slug: string): Promise<string> {
      const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-midx-interop-${slug}-`));
      roots.push(dir);
      return dir;
    }

    describe('Given a BASE repo with a healthy flat midx, and the same repo with the midx removed, When both git and tsgit read every object (requirement 8)', () => {
      let withMidx: BaseFixture;
      let withoutMidxDir: string;

      beforeAll(async () => {
        const root = await newRoot('healthy-twin');
        withMidx = await buildBaseFixture(root, 'with-midx');
        const withoutBase = await buildBaseFixture(root, 'without-midx');
        await rm(midxPaths(withoutBase.dir).flat, { force: true });
        withoutMidxDir = withoutBase.dir;
      }, SETUP_TIMEOUT);

      it('Then every packed and loose object reads byte-identical on both tools, with and without a midx present', async () => {
        // Arrange
        const withMidxCtx = trackedNodeContext(withMidx.dir);
        const withoutMidxCtx = trackedNodeContext(withoutMidxDir);

        // Act + Assert
        for (const oid of [...withMidx.packedOids, withMidx.looseOid]) {
          await expectBothRead(withMidx.dir, withMidxCtx, oid);
          await expectBothRead(withoutMidxDir, withoutMidxCtx, oid);
        }
        expect(await getPackRegistry(withMidxCtx).all()).toHaveLength(3);
      });
    });

    describe('Pin D — midx versions', () => {
      describe("Given a flat midx written at git's default version, When both tools read it (row D4)", () => {
        it('Then git accepts it (version byte 1) and every packed object reads on both', async () => {
          // Arrange
          const dir = await newRoot('d4');
          const fixture = await buildBaseFixture(dir, 'repo');
          const flatBytes = readFileSync(midxPaths(fixture.dir).flat);
          const sut = trackedNodeContext(fixture.dir);

          // Act + Assert
          expect(flatBytes.readUInt8(4)).toBe(1);
          expect(gitExit(fixture.dir, 'cat-file', '-p', fixture.packedOids[0])).toBe(0);
          await expectBothRead(fixture.dir, sut, fixture.packedOids[0]);
        });
      });

      describe('Given a flat midx written with -c midx.version=2, When both tools read it (row D5)', () => {
        it('Then git verify exits 0 and every packed object reads on both', async () => {
          // Arrange
          const dir = await newRoot('d5');
          const fixture = await buildBaseFixture(dir, 'repo');
          git(fixture.dir, '-c', 'midx.version=2', 'multi-pack-index', 'write');
          const sut = trackedNodeContext(fixture.dir);

          // Act
          const verifyExit = gitExit(fixture.dir, 'multi-pack-index', 'verify');

          // Assert
          expect(verifyExit).toBe(0);
          for (const oid of fixture.packedOids) await expectBothRead(fixture.dir, sut, oid);
        });
      });

      describe.each([0, 3])(
        'Given a flat midx restamped to version %i, When both tools read it (row D6)',
        (version) => {
          it('Then git dies at exit 128 and tsgit rejects every read — loose included — with the version check', async () => {
            // Arrange
            const dir = await newRoot(`d6-${version}`);
            const fixture = await buildBaseFixture(dir, 'repo');
            mutateMidxOrThrow(midxPaths(fixture.dir).flat, (bytes) => {
              bytes.writeUInt8(version, 4);
              return bytes;
            });

            // Act + Assert
            await expectTierARow({
              dir: fixture.dir,
              packedOids: fixture.packedOids,
              looseOid: fixture.looseOid,
              gitExitCode: 128,
              check: 'version',
            });
          });
        },
      );

      describe('Given a v1 flat midx whose PNAM entries are not lexicographically ordered, When both tools read it (row D7)', () => {
        it('Then git dies at exit 128 and tsgit rejects every read — loose included — with the pack-names check', async () => {
          // Arrange
          const dir = await newRoot('d7');
          const fixture = await buildBaseFixture(dir, 'repo');
          mutateMidxOrThrow(midxPaths(fixture.dir).flat, swapFirstTwoPnamNames);

          // Act + Assert
          await expectTierARow({
            dir: fixture.dir,
            packedOids: fixture.packedOids,
            looseOid: fixture.looseOid,
            gitExitCode: 128,
            check: 'pack-names',
          });
        });
      });

      describe('Given the SAME non-lexicographic PNAM bytes restamped to version 2, When both tools read it (row D8)', () => {
        it('Then both accept it: git exits 0 and every packed object reads on both — v2 does not require PNAM order', async () => {
          // Arrange
          const dir = await newRoot('d8');
          const fixture = await buildBaseFixture(dir, 'repo');
          mutateMidxOrThrow(midxPaths(fixture.dir).flat, (bytes) => {
            const reordered = swapFirstTwoPnamNames(bytes);
            reordered.writeUInt8(2, 4);
            return reordered;
          });
          const sut = trackedNodeContext(fixture.dir);

          // Act + Assert
          expect(gitExit(fixture.dir, 'cat-file', '-p', fixture.packedOids[0])).toBe(0);
          for (const oid of fixture.packedOids) await expectBothRead(fixture.dir, sut, oid);
        });
      });
    });

    describe('Pin F — large offsets (LOFF)', () => {
      describe('Given a flat midx rebuilt with a valid, in-range LOFF indirection on object 0, When both tools read every packed object (row F1)', () => {
        it('Then git exits 0 and every packed object still reads byte-identical', async () => {
          // Arrange
          const dir = await newRoot('f1');
          const fixture = await buildBaseFixture(dir, 'repo');
          const flatPath = midxPaths(fixture.dir).flat;
          const crafted = craftLoffMidx(readFileSync(flatPath), { row: 0, count: 1 });
          chmodSync(flatPath, 0o644);
          writeFileSync(flatPath, crafted);
          const sut = trackedNodeContext(fixture.dir);

          // Act
          const verifyExit = gitExit(fixture.dir, 'multi-pack-index', 'verify');

          // Assert
          expect(verifyExit).toBe(0);
          for (const oid of fixture.packedOids) {
            expect(gitExit(fixture.dir, 'cat-file', '-p', oid)).toBe(0);
            await expectBothRead(fixture.dir, sut, oid);
          }
        });
      });

      describe('Given a flat midx whose OOFF entry 0 has bit 31 set but carries NO LOFF chunk, When both tools look up that object (row F2)', () => {
        it('Then git dies with a truncated-pack fatal at exit 128 and tsgit rejects the same lookup — the bit is literal without an LOFF chunk', async () => {
          // Arrange
          const dir = await newRoot('f2');
          const fixture = await buildBaseFixture(dir, 'repo');
          mutateMidxOrThrow(midxPaths(fixture.dir).flat, (bytes) => {
            const parsed = parseMultiPackIndex(bytes, DIGEST_LENGTH);
            const entryOffsetField = parsed.objectOffsetsOffset + 4;
            const raw = bytes.readUInt32BE(entryOffsetField);
            bytes.writeUInt32BE((raw | 0x80000000) >>> 0, entryOffsetField);
            return bytes;
          });
          const sut = trackedNodeContext(fixture.dir);

          // Act
          const flatBytes = readFileSync(midxPaths(fixture.dir).flat);
          const parsed = parseMultiPackIndex(flatBytes, DIGEST_LENGTH);
          const targetOid = readFirstOidInOidl(flatBytes, parsed);
          const gitResult = batchCheck(fixture.dir, targetOid);
          let caught: unknown;
          try {
            await readObject(sut, targetOid as never);
            expect.unreachable('expected readObject to reject');
          } catch (error) {
            caught = error;
          }

          // Assert
          expect(gitResult.exitCode).toBe(128);
          expect(gitResult.stderr).toContain('offset beyond end of packfile');
          // No LOFF chunk means bit 31 is part of the literal offset (the .idx
          // v2 rule): the pack's own offset table has no entry that large, so
          // the delta-chain walk rejects it as a corrupt index — the same
          // symptom class as git's own out-of-bounds refusal.
          expect((caught as TsgitError).data).toEqual({
            code: 'INVALID_PACK_INDEX',
            reason: 'offset not in pack index: corrupt index',
          });
        });
      });
    });

    describe('Pin G — corruption posture: two tiers, and one of them kills the read', () => {
      describe('Tier A — a scan-time fault denies every read, loose included', () => {
        const TIER_A_ROWS: ReadonlyArray<{
          readonly label: string;
          readonly check: string;
          readonly mutate: (bytes: Buffer) => Buffer;
        }> = [
          {
            label: 'row G1 — signature byte flipped',
            check: 'signature',
            mutate: (bytes) => {
              bytes[3] = (bytes[3] ?? 0) ^ 0x01;
              return bytes;
            },
          },
          {
            label: 'row G2 — version 3',
            check: 'version',
            mutate: (bytes) => {
              bytes.writeUInt8(3, 4);
              return bytes;
            },
          },
          {
            label: 'row G3 — version 0',
            check: 'version',
            mutate: (bytes) => {
              bytes.writeUInt8(0, 4);
              return bytes;
            },
          },
          {
            label: 'row G9 — numPacks overstated (99)',
            check: 'pack-names',
            mutate: (bytes) => {
              bytes.writeUInt32BE(99, 8);
              return bytes;
            },
          },
          {
            label: 'row G11 — PNAM chunk id clobbered',
            check: 'required-chunk',
            mutate: (bytes) => {
              bytes.write('XXXX', chunkTableRowOffset(bytes, 'PNAM'), 'ascii');
              return bytes;
            },
          },
          {
            label: 'row G12 — OIDF chunk id clobbered',
            check: 'required-chunk',
            mutate: (bytes) => {
              bytes.write('XXXX', chunkTableRowOffset(bytes, 'OIDF'), 'ascii');
              return bytes;
            },
          },
          {
            label: 'row G13 — OIDF fanout non-monotonic',
            check: 'fanout',
            mutate: (bytes) => {
              const parsed = parseMultiPackIndex(bytes, DIGEST_LENGTH);
              bytes.writeUInt32BE(0xffff, parsed.oidFanoutOffset);
              return bytes;
            },
          },
        ];

        describe('Given one of these scan-time structural faults on the flat midx, When both tools attempt every read', () => {
          it.each(TIER_A_ROWS)(
            'Then git dies at exit 128 and tsgit rejects every read, loose included, with the $check check ($label)',
            async ({ mutate, check }) => {
              // Arrange
              const dir = await newRoot(`g-tier-a-${check}`);
              const fixture = await buildBaseFixture(dir, 'repo');
              mutateMidxOrThrow(midxPaths(fixture.dir).flat, mutate);

              // Act + Assert
              await expectTierARow({
                dir: fixture.dir,
                packedOids: fixture.packedOids,
                looseOid: fixture.looseOid,
                gitExitCode: 128,
                check,
              });
            },
          );
        });

        describe('Given numPacks understated (1, real count 3), When both tools look up an object in the now-out-of-range packs (row G10)', () => {
          it('Then the in-range object still reads on both, the others die per-lookup, and the loose object is unaffected — the fault is caught only at entry resolution, not at scan time', async () => {
            // Arrange — find each marker oid's REAL packIndex before mutating,
            // since PNAM's order (git's own tie-break) need not match build order
            const dir = await newRoot('g10');
            const fixture = await buildBaseFixture(dir, 'repo');
            const originalFlatBytes = readFileSync(midxPaths(fixture.dir).flat);
            const originalParsed = parseMultiPackIndex(originalFlatBytes, DIGEST_LENGTH);
            const packIndexOf = (oid: string): number => {
              const entry = lookupMultiPackIndex(originalParsed, oid as never);
              if (entry === undefined) throw new Error(`g10: ${oid} not present in the midx`);
              return entry.packIndex;
            };
            const inRangeOid = fixture.packedOids.find((oid) => packIndexOf(oid) === 0);
            const outOfRangeOids = fixture.packedOids.filter((oid) => packIndexOf(oid) !== 0);
            if (inRangeOid === undefined || outOfRangeOids.length === 0) {
              throw new Error('g10: fixture did not spread packIndex 0/1/2 across the marker oids');
            }
            mutateMidxOrThrow(midxPaths(fixture.dir).flat, (bytes) => {
              bytes.writeUInt32BE(1, 8);
              return bytes;
            });
            const sut = trackedNodeContext(fixture.dir);

            // Act + Assert — the object bound to pack 0 is unaffected
            expect(gitExit(fixture.dir, 'cat-file', '-p', inRangeOid)).toBe(0);
            await expectBothRead(fixture.dir, sut, inRangeOid);

            // Act + Assert — objects whose entry now references an out-of-range
            // pack die, per lookup, on both tools
            for (const oid of outOfRangeOids) {
              expect(gitExit(fixture.dir, 'cat-file', '-p', oid)).toBe(128);
              await expectMidxRefusal(sut, oid, 'pack-int-id');
            }

            // Act + Assert — the loose object never touches entry resolution
            await expectBothRead(fixture.dir, sut, fixture.looseOid);
          });
        });
      });

      describe('Tier B — a fault the parser cannot recover from discards the midx and falls back to the .idx scan', () => {
        const TIER_B_ROWS: ReadonlyArray<{
          readonly label: string;
          readonly mutate: (bytes: Buffer) => Buffer;
        }> = [
          {
            label: 'row G5 — hashVersion set to 2 in a SHA-1 repo',
            mutate: (bytes) => {
              bytes.writeUInt8(2, 5);
              return bytes;
            },
          },
          {
            label: 'row G6 — truncated to 8 bytes',
            mutate: (bytes) => bytes.subarray(0, 8),
          },
          {
            label: 'row G14 — numChunks byte set to 0',
            mutate: (bytes) => {
              bytes.writeUInt8(0, 6);
              return bytes;
            },
          },
          {
            label: 'row G15 — zero-length file',
            mutate: () => Buffer.alloc(0),
          },
        ];

        describe('Given one of these unrecoverable midx faults, When both tools read every object', () => {
          it.each(TIER_B_ROWS)(
            'Then the midx is discarded and every read still succeeds from the ordinary .idx scan ($label)',
            async ({ mutate }) => {
              // Arrange
              const dir = await newRoot('g-tier-b');
              const fixture = await buildBaseFixture(dir, 'repo');
              mutateMidxOrThrow(midxPaths(fixture.dir).flat, mutate);
              const sut = trackedNodeContext(fixture.dir);

              // Act + Assert
              for (const oid of [...fixture.packedOids, fixture.looseOid]) {
                expect(gitExit(fixture.dir, 'cat-file', '-p', oid)).toBe(0);
                await expectBothRead(fixture.dir, sut, oid);
              }
            },
          );
        });

        describe('Given the flat midx truncated mid-OIDL, so its chunk table now claims offsets past end of file, When both tools read every object (row G7)', () => {
          it('Then git reports an improper chunk offset and every read still succeeds from the ordinary .idx scan', async () => {
            // Arrange
            const dir = await newRoot('g7');
            const fixture = await buildBaseFixture(dir, 'repo');
            const flatPath = midxPaths(fixture.dir).flat;
            const originalParsed = parseMultiPackIndex(readFileSync(flatPath), DIGEST_LENGTH);
            mutateMidxOrThrow(flatPath, (bytes) =>
              bytes.subarray(0, originalParsed.oidLookupOffset + 5),
            );
            const sut = trackedNodeContext(fixture.dir);

            // Act + Assert
            for (const oid of [...fixture.packedOids, fixture.looseOid]) {
              expect(gitExit(fixture.dir, 'cat-file', '-p', oid)).toBe(0);
              await expectBothRead(fixture.dir, sut, oid);
            }
          });
        });

        describe('Given the flat midx made unreadable via chmod 000, When both tools read every object (row G16, node tier only)', () => {
          it('Then reads still succeed on both, silently, from the ordinary .idx scan', async () => {
            // Arrange
            const dir = await newRoot('g16');
            const fixture = await buildBaseFixture(dir, 'repo');
            chmodSync(midxPaths(fixture.dir).flat, 0o000);
            const sut = trackedNodeContext(fixture.dir);

            // Act + Assert
            for (const oid of [...fixture.packedOids, fixture.looseOid]) {
              expect(gitExit(fixture.dir, 'cat-file', '-p', oid)).toBe(0);
              await expectBothRead(fixture.dir, sut, oid);
            }
          });
        });
      });

      describe('Given a midx written with -c midx.version=2, When both tools read every object (row G4)', () => {
        it('Then both accept it: every object reads on both', async () => {
          // Arrange
          const dir = await newRoot('g4');
          const fixture = await buildBaseFixture(dir, 'repo');
          git(fixture.dir, '-c', 'midx.version=2', 'multi-pack-index', 'write');
          const sut = trackedNodeContext(fixture.dir);

          // Act + Assert
          for (const oid of fixture.packedOids) {
            expect(gitExit(fixture.dir, 'cat-file', '-p', oid)).toBe(0);
            await expectBothRead(fixture.dir, sut, oid);
          }
        });
      });

      describe('Given the trailer digest flipped, When both tools read every object (row G8)', () => {
        it('Then reads stay silent on both — the midx is still used, not skipped — because the trailer is never verified on the read path', async () => {
          // Arrange
          const dir = await newRoot('g8');
          const dup = await buildDupFixture(dir, 'repo');
          const flatPath = midxPaths(dup.dir).flat;
          // Flips the trailer directly — NEVER through `mutateMidxOrThrow`,
          // which would immediately re-stamp a correct digest right back over
          // this exact mutation.
          const before = readFileSync(flatPath);
          const flipped = Buffer.from(before);
          const trailerStart = flipped.length - DIGEST_LENGTH;
          flipped[trailerStart] = (flipped[trailerStart] ?? 0) ^ 0x01;
          chmodSync(flatPath, 0o644);
          writeFileSync(flatPath, flipped);
          const sut = trackedNodeContext(dup.dir);

          // Act
          const gitResult = batchCheck(dup.dir, dup.dupOid);
          const registry = getPackRegistry(sut);
          const hit = await registry.lookup(dup.dupOid as never);

          // Assert — git still reads it (silent) and the midx is still the
          // authority: the deleted-pack-A proof (Pin H2) still applies on this
          // same, now-checksum-wrong file, which only `fsck`/`verify` catch.
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stdout).toContain(`${dup.dupOid} blob`);
          expect(hit?.pack.name).toBe(dup.assignedPack);
        });
      });

      describe('Given the same signature-flipped midx, but core.multiPackIndex=false, When both tools read every object (row G17)', () => {
        it("Then git's config escape hatch suppresses the midx entirely (every read succeeds) — tsgit has no such config and still refuses (documented divergence, out of scope)", async () => {
          // Arrange
          const dir = await newRoot('g17');
          const fixture = await buildBaseFixture(dir, 'repo');
          mutateMidxOrThrow(midxPaths(fixture.dir).flat, (bytes) => {
            bytes[3] = (bytes[3] ?? 0) ^ 0x01;
            return bytes;
          });
          git(fixture.dir, 'config', 'core.multiPackIndex', 'false');
          const sut = trackedNodeContext(fixture.dir);

          // Act + Assert — git: the config hatch suppresses the midx entirely
          for (const oid of fixture.packedOids) {
            expect(gitExit(fixture.dir, 'cat-file', '-p', oid)).toBe(0);
          }

          // Act + Assert — tsgit: no such config exists, so the same on-disk
          // fault still denies every read, including loose
          await expectMidxRefusal(sut, fixture.packedOids[0], 'signature');
          await expectMidxRefusal(sut, fixture.looseOid, 'signature');
        });
      });
    });

    describe('Pin H — the midx is authoritative for the packs it names', () => {
      /** Overwrites `packBaseName`'s own PNAM slot with same-length garbage no
       *  on-disk file matches — H7's exact shape. */
      function corruptPnamEntryFor(bytes: Buffer, packBaseName: string): Buffer {
        const numChunks = bytes.readUInt8(6);
        const pnamStart = 12 + (numChunks + 1) * 12;
        const parsed = parseMultiPackIndex(bytes, DIGEST_LENGTH);
        let cursor = pnamStart;
        for (const name of parsed.packNames) {
          if (name.slice(0, -'.idx'.length) === packBaseName) {
            bytes.write('z'.repeat(name.length), cursor, 'ascii');
            return bytes;
          }
          cursor += name.length + 1;
        }
        throw new Error(`corruptPnamEntryFor: pack ${packBaseName} not found in PNAM`);
      }

      describe('Given a healthy DUP repo (control), When both tools look up the duplicated blob (row H1)', () => {
        it('Then both read it', async () => {
          // Arrange
          const dir = await newRoot('h1');
          const dup = await buildDupFixture(dir, 'repo');
          const sut = trackedNodeContext(dup.dir);

          // Act
          const gitResult = batchCheck(dup.dir, dup.dupOid);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stdout).toContain(`${dup.dupOid} blob`);
          await expectBothRead(dup.dir, sut, dup.dupOid);
        });
      });

      describe('Given the assigned pack fully deleted (.pack + .idx + .rev), When both tools look up the duplicated blob (row H2)', () => {
        it('Then both report it missing — the sibling pack is never consulted', async () => {
          // Arrange
          const dir = await newRoot('h2');
          const dup = await buildDupFixture(dir, 'repo');
          await rm(packFile(dup.dir, dup.assignedPack, 'pack'), { force: true });
          await rm(packFile(dup.dir, dup.assignedPack, 'idx'), { force: true });
          await rm(packFile(dup.dir, dup.assignedPack, 'rev'), { force: true });
          const sut = trackedNodeContext(dup.dir);

          // Act
          const gitResult = batchCheck(dup.dir, dup.dupOid);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stdout).toContain(`${dup.dupOid} missing`);
          await expectObjectMissing(sut, dup.dupOid);
        });
      });

      describe("Given the assigned pack's .pack deleted but its .idx kept, When both tools look up the duplicated blob (row H3)", () => {
        it('Then both report it missing', async () => {
          // Arrange
          const dir = await newRoot('h3');
          const dup = await buildDupFixture(dir, 'repo');
          await rm(packFile(dup.dir, dup.assignedPack, 'pack'), { force: true });
          const sut = trackedNodeContext(dup.dir);

          // Act
          const gitResult = batchCheck(dup.dir, dup.dupOid);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stdout).toContain(`${dup.dupOid} missing`);
          await expectObjectMissing(sut, dup.dupOid);
        });
      });

      describe("Given the assigned pack's .pack made unreadable via chmod 000, When both tools look up the duplicated blob (row H4, node tier only)", () => {
        it('Then both report it missing', async () => {
          // Arrange
          const dir = await newRoot('h4');
          const dup = await buildDupFixture(dir, 'repo');
          chmodSync(packFile(dup.dir, dup.assignedPack, 'pack'), 0o000);
          const sut = trackedNodeContext(dup.dir);

          // Act
          const gitResult = batchCheck(dup.dir, dup.dupOid);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stdout).toContain(`${dup.dupOid} missing`);
          await expectObjectMissing(sut, dup.dupOid);
        });
      });

      describe('Given the assigned pack deleted, When git reads with core.multiPackIndex=false but tsgit reads with no such config (row H5)', () => {
        it("Then git's config hatch falls back to the sibling pack and reads it, while tsgit — with no config to disable authority — still reports it missing (documented divergence, out of scope)", async () => {
          // Arrange
          const dir = await newRoot('h5');
          const dup = await buildDupFixture(dir, 'repo');
          await rm(packFile(dup.dir, dup.assignedPack, 'pack'), { force: true });
          await rm(packFile(dup.dir, dup.assignedPack, 'idx'), { force: true });
          git(dup.dir, 'config', 'core.multiPackIndex', 'false');
          const sut = trackedNodeContext(dup.dir);

          // Act
          const gitResult = batchCheck(dup.dir, dup.dupOid);

          // Assert — git: the config hatch restores the sibling pack's answer
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stdout).toContain(`${dup.dupOid} blob`);

          // Assert — tsgit: no config exists; the midx's authority still hides it
          await expectObjectMissing(sut, dup.dupOid);
        });
      });

      describe('Given the assigned pack deleted AND the midx file itself removed, When both tools look up the duplicated blob (row H6)', () => {
        it('Then both fall back to the sibling pack and read it', async () => {
          // Arrange
          const dir = await newRoot('h6');
          const dup = await buildDupFixture(dir, 'repo');
          await rm(packFile(dup.dir, dup.assignedPack, 'pack'), { force: true });
          await rm(packFile(dup.dir, dup.assignedPack, 'idx'), { force: true });
          await rm(midxPaths(dup.dir).flat, { force: true });
          const sut = trackedNodeContext(dup.dir);

          // Act
          const gitResult = batchCheck(dup.dir, dup.dupOid);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stdout).toContain(`${dup.dupOid} blob`);
          await expectBothRead(dup.dir, sut, dup.dupOid);
        });
      });

      describe("Given the assigned pack's own PNAM entry mutated to a same-length name no file has (its real pack files left intact), When both tools look up the duplicated blob (row H7)", () => {
        it('Then both fall back to the ordinary .idx scan and read it, from the now-unclaimed real pack', async () => {
          // Arrange
          const dir = await newRoot('h7');
          const dup = await buildDupFixture(dir, 'repo');
          mutateMidxOrThrow(midxPaths(dup.dir).flat, (bytes) => {
            // Version bumped to 2 so an incidental v1 lexicographic-order trip
            // (garbage replacing a real name can sort anywhere) never masks
            // the row's own point — pack-name resolution, not pack-name order.
            const corrupted = corruptPnamEntryFor(bytes, dup.assignedPack);
            corrupted.writeUInt8(2, 4);
            return corrupted;
          });
          const sut = trackedNodeContext(dup.dir);

          // Act
          const gitResult = batchCheck(dup.dir, dup.dupOid);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stdout).toContain(`${dup.dupOid} blob`);
          await expectBothRead(dup.dir, sut, dup.dupOid);
        });
      });

      describe('Given a new pack written into the pack directory AFTER the midx, When both tools look up an object only that pack holds (row H8)', () => {
        it("Then both find it normally — the midx never subtracts a pack it doesn't name", async () => {
          // Arrange — a third, `.keep`-guarded repack lands the late commit in
          // its own pack, leaving the two DUP packs and the midx untouched.
          const dir = await newRoot('h8');
          const dup = await buildDupFixture(dir, 'repo');
          await writeFile(path.join(dup.dir, 'late.txt'), 'a pack added after the midx\n');
          git(dup.dir, 'add', '-A');
          git(dup.dir, 'commit', '-m', 'late addition');
          const lateOid = git(dup.dir, 'rev-parse', 'HEAD:late.txt').trim();
          const packDir = path.join(dup.dir, '.git', 'objects', 'pack');
          for (const entry of await readdir(packDir)) {
            if (!entry.endsWith('.pack')) continue;
            await writeFile(path.join(packDir, `${entry.slice(0, -'.pack'.length)}.keep`), '');
          }
          git(dup.dir, 'repack', '-dq');
          const sut = trackedNodeContext(dup.dir);

          // Act
          const gitResult = batchCheck(dup.dir, lateOid);
          const gitCount = git(dup.dir, 'count-objects', '-v');

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stdout).toContain(`${lateOid} blob`);
          expect(gitCount).toContain('packs: 3');
          await expectBothRead(dup.dir, sut, lateOid);
        });
      });
    });

    describe('Pin I — chain degradation', () => {
      /** Every CHAIN object worth reading: the duplicated blob, the third
       *  pack's own commit tree entry (via its file), and the loose blob. */
      async function chainReadTargets(fixture: ChainFixture): Promise<ReadonlyArray<string>> {
        const thirdOid = git(fixture.dir, 'rev-parse', 'HEAD:third.txt').trim();
        return [fixture.dupOid, thirdOid, fixture.looseOid];
      }

      describe('Given a healthy two-layer chain (control), When both tools read every object (row I1)', () => {
        it('Then all succeed', async () => {
          // Arrange
          const dir = await newRoot('i1');
          const fixture = await buildChainFixture(dir, 'repo');
          const targets = await chainReadTargets(fixture);
          const sut = trackedNodeContext(fixture.dir);

          // Act + Assert
          for (const oid of targets) {
            expect(gitExit(fixture.dir, 'cat-file', '-p', oid)).toBe(0);
            await expectBothRead(fixture.dir, sut, oid);
          }
        });
      });

      describe("Given layer 2's .midx file deleted, When both tools read every object (row I2)", () => {
        it('Then git warns and the chain is dropped entirely — every object still reads from the ordinary .idx scan on both tools', async () => {
          // Arrange
          const dir = await newRoot('i2');
          const fixture = await buildChainFixture(dir, 'repo');
          const targets = await chainReadTargets(fixture);
          await rm(chainLayerPath(fixture.dir, fixture.layerDigests[1]), { force: true });
          const sut = trackedNodeContext(fixture.dir);

          // Act
          const gitResult = batchCheck(fixture.dir, fixture.dupOid);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stderr).toContain('unable to find all multi-pack index files');
          for (const oid of targets) await expectBothRead(fixture.dir, sut, oid);
        });
      });

      describe('Given a chain layer with a bad signature, When both tools read every object (row I3)', () => {
        it('Then git dies at exit 128 and tsgit rejects every read — loose included — with the signature check', async () => {
          // Arrange
          const dir = await newRoot('i3');
          const fixture = await buildChainFixture(dir, 'repo');
          const thirdOid = git(fixture.dir, 'rev-parse', 'HEAD:third.txt').trim();
          mutateMidxOrThrow(chainLayerPath(fixture.dir, fixture.layerDigests[0]), (bytes) => {
            bytes[3] = (bytes[3] ?? 0) ^ 0x01;
            return bytes;
          });

          // Act + Assert
          await expectTierARow({
            dir: fixture.dir,
            packedOids: [fixture.dupOid, thirdOid],
            looseOid: fixture.looseOid,
            gitExitCode: 128,
            check: 'signature',
          });
        });
      });

      describe('Given a chain layer truncated to 8 bytes, When both tools read every object (row I4)', () => {
        it('Then git warns (too small, then unable to find all files) and the chain is dropped — every object still reads', async () => {
          // Arrange
          const dir = await newRoot('i4');
          const fixture = await buildChainFixture(dir, 'repo');
          const targets = await chainReadTargets(fixture);
          mutateMidxOrThrow(chainLayerPath(fixture.dir, fixture.layerDigests[0]), (bytes) =>
            bytes.subarray(0, 8),
          );
          const sut = trackedNodeContext(fixture.dir);

          // Act
          const gitResult = batchCheck(fixture.dir, fixture.dupOid);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stderr).toContain('is too small');
          for (const oid of targets) await expectBothRead(fixture.dir, sut, oid);
        });
      });

      describe('Given the chain manifest file deleted (layers remain), When both tools read every object (row I5)', () => {
        it('Then all succeed, silently, from the ordinary .idx scan', async () => {
          // Arrange
          const dir = await newRoot('i5');
          const fixture = await buildChainFixture(dir, 'repo');
          const targets = await chainReadTargets(fixture);
          await rm(midxPaths(fixture.dir).chainFile, { force: true });
          const sut = trackedNodeContext(fixture.dir);

          // Act + Assert
          for (const oid of targets) {
            expect(gitExit(fixture.dir, 'cat-file', '-p', oid)).toBe(0);
            await expectBothRead(fixture.dir, sut, oid);
          }
        });
      });

      describe('Given the chain manifest file emptied, When both tools read every object (row I6)', () => {
        it('Then all succeed, silently, from the ordinary .idx scan', async () => {
          // Arrange
          const dir = await newRoot('i6');
          const fixture = await buildChainFixture(dir, 'repo');
          const targets = await chainReadTargets(fixture);
          chmodSync(midxPaths(fixture.dir).chainFile, 0o644);
          writeFileSync(midxPaths(fixture.dir).chainFile, '');
          const sut = trackedNodeContext(fixture.dir);

          // Act + Assert
          for (const oid of targets) {
            expect(gitExit(fixture.dir, 'cat-file', '-p', oid)).toBe(0);
            await expectBothRead(fixture.dir, sut, oid);
          }
        });
      });

      describe('Given the chain manifest truncated to list only layer 1, When both tools read every object (row I7)', () => {
        it("Then all succeed — layer 1's own objects via the chain, layer 2's pack via the ordinary scan (the chain does not name it)", async () => {
          // Arrange
          const dir = await newRoot('i7');
          const fixture = await buildChainFixture(dir, 'repo');
          const targets = await chainReadTargets(fixture);
          chmodSync(midxPaths(fixture.dir).chainFile, 0o644);
          writeFileSync(midxPaths(fixture.dir).chainFile, `${fixture.layerDigests[0]}\n`);
          const sut = trackedNodeContext(fixture.dir);

          // Act + Assert
          for (const oid of targets) {
            expect(gitExit(fixture.dir, 'cat-file', '-p', oid)).toBe(0);
            await expectBothRead(fixture.dir, sut, oid);
          }
        });
      });

      describe('Given a bogus 40-hex digest appended to the chain manifest, When both tools read every object (row I8)', () => {
        it('Then git warns and the chain is dropped entirely — every object still reads', async () => {
          // Arrange
          const dir = await newRoot('i8');
          const fixture = await buildChainFixture(dir, 'repo');
          const targets = await chainReadTargets(fixture);
          chmodSync(midxPaths(fixture.dir).chainFile, 0o644);
          writeFileSync(
            midxPaths(fixture.dir).chainFile,
            `${fixture.layerDigests[0]}\n${fixture.layerDigests[1]}\n${'a'.repeat(40)}\n`,
          );
          const sut = trackedNodeContext(fixture.dir);

          // Act
          const gitResult = batchCheck(fixture.dir, fixture.dupOid);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stderr).toContain('unable to find all multi-pack index files');
          for (const oid of targets) await expectBothRead(fixture.dir, sut, oid);
        });
      });

      describe('Given the chain manifest reordered (layer 2 listed before layer 1), When both tools read every object (row I9)', () => {
        it('Then all succeed — the two layers cover disjoint packs, so order never changes an answer', async () => {
          // Arrange
          const dir = await newRoot('i9');
          const fixture = await buildChainFixture(dir, 'repo');
          const targets = await chainReadTargets(fixture);
          chmodSync(midxPaths(fixture.dir).chainFile, 0o644);
          writeFileSync(
            midxPaths(fixture.dir).chainFile,
            `${fixture.layerDigests[1]}\n${fixture.layerDigests[0]}\n`,
          );
          const sut = trackedNodeContext(fixture.dir);

          // Act + Assert
          for (const oid of targets) {
            expect(gitExit(fixture.dir, 'cat-file', '-p', oid)).toBe(0);
            await expectBothRead(fixture.dir, sut, oid);
          }
        });
      });

      describe('Given a non-hex line appended to the chain manifest, When both tools read every object (row I10)', () => {
        it('Then the garbage line is silently ignored on both — the real layers before it still load', async () => {
          // Arrange
          const dir = await newRoot('i10');
          const fixture = await buildChainFixture(dir, 'repo');
          const targets = await chainReadTargets(fixture);
          chmodSync(midxPaths(fixture.dir).chainFile, 0o644);
          writeFileSync(
            midxPaths(fixture.dir).chainFile,
            `${fixture.layerDigests[0]}\n${fixture.layerDigests[1]}\ngarbage\n`,
          );
          const sut = trackedNodeContext(fixture.dir);

          // Act + Assert
          for (const oid of targets) {
            expect(gitExit(fixture.dir, 'cat-file', '-p', oid)).toBe(0);
            await expectBothRead(fixture.dir, sut, oid);
          }
        });
      });
    });

    describe('Pin J — flat vs chain precedence', () => {
      interface ChainSnapshot {
        readonly chainText: string;
        readonly layers: ReadonlyArray<{ readonly digest: string; readonly bytes: Buffer }>;
      }

      function snapshotChain(fixture: ChainFixture): ChainSnapshot {
        return {
          chainText: readFileSync(midxPaths(fixture.dir).chainFile, 'utf8'),
          layers: fixture.layerDigests.map((digest) => ({
            digest,
            bytes: readFileSync(chainLayerPath(fixture.dir, digest)),
          })),
        };
      }

      function restoreChain(dir: string, snapshot: ChainSnapshot): void {
        const { chainDir, chainFile } = midxPaths(dir);
        mkdirSync(chainDir, { recursive: true });
        writeFileSync(chainFile, snapshot.chainText);
        for (const layer of snapshot.layers) {
          writeFileSync(chainLayerPath(dir, layer.digest), layer.bytes);
        }
      }

      /**
       * The only way real git ever writes a flat file once a chain already
       * exists: a plain (non-incremental) `write` over an UNCHANGED chain is a
       * no-op, so a genuinely new, `.keep`-protected pack is added first to
       * give it something to do. The write empties `multi-pack-index.d/` as a
       * side effect (Pin A) — restored by the caller from a snapshot taken
       * before this runs, which is the only way to reproduce "flat + a chain
       * still sitting there" at all, since git itself never produces that
       * combination in one step.
       */
      function forceFlatWriteOverChain(dir: string): void {
        const packDir = path.join(dir, '.git', 'objects', 'pack');
        writeFileSync(path.join(dir, 'force-flat.txt'), 'forces a genuinely new, uncovered pack\n');
        git(dir, 'add', '-A');
        git(dir, 'commit', '-m', 'force flat write');
        for (const entry of readdirSync(packDir)) {
          if (!entry.endsWith('.pack')) continue;
          writeFileSync(path.join(packDir, `${entry.slice(0, -'.pack'.length)}.keep`), '');
        }
        git(dir, 'repack', '-dq');
        writeMultiPackIndex(dir);
      }

      describe("Given a broken chain (a layer's .midx file deleted) and NO flat midx, When both tools read every object (row J1, control)", () => {
        it('Then git warns and every object still reads', async () => {
          // Arrange
          const dir = await newRoot('j1');
          const fixture = await buildChainFixture(dir, 'repo');
          const thirdOid = git(fixture.dir, 'rev-parse', 'HEAD:third.txt').trim();
          await rm(chainLayerPath(fixture.dir, fixture.layerDigests[1]), { force: true });
          const sut = trackedNodeContext(fixture.dir);

          // Act
          const gitResult = batchCheck(fixture.dir, fixture.dupOid);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stderr).toContain('unable to find all multi-pack index files');
          for (const oid of [fixture.dupOid, thirdOid, fixture.looseOid]) {
            await expectBothRead(fixture.dir, sut, oid);
          }
        });
      });

      describe('Given the SAME broken chain, but with a valid flat midx also present, When both tools read every object (row J2)', () => {
        it('Then git prints no warning — the flat file suppresses the chain entirely — and every object still reads', async () => {
          // Arrange
          const dir = await newRoot('j2');
          const fixture = await buildChainFixture(dir, 'repo');
          const thirdOid = git(fixture.dir, 'rev-parse', 'HEAD:third.txt').trim();
          const snapshot = snapshotChain(fixture);
          forceFlatWriteOverChain(fixture.dir);
          restoreChain(fixture.dir, snapshot);
          await rm(chainLayerPath(fixture.dir, fixture.layerDigests[1]), { force: true });
          const sut = trackedNodeContext(fixture.dir);

          // Act
          const gitResult = batchCheck(fixture.dir, fixture.dupOid);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stderr).not.toContain('unable to find all multi-pack index files');
          for (const oid of [fixture.dupOid, thirdOid, fixture.looseOid]) {
            await expectBothRead(fixture.dir, sut, oid);
          }
        });
      });

      describe('Given a chain with a bogus digest line, plus a valid flat midx, When both tools read every object (row J3)', () => {
        it('Then git prints no warning and every object still reads', async () => {
          // Arrange
          const dir = await newRoot('j3');
          const fixture = await buildChainFixture(dir, 'repo');
          const thirdOid = git(fixture.dir, 'rev-parse', 'HEAD:third.txt').trim();
          const snapshot = snapshotChain(fixture);
          forceFlatWriteOverChain(fixture.dir);
          restoreChain(fixture.dir, snapshot);
          writeFileSync(
            midxPaths(fixture.dir).chainFile,
            `${fixture.layerDigests[0]}\n${fixture.layerDigests[1]}\n${'b'.repeat(40)}\n`,
          );
          const sut = trackedNodeContext(fixture.dir);

          // Act
          const gitResult = batchCheck(fixture.dir, fixture.dupOid);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stderr).not.toContain('unable to find all multi-pack index files');
          for (const oid of [fixture.dupOid, thirdOid, fixture.looseOid]) {
            await expectBothRead(fixture.dir, sut, oid);
          }
        });
      });

      describe('Given a chain layer with a bad signature (Tier A on its own), plus a valid flat midx, When both tools read every object (row J4)', () => {
        it('Then both accept it at exit 0 — the flat file suppresses the chain entirely, so the Tier-A layer is never even read', async () => {
          // Arrange
          const dir = await newRoot('j4');
          const fixture = await buildChainFixture(dir, 'repo');
          const thirdOid = git(fixture.dir, 'rev-parse', 'HEAD:third.txt').trim();
          const snapshot = snapshotChain(fixture);
          forceFlatWriteOverChain(fixture.dir);
          restoreChain(fixture.dir, snapshot);
          mutateMidxOrThrow(chainLayerPath(fixture.dir, fixture.layerDigests[0]), (bytes) => {
            bytes[3] = (bytes[3] ?? 0) ^ 0x01;
            return bytes;
          });
          const sut = trackedNodeContext(fixture.dir);

          // Act + Assert
          for (const oid of [fixture.dupOid, thirdOid, fixture.looseOid]) {
            expect(gitExit(fixture.dir, 'cat-file', '-p', oid)).toBe(0);
            await expectBothRead(fixture.dir, sut, oid);
          }
        });
      });

      describe('Given an unparseable (Tier-B, too-small) flat midx alongside an intact chain whose layer-1 pack was deleted, When both tools look up the duplicated blob (row J5)', () => {
        it('Then git errors on the flat file, then reports the object missing — the chain IS read and its own authority applies', async () => {
          // Arrange
          const dir = await newRoot('j5');
          const fixture = await buildChainFixture(dir, 'repo');
          const snapshot = snapshotChain(fixture);
          forceFlatWriteOverChain(fixture.dir);
          restoreChain(fixture.dir, snapshot);
          mutateMidxOrThrow(midxPaths(fixture.dir).flat, (bytes) => bytes.subarray(0, 8));
          await rm(packFile(fixture.dir, fixture.assignedPack, 'pack'), { force: true });
          await rm(packFile(fixture.dir, fixture.assignedPack, 'idx'), { force: true });
          const sut = trackedNodeContext(fixture.dir);

          // Act
          const gitResult = batchCheck(fixture.dir, fixture.dupOid);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stderr).toContain('is too small');
          expect(gitResult.stdout).toContain(`${fixture.dupOid} missing`);
          await expectObjectMissing(sut, fixture.dupOid);
        });
      });

      describe('Given a flat midx with a bad signature (Tier A) alongside an intact chain, When both tools read every object (row J6)', () => {
        it('Then git dies at exit 128 and tsgit rejects every read — loose included — with the signature check; nothing else is even consulted', async () => {
          // Arrange
          const dir = await newRoot('j6');
          const fixture = await buildChainFixture(dir, 'repo');
          const thirdOid = git(fixture.dir, 'rev-parse', 'HEAD:third.txt').trim();
          const snapshot = snapshotChain(fixture);
          forceFlatWriteOverChain(fixture.dir);
          restoreChain(fixture.dir, snapshot);
          mutateMidxOrThrow(midxPaths(fixture.dir).flat, (bytes) => {
            bytes[3] = (bytes[3] ?? 0) ^ 0x01;
            return bytes;
          });

          // Act + Assert
          await expectTierARow({
            dir: fixture.dir,
            packedOids: [fixture.dupOid, thirdOid],
            looseOid: fixture.looseOid,
            gitExitCode: 128,
            check: 'signature',
          });
        });
      });
    });

    describe("Pin L — the rest of git's midx dependencies", () => {
      describe("Given a midx-named pack's .idx deleted but its .pack kept, When both tools look up the packed object (row L5)", () => {
        it('Then both report the object missing', async () => {
          // Arrange
          const dir = await newRoot('l5');
          const fixture = await buildBaseFixture(dir, 'repo');
          const flatBytes = readFileSync(midxPaths(fixture.dir).flat);
          const parsed = parseMultiPackIndex(flatBytes, DIGEST_LENGTH);
          const targetOid = fixture.packedOids[0];
          const targetEntry = lookupMultiPackIndex(parsed, targetOid as never);
          if (targetEntry === undefined)
            throw new Error(`l5: ${targetOid} not present in the midx`);
          const targetPackFullName = parsed.packNames[targetEntry.packIndex];
          if (targetPackFullName === undefined) {
            throw new Error(`l5: pack index ${targetEntry.packIndex} has no PNAM entry`);
          }
          const targetPackName = targetPackFullName.slice(0, -'.idx'.length);
          await rm(path.join(fixture.dir, '.git', 'objects', 'pack', `${targetPackName}.idx`), {
            force: true,
          });
          const sut = trackedNodeContext(fixture.dir);

          // Act
          const gitResult = batchCheck(fixture.dir, targetOid);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stdout).toContain(`${targetOid} missing`);
          await expectObjectMissing(sut, targetOid);
        });
      });
    });
  },
);
