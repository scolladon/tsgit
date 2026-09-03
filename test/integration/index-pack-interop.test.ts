/**
 * Cross-tool interop for the two-pass pack entry indexer in
 * `internal/index-pack.ts`: `walkPackEntries`'s (id, offset) set over a REAL
 * git-produced pack must agree with `git show-index`'s own listing, the same
 * pack must satisfy `git verify-pack` with zero complaints, and the
 * refusal/acceptance matrix crafted by hand must agree with `git index-pack
 * --strict` byte-for-byte where the design says it should, and diverge only
 * where it is recorded as a deliberate, ratified divergence.
 *
 * Fixture A: a single 2 000-line file churned over 300 commits (20 lines
 * rewritten + 1 appended each), built via one `git fast-import` stream
 * (deterministic xorshift32 content, fixed author/committer identity and
 * timestamps) rather than 300 `git commit` invocations, then
 * `git -c pack.threads=1 repack -a -d` — single-threaded so delta selection
 * (and so the resulting max chain depth) is deterministic. Measured: 903
 * objects (301 commit / 301 tree / 301 blob), max chain depth 50 —
 * saturating git's default `pack.depth`.
 *
 * @proves
 *   surface:        packIndex
 *   bucket:         cross-tool-interop
 *   unique:         walkPackEntries over a real git pack agrees with `git show-index` / `verify-pack`
 *   interopSurface: packfile
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { fetchPack, type NegotiatePackBytes } from '../../src/application/primitives/fetch-pack.js';
import {
  type ExternalBaseResolver,
  walkPackEntries,
} from '../../src/application/primitives/internal/index-pack.js';
import { TsgitError } from '../../src/domain/error.js';
import type { ObjectId } from '../../src/domain/objects/object-id.js';
import { buildSyntheticPack, type EntrySpec } from '../unit/application/primitives/pack-fixture.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const FIXTURE_A_SEED = 1234;
const FIXTURE_A_LINE_COUNT = 2000;
const FIXTURE_A_COMMITS = 300;
const FIXTURE_A_REWRITES_PER_COMMIT = 20;
const AUTHOR = 'Ada <ada@example.com>';
const BASE_TIMESTAMP = 1_700_000_000;

/** Deterministic xorshift32 — same shape as the unit corpus's own
 *  `pseudoRandomBytes`, but driving line content rather than raw bytes. */
const makeXorshift32 = (seed: number): (() => number) => {
  let state = seed >>> 0 || 1;
  return (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
};

const blobRecord = (mark: number, content: string): string =>
  `blob\nmark :${mark}\ndata ${Buffer.byteLength(content)}\n${content}\n`;

const commitRecord = (fileMark: number, timestamp: number, message: string): string =>
  `commit refs/heads/main\n${`author ${AUTHOR} ${timestamp} +0000\n`}${`committer ${AUTHOR} ${timestamp} +0000\n`}data ${Buffer.byteLength(message)}\n${message}M 100644 :${fileMark} churn.txt\n`;

/**
 * Fixture A's own fast-import stream: a seed commit writing `churn.txt` at
 * `FIXTURE_A_LINE_COUNT` deterministic lines, then `FIXTURE_A_COMMITS`
 * commits each rewriting `FIXTURE_A_REWRITES_PER_COMMIT` deterministically
 * chosen lines and appending one more. fast-import auto-chains successive
 * `commit refs/heads/main` records onto the ref's current tip, so no
 * explicit `from` is needed once the seed commit lands.
 */
const buildFixtureAStream = (): string => {
  const rng = makeXorshift32(FIXTURE_A_SEED);
  const lines: string[] = [];
  for (let i = 0; i < FIXTURE_A_LINE_COUNT; i += 1) {
    lines.push(`seed ${i} ${rng().toString(16)}`);
  }

  let mark = 0;
  const nextMark = (): number => {
    mark += 1;
    return mark;
  };

  const seedMark = nextMark();
  let stream = blobRecord(seedMark, `${lines.join('\n')}\n`);
  stream += commitRecord(seedMark, BASE_TIMESTAMP, 'seed churn.txt\n');

  for (let c = 0; c < FIXTURE_A_COMMITS; c += 1) {
    for (let r = 0; r < FIXTURE_A_REWRITES_PER_COMMIT; r += 1) {
      const idx = rng() % lines.length;
      lines[idx] = `rewrite c${c} r${r} ${rng().toString(16)}`;
    }
    lines.push(`append c${c} ${rng().toString(16)}`);
    const fileMark = nextMark();
    stream += blobRecord(fileMark, `${lines.join('\n')}\n`);
    stream += commitRecord(fileMark, BASE_TIMESTAMP + c + 1, `churn ${c}\n`);
  }
  return stream;
};

/**
 * Pipes `streamContent` into `git fast-import` from a real file descriptor
 * (never buffered through the child's `input` option) — the throwaway
 * stream file lives outside the fixture repository and is removed
 * regardless of outcome, matching `rev-bitmap-closure-fixtures.ts`'s own
 * recipe for the same shape of fixture.
 */
const runFastImport = async (dir: string, streamContent: string): Promise<void> => {
  const streamPath = path.join(
    os.tmpdir(),
    `tsgit-index-pack-fixture-${path.basename(dir)}-${process.pid}.fi`,
  );
  await writeFile(streamPath, streamContent);
  try {
    const fd = openSync(streamPath, 'r');
    try {
      const result = spawnSync('git', ['-C', dir, 'fast-import', '--quiet'], {
        env: runGitEnv(),
        stdio: [fd, 'ignore', 'inherit'],
      });
      if (result.status !== 0) {
        throw new Error(`git fast-import exited with status ${String(result.status)}`);
      }
    } finally {
      closeSync(fd);
    }
  } finally {
    await rm(streamPath, { force: true });
  }
};

interface ShowIndexEntry {
  readonly offset: number;
  readonly id: string;
}

const SHOW_INDEX_LINE = /^(\d+) ([0-9a-f]+) \([0-9a-f]+\)$/;

/** `git show-index`'s own line shape: `<offset> <oid> (<crc32>)`, one per
 *  object. The crc32 group is matched (to validate the line shape) but not
 *  captured into the result — this row only pins the (id, offset) set. */
const parseShowIndexOutput = (output: string): ShowIndexEntry[] =>
  output
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = SHOW_INDEX_LINE.exec(line);
      if (match === null) throw new Error(`show-index: unparsable line: ${line}`);
      return { offset: Number(match[1]), id: match[2] as string };
    });

/** Offsets are unique per entry, so sorting by offset gives a canonical
 *  order for comparing two (id, offset) sets built by different tools. */
const byOffsetAscending = <T extends { readonly offset: number }>(items: ReadonlyArray<T>): T[] =>
  [...items].sort((a, b) => a.offset - b.offset);

const ENCODER = new TextEncoder();

/** Computes a blob's loose object id independently of the indexer under
 *  test — needed to declare a REF_DELTA's base id before (or instead of)
 *  the base object itself exists in the crafted pack. */
const blobIdOf = async (
  ctx: ReturnType<typeof createMemoryContext>,
  content: Uint8Array,
): Promise<string> => {
  const header = ENCODER.encode(`blob ${content.length}\0`);
  const loose = new Uint8Array(header.length + content.length);
  loose.set(header, 0);
  loose.set(content, header.length);
  return ctx.hash.hashHex(loose);
};

/** A linear OFS chain: one base blob, then `depth` deltas each chained onto
 *  the immediately preceding entry — the same shape the unit corpus's own
 *  `buildOfsChain` builds, duplicated here (module-private there) rather
 *  than shared across a unit/integration boundary. */
const buildOfsChain = (depth: number): EntrySpec[] => {
  const base: EntrySpec = { kind: 'base', type: 'blob', content: new Uint8Array([0]) };
  const entries: EntrySpec[] = [base];
  let previous = base.content;
  for (let level = 0; level < depth; level += 1) {
    const target = new Uint8Array(previous.length + 1);
    target.set(previous, 0);
    target[previous.length] = level & 0xff;
    entries.push({ kind: 'ofs-delta', baseIndex: entries.length - 1, targetContent: target });
    previous = target;
  }
  return entries;
};

interface CraftedPackDir {
  readonly packPath: string;
  idxPath(): string;
  dispose(): Promise<void>;
}

/** Writes a crafted pack's bytes to a fresh temp directory as
 *  `crafted.pack`, for `git index-pack` to read directly (the file form,
 *  not `--stdin`, so an accepting run's sibling `.idx` lands beside it at a
 *  path the test can also read back). */
const withCraftedPack = async (packBytes: Uint8Array): Promise<CraftedPackDir> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-index-pack-crafted-'));
  const packPath = path.join(dir, 'crafted.pack');
  await writeFile(packPath, packBytes);
  return {
    packPath,
    idxPath: () => path.join(dir, 'crafted.idx'),
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
};

describe.skipIf(!GIT_AVAILABLE)('index-pack interop', () => {
  let pair: PeerPair;
  let packBytes: Uint8Array;
  let idxBytes: Uint8Array;
  let idxPath: string;

  beforeAll(async () => {
    pair = await makePeerPair('index-pack');
    runGit(['init', '-q', '-b', 'main', pair.peer]);
    runGit(['-C', pair.peer, 'config', 'user.name', 'Ada']);
    runGit(['-C', pair.peer, 'config', 'user.email', 'ada@example.com']);
    runGit(['-C', pair.peer, 'config', 'commit.gpgsign', 'false']);
    disableAutoMaintenance(pair.peer);

    await runFastImport(pair.peer, buildFixtureAStream());
    runGit(['-C', pair.peer, 'checkout', '-f', 'main']);
    runGit(['-C', pair.peer, '-c', 'pack.threads=1', 'repack', '-a', '-d']);

    const packDir = path.join(pair.peer, '.git', 'objects', 'pack');
    const packName = (await readdir(packDir)).find((name) => name.endsWith('.pack'));
    if (packName === undefined) {
      throw new Error('index-pack interop: no pack survived repack -a -d');
    }
    const stem = packName.slice(0, -'.pack'.length);
    idxPath = path.join(packDir, `${stem}.idx`);
    packBytes = await readFile(path.join(packDir, `${stem}.pack`));
    idxBytes = await readFile(idxPath);
  }, 60_000);

  afterAll(async () => {
    await pair.dispose();
  });

  describe('Given fixture A (a 300-commit text churn) repacked by canonical git', () => {
    describe('When walkPackEntries walks the pack bytes', () => {
      it('Then its (id, offset) set matches `git show-index`, and `git verify-pack` accepts the pack', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const walked = await walkPackEntries(ctx, packBytes);
        const showIndexOutput = runGit(['show-index'], { input: idxBytes });
        const verifyOut = runGit(['verify-pack', idxPath]);

        // Assert
        const walkedSet = byOffsetAscending(walked).map((e) => ({ offset: e.offset, id: e.id }));
        const showIndexSet = byOffsetAscending(parseShowIndexOutput(showIndexOutput));
        expect(walkedSet).toEqual(showIndexSet);
        expect(verifyOut).toBe('');
      });
    });
  });

  describe('Given fixture A indexed through fetchPack (the real receive path)', () => {
    describe('When its sibling .idx is handed to git', () => {
      it('Then git fsck --strict accepts the resulting repository with zero output, and verify-pack / show-index / cat-file all agree with the object count', async () => {
        // Arrange — drive the real `fetchPack` receive pipeline (quarantine,
        // the two-pass indexer, sibling artifact assembly) with a
        // negotiator that simply hands over fixture A's real bytes,
        // bypassing HTTP — the shape a `Content-Type` framer would.
        const ctx = createMemoryContext();
        const negotiator: NegotiatePackBytes = async (_ctx, _input) => ({
          packBody: (async function* singleChunk() {
            yield packBytes;
          })(),
          shallow: [],
          unshallow: [],
        });

        // Act
        const result = await fetchPack(ctx, negotiator, {
          wants: ['a'.repeat(40) as ObjectId],
          haves: [],
          capabilities: [],
          progressOp: 'test:write-objects',
        });
        expect(result.objectCount).toBeGreaterThan(0);

        const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-index-pack-oracle-'));
        try {
          runGit(['init', '-q', '-b', 'main', dir]);
          const packOutDir = path.join(dir, '.git', 'objects', 'pack');
          await writeFile(
            path.join(packOutDir, path.basename(result.packPath)),
            await ctx.fs.read(result.packPath),
          );
          const writtenIdxPath = path.join(packOutDir, path.basename(result.idxPath));
          await writeFile(writtenIdxPath, await ctx.fs.read(result.idxPath));
          // Point a real ref at fixture A's tip commit — otherwise every
          // object is reachable from nothing and `fsck` reports the tip as
          // a dangling commit on stdout, which is informational, not a
          // fault, but would make the "zero output" assertion meaningless.
          // The object must already be on disk (written above) before a ref
          // can name it.
          const fixtureATip = runGit(['-C', pair.peer, 'rev-parse', 'refs/heads/main']).trim();
          runGit(['-C', dir, 'update-ref', 'refs/heads/main', fixtureATip]);

          // Assert — every reader canonical git ships agrees with the
          // sibling artifacts the indexer's own slab produced.
          const verifyOut = runGit(['verify-pack', '-v', writtenIdxPath]);
          const verifyEntryLines = verifyOut
            .trim()
            .split('\n')
            .filter((line) => /^[0-9a-f]{40,64}\s/.test(line));
          expect(verifyEntryLines.length).toBe(result.objectCount);

          const showIndexOut = runGit(['show-index'], { input: await ctx.fs.read(result.idxPath) });
          expect(
            showIndexOut
              .trim()
              .split('\n')
              .filter((line) => line.length > 0).length,
          ).toBe(result.objectCount);

          const batchCheckOut = runGit([
            '-C',
            dir,
            'cat-file',
            '--batch-all-objects',
            '--batch-check',
          ]);
          expect(
            batchCheckOut
              .trim()
              .split('\n')
              .filter((line) => line.length > 0).length,
          ).toBe(result.objectCount);

          const fsckResult = tryRunGitWithExit(['-C', dir, 'fsck', '--strict']);
          expect(fsckResult.exitCode).toBe(0);
          expect(fsckResult.stdout).toBe('');
          expect(fsckResult.stderr).toBe('');
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }, 60_000);
    });
  });

  describe('Given the crafted OFS-distance-0 pack (self-referential OFS_DELTA)', () => {
    describe('When git index-pack --strict and tsgit walkPackEntries both run over the same bytes', () => {
      it("Then both refuse, and tsgit's reason is git's own out-of-bound tail, byte-identical", async () => {
        // Arrange
        const ctx = createMemoryContext();
        const built = await buildSyntheticPack(ctx, [
          { kind: 'base', type: 'blob', content: ENCODER.encode('ofs-distance-0 base') },
          {
            kind: 'ofs-delta',
            baseIndex: 0,
            targetContent: ENCODER.encode('ofs-distance-0 target'),
            distanceOverride: 0,
          },
        ]);
        const dir = await withCraftedPack(built.packBytes);
        try {
          // Act
          const gitResult = tryRunGitWithExit(['index-pack', '--strict', dir.packPath]);
          let caught: unknown;
          try {
            await walkPackEntries(ctx, built.packBytes);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(gitResult.exitCode).not.toBe(0);
          expect(gitResult.stderr).toContain('delta base offset is out of bound');
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { reason?: string; offset?: number };
          expect(data.reason).toBe('delta base offset is out of bound');
          // git names the offending entry in its own prefix — "pack has bad
          // object at offset N: <reason>". Both tools must name the SAME
          // entry, not merely refuse; tsgit ships N as a field and the caller
          // reconstructs the line.
          const gitOffset = /at offset (\d+):/.exec(gitResult.stderr)?.[1];
          expect(gitOffset).toBeDefined();
          expect(data.offset).toBe(Number(gitOffset));
        } finally {
          await dir.dispose();
        }
      });
    });
  });

  describe("Given the crafted REF_DELTA cycle pack (two deltas naming each other's target oid, no base entry)", () => {
    describe('When git index-pack --strict and tsgit walkPackEntries both run over the same bytes', () => {
      it('Then both refuse with "pack has 2 unresolved deltas", byte-identical', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const targetA = ENCODER.encode('interop ref-cycle target A');
        const targetB = ENCODER.encode('interop ref-cycle target B');
        const idOfA = await blobIdOf(ctx, targetA);
        const idOfB = await blobIdOf(ctx, targetB);
        const built = await buildSyntheticPack(ctx, [
          {
            kind: 'ref-delta',
            baseId: idOfB,
            baseUncompressed: new Uint8Array(0),
            targetContent: targetA,
          },
          {
            kind: 'ref-delta',
            baseId: idOfA,
            baseUncompressed: new Uint8Array(0),
            targetContent: targetB,
          },
        ]);
        const dir = await withCraftedPack(built.packBytes);
        try {
          // Act
          const gitResult = tryRunGitWithExit(['index-pack', '--strict', dir.packPath]);
          let caught: unknown;
          try {
            await walkPackEntries(ctx, built.packBytes);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(gitResult.exitCode).not.toBe(0);
          expect(gitResult.stderr).toContain('pack has 2 unresolved deltas');
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { reason?: string };
          expect(data.reason).toBe('pack has 2 unresolved deltas');
        } finally {
          await dir.dispose();
        }
      });
    });
  });

  describe('Given the crafted all-deltas pack with no base entry (two REF deltas, unrelated missing bases)', () => {
    describe('When git index-pack --strict and tsgit walkPackEntries both run over the same bytes', () => {
      it('Then both refuse with "pack has 2 unresolved deltas", byte-identical', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const unrelatedIdA = await blobIdOf(ctx, ENCODER.encode('nowhere near this pack A'));
        const unrelatedIdB = await blobIdOf(ctx, ENCODER.encode('nowhere near this pack B'));
        const built = await buildSyntheticPack(ctx, [
          {
            kind: 'ref-delta',
            baseId: unrelatedIdA,
            baseUncompressed: new Uint8Array(0),
            targetContent: ENCODER.encode('all-deltas target A'),
          },
          {
            kind: 'ref-delta',
            baseId: unrelatedIdB,
            baseUncompressed: new Uint8Array(0),
            targetContent: ENCODER.encode('all-deltas target B'),
          },
        ]);
        const dir = await withCraftedPack(built.packBytes);
        try {
          // Act
          const gitResult = tryRunGitWithExit(['index-pack', '--strict', dir.packPath]);
          let caught: unknown;
          try {
            await walkPackEntries(ctx, built.packBytes);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(gitResult.exitCode).not.toBe(0);
          expect(gitResult.stderr).toContain('pack has 2 unresolved deltas');
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { reason?: string };
          expect(data.reason).toBe('pack has 2 unresolved deltas');
        } finally {
          await dir.dispose();
        }
      });
    });
  });

  describe('Given a crafted pack with exactly one unresolvable delta', () => {
    describe('When git index-pack --strict and tsgit walkPackEntries both run over the same bytes', () => {
      it('Then both say "pack has 1 unresolved delta" — the singular a naive template gets wrong', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const unknownId = await blobIdOf(ctx, ENCODER.encode('singular unresolved, missing base'));
        const built = await buildSyntheticPack(ctx, [
          {
            kind: 'base',
            type: 'blob',
            content: ENCODER.encode('singular unresolved, present base'),
          },
          {
            kind: 'ref-delta',
            baseId: unknownId,
            baseUncompressed: new Uint8Array(0),
            targetContent: ENCODER.encode('singular unresolved target'),
          },
        ]);
        const dir = await withCraftedPack(built.packBytes);
        try {
          // Act
          const gitResult = tryRunGitWithExit(['index-pack', '--strict', dir.packPath]);
          let caught: unknown;
          try {
            await walkPackEntries(ctx, built.packBytes);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(gitResult.exitCode).not.toBe(0);
          expect(gitResult.stderr).toContain('pack has 1 unresolved delta');
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { reason?: string };
          expect(data.reason).toBe('pack has 1 unresolved delta');
        } finally {
          await dir.dispose();
        }
      });
    });
  });

  describe('Given the crafted forward-REF pack (REF_DELTA before its base)', () => {
    describe('When git index-pack and tsgit walkPackEntries both run over the same bytes', () => {
      it('Then both accept, with the same oid set', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const baseContent = ENCODER.encode('forward-ref base content');
        const baseId = await blobIdOf(ctx, baseContent);
        const built = await buildSyntheticPack(ctx, [
          {
            kind: 'ref-delta',
            baseId,
            baseUncompressed: baseContent,
            targetContent: ENCODER.encode('forward-ref target content'),
          },
          { kind: 'base', type: 'blob', content: baseContent },
        ]);
        const dir = await withCraftedPack(built.packBytes);
        try {
          // Act
          const gitResult = tryRunGitWithExit(['index-pack', dir.packPath]);
          const walked = await walkPackEntries(ctx, built.packBytes);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          const showIndexOut = runGit(['show-index'], {
            input: await readFile(dir.idxPath()),
          });
          const gitIds = byOffsetAscending(parseShowIndexOutput(showIndexOut)).map((e) => e.id);
          const tsgitIds = byOffsetAscending(walked).map((e) => e.id);
          expect(tsgitIds).toEqual(gitIds);
        } finally {
          await dir.dispose();
        }
      });
    });
  });

  describe.each([50, 51, 1000])('Given an OFS chain of depth %i', (depth) => {
    describe('When git index-pack and tsgit walkPackEntries both run over the same bytes', () => {
      it(
        'Then both accept — no depth cap on either indexer',
        async () => {
          // Arrange — no depth cap is deliberate (the indexer's own concern
          // only): tsgit's object RESOLVER separately refuses chains past
          // `MAX_DELTA_CHAIN_DEPTH = 50` (`object-resolver.ts`,
          // `fsck/object-cache.ts`) when later READING such a pack back —
          // a pre-existing gap this design leaves open rather than closing
          // with a refusal git itself does not make at index time.
          const ctx = createMemoryContext();
          const built = await buildSyntheticPack(ctx, buildOfsChain(depth));
          const dir = await withCraftedPack(built.packBytes);
          try {
            // Act
            const gitResult = tryRunGitWithExit(['index-pack', dir.packPath]);
            const walked = await walkPackEntries(ctx, built.packBytes);

            // Assert
            expect(gitResult.exitCode).toBe(0);
            expect(walked).toHaveLength(depth + 1);
          } finally {
            await dir.dispose();
          }
        },
        depth >= 1000 ? 30_000 : undefined,
      );
    });
  });

  describe('Given four identical zero-length blobs (duplicate oid)', () => {
    describe('When git index-pack (default) vs --strict, and tsgit walkPackEntries, all run over the same bytes', () => {
      it('Then git accepts by default but refuses under --strict, while tsgit accepts either way — a recorded, not asserted-away, divergence', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const built = await buildSyntheticPack(
          ctx,
          Array.from(
            { length: 4 },
            (): EntrySpec => ({ kind: 'base', type: 'blob', content: new Uint8Array(0) }),
          ),
        );
        const defaultDir = await withCraftedPack(built.packBytes);
        const strictDir = await withCraftedPack(built.packBytes);
        try {
          // Act
          const defaultResult = tryRunGitWithExit(['index-pack', defaultDir.packPath]);
          const strictResult = tryRunGitWithExit(['index-pack', '--strict', strictDir.packPath]);
          const walked = await walkPackEntries(ctx, built.packBytes);

          // Assert — git's default fetch shape (fsckObjects defaulting
          // false) matches tsgit; only --strict diverges, and that
          // divergence is the one this design explicitly records, not
          // papers over.
          expect(defaultResult.exitCode).toBe(0);
          expect(strictResult.exitCode).not.toBe(0);
          expect(strictResult.stderr).toContain('appears twice');
          expect(walked).toHaveLength(4);
        } finally {
          await defaultDir.dispose();
          await strictDir.dispose();
        }
      });
    });
  });

  describe('Given a real thin pack built by canonical git (pack-objects --thin --revs), When it is offered to tsgit without and then with the bases available', () => {
    it("Then tsgit refuses without a resolver, completes once the store's bases are available, and git index-pack --stdin --fix-thin accepts the same bytes", async () => {
      // Arrange — a two-commit repo where the second commit's blob is
      // packed thin against the first, absent from the pack itself.
      const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-index-pack-thin-'));
      try {
        runGit(['init', '-q', '-b', 'main', dir]);
        runGit(['-C', dir, 'config', 'user.name', 'Ada']);
        runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);
        runGit(['-C', dir, 'config', 'commit.gpgsign', 'false']);
        disableAutoMaintenance(dir);
        const commitEnv = {
          ...runGitEnv(),
          GIT_AUTHOR_DATE: '2020-01-01T00:00:00',
          GIT_COMMITTER_DATE: '2020-01-01T00:00:00',
        };

        // A single short line is too small for `pack-objects` to bother
        // deltifying — the thin pack would then carry the blob whole and
        // never exercise the external-base seam at all. 500 near-identical
        // lines, one changed, gives delta selection an obvious win.
        const churnLines = (changedAt: number): string =>
          `${Array.from({ length: 500 }, (_unused, i) =>
            i === changedAt ? 'changed line' : `line ${i} thin-pack-churn`,
          ).join('\n')}\n`;

        await writeFile(path.join(dir, 'file.txt'), churnLines(-1));
        runGit(['-C', dir, 'add', 'file.txt']);
        runGit(['-C', dir, 'commit', '-q', '-m', 'v1'], { env: commitEnv });
        const v1Commit = runGit(['-C', dir, 'rev-parse', 'HEAD']).trim();

        await writeFile(path.join(dir, 'file.txt'), churnLines(5));
        runGit(['-C', dir, 'add', 'file.txt']);
        runGit(['-C', dir, 'commit', '-q', '-m', 'v2'], { env: commitEnv });
        const v2Commit = runGit(['-C', dir, 'rev-parse', 'HEAD']).trim();

        const thinPackBytes = new Uint8Array(
          execFileSync('git', ['-C', dir, 'pack-objects', '--thin', '--revs', '--stdout'], {
            input: `${v2Commit}\n^${v1Commit}\n`,
            env: runGitEnv(),
            maxBuffer: 64 * 1024 * 1024,
          }),
        );

        // Act / Assert — refuses without a resolver.
        const ctx = createMemoryContext();
        let caught: unknown;
        try {
          await walkPackEntries(ctx, thinPackBytes);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(TsgitError);

        // Act / Assert — completes once bases are available locally.
        const resolver: ExternalBaseResolver = async (oid) => {
          const type = runGit(['-C', dir, 'cat-file', '-t', oid]).trim();
          if (type !== 'blob' && type !== 'tree' && type !== 'commit' && type !== 'tag') {
            return undefined;
          }
          const content = new Uint8Array(
            execFileSync('git', ['-C', dir, 'cat-file', type, oid], { env: runGitEnv() }),
          );
          return { type, content };
        };
        const walked = await walkPackEntries(ctx, thinPackBytes, resolver);
        expect(walked.length).toBeGreaterThan(0);

        // Act / Assert — git's own --fix-thin accepts the identical bytes.
        const fixOutput = runGit(['-C', dir, 'index-pack', '--stdin', '--fix-thin'], {
          input: thinPackBytes,
        });
        expect(fixOutput).toContain('pack\t');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
