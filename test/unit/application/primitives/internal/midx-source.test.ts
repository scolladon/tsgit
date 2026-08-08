import { describe, expect, it, vi } from 'vitest';
import {
  isTierBMidxFault,
  loadMidxSet,
} from '../../../../../src/application/primitives/internal/midx-source.js';
import {
  commonGitDir,
  multiPackIndexChainPath,
  multiPackIndexLayerPath,
  multiPackIndexPath,
  packsDir,
} from '../../../../../src/application/primitives/path-layout.js';
import {
  MAX_MIDX_BYTES,
  MAX_MIDX_CHAIN_LAYERS,
  REASON_MIDX_CHAIN_TOO_LONG,
  REASON_MIDX_EXCEEDS_MAX,
} from '../../../../../src/application/primitives/validators.js';
import {
  fileNotFound,
  operationAborted,
  permissionDenied,
  TsgitError,
} from '../../../../../src/domain/error.js';
import type { MidxCheck } from '../../../../../src/domain/storage/error.js';
import { invalidMultiPackIndex } from '../../../../../src/domain/storage/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildMidx, type MidxSpec } from '../../../domain/storage/arbitraries.js';
import { buildSeededContext, instrumentedContext } from '../fixtures.js';

async function writeMidx(
  ctx: Context,
  dir: string,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  await ctx.fs.write(`${dir}/${name}`, bytes);
}

function baseSpec(overrides: Partial<MidxSpec> = {}): MidxSpec {
  return {
    version: 1,
    hashVersion: 1,
    digestLength: 20,
    numBaseFiles: 0,
    packNames: [],
    entries: [],
    ...overrides,
  };
}

function layerDigest(n: number, digestLength: number): string {
  return n.toString(16).padStart(digestLength * 2, '0');
}

/** Flip the first signature byte ('M' → 0x00) — never matches the midx magic. */
function flipSignature(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  copy[0] = 0;
  return copy;
}

function truncateTo8(bytes: Uint8Array): Uint8Array {
  return bytes.slice(0, 8);
}

async function writeLayerFile(
  ctx: Context,
  dir: string,
  digest: string,
  spec: MidxSpec,
): Promise<void> {
  await writeMidx(
    ctx,
    `${dir}/multi-pack-index.d`,
    `multi-pack-index-${digest}.midx`,
    buildMidx(spec),
  );
}

/** Writes each spec as a chain layer (base first) plus the chain manifest
 *  listing their digests in order. Returns the digests, base first. */
async function writeChain(
  ctx: Context,
  dir: string,
  specs: ReadonlyArray<MidxSpec>,
): Promise<ReadonlyArray<string>> {
  const digests = specs.map((spec, i) => layerDigest(i + 1, spec.digestLength));
  for (const [i, spec] of specs.entries()) {
    await writeLayerFile(ctx, dir, digests[i]!, spec);
  }
  await ctx.fs.writeUtf8(multiPackIndexChainPath(dir), `${digests.join('\n')}\n`);
  return digests;
}

async function expectRejectsWithCheck(promise: Promise<unknown>, check: MidxCheck): Promise<void> {
  try {
    await promise;
    expect.unreachable();
  } catch (error) {
    const data = (error as TsgitError).data;
    expect(data.code).toBe('INVALID_MULTI_PACK_INDEX');
    if (data.code !== 'INVALID_MULTI_PACK_INDEX') {
      expect.fail(`expected INVALID_MULTI_PACK_INDEX, got ${data.code}`);
    }
    expect(data.check).toBe(check);
  }
}

describe('midx-source', () => {
  describe('loadMidxSet', () => {
    describe('Given a packs directory with two .idx files and no multi-pack-index', () => {
      describe('When loadMidxSet is called', () => {
        it('Then set is undefined, faults is empty, flatFilePresent is false, and no midx path is ever read', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dir = packsDir(commonGitDir(ctx));
          await ctx.fs.write(`${dir}/pack-aa.idx`, new Uint8Array([0]));
          await ctx.fs.write(`${dir}/pack-bb.idx`, new Uint8Array([0]));
          const { ctx: instrumented, calls } = instrumentedContext(ctx);

          // Act
          const result = await loadMidxSet(instrumented, dir);

          // Assert
          expect(result.set).toBeUndefined();
          expect(result.faults).toEqual([]);
          expect(result.flatFilePresent).toBe(false);
          const midxReads = calls().filter(
            (call) =>
              (call.method === 'read' || call.method === 'readUtf8') &&
              call.path.includes('multi-pack-index'),
          );
          expect(midxReads).toEqual([]);
        });
      });
    });

    describe('Given a healthy flat multi-pack-index', () => {
      describe('When loadMidxSet is called', () => {
        it("Then the set is flat-kind with one layer, flatFilePresent is true, and artefacts is ['multi-pack-index']", async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dir = packsDir(commonGitDir(ctx));
          await writeMidx(ctx, dir, 'multi-pack-index', buildMidx(baseSpec()));

          // Act
          const result = await loadMidxSet(ctx, dir);

          // Assert
          expect(result.set?.kind).toBe('flat');
          expect(result.set?.layers).toHaveLength(1);
          expect(result.set?.artefacts).toEqual(['multi-pack-index']);
          expect(result.flatFilePresent).toBe(true);
          expect(result.faults).toEqual([]);
        });
      });
    });

    describe('Given a healthy chain and no flat midx', () => {
      describe('When loadMidxSet is called', () => {
        it.each([1, 2, 3])(
          'Then the set is chain-kind with %i layer(s), base first',
          async (layerCount) => {
            // Arrange
            const ctx = await buildSeededContext();
            const dir = packsDir(commonGitDir(ctx));
            const specs = Array.from({ length: layerCount }, (_, i) =>
              baseSpec({ numBaseFiles: i }),
            );
            await writeChain(ctx, dir, specs);

            // Act
            const result = await loadMidxSet(ctx, dir);

            // Assert
            expect(result.set?.kind).toBe('chain');
            expect(result.set?.layers.map((layer) => layer.numBaseFiles)).toEqual(
              specs.map((_, i) => i),
            );
            expect(result.flatFilePresent).toBe(false);
          },
        );
      });
    });

    describe('Given a healthy 2-layer chain', () => {
      describe('When loadMidxSet is called', () => {
        it('Then artefacts lists each layer file name, base first, last element is the head', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dir = packsDir(commonGitDir(ctx));
          const digests = await writeChain(ctx, dir, [baseSpec(), baseSpec()]);

          // Act
          const result = await loadMidxSet(ctx, dir);

          // Assert
          expect(result.set?.artefacts).toEqual([
            `multi-pack-index-${digests[0]}.midx`,
            `multi-pack-index-${digests[1]}.midx`,
          ]);
        });
      });
    });

    describe('Given a loadable flat midx alongside a chain whose base layer has a bad signature', () => {
      describe('When loadMidxSet is called', () => {
        it('Then resolves via the flat file and the chain is never read', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dir = packsDir(commonGitDir(ctx));
          await writeMidx(ctx, dir, 'multi-pack-index', buildMidx(baseSpec()));
          const digests = await writeChain(ctx, dir, [baseSpec()]);
          const layerPath = multiPackIndexLayerPath(dir, digests[0]!);
          await ctx.fs.write(layerPath, flipSignature(await ctx.fs.read(layerPath)));
          const { ctx: instrumented, calls } = instrumentedContext(ctx);

          // Act
          const result = await loadMidxSet(instrumented, dir);

          // Assert
          expect(result.set?.kind).toBe('flat');
          const chainReads = calls().filter((call) => call.path.includes('multi-pack-index.d'));
          expect(chainReads).toEqual([]);
        });
      });
    });

    describe('Given a flat midx truncated to 8 bytes alongside an intact chain', () => {
      describe('When loadMidxSet is called', () => {
        it('Then the chain rescues the read: kind chain, one fault on multi-pack-index, flatFilePresent true', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dir = packsDir(commonGitDir(ctx));
          await writeMidx(ctx, dir, 'multi-pack-index', truncateTo8(buildMidx(baseSpec())));
          await writeChain(ctx, dir, [baseSpec()]);

          // Act
          const result = await loadMidxSet(ctx, dir);

          // Assert
          expect(result.set?.kind).toBe('chain');
          expect(result.faults).toHaveLength(1);
          expect(result.faults[0]?.artefact).toBe('multi-pack-index');
          expect(result.flatFilePresent).toBe(true);
        });
      });
    });

    describe('Given a flat midx with a flipped signature alongside an intact chain', () => {
      describe('When loadMidxSet is called', () => {
        it('Then rejects with check signature and the chain is never read', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dir = packsDir(commonGitDir(ctx));
          await writeMidx(ctx, dir, 'multi-pack-index', flipSignature(buildMidx(baseSpec())));
          await writeChain(ctx, dir, [baseSpec()]);
          const { ctx: instrumented, calls } = instrumentedContext(ctx);

          // Act + Assert
          await expectRejectsWithCheck(loadMidxSet(instrumented, dir), 'signature');
          const chainReads = calls().filter((call) => call.path.includes('multi-pack-index.d'));
          expect(chainReads).toEqual([]);
        });
      });
    });

    describe('Given no chain file at all, and no flat midx', () => {
      describe('When loadMidxSet is called', () => {
        it('Then set is undefined and no fault is recorded', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dir = packsDir(commonGitDir(ctx));

          // Act
          const result = await loadMidxSet(ctx, dir);

          // Assert
          expect(result.set).toBeUndefined();
          expect(result.faults).toEqual([]);
        });
      });
    });

    describe('Given an empty chain file', () => {
      describe('When loadMidxSet is called', () => {
        it('Then set is undefined and no fault is recorded', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dir = packsDir(commonGitDir(ctx));
          await ctx.fs.writeUtf8(multiPackIndexChainPath(dir), '');

          // Act
          const result = await loadMidxSet(ctx, dir);

          // Assert
          expect(result.set).toBeUndefined();
          expect(result.faults).toEqual([]);
        });
      });
    });

    describe('Given the chain file vanishes between the presence check and the read', () => {
      describe('When loadMidxSet is called', () => {
        it('Then set is undefined and no fault is recorded', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dir = packsDir(commonGitDir(ctx));
          const chainPath = multiPackIndexChainPath(dir);
          await ctx.fs.writeUtf8(chainPath, `${layerDigest(1, 20)}\n`);
          const wrapped: Context = {
            ...ctx,
            fs: {
              ...ctx.fs,
              readUtf8: async (path) => {
                if (path === chainPath) throw new TsgitError({ code: 'FILE_NOT_FOUND', path });
                return ctx.fs.readUtf8(path);
              },
            },
          };

          // Act
          const result = await loadMidxSet(wrapped, dir);

          // Assert
          expect(result.set).toBeUndefined();
          expect(result.faults).toEqual([]);
        });
      });
    });

    describe('Given a chain that lists a digest with no layer file on disk', () => {
      describe('When loadMidxSet is called', () => {
        it('Then set is undefined and one fault is recorded for the missing layer', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dir = packsDir(commonGitDir(ctx));
          const digest = layerDigest(1, 20);
          await ctx.fs.writeUtf8(multiPackIndexChainPath(dir), `${digest}\n`);

          // Act
          const result = await loadMidxSet(ctx, dir);

          // Assert
          expect(result.set).toBeUndefined();
          expect(result.faults).toHaveLength(1);
          expect(result.faults[0]?.artefact).toBe(`multi-pack-index-${digest}.midx`);
        });
      });
    });

    describe('Given a chain whose only layer is truncated to 8 bytes', () => {
      describe('When loadMidxSet is called', () => {
        it('Then set is undefined and one fault is recorded', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dir = packsDir(commonGitDir(ctx));
          const digests = await writeChain(ctx, dir, [baseSpec()]);
          const layerPath = multiPackIndexLayerPath(dir, digests[0]!);
          await ctx.fs.write(layerPath, truncateTo8(await ctx.fs.read(layerPath)));

          // Act
          const result = await loadMidxSet(ctx, dir);

          // Assert
          expect(result.set).toBeUndefined();
          expect(result.faults).toHaveLength(1);
        });
      });
    });

    describe('Given a 2-layer chain whose base layer has a flipped signature', () => {
      describe('When loadMidxSet is called', () => {
        it('Then rejects instead of discarding the chain', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dir = packsDir(commonGitDir(ctx));
          const digests = await writeChain(ctx, dir, [baseSpec(), baseSpec()]);
          const basePath = multiPackIndexLayerPath(dir, digests[0]!);
          await ctx.fs.write(basePath, flipSignature(await ctx.fs.read(basePath)));

          // Act + Assert
          await expectRejectsWithCheck(loadMidxSet(ctx, dir), 'signature');
        });
      });
    });

    describe('Given a 2-layer chain whose head layer has a flipped signature', () => {
      describe('When loadMidxSet is called', () => {
        it('Then rejects instead of discarding the chain', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dir = packsDir(commonGitDir(ctx));
          const digests = await writeChain(ctx, dir, [baseSpec(), baseSpec()]);
          const headPath = multiPackIndexLayerPath(dir, digests[1]!);
          await ctx.fs.write(headPath, flipSignature(await ctx.fs.read(headPath)));

          // Act + Assert
          await expectRejectsWithCheck(loadMidxSet(ctx, dir), 'signature');
        });
      });
    });

    describe('Given a chain manifest with one real layer line followed by a non-hex garbage line', () => {
      describe('When loadMidxSet is called', () => {
        it('Then the leading run still loads the real layer', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dir = packsDir(commonGitDir(ctx));
          const digest = layerDigest(1, 20);
          await writeLayerFile(ctx, dir, digest, baseSpec());
          await ctx.fs.writeUtf8(multiPackIndexChainPath(dir), `${digest}\ngarbage\n`);

          // Act
          const result = await loadMidxSet(ctx, dir);

          // Assert
          expect(result.set?.kind).toBe('chain');
          expect(result.set?.layers).toHaveLength(1);
        });
      });
    });

    describe('Given a chain manifest with a real layer line, a garbage line, then another real layer line', () => {
      describe('When loadMidxSet is called', () => {
        it('Then only the layers before the garbage line load', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dir = packsDir(commonGitDir(ctx));
          const digestA = layerDigest(1, 20);
          const digestB = layerDigest(2, 20);
          await writeLayerFile(ctx, dir, digestA, baseSpec());
          await writeLayerFile(ctx, dir, digestB, baseSpec());
          await ctx.fs.writeUtf8(multiPackIndexChainPath(dir), `${digestA}\ngarbage\n${digestB}\n`);

          // Act
          const result = await loadMidxSet(ctx, dir);

          // Assert
          expect(result.set?.kind).toBe('chain');
          expect(result.set?.layers).toHaveLength(1);
        });
      });
    });

    describe('Given a chain manifest whose leading hex run exceeds the layer cap', () => {
      describe('When loadMidxSet is called', () => {
        it('Then the whole chain is discarded with one fault reasoned as chain-too-long', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dir = packsDir(commonGitDir(ctx));
          const lines = Array.from({ length: MAX_MIDX_CHAIN_LAYERS + 1 }, (_, i) =>
            layerDigest(i + 1, 20),
          );
          await ctx.fs.writeUtf8(multiPackIndexChainPath(dir), `${lines.join('\n')}\n`);

          // Act
          const result = await loadMidxSet(ctx, dir);

          // Assert
          expect(result.set).toBeUndefined();
          expect(result.faults).toHaveLength(1);
          expect(result.faults[0]?.data).toMatchObject({
            code: 'INVALID_MULTI_PACK_INDEX',
            reason: REASON_MIDX_CHAIN_TOO_LONG,
          });
        });
      });
    });

    describe('Given a flat midx whose stat reports a size over the byte cap', () => {
      describe('When loadMidxSet is called', () => {
        it('Then a fault is recorded and the file is never read', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dir = packsDir(commonGitDir(ctx));
          const flatPath = multiPackIndexPath(dir);
          await writeMidx(ctx, dir, 'multi-pack-index', buildMidx(baseSpec()));
          const lying: Context = {
            ...ctx,
            fs: {
              ...ctx.fs,
              stat: async (path) => {
                const real = await ctx.fs.stat(path);
                return path === flatPath ? { ...real, size: MAX_MIDX_BYTES + 1 } : real;
              },
            },
          };
          const { ctx: instrumented, calls } = instrumentedContext(lying);

          // Act
          const result = await loadMidxSet(instrumented, dir);

          // Assert
          expect(result.faults).toHaveLength(1);
          expect(result.faults[0]?.data).toMatchObject({ reason: REASON_MIDX_EXCEEDS_MAX });
          const reads = calls().filter((call) => call.method === 'read' && call.path === flatPath);
          expect(reads).toEqual([]);
        });
      });
    });

    describe('Given a chain layer whose stat reports a size over the byte cap', () => {
      describe('When loadMidxSet is called', () => {
        it('Then the whole chain is discarded and the layer is never read', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dir = packsDir(commonGitDir(ctx));
          const digests = await writeChain(ctx, dir, [baseSpec()]);
          const layerPath = multiPackIndexLayerPath(dir, digests[0]!);
          const lying: Context = {
            ...ctx,
            fs: {
              ...ctx.fs,
              stat: async (path) => {
                const real = await ctx.fs.stat(path);
                return path === layerPath ? { ...real, size: MAX_MIDX_BYTES + 1 } : real;
              },
            },
          };
          const { ctx: instrumented, calls } = instrumentedContext(lying);

          // Act
          const result = await loadMidxSet(instrumented, dir);

          // Assert
          expect(result.set).toBeUndefined();
          expect(result.faults).toHaveLength(1);
          expect(result.faults[0]?.data).toMatchObject({ reason: REASON_MIDX_EXCEEDS_MAX });
          const reads = calls().filter((call) => call.method === 'read' && call.path === layerPath);
          expect(reads).toEqual([]);
        });
      });
    });

    describe('Given a chain manifest whose second line is a hostile path or contains a NUL byte', () => {
      describe('When loadMidxSet is called', () => {
        it.each([
          ['a path-traversal line', '../../../../etc/passwd'],
          ['a line containing NUL', `aa bb${'0'.repeat(35)}`],
        ])(
          'Then the run terminates at %s and it is never used to build a path',
          async (_label, hostileLine) => {
            // Arrange
            const ctx = await buildSeededContext();
            const dir = packsDir(commonGitDir(ctx));
            const digest = layerDigest(1, 20);
            await writeLayerFile(ctx, dir, digest, baseSpec());
            await ctx.fs.writeUtf8(multiPackIndexChainPath(dir), `${digest}\n${hostileLine}\n`);
            const { ctx: instrumented, calls } = instrumentedContext(ctx);

            // Act
            const result = await loadMidxSet(instrumented, dir);

            // Assert
            expect(result.set?.layers).toHaveLength(1);
            const suspicious = calls().filter((call) => call.path.includes(hostileLine));
            expect(suspicious).toEqual([]);
          },
        );
      });
    });

    describe('Given a healthy flat midx whose trailer bytes are wrong', () => {
      describe('When loadMidxSet is called', () => {
        it('Then it loads normally without ever calling the hash service', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dir = packsDir(commonGitDir(ctx));
          const bytes = buildMidx(baseSpec());
          const corrupted = bytes.slice();
          corrupted.set(new Uint8Array(20).fill(0xff), corrupted.length - 20);
          await writeMidx(ctx, dir, 'multi-pack-index', corrupted);
          const hashHex = vi.fn(ctx.hash.hashHex);
          const wrapped: Context = { ...ctx, hash: { ...ctx.hash, hashHex } };

          // Act
          const result = await loadMidxSet(wrapped, dir);

          // Assert
          expect(result.set?.kind).toBe('flat');
          expect(hashHex).not.toHaveBeenCalled();
        });
      });
    });
  });

  describe('isTierBMidxFault', () => {
    describe('Given an INVALID_MULTI_PACK_INDEX error for each MidxCheck member', () => {
      describe('When isTierBMidxFault is called', () => {
        it.each<{ check: MidxCheck; tier: 'A' | 'B' }>([
          { check: 'size', tier: 'B' },
          { check: 'chunk-table', tier: 'B' },
          { check: 'chunk-length', tier: 'B' },
          { check: 'hash-version', tier: 'B' },
          { check: 'signature', tier: 'A' },
          { check: 'version', tier: 'A' },
          { check: 'required-chunk', tier: 'A' },
          { check: 'fanout', tier: 'A' },
          { check: 'pack-names', tier: 'A' },
          { check: 'pack-int-id', tier: 'A' },
          { check: 'large-offset', tier: 'A' },
        ])('Then returns the expected tier ($tier) for check=$check', ({ check, tier }) => {
          // Arrange
          const sut = isTierBMidxFault;
          const err = invalidMultiPackIndex(check, 'test reason');

          // Act
          const result = sut(err);

          // Assert
          expect(result).toBe(tier === 'B');
        });
      });
    });

    describe('Given a FILE_NOT_FOUND error on a midx artefact', () => {
      describe('When isTierBMidxFault is called', () => {
        it('Then returns true', () => {
          // Arrange
          const sut = isTierBMidxFault;
          const err = fileNotFound('/g/objects/pack/multi-pack-index');

          // Act
          const result = sut(err);

          // Assert
          expect(result).toBe(true);
        });
      });
    });

    describe('Given a PERMISSION_DENIED error on a midx artefact', () => {
      describe('When isTierBMidxFault is called', () => {
        it('Then returns true', () => {
          // Arrange
          const sut = isTierBMidxFault;
          const err = permissionDenied('/g/objects/pack/multi-pack-index');

          // Act
          const result = sut(err);

          // Assert
          expect(result).toBe(true);
        });
      });
    });

    describe('Given an unrelated TsgitError code', () => {
      describe('When isTierBMidxFault is called', () => {
        it('Then returns false', () => {
          // Arrange
          const sut = isTierBMidxFault;
          const err = operationAborted();

          // Act
          const result = sut(err);

          // Assert
          expect(result).toBe(false);
        });
      });
    });

    describe('Given a non-TsgitError value', () => {
      describe('When isTierBMidxFault is called', () => {
        it('Then returns false', () => {
          // Arrange
          const sut = isTierBMidxFault;
          const err = new Error('boom');

          // Act
          const result = sut(err);

          // Assert
          expect(result).toBe(false);
        });
      });
    });
  });
});
