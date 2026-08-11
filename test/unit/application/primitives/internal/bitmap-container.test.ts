/**
 * Unit tests for the load → parse → range-validate pipeline both bitmap
 * flavours share, taken at the module's own seam: every function here is
 * I/O-free, so a hand-built byte string and a stub `Context` are the whole
 * fixture — no pack, no registry, no loader in the way.
 *
 * The decline shape is the subject throughout: `undefined` for the caller to
 * fall through with, and — for a present-but-faulty artefact — exactly one
 * `ctx.logger.warn` whose MESSAGE says which of the four refusals fired.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  declineBitmap,
  invertPositions,
  parseBitmapContainer,
  usableBitmapBytes,
  validateBitmapContainer,
} from '../../../../../src/application/primitives/internal/bitmap-container.js';
import { permissionDenied, TsgitError } from '../../../../../src/domain/error.js';
import type { Context } from '../../../../../src/ports/context.js';
import {
  type BitmapEntrySpec,
  type BitmapSpec,
  type BitmapStreamSpec,
  buildBitmap,
} from '../../../domain/storage/arbitraries.js';

const DIGEST_LENGTH = 20;
const ARTEFACT_NAME = 'pack-fixture.bitmap';

interface StubbedContext {
  readonly ctx: Context;
  readonly warn: ReturnType<typeof vi.fn>;
}

/** A `Context` carrying only what this pipeline reads: a digest length and a
 *  logger. Nothing here touches a FileSystem, so nothing more is needed. */
function stubContext(): StubbedContext {
  const warn = vi.fn();
  const ctx = {
    hashConfig: { digestLength: DIGEST_LENGTH },
    logger: { warn },
  } as unknown as Context;
  return { ctx, warn };
}

const emptyStream = (bitSize: number): BitmapStreamSpec => ({ bitSize, bits: [] });

function bitmapBytes(
  entries: ReadonlyArray<BitmapEntrySpec>,
  commitBits: ReadonlyArray<number> = [],
  bitSize = 2,
): Uint8Array {
  const spec: BitmapSpec = {
    optionFlags: 1,
    digestLength: DIGEST_LENGTH,
    checksum: new Uint8Array(DIGEST_LENGTH).fill(0xbb),
    typeStreams: [
      { bitSize, bits: commitBits },
      emptyStream(bitSize),
      emptyStream(bitSize),
      emptyStream(bitSize),
    ],
    entries,
    trailingBytes: 0,
  };
  return buildBitmap(spec);
}

const terminatorEntry = (position: number): BitmapEntrySpec => ({
  position,
  xorOffset: 0,
  flags: 0,
  bitSize: 0,
  bits: [],
});

// ---------------------------------------------------------------------------
// invertPositions — the permutation proof
// ---------------------------------------------------------------------------

describe('Given a position table that is a genuine permutation of its own range', () => {
  describe('When it is inverted', () => {
    it('Then every own position names the bit position that stored it', () => {
      // Arrange
      const positions = new Uint32Array([2, 0, 1]);
      const sut = invertPositions;

      // Act
      const result = sut(positions);

      // Assert
      expect(result).toEqual(new Uint32Array([1, 2, 0]));
    });
  });
});

describe('Given a position table storing an own position past its own end', () => {
  describe('When it is inverted', () => {
    it('Then it declines rather than write past the inverse', () => {
      // Arrange — 5 is beyond a 2-slot table, and no slot is claimed twice,
      // so only the range arm of the guard can reject it.
      const positions = new Uint32Array([0, 5]);
      const sut = invertPositions;

      // Act
      const result = sut(positions);

      // Assert
      expect(result).toBeUndefined();
    });
  });
});

describe('Given a position table storing an own position exactly equal to its length', () => {
  describe('When it is inverted', () => {
    it('Then it declines — the last valid own position is length - 1', () => {
      // Arrange
      const positions = new Uint32Array([0, 2]);
      const sut = invertPositions;

      // Act
      const result = sut(positions);

      // Assert
      expect(result).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// declineBitmap — the one decline shape, message included
// ---------------------------------------------------------------------------

describe('Given a reason for declining a present-but-faulty artefact', () => {
  describe('When the decline is taken', () => {
    it('Then one warn carries the prefixed reason and the artefact name, and undefined is returned', () => {
      // Arrange
      const { ctx, warn } = stubContext();
      const sut = declineBitmap;

      // Act
      const result = sut(ctx, 'something specific went wrong', ARTEFACT_NAME);

      // Assert
      expect(result).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('bitmapBinding: something specific went wrong', {
        bitmap: ARTEFACT_NAME,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// parseBitmapContainer — over-long entry table, structural refusal, and the
// fault it must never swallow
// ---------------------------------------------------------------------------

describe('Given a bitmap declaring more entries than the artefact has objects', () => {
  describe('When the container is parsed', () => {
    it('Then it declines, naming the over-long entry table in the warn message', () => {
      // Arrange
      const bytes = bitmapBytes([terminatorEntry(0), terminatorEntry(1), terminatorEntry(0)]);
      const { ctx, warn } = stubContext();
      const sut = parseBitmapContainer;

      // Act
      const result = sut(ctx, bytes, ARTEFACT_NAME, 'pack', 2);

      // Assert
      expect(result).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'bitmapBinding: pack bitmap declares more entries than the artefact has objects, declining',
        { bitmap: ARTEFACT_NAME },
      );
    });
  });
});

describe('Given a midx bitmap whose container bytes carry the wrong magic', () => {
  describe('When the container is parsed', () => {
    it('Then it declines, naming the flavour and the fault in the warn message', () => {
      // Arrange
      const bytes = bitmapBytes([terminatorEntry(0)]);
      const corrupted = bytes.slice();
      new DataView(corrupted.buffer).setUint32(0, 0xdeadbeef);
      const { ctx, warn } = stubContext();
      const sut = parseBitmapContainer;

      // Act
      const result = sut(ctx, corrupted, ARTEFACT_NAME, 'midx', 2);

      // Assert
      expect(result).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      const [message, context] = warn.mock.calls[0] ?? [];
      expect(message).toBe('bitmapBinding: discarding unusable midx bitmap');
      expect(context).toMatchObject({ bitmap: ARTEFACT_NAME, code: 'INVALID_PACK_BITMAP' });
    });
  });
});

describe('Given a Context whose digest length read raises a fault that is not a bitmap refusal', () => {
  describe('When the container is parsed', () => {
    it('Then the fault propagates untouched and nothing is warned', () => {
      // Arrange — the catch recognises exactly one code; every other fault is
      // a defect, and a defect that is logged and swallowed is a defect lost.
      const warn = vi.fn();
      const ctx = {
        hashConfig: {
          get digestLength(): number {
            throw permissionDenied('/objects/pack/pack-fixture.bitmap');
          },
        },
        logger: { warn },
      } as unknown as Context;
      const bytes = bitmapBytes([terminatorEntry(0)]);
      const sut = parseBitmapContainer;

      // Act
      let caught: unknown;
      try {
        sut(ctx, bytes, ARTEFACT_NAME, 'pack', 2);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data).toEqual({
        code: 'PERMISSION_DENIED',
        path: '/objects/pack/pack-fixture.bitmap',
      });
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// usableBitmapBytes — the refused load is the only loud outcome
// ---------------------------------------------------------------------------

describe('Given a bitmap load refused by the artefact source', () => {
  describe('When usable bytes are resolved from it', () => {
    it('Then it declines, naming the flavour and the refusal in the warn message', () => {
      // Arrange
      const { ctx, warn } = stubContext();
      const sut = usableBitmapBytes;

      // Act
      const result = sut(ctx, 'pack', ARTEFACT_NAME, {
        kind: 'refused',
        data: permissionDenied('/objects/pack/pack-fixture.bitmap').data,
      });

      // Assert
      expect(result).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      const [message, context] = warn.mock.calls[0] ?? [];
      expect(message).toBe('bitmapBinding: discarding unusable pack bitmap');
      expect(context).toMatchObject({ bitmap: ARTEFACT_NAME, code: 'PERMISSION_DENIED' });
    });
  });
});

// ---------------------------------------------------------------------------
// validateBitmapContainer — the out-of-range decline owns its own message
// ---------------------------------------------------------------------------

describe('Given a bitmap whose commits stream sets a bit past the artefact object count', () => {
  describe('When the container is validated', () => {
    it('Then it declines, naming the out-of-range position in the warn message', () => {
      // Arrange
      const bytes = bitmapBytes([terminatorEntry(0)], [5], 6);
      const { ctx, warn } = stubContext();
      const sut = validateBitmapContainer;

      // Act
      const result = sut(ctx, 'pack', ARTEFACT_NAME, bytes, 2);

      // Assert
      expect(result).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'bitmapBinding: pack bitmap position out of range, declining',
        { bitmap: ARTEFACT_NAME },
      );
    });
  });
});
