import { describe, expect, it } from 'vitest';

import type { TsgitError } from '../../../../src/domain/error.js';
import type { RevIndexCheck } from '../../../../src/domain/storage/error.js';
import {
  parsePackRevIndex,
  REASON_REV_INDEX_CORRUPT,
  REASON_REV_INDEX_TOO_SMALL,
  revIndexPositionAt,
} from '../../../../src/domain/storage/rev-index.js';
import { buildRevIndex, type RevIndexSpec } from './arbitraries.js';

// --- Fixture helpers -------------------------------------------------------

function baseSpec(overrides: Partial<RevIndexSpec> = {}): RevIndexSpec {
  return {
    hashId: 1,
    digestLength: 20,
    body: [1, 9, 11, 0, 2, 3, 4, 5, 6, 7, 8, 10],
    packChecksum: new Uint8Array(20).fill(0xfc),
    ...overrides,
  };
}

function pokeSignature(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  copy[3] = copy[3]! ^ 0xff;
  return copy;
}

function pokeVersion(bytes: Uint8Array, version: number): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(4, version);
  return copy;
}

function pokeHashId(bytes: Uint8Array, hashId: number): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(8, hashId);
  return copy;
}

function truncate(bytes: Uint8Array, length: number): Uint8Array {
  return bytes.slice(0, length);
}

function extend(bytes: Uint8Array, extraBytes: number): Uint8Array {
  const copy = new Uint8Array(bytes.length + extraBytes);
  copy.set(bytes, 0);
  return copy;
}

function expectRefusal(act: () => void, check: RevIndexCheck, reasonContains: string): void {
  // Captured OUTSIDE the try: an expect.fail thrown inside it would be
  // swallowed by this function's own catch and resurface as a confusing
  // downstream TypeError instead of the intended message.
  let caught: unknown;
  try {
    act();
  } catch (e) {
    caught = e;
  }
  if (caught === undefined) {
    expect.fail('Should have thrown');
  }
  const data = (caught as TsgitError).data;
  if (data.code !== 'INVALID_PACK_REV_INDEX') {
    expect.fail(`expected INVALID_PACK_REV_INDEX, got ${data.code}`);
  }
  expect(data.check).toBe(check);
  expect(data.reason).toContain(reasonContains);
}

describe('rev-index', () => {
  describe('parsePackRevIndex', () => {
    describe('Given a well-formed rev-index', () => {
      describe('When parsing 0 objects', () => {
        it('Then the parsed fields equal the spec', () => {
          // Arrange
          const spec = baseSpec({ body: [], packChecksum: new Uint8Array(20).fill(0xaa) });
          const sut = parsePackRevIndex;

          // Act
          const result = sut(buildRevIndex(spec), spec.digestLength, spec.body.length);

          // Assert
          expect(result.version).toBe(1);
          expect(result.hashId).toBe(1);
          expect(result.digestLength).toBe(20);
          expect(result.objectCount).toBe(0);
          expect(result.packChecksum).toEqual(spec.packChecksum);
        });
      });

      describe('When parsing 1 object', () => {
        it('Then the parsed fields equal the spec', () => {
          // Arrange
          const spec = baseSpec({ body: [0], packChecksum: new Uint8Array(20).fill(0xbb) });
          const sut = parsePackRevIndex;

          // Act
          const result = sut(buildRevIndex(spec), spec.digestLength, spec.body.length);

          // Assert
          expect(result.objectCount).toBe(1);
          expect(result.packChecksum).toEqual(spec.packChecksum);
        });
      });

      describe('When parsing a 12-object SHA-1 fixture (body prefix 1, 9, 11)', () => {
        it('Then the decoded body equals the spec', () => {
          // Arrange
          const spec = baseSpec();
          const sut = parsePackRevIndex;

          // Act
          const result = sut(buildRevIndex(spec), spec.digestLength, spec.body.length);
          const decoded = Array.from({ length: result.objectCount }, (_, p) =>
            revIndexPositionAt(result, p),
          );

          // Assert
          expect(result.objectCount).toBe(12);
          expect(result.packChecksum).toEqual(spec.packChecksum);
          expect(decoded).toEqual(spec.body);
        });
      });

      describe('When parsing hashId 2 with digestLength 32', () => {
        it('Then it accepts a 124-byte file — the Pin G sha256 twin of the 12-object fixture', () => {
          // Arrange
          const spec = baseSpec({
            hashId: 2,
            digestLength: 32,
            packChecksum: new Uint8Array(32).fill(0xcc),
          });
          const sut = parsePackRevIndex;
          const bytes = buildRevIndex(spec);

          // Act
          const result = sut(bytes, spec.digestLength, spec.body.length);

          // Assert
          expect(bytes.length).toBe(124);
          expect(result.hashId).toBe(2);
          expect(result.digestLength).toBe(32);
        });
      });

      describe('When parsing hashId 2 in a digestLength-20 (SHA-1) file', () => {
        it('Then it accepts — canonical git accepts the hashId/digestLength disagreement', () => {
          // Arrange
          const spec = baseSpec({ hashId: 2, digestLength: 20, body: [0] });
          const sut = parsePackRevIndex;

          // Act
          const result = sut(buildRevIndex(spec), spec.digestLength, spec.body.length);

          // Assert
          expect(result.hashId).toBe(2);
          expect(result.digestLength).toBe(20);
        });
      });
    });

    describe('Given a file below or at the too-small boundary', () => {
      describe('When parsing a zero-length file', () => {
        it('Then refuses with size / too small', () => {
          // Arrange & Act & Assert
          expectRefusal(
            () => parsePackRevIndex(new Uint8Array(0), 20, 5),
            'size',
            REASON_REV_INDEX_TOO_SMALL,
          );
        });
      });

      describe('When parsing an 11-byte file', () => {
        it('Then refuses with size / too small', () => {
          // Arrange & Act & Assert
          expectRefusal(
            () => parsePackRevIndex(new Uint8Array(11), 20, 5),
            'size',
            REASON_REV_INDEX_TOO_SMALL,
          );
        });
      });

      describe('When parsing a file truncated to 12 + 2·digestLength − 1 bytes', () => {
        it('Then refuses with size / too small', () => {
          // Arrange
          const fullBytes = buildRevIndex(
            baseSpec({ body: [0, 1, 2, 3, 4], packChecksum: new Uint8Array(20).fill(0xdd) }),
          );
          const bytes = truncate(fullBytes, 51);

          // Act & Assert
          expectRefusal(() => parsePackRevIndex(bytes, 20, 5), 'size', REASON_REV_INDEX_TOO_SMALL);
        });
      });
    });

    describe('Given a file at or past the too-small boundary but not its exact size', () => {
      describe('When parsing a file truncated to exactly 12 + 2·digestLength bytes, with objectCount > 0', () => {
        it('Then refuses with size / corrupt — one byte away from the too-small boundary', () => {
          // Arrange
          const fullBytes = buildRevIndex(
            baseSpec({ body: [0, 1, 2, 3, 4], packChecksum: new Uint8Array(20).fill(0xdd) }),
          );
          const bytes = truncate(fullBytes, 52);

          // Act & Assert
          expectRefusal(() => parsePackRevIndex(bytes, 20, 5), 'size', REASON_REV_INDEX_CORRUPT);
        });
      });

      describe('When parsing a file one byte short of its exact size', () => {
        it('Then refuses with size / corrupt', () => {
          // Arrange
          const fullBytes = buildRevIndex(
            baseSpec({ body: [0, 1, 2, 3, 4], packChecksum: new Uint8Array(20).fill(0xdd) }),
          );
          const bytes = truncate(fullBytes, fullBytes.length - 1);

          // Act & Assert
          expectRefusal(() => parsePackRevIndex(bytes, 20, 5), 'size', REASON_REV_INDEX_CORRUPT);
        });
      });

      describe('When parsing a file one byte longer than its exact size', () => {
        it('Then refuses with size / corrupt', () => {
          // Arrange
          const fullBytes = buildRevIndex(
            baseSpec({ body: [0, 1, 2, 3, 4], packChecksum: new Uint8Array(20).fill(0xdd) }),
          );
          const bytes = extend(fullBytes, 1);

          // Act & Assert
          expectRefusal(() => parsePackRevIndex(bytes, 20, 5), 'size', REASON_REV_INDEX_CORRUPT);
        });
      });

      describe('When parsing a file four bytes longer than its exact size', () => {
        it('Then refuses with size / corrupt', () => {
          // Arrange
          const fullBytes = buildRevIndex(
            baseSpec({ body: [0, 1, 2, 3, 4], packChecksum: new Uint8Array(20).fill(0xdd) }),
          );
          const bytes = extend(fullBytes, 4);

          // Act & Assert
          expectRefusal(() => parsePackRevIndex(bytes, 20, 5), 'size', REASON_REV_INDEX_CORRUPT);
        });
      });
    });

    describe('Given a rev-index with the 4th signature byte flipped', () => {
      describe('When parsing', () => {
        it('Then refuses with signature', () => {
          // Arrange
          const spec = baseSpec({ body: [0], packChecksum: new Uint8Array(20) });
          const bytes = pokeSignature(buildRevIndex(spec));

          // Act & Assert
          expectRefusal(
            () => parsePackRevIndex(bytes, spec.digestLength, spec.body.length),
            'signature',
            'signature',
          );
        });
      });
    });

    describe('Given a rev-index with version 0', () => {
      describe('When parsing', () => {
        it('Then refuses with version', () => {
          // Arrange
          const spec = baseSpec({ body: [0], packChecksum: new Uint8Array(20) });
          const bytes = pokeVersion(buildRevIndex(spec), 0);

          // Act & Assert
          expectRefusal(
            () => parsePackRevIndex(bytes, spec.digestLength, spec.body.length),
            'version',
            'version',
          );
        });
      });
    });

    describe('Given a rev-index with version 2', () => {
      describe('When parsing', () => {
        it('Then refuses with version — there is no v2', () => {
          // Arrange
          const spec = baseSpec({ body: [0], packChecksum: new Uint8Array(20) });
          const bytes = pokeVersion(buildRevIndex(spec), 2);

          // Act & Assert
          expectRefusal(
            () => parsePackRevIndex(bytes, spec.digestLength, spec.body.length),
            'version',
            'version',
          );
        });
      });
    });

    describe('Given a rev-index with version 255', () => {
      describe('When parsing', () => {
        it('Then refuses with version', () => {
          // Arrange
          const spec = baseSpec({ body: [0], packChecksum: new Uint8Array(20) });
          const bytes = pokeVersion(buildRevIndex(spec), 255);

          // Act & Assert
          expectRefusal(
            () => parsePackRevIndex(bytes, spec.digestLength, spec.body.length),
            'version',
            'version',
          );
        });
      });
    });

    describe('Given a rev-index with hashId 0', () => {
      describe('When parsing', () => {
        it('Then refuses with hash-id', () => {
          // Arrange
          const spec = baseSpec({ body: [0], packChecksum: new Uint8Array(20) });
          const bytes = pokeHashId(buildRevIndex(spec), 0);

          // Act & Assert
          expectRefusal(
            () => parsePackRevIndex(bytes, spec.digestLength, spec.body.length),
            'hash-id',
            'hash id',
          );
        });
      });
    });

    describe('Given a rev-index with hashId 3', () => {
      describe('When parsing', () => {
        it('Then refuses with hash-id', () => {
          // Arrange
          const spec = baseSpec({ body: [0], packChecksum: new Uint8Array(20) });
          const bytes = pokeHashId(buildRevIndex(spec), 3);

          // Act & Assert
          expectRefusal(
            () => parsePackRevIndex(bytes, spec.digestLength, spec.body.length),
            'hash-id',
            'hash id',
          );
        });
      });
    });
  });

  describe('revIndexPositionAt', () => {
    describe('Given a 12-object SHA-1 fixture', () => {
      describe('When reading p = 0', () => {
        it('Then returns the first body word', () => {
          // Arrange
          const spec = baseSpec();
          const sut = revIndexPositionAt;
          const rev = parsePackRevIndex(buildRevIndex(spec), spec.digestLength, spec.body.length);

          // Act
          const result = sut(rev, 0);

          // Assert
          expect(result).toBe(spec.body[0]);
        });
      });

      describe('When reading p = N − 1', () => {
        it('Then returns the last body word', () => {
          // Arrange
          const spec = baseSpec();
          const sut = revIndexPositionAt;
          const rev = parsePackRevIndex(buildRevIndex(spec), spec.digestLength, spec.body.length);

          // Act
          const result = sut(rev, rev.objectCount - 1);

          // Assert
          expect(result).toBe(spec.body[spec.body.length - 1]);
        });
      });

      describe('When reading p = N', () => {
        it('Then refuses with a bounds check', () => {
          // Arrange
          const spec = baseSpec();
          const rev = parsePackRevIndex(buildRevIndex(spec), spec.digestLength, spec.body.length);

          // Act & Assert
          expectRefusal(() => revIndexPositionAt(rev, rev.objectCount), 'size', 'out of range');
        });
      });
    });

    describe('Given a body with an out-of-range stored value (999 in a 12-object file)', () => {
      describe('When reading the position that holds it', () => {
        it('Then the value is returned, not refused — a verification verdict, not a parse refusal', () => {
          // Arrange
          const spec = baseSpec({ body: [999, 9, 11, 0, 2, 3, 4, 5, 6, 7, 8, 10] });
          const sut = revIndexPositionAt;
          const rev = parsePackRevIndex(buildRevIndex(spec), spec.digestLength, spec.body.length);

          // Act
          const result = sut(rev, 0);

          // Assert
          expect(result).toBe(999);
        });
      });
    });

    describe('Given a body that is not a permutation (body[0] === body[1])', () => {
      describe('When parsing and reading each position', () => {
        it('Then it parses and the values come back as stored', () => {
          // Arrange
          const spec = baseSpec({ body: [5, 5, 0, 1, 2, 3, 4, 6, 7, 8, 9, 10] });
          const rev = parsePackRevIndex(buildRevIndex(spec), spec.digestLength, spec.body.length);

          // Act
          const result = Array.from({ length: rev.objectCount }, (_, p) =>
            revIndexPositionAt(rev, p),
          );

          // Assert
          expect(result).toEqual(spec.body);
        });
      });
    });
  });
});
