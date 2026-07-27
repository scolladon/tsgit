import { describe, expect, it } from 'vitest';

import {
  commitDataAt,
  parseCommitGraphLayer,
  positionOf,
} from '../../../../src/domain/commit/commit-graph.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import { compareBytes } from '../../../../src/domain/objects/encoding.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import {
  buildCommitGraphBytes,
  type CommitGraphCommitModel,
  type CommitGraphLayerModel,
} from './arbitraries.js';

// --- Fixture helpers -------------------------------------------------------

function oid(prefix: string): ObjectId {
  return (prefix + '0'.repeat(40 - prefix.length)) as ObjectId;
}

function commit(
  oidPrefix: string,
  parentPositions: readonly number[],
  overrides: Partial<CommitGraphCommitModel> = {},
): CommitGraphCommitModel {
  return {
    oid: oid(oidPrefix),
    rootTree: oid(`e${oidPrefix}`),
    parentPositions,
    generationV1: 1,
    committerDate: 1_700_000_000,
    generationV2Offset: 5,
    ...overrides,
  };
}

// A root commit, a single-parent commit, and a 2-parent merge commit — the
// exact chunk composition (OIDF, OIDL, CDAT, GDA2 — no EDGE, no BASE) that
// `git commit-graph write --reachable` produces for a 5-commit repo (Pin D).
function fiveCommitModel(): CommitGraphLayerModel {
  return {
    hashVersion: 1,
    numBaseGraphs: 0,
    baseGraphHashes: [],
    includeGenerationData: true,
    commits: [
      commit('c0', [], { generationV1: 1, committerDate: 1_700_000_000, generationV2Offset: 0 }),
      commit('c1', [0], { generationV1: 2, committerDate: 1_700_000_100, generationV2Offset: 100 }),
      commit('c2', [1], { generationV1: 3, committerDate: 1_700_000_200, generationV2Offset: 200 }),
      commit('c3', [0, 2], {
        generationV1: 4,
        committerDate: 1_700_000_300,
        generationV2Offset: 300,
      }),
      commit('c4', [3], { generationV1: 5, committerDate: 1_700_000_400, generationV2Offset: 400 }),
    ],
  };
}

// No GDA2/BASE chunk, so EDGE is the last real chunk in the table — the
// corruption helpers below shrink/rename it via the sentinel row without
// perturbing a following chunk's own size check.
function octopusModel(): CommitGraphLayerModel {
  return {
    hashVersion: 1,
    numBaseGraphs: 0,
    baseGraphHashes: [],
    includeGenerationData: false,
    commits: [commit('d0', []), commit('d1', []), commit('d2', []), commit('d3', [0, 1, 2])],
  };
}

function chainBaseModel(): CommitGraphLayerModel {
  return {
    hashVersion: 1,
    numBaseGraphs: 0,
    baseGraphHashes: [],
    includeGenerationData: true,
    commits: [commit('a0', []), commit('a1', [0]), commit('a2', [1])],
  };
}

// Global positions: the base layer owns 0..2 (a0,a1,a2); the tip owns 3..4
// (b0,b1) — parent positions here follow that concatenated numbering, which
// is what a real chain layer records (cross-layer resolution is Part 11's
// job, not this parser's).
function chainTipModel(baseGraphHash: ObjectId): CommitGraphLayerModel {
  return {
    hashVersion: 1,
    numBaseGraphs: 1,
    baseGraphHashes: [baseGraphHash],
    includeGenerationData: true,
    commits: [commit('b0', [2]), commit('b1', [3])],
  };
}

function readChunkRowOffset(view: DataView, rowIndex: number): number {
  const rowStart = 8 + rowIndex * 12;
  return view.getUint32(rowStart + 4) * 0x100000000 + view.getUint32(rowStart + 8);
}

function findChunkRowIndex(bytes: Uint8Array, id: string): number {
  const numChunks = bytes[6]!;
  const decoder = new TextDecoder();
  for (let i = 0; i < numChunks; i += 1) {
    const rowStart = 8 + i * 12;
    if (decoder.decode(bytes.subarray(rowStart, rowStart + 4)) === id) return i;
  }
  throw new Error(`chunk ${id} not present in fixture`);
}

function renameChunkRowId(bytes: Uint8Array, id: string, newId: string): Uint8Array {
  const copy = bytes.slice();
  const rowStart = 8 + findChunkRowIndex(copy, id) * 12;
  copy.set(new TextEncoder().encode(newId), rowStart);
  return copy;
}

// Shrinks `id`'s chunk by adjusting the OFFSET of the row immediately after
// it in the table — that row is `id`'s end boundary, so this changes only
// `id`'s computed size without disturbing any earlier chunk's range.
function shrinkChunkAfter(bytes: Uint8Array, id: string, delta: number): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  const nextRowStart = 8 + (findChunkRowIndex(copy, id) + 1) * 12;
  const low = view.getUint32(nextRowStart + 8);
  view.setUint32(nextRowStart + 8, low + delta);
  return copy;
}

function setGda2Overflow(bytes: Uint8Array, commitIndex: number): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  const gda2Start = readChunkRowOffset(view, findChunkRowIndex(copy, 'GDA2'));
  const entryOffset = gda2Start + commitIndex * 4;
  view.setUint32(entryOffset, view.getUint32(entryOffset) | 0x80000000);
  return copy;
}

function expectThrows(
  act: () => void,
  code: 'INVALID_COMMIT_GRAPH_HEADER' | 'INVALID_COMMIT_GRAPH_CHUNK',
  reasonContains: string,
): void {
  try {
    act();
    expect.fail('Should have thrown');
  } catch (e) {
    const err = e as TsgitError;
    expect(err.data).toEqual(
      expect.objectContaining({ code, reason: expect.stringContaining(reasonContains) }),
    );
  }
}

const validBytes = buildCommitGraphBytes(fiveCommitModel());

describe('commit-graph', () => {
  describe('parseCommitGraphLayer', () => {
    describe('Given the pinned 5-commit single-file commit-graph layout (git 2.55.0, Pin D)', () => {
      describe('When reading the raw chunk table', () => {
        it('Then the offsets match the pinned byte layout (OIDF@68, OIDL@1092, CDAT@1192, GDA2@1372, end@1392, file 1412)', () => {
          // Arrange
          const bytes = buildCommitGraphBytes(fiveCommitModel());
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

          // Act
          const rowOffsets = [0, 1, 2, 3, 4].map((row) => readChunkRowOffset(view, row));

          // Assert
          expect(rowOffsets).toEqual([68, 1092, 1192, 1372, 1392]);
          expect(bytes.length).toBe(1412);
        });

        it('Then the OIDF fanout has 256 entries and the last equals the commit count', () => {
          // Arrange
          const bytes = buildCommitGraphBytes(fiveCommitModel());
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          const oidfOffset = readChunkRowOffset(view, 0);

          // Act
          const lastFanoutEntry = view.getUint32(oidfOffset + 255 * 4);

          // Assert
          expect(lastFanoutEntry).toBe(5);
        });

        it('Then the OIDL entries are sorted ascending', () => {
          // Arrange
          const model = fiveCommitModel();
          const bytes = buildCommitGraphBytes(model);
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          const oidlOffset = readChunkRowOffset(view, 1);

          // Act
          const readOids = model.commits.map((_, i) =>
            bytes.subarray(oidlOffset + i * 20, oidlOffset + i * 20 + 20),
          );

          // Assert
          for (let i = 1; i < readOids.length; i += 1) {
            expect(compareBytes(readOids[i - 1]!, readOids[i]!)).toBeLessThan(0);
          }
        });
      });

      describe('When parsing', () => {
        it('Then hashVersion, commitCount, and numBaseGraphs decode correctly', () => {
          // Arrange
          const bytes = buildCommitGraphBytes(fiveCommitModel());

          // Act
          const layer = parseCommitGraphLayer(bytes);

          // Assert
          expect(layer.hashVersion).toBe(1);
          expect(layer.commitCount).toBe(5);
          expect(layer.numBaseGraphs).toBe(0);
          expect(layer.baseGraphHashes).toEqual([]);
        });

        it('Then positionOf resolves every oid to its sorted index', () => {
          // Arrange
          const model = fiveCommitModel();
          const layer = parseCommitGraphLayer(buildCommitGraphBytes(model));

          // Act + Assert
          model.commits.forEach((c, i) => {
            expect(positionOf(layer, c.oid)).toBe(i);
          });
        });

        it('Then commitDataAt reads the root tree, generation, and committer date for each entry', () => {
          // Arrange
          const model = fiveCommitModel();
          const layer = parseCommitGraphLayer(buildCommitGraphBytes(model));

          // Act + Assert
          model.commits.forEach((c, i) => {
            const result = commitDataAt(layer, i);
            expect(result.rootTree).toBe(c.rootTree);
            expect(result.committerDate).toBe(c.committerDate);
            expect(result.generation).toBe(c.committerDate + c.generationV2Offset);
          });
        });

        it.each([
          {
            pos: 0,
            expectedParent1: undefined,
            expectedParent2: undefined,
            label: 'a root commit (no parents)',
          },
          {
            pos: 1,
            expectedParent1: 0,
            expectedParent2: undefined,
            label: 'a single-parent commit',
          },
          { pos: 3, expectedParent1: 0, expectedParent2: 2, label: 'a 2-parent merge commit' },
        ])(
          'Then parent1Pos=$expectedParent1 and parent2Pos=$expectedParent2 for $label',
          ({ pos, expectedParent1, expectedParent2 }) => {
            // Arrange
            const layer = parseCommitGraphLayer(buildCommitGraphBytes(fiveCommitModel()));

            // Act
            const result = commitDataAt(layer, pos);

            // Assert
            expect(result.parent1Pos).toBe(expectedParent1);
            expect(result.parent2Pos).toBe(expectedParent2);
            expect(result.additionalParentPositions).toEqual([]);
          },
        );
      });
    });

    describe('Given an octopus merge commit (3+ parents)', () => {
      describe('When parsing', () => {
        it('Then parent1Pos/parent2Pos come from CDAT and the rest resolve through EDGE', () => {
          // Arrange
          const layer = parseCommitGraphLayer(buildCommitGraphBytes(octopusModel()));

          // Act
          const result = commitDataAt(layer, 3);

          // Assert
          expect(result.parent1Pos).toBe(0);
          expect(result.parent2Pos).toBe(1);
          expect(result.additionalParentPositions).toEqual([2]);
        });
      });
    });

    describe('Given an oid not present in the layer', () => {
      describe('When calling positionOf', () => {
        it('Then returns undefined', () => {
          // Arrange
          const layer = parseCommitGraphLayer(buildCommitGraphBytes(fiveCommitModel()));

          // Act
          const result = positionOf(layer, oid('ff'));

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given a layer with no GDA2 chunk', () => {
      describe('When reading commit data', () => {
        it('Then generation falls back to the CDAT v1 topological level', () => {
          // Arrange
          const model: CommitGraphLayerModel = {
            ...fiveCommitModel(),
            includeGenerationData: false,
          };
          const layer = parseCommitGraphLayer(buildCommitGraphBytes(model));

          // Act
          const result = commitDataAt(layer, 2);

          // Assert
          expect(result.generation).toBe(model.commits[2]!.generationV1);
        });
      });
    });

    describe('Given a 2-layer chain (base 3 commits, tip 2 commits)', () => {
      describe('When building the base layer', () => {
        it('Then the header bytes are 43 47 50 48 01 01 04 00 (4 chunks, 0 base graphs)', () => {
          // Arrange
          const bytes = buildCommitGraphBytes(chainBaseModel());

          // Act
          const header = Array.from(bytes.subarray(0, 8));

          // Assert
          expect(header).toEqual([0x43, 0x47, 0x50, 0x48, 0x01, 0x01, 0x04, 0x00]);
        });
      });

      describe('When building the tip layer', () => {
        it('Then the header bytes are 43 47 50 48 01 01 05 01 (5 chunks, 1 base graph)', () => {
          // Arrange
          const bytes = buildCommitGraphBytes(chainTipModel(oid('a2')));

          // Act
          const header = Array.from(bytes.subarray(0, 8));

          // Assert
          expect(header).toEqual([0x43, 0x47, 0x50, 0x48, 0x01, 0x01, 0x05, 0x01]);
        });
      });

      describe('When parsing the tip layer', () => {
        it('Then numBaseGraphs equals the BASE chunk oid count and holds the base layer hash', () => {
          // Arrange
          const baseHash = oid('a2');
          const layer = parseCommitGraphLayer(buildCommitGraphBytes(chainTipModel(baseHash)));

          // Act + Assert
          expect(layer.numBaseGraphs).toBe(1);
          expect(layer.baseGraphHashes).toHaveLength(layer.numBaseGraphs);
          expect(layer.baseGraphHashes[0]).toBe(baseHash);
        });
      });
    });

    describe('Given malformed commit-graph header bytes', () => {
      describe('When parsing', () => {
        it.each([
          {
            bytes: new Uint8Array(4),
            reasonContains: 'truncated',
            label: 'shorter than the header',
          },
          {
            bytes: (() => {
              const copy = validBytes.slice();
              new DataView(copy.buffer).setUint32(0, 0xdeadbeef);
              return copy;
            })(),
            reasonContains: 'magic',
            label: 'wrong magic bytes',
          },
          {
            bytes: (() => {
              const copy = validBytes.slice();
              new DataView(copy.buffer).setUint8(4, 2);
              return copy;
            })(),
            reasonContains: 'version',
            label: 'unsupported version',
          },
          {
            bytes: (() => {
              const copy = validBytes.slice();
              new DataView(copy.buffer).setUint8(5, 9);
              return copy;
            })(),
            reasonContains: 'hash version',
            label: 'unsupported hash version',
          },
        ])('Then throws INVALID_COMMIT_GRAPH_HEADER for $label', ({ bytes, reasonContains }) => {
          // Arrange (bytes from the each-table row) + Act & Assert
          expectThrows(
            () => parseCommitGraphLayer(bytes),
            'INVALID_COMMIT_GRAPH_HEADER',
            reasonContains,
          );
        });
      });
    });

    describe('Given malformed commit-graph chunk structure', () => {
      describe('When parsing', () => {
        it.each([
          {
            bytes: validBytes.subarray(0, 30),
            reasonContains: 'chunk table',
            label: 'a file too short for the chunk table',
          },
          {
            bytes: validBytes.subarray(0, validBytes.length - 5),
            reasonContains: 'trailer',
            label: 'a file too short for the trailer',
          },
          {
            bytes: renameChunkRowId(validBytes, 'OIDF', 'XXXX'),
            reasonContains: 'missing required OIDF',
            label: 'a missing required OIDF chunk',
          },
          {
            bytes: shrinkChunkAfter(validBytes, 'OIDL', -8),
            reasonContains: 'truncated OIDL',
            label: 'an OIDL chunk shorter than commitCount * hashLength',
          },
        ])('Then throws INVALID_COMMIT_GRAPH_CHUNK for $label', ({ bytes, reasonContains }) => {
          // Arrange (bytes from the each-table row) + Act & Assert
          expectThrows(
            () => parseCommitGraphLayer(bytes),
            'INVALID_COMMIT_GRAPH_CHUNK',
            reasonContains,
          );
        });
      });
    });

    describe('Given a tip layer declaring base graphs with no BASE chunk', () => {
      describe('When parsing', () => {
        it('Then throws INVALID_COMMIT_GRAPH_CHUNK for a missing BASE chunk', () => {
          // Arrange
          const bytes = renameChunkRowId(
            buildCommitGraphBytes(chainTipModel(oid('a2'))),
            'BASE',
            'XXXX',
          );

          // Act & Assert
          expectThrows(
            () => parseCommitGraphLayer(bytes),
            'INVALID_COMMIT_GRAPH_CHUNK',
            'missing BASE',
          );
        });
      });
    });

    describe('Given a BASE chunk whose size does not match numBaseGraphs * hashLength', () => {
      describe('When parsing', () => {
        it('Then throws INVALID_COMMIT_GRAPH_CHUNK for a truncated BASE chunk', () => {
          // Arrange
          const bytes = shrinkChunkAfter(
            buildCommitGraphBytes(chainTipModel(oid('a2'))),
            'BASE',
            -20,
          );

          // Act & Assert
          expectThrows(
            () => parseCommitGraphLayer(bytes),
            'INVALID_COMMIT_GRAPH_CHUNK',
            'truncated BASE',
          );
        });
      });
    });

    describe('Given an octopus commit whose EDGE chunk is missing', () => {
      describe('When reading commit data', () => {
        it('Then throws INVALID_COMMIT_GRAPH_CHUNK for the octopus parent reference', () => {
          // Arrange
          const bytes = renameChunkRowId(buildCommitGraphBytes(octopusModel()), 'EDGE', 'XXXX');
          const layer = parseCommitGraphLayer(bytes);

          // Act & Assert
          expectThrows(
            () => commitDataAt(layer, 3),
            'INVALID_COMMIT_GRAPH_CHUNK',
            'missing EDGE chunk',
          );
        });
      });
    });

    describe('Given an octopus commit whose EDGE chain never terminates', () => {
      describe('When reading commit data', () => {
        it('Then throws INVALID_COMMIT_GRAPH_CHUNK for a truncated EDGE chunk', () => {
          // Arrange — drop the EDGE chunk's last entry (the one carrying the
          // terminator bit), so the walk runs off the end of the chunk.
          const bytes = shrinkChunkAfter(buildCommitGraphBytes(octopusModel()), 'EDGE', -4);
          const layer = parseCommitGraphLayer(bytes);

          // Act & Assert
          expectThrows(
            () => commitDataAt(layer, 3),
            'INVALID_COMMIT_GRAPH_CHUNK',
            'never terminates',
          );
        });
      });
    });

    describe('Given a GDA2 entry with its overflow bit set', () => {
      describe('When reading commit data', () => {
        it('Then falls back to the v1 topological generation instead of throwing', () => {
          // Arrange
          const model = fiveCommitModel();
          const bytes = setGda2Overflow(buildCommitGraphBytes(model), 0);
          const layer = parseCommitGraphLayer(bytes);

          // Act
          const result = commitDataAt(layer, 0);

          // Assert — the corrected date lives in the unparsed GDO2 chunk; the
          // reader degrades to the CDAT v1 generation rather than failing a
          // read git itself serves
          expect(result.generation).toBe(model.commits[0]!.generationV1);
          expect(result.committerDate).toBe(model.commits[0]!.committerDate);
        });
      });
    });
  });
});
