/**
 * Unit tests for `gc`'s step-1b classifier (`classifyPackFiles`) — the pure
 * sibling-marker lookup that sorts every registered pack into exactly one
 * of four file classes: kept (`.keep`), promisor (`.promisor`), cruft
 * (`.mtimes`) or normal (none of the three).
 *
 * Coverage:
 *  - one test per class
 *  - one test per confusable marker PAIR (`.keep` wins over `.mtimes`;
 *    `.keep` wins over `.promisor`; `.promisor` wins over `.mtimes`)
 *  - a mixed directory partitions every pack into its own bucket in one pass
 */
import { describe, expect, it } from 'vitest';
import {
  classifyPackFiles,
  type RegisteredPack,
} from '../../../../src/application/primitives/pack-registry.js';

/** A minimal stand-in for a `RegisteredPack` — the classifier reads only
 *  `.name`, so nothing else needs a working implementation. */
const fakePack = (name: string): RegisteredPack => ({ name }) as unknown as RegisteredPack;

describe('classifyPackFiles', () => {
  describe('Given a pack whose only sibling marker is .keep', () => {
    describe('When packs are classified', () => {
      it('Then it lands in kept, and nowhere else', () => {
        // Arrange
        const pack = fakePack('pack-aaa');
        const fileNames = new Set(['pack-aaa.idx', 'pack-aaa.pack', 'pack-aaa.keep']);
        const sut = classifyPackFiles;

        // Act
        const result = sut([pack], fileNames);

        // Assert
        expect(result.kept).toEqual([pack]);
        expect(result.promisor).toEqual([]);
        expect(result.cruft).toEqual([]);
        expect(result.normal).toEqual([]);
      });
    });
  });

  describe('Given a pack whose only sibling marker is .promisor', () => {
    describe('When packs are classified', () => {
      it('Then it lands in promisor, and nowhere else', () => {
        // Arrange
        const pack = fakePack('pack-bbb');
        const fileNames = new Set(['pack-bbb.idx', 'pack-bbb.pack', 'pack-bbb.promisor']);
        const sut = classifyPackFiles;

        // Act
        const result = sut([pack], fileNames);

        // Assert
        expect(result.promisor).toEqual([pack]);
        expect(result.kept).toEqual([]);
        expect(result.cruft).toEqual([]);
        expect(result.normal).toEqual([]);
      });
    });
  });

  describe('Given a pack whose only sibling marker is .mtimes', () => {
    describe('When packs are classified', () => {
      it('Then it lands in cruft, and nowhere else', () => {
        // Arrange
        const pack = fakePack('pack-ccc');
        const fileNames = new Set(['pack-ccc.idx', 'pack-ccc.pack', 'pack-ccc.mtimes']);
        const sut = classifyPackFiles;

        // Act
        const result = sut([pack], fileNames);

        // Assert
        expect(result.cruft).toEqual([pack]);
        expect(result.kept).toEqual([]);
        expect(result.promisor).toEqual([]);
        expect(result.normal).toEqual([]);
      });
    });
  });

  describe('Given a pack carrying none of the three markers', () => {
    describe('When packs are classified', () => {
      it('Then it lands in normal, and nowhere else', () => {
        // Arrange
        const pack = fakePack('pack-ddd');
        const fileNames = new Set(['pack-ddd.idx', 'pack-ddd.pack']);
        const sut = classifyPackFiles;

        // Act
        const result = sut([pack], fileNames);

        // Assert
        expect(result.normal).toEqual([pack]);
        expect(result.kept).toEqual([]);
        expect(result.promisor).toEqual([]);
        expect(result.cruft).toEqual([]);
      });
    });
  });

  describe('Given a pack carrying both .keep and .mtimes', () => {
    describe('When packs are classified', () => {
      it('Then .keep wins — it lands in kept, never cruft', () => {
        // Arrange
        const pack = fakePack('pack-eee');
        const fileNames = new Set([
          'pack-eee.idx',
          'pack-eee.pack',
          'pack-eee.keep',
          'pack-eee.mtimes',
        ]);
        const sut = classifyPackFiles;

        // Act
        const result = sut([pack], fileNames);

        // Assert
        expect(result.kept).toEqual([pack]);
        expect(result.cruft).toEqual([]);
      });
    });
  });

  describe('Given a pack carrying both .keep and .promisor', () => {
    describe('When packs are classified', () => {
      it('Then .keep wins — it lands in kept, never promisor', () => {
        // Arrange
        const pack = fakePack('pack-fff');
        const fileNames = new Set([
          'pack-fff.idx',
          'pack-fff.pack',
          'pack-fff.keep',
          'pack-fff.promisor',
        ]);
        const sut = classifyPackFiles;

        // Act
        const result = sut([pack], fileNames);

        // Assert
        expect(result.kept).toEqual([pack]);
        expect(result.promisor).toEqual([]);
      });
    });
  });

  describe('Given a pack carrying both .promisor and .mtimes, with no .keep', () => {
    describe('When packs are classified', () => {
      it('Then .promisor wins — it lands in promisor, never cruft', () => {
        // Arrange
        const pack = fakePack('pack-ggg');
        const fileNames = new Set([
          'pack-ggg.idx',
          'pack-ggg.pack',
          'pack-ggg.promisor',
          'pack-ggg.mtimes',
        ]);
        const sut = classifyPackFiles;

        // Act
        const result = sut([pack], fileNames);

        // Assert
        expect(result.promisor).toEqual([pack]);
        expect(result.cruft).toEqual([]);
      });
    });
  });

  describe('Given one pack of each of the four classes in the same directory', () => {
    describe('When packs are classified', () => {
      it('Then each pack lands in its own bucket, in one pass', () => {
        // Arrange
        const kept = fakePack('pack-kept');
        const promisor = fakePack('pack-promisor');
        const cruft = fakePack('pack-cruft');
        const normal = fakePack('pack-normal');
        const fileNames = new Set([
          'pack-kept.idx',
          'pack-kept.pack',
          'pack-kept.keep',
          'pack-promisor.idx',
          'pack-promisor.pack',
          'pack-promisor.promisor',
          'pack-cruft.idx',
          'pack-cruft.pack',
          'pack-cruft.mtimes',
          'pack-normal.idx',
          'pack-normal.pack',
        ]);
        const sut = classifyPackFiles;

        // Act
        const result = sut([kept, promisor, cruft, normal], fileNames);

        // Assert
        expect(result.kept).toEqual([kept]);
        expect(result.promisor).toEqual([promisor]);
        expect(result.cruft).toEqual([cruft]);
        expect(result.normal).toEqual([normal]);
      });
    });
  });
});
