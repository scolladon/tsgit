import { describe, expect, it } from 'vitest';
import type { LineKey } from '../../../../../src/domain/diff/whitespace.js';
import { classifyLines, hashLineSide } from '../../../../../src/domain/diff/xdiff/xdl-classify.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** `classifyLines`, hashing both sides from scratch — this suite's default shape. */
const classify = (
  ours: ReadonlyArray<Uint8Array>,
  theirs: ReadonlyArray<Uint8Array>,
  lineKey?: LineKey,
) =>
  classifyLines(ours, theirs, lineKey, hashLineSide(ours, lineKey), hashLineSide(theirs, lineKey));

describe('classifyLines', () => {
  describe('Given both sides empty', () => {
    describe('When classifyLines is called', () => {
      it('Then it returns empty class arrays and a zero class count', () => {
        // Arrange
        const sut = classify;
        const ours: ReadonlyArray<Uint8Array> = [];
        const theirs: ReadonlyArray<Uint8Array> = [];

        // Act
        const result = sut(ours, theirs);

        // Assert
        expect(Array.from(result.ours)).toEqual([]);
        expect(Array.from(result.theirs)).toEqual([]);
        expect(result.classCount).toBe(0);
      });
    });
  });

  describe('Given the same line content on both sides', () => {
    describe('When classifyLines is called', () => {
      it('Then the two lines share one class id', () => {
        // Arrange
        const sut = classify;
        const ours = [enc('same\n')];
        const theirs = [enc('same\n')];

        // Act
        const result = sut(ours, theirs);

        // Assert
        expect(result.ours[0]).toBe(result.theirs[0]);
        expect(result.classCount).toBe(1);
      });
    });
  });

  describe('Given a line terminated by LF and its unterminated counterpart', () => {
    describe('When classifyLines is called', () => {
      it('Then they are classified as two different lines', () => {
        // Arrange — same content, but only one side carries the trailing LF
        const sut = classify;
        const ours = [enc('same\n')];
        const theirs = [enc('same')];

        // Act
        const result = sut(ours, theirs);

        // Assert
        expect(result.ours[0]).not.toBe(result.theirs[0]);
        expect(result.classCount).toBe(2);
      });
    });
  });

  describe('Given a lineKey with whitespace mode all', () => {
    describe('When two lines differ only by an internal space', () => {
      it('Then they share one class id', () => {
        // Arrange
        const sut = classify;
        const ours = [enc('a b\n')];
        const theirs = [enc('ab\n')];
        const lineKey = { mode: 'all' as const, ignoreCrAtEol: false };

        // Act
        const result = sut(ours, theirs, lineKey);

        // Assert
        expect(result.ours[0]).toBe(result.theirs[0]);
        expect(result.classCount).toBe(1);
      });
    });

    describe('When no lineKey is given for the same two lines', () => {
      it('Then they are classified as two different lines', () => {
        // Arrange
        const sut = classify;
        const ours = [enc('a b\n')];
        const theirs = [enc('ab\n')];

        // Act
        const result = sut(ours, theirs);

        // Assert
        expect(result.ours[0]).not.toBe(result.theirs[0]);
        expect(result.classCount).toBe(2);
      });
    });
  });

  describe('Given two distinct lines whose hash lands in the same table bucket', () => {
    describe('When classifyLines is called', () => {
      it('Then bytesEqual disambiguates them into two different class ids', () => {
        // Arrange — verified by direct computation: at the capacity this
        // pair produces (2 lines total => table size 4), `aa\n` and `ae\n`
        // hash into the same bucket under the djb2 fold.
        const sut = classify;
        const ours = [enc('aa\n')];
        const theirs = [enc('ae\n')];

        // Act
        const result = sut(ours, theirs);

        // Assert
        expect(result.ours[0]).not.toBe(result.theirs[0]);
        expect(result.classCount).toBe(2);
      });
    });
  });

  describe('Given repeated and fresh lines across both sides', () => {
    describe('When classifyLines is called', () => {
      it('Then ids are assigned in first-appearance order, ours then theirs', () => {
        // Arrange
        const sut = classify;
        const ours = [enc('b\n'), enc('a\n')];
        const theirs = [enc('a\n'), enc('c\n')];

        // Act
        const result = sut(ours, theirs);

        // Assert — 'b' is class 0, 'a' is class 1 (first seen in ours), 'c' is class 2
        expect(Array.from(result.ours)).toEqual([0, 1]);
        expect(Array.from(result.theirs)).toEqual([1, 2]);
        expect(result.classCount).toBe(3);
      });
    });
  });

  describe('Given lines only on one side', () => {
    describe('When theirs is empty', () => {
      it('Then theirs is an empty class array and ours is classified normally', () => {
        // Arrange
        const sut = classify;
        const ours = [enc('only\n')];
        const theirs: ReadonlyArray<Uint8Array> = [];

        // Act
        const result = sut(ours, theirs);

        // Assert
        expect(Array.from(result.theirs)).toEqual([]);
        expect(Array.from(result.ours)).toEqual([0]);
        expect(result.classCount).toBe(1);
      });
    });
  });

  describe('Given a hash array already computed elsewhere for one side', () => {
    describe('When classifyLines is given that array instead of a fresh one', () => {
      it('Then classification is identical to hashing both sides from scratch', () => {
        // Arrange — theirs' hash was computed once, independently, by whoever
        // held these lines before this call (blame's hop-to-hop cache).
        const sut = classifyLines;
        const ours = [enc('b\n'), enc('a\n')];
        const theirs = [enc('a\n'), enc('c\n')];
        const theirsHashes = hashLineSide(theirs, undefined);

        // Act
        const result = sut(ours, theirs, undefined, hashLineSide(ours, undefined), theirsHashes);

        // Assert
        expect(Array.from(result.ours)).toEqual([0, 1]);
        expect(Array.from(result.theirs)).toEqual([1, 2]);
        expect(result.classCount).toBe(3);
      });
    });
  });

  describe('Given hashLineSide is handed an output array under an active lineKey', () => {
    describe('When hashLineSide returns', () => {
      it('Then the array holds each line’s normalized bytes, aligned index-for-index with the input', () => {
        // Arrange
        const sut = hashLineSide;
        const key: LineKey = { mode: 'all', ignoreCrAtEol: false };
        const lines = [enc('  a\n'), enc('b  \n')];
        const normalizedOut: Uint8Array[] = [];

        // Act
        sut(lines, key, normalizedOut);

        // Assert
        expect(normalizedOut).toEqual([enc('a'), enc('b')]);
      });
    });
  });

  describe('Given classifyLines is handed the normalized bytes hashLineSide already produced', () => {
    describe('When classifyLines classifies using them instead of re-normalizing', () => {
      it('Then classification is identical to the same call without them', () => {
        // Arrange — a whitespace-only pair, so re-normalizing (or not) is the
        // only thing that could change whether the two lines share a class.
        const sut = classifyLines;
        const key: LineKey = { mode: 'all', ignoreCrAtEol: false };
        const ours = [enc('  a\n')];
        const theirs = [enc('a  \n')];
        const oursNormalized: Uint8Array[] = [];
        const theirsNormalized: Uint8Array[] = [];
        const oursHashes = hashLineSide(ours, key, oursNormalized);
        const theirsHashes = hashLineSide(theirs, key, theirsNormalized);

        // Act
        const shared = sut(
          ours,
          theirs,
          key,
          oursHashes,
          theirsHashes,
          oursNormalized,
          theirsNormalized,
        );
        const fromScratch = classify(ours, theirs, key);

        // Assert
        expect(Array.from(shared.ours)).toEqual([0]);
        expect(Array.from(shared.theirs)).toEqual([0]);
        expect(shared).toEqual(fromScratch);
      });
    });
  });
});
