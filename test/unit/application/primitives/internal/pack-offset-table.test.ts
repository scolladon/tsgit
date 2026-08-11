import { describe, expect, it, vi } from 'vitest';
import type { ArtefactLoad } from '../../../../../src/application/primitives/internal/pack-artefact-source.js';
import {
  REV_INDEX_MIN_OBJECTS,
  resolveSortedOffsets,
} from '../../../../../src/application/primitives/internal/pack-offset-table.js';
import {
  invalidPackRevIndex,
  type PackRevIndex,
  REASON_REV_INDEX_CORRUPT,
  REV_HEADER_SIZE,
} from '../../../../../src/domain/storage/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const DIGEST_LENGTH = 20;

/**
 * The offsets a pack of `count` objects might carry, deliberately NOT in
 * ascending order so a result that merely echoes its input is
 * distinguishable from one that actually sorted.
 */
const descendingOffsets = (count: number): ReadonlyArray<number> =>
  Array.from({ length: count }, (_unused, i) => (count - i) * 8);

const ascending = (raw: ReadonlyArray<number>): Float64Array =>
  Float64Array.from([...raw].sort((a, b) => a - b));

/** A `PackRevIndex` over real bytes — `revIndexPositionAt` reads the body
 *  through the DataView, so a plain object standing in for it would not
 *  exercise the same path. */
const revIndexOf = (positions: ReadonlyArray<number>): PackRevIndex => {
  const bytes = new Uint8Array(REV_HEADER_SIZE + positions.length * 4 + 2 * DIGEST_LENGTH);
  const view = new DataView(bytes.buffer);
  positions.forEach((position, packPosition) => {
    view.setUint32(REV_HEADER_SIZE + packPosition * 4, position);
  });
  return {
    version: 1,
    hashId: 1,
    digestLength: DIGEST_LENGTH,
    objectCount: positions.length,
    packChecksum: new Uint8Array(DIGEST_LENGTH),
    _bytes: bytes,
    _view: view,
  } as PackRevIndex;
};

/** The identity permutation: pack position `p` maps to index position `p`,
 *  so a gather returns `raw` in its original order. */
const identityPositions = (count: number): ReadonlyArray<number> =>
  Array.from({ length: count }, (_unused, i) => i);

const usable = (rev: PackRevIndex): ArtefactLoad<PackRevIndex> => ({
  kind: 'usable',
  value: rev,
  bytes: new Uint8Array(0),
});

const contextWith = (warn: ReturnType<typeof vi.fn>): Context =>
  ({ logger: { warn } }) as unknown as Context;

describe('resolveSortedOffsets', () => {
  describe('Given a pack below the object-count threshold and a loader that would resolve', () => {
    describe('When resolveSortedOffsets runs', () => {
      it('Then it sorts and never calls the loader — the threshold skips the read, not just the gather', async () => {
        // Arrange — the whole saving the threshold exists for is the I/O, so
        // the load never being FORCED is the property under test, not merely
        // that a gathered order was computed and discarded.
        const raw = descendingOffsets(REV_INDEX_MIN_OBJECTS - 1);
        const loadRevIndex = vi.fn(
          async (): Promise<ArtefactLoad<PackRevIndex>> => ({
            kind: 'absent',
          }),
        );
        const sut = resolveSortedOffsets;

        // Act
        const result = await sut(contextWith(vi.fn()), 'pack-small', raw, loadRevIndex);

        // Assert
        expect(loadRevIndex).not.toHaveBeenCalled();
        expect(result).toEqual(ascending(raw));
      });
    });
  });

  describe('Given a pack exactly at the object-count threshold with a usable .rev', () => {
    describe('When resolveSortedOffsets runs', () => {
      it('Then it loads the artefact and returns the order that body implies', async () => {
        // Arrange — the boundary itself: one object fewer took the sort arm
        // above, so this pins which side of the comparison the threshold is on.
        const raw = descendingOffsets(REV_INDEX_MIN_OBJECTS);
        const loadRevIndex = vi.fn(
          async (): Promise<ArtefactLoad<PackRevIndex>> =>
            usable(revIndexOf(identityPositions(raw.length))),
        );
        const sut = resolveSortedOffsets;

        // Act
        const result = await sut(contextWith(vi.fn()), 'pack-big', raw, loadRevIndex);

        // Assert — the identity body implies `raw` UNSORTED, which the sort
        // arm could never produce.
        expect(loadRevIndex).toHaveBeenCalledTimes(1);
        expect(result).toEqual(Float64Array.from(raw));
      });
    });
  });

  describe('Given an above-threshold pack whose .rev is refused', () => {
    describe('When resolveSortedOffsets runs', () => {
      it('Then it falls back to the sort and warns once, naming the artefact', async () => {
        // Arrange
        const raw = descendingOffsets(REV_INDEX_MIN_OBJECTS);
        const warn = vi.fn();
        const loadRevIndex = async (): Promise<ArtefactLoad<PackRevIndex>> => ({
          kind: 'refused',
          data: invalidPackRevIndex('size', REASON_REV_INDEX_CORRUPT).data,
        });
        const sut = resolveSortedOffsets;

        // Act
        const result = await sut(contextWith(warn), 'pack-refused', raw, loadRevIndex);

        // Assert
        expect(result).toEqual(ascending(raw));
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[1]).toMatchObject({
          rev: 'pack-refused.rev',
          reason: REASON_REV_INDEX_CORRUPT,
        });
      });
    });
  });

  describe('Given an above-threshold pack whose .rev is absent', () => {
    describe('When resolveSortedOffsets runs', () => {
      it('Then it falls back to the sort in silence, as git says nothing about an artefact it has not got', async () => {
        // Arrange
        const raw = descendingOffsets(REV_INDEX_MIN_OBJECTS);
        const warn = vi.fn();
        const loadRevIndex = async (): Promise<ArtefactLoad<PackRevIndex>> => ({ kind: 'absent' });
        const sut = resolveSortedOffsets;

        // Act
        const result = await sut(contextWith(warn), 'pack-absent', raw, loadRevIndex);

        // Assert
        expect(result).toEqual(ascending(raw));
        expect(warn).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given an above-threshold pack whose .rev is unreadable', () => {
    describe('When resolveSortedOffsets runs', () => {
      it('Then it falls back to the sort in silence — cannot-tell is not corrupt', async () => {
        // Arrange
        const raw = descendingOffsets(REV_INDEX_MIN_OBJECTS);
        const warn = vi.fn();
        const loadRevIndex = async (): Promise<ArtefactLoad<PackRevIndex>> => ({
          kind: 'unreadable',
        });
        const sut = resolveSortedOffsets;

        // Act
        const result = await sut(contextWith(warn), 'pack-unreadable', raw, loadRevIndex);

        // Assert
        expect(result).toEqual(ascending(raw));
        expect(warn).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given an above-threshold pack whose .rev body names a position outside the pack', () => {
    describe('When resolveSortedOffsets runs', () => {
      it('Then it falls back to the sort and warns once about the out-of-range position', async () => {
        // Arrange — one stored position past the end is enough: the gather
        // must refuse the whole body rather than read off the end of `raw`.
        const raw = descendingOffsets(REV_INDEX_MIN_OBJECTS);
        const positions = [...identityPositions(raw.length)];
        positions[0] = raw.length;
        const warn = vi.fn();
        const loadRevIndex = async (): Promise<ArtefactLoad<PackRevIndex>> =>
          usable(revIndexOf(positions));
        const sut = resolveSortedOffsets;

        // Act
        const result = await sut(contextWith(warn), 'pack-oob', raw, loadRevIndex);

        // Assert
        expect(result).toEqual(ascending(raw));
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[1]).toMatchObject({ rev: 'pack-oob.rev' });
      });
    });
  });
});
