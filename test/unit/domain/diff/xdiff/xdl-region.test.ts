import { describe, expect, it } from 'vitest';
import {
  type LineRegion,
  markRegion,
  type RegionSink,
} from '../../../../../src/domain/diff/xdiff/xdl-region.js';

const OURS_LINES = 6;
const THEIRS_LINES = 5;

const freshSink = (): RegionSink => ({
  oursChanged: new Uint8Array(OURS_LINES),
  theirsChanged: new Uint8Array(THEIRS_LINES),
  fallback: () => undefined,
});

describe('markRegion', () => {
  describe('Given 1-based regions on each side, When marked', () => {
    it.each<{ label: string; region: LineRegion; ours: number[]; theirs: number[] }>([
      {
        label: 'a window inside both sides',
        region: { line1: 2, count1: 3, line2: 4, count2: 1 },
        ours: [0, 1, 1, 1, 0, 0],
        theirs: [0, 0, 0, 1, 0],
      },
      {
        label: 'windows starting at the first line',
        region: { line1: 1, count1: 1, line2: 1, count2: 2 },
        ours: [1, 0, 0, 0, 0, 0],
        theirs: [1, 1, 0, 0, 0],
      },
      {
        label: 'windows ending at the last line',
        region: { line1: 5, count1: 2, line2: 5, count2: 1 },
        ours: [0, 0, 0, 0, 1, 1],
        theirs: [0, 0, 0, 0, 1],
      },
      {
        label: 'an empty window on one side',
        region: { line1: 3, count1: 0, line2: 2, count2: 2 },
        ours: [0, 0, 0, 0, 0, 0],
        theirs: [0, 1, 1, 0, 0],
      },
    ])('Then $label marks exactly those lines', ({ region, ours, theirs }) => {
      // Arrange
      const sink = freshSink();
      const sut = markRegion;

      // Act
      sut(sink, region);

      // Assert
      expect([...sink.oursChanged]).toEqual(ours);
      expect([...sink.theirsChanged]).toEqual(theirs);
    });
  });

  describe('Given lines another region already marked', () => {
    describe('When a disjoint region is marked', () => {
      it('Then the earlier marks stay', () => {
        // Arrange
        const sink = freshSink();
        markRegion(sink, { line1: 1, count1: 1, line2: 1, count2: 1 });
        const sut = markRegion;

        // Act
        sut(sink, { line1: 6, count1: 1, line2: 5, count2: 1 });

        // Assert
        expect([...sink.oursChanged]).toEqual([1, 0, 0, 0, 0, 1]);
        expect([...sink.theirsChanged]).toEqual([1, 0, 0, 0, 1]);
      });
    });
  });
});
