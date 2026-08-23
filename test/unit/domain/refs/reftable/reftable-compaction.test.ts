import { describe, expect, it } from 'vitest';
import {
  compactionMetric,
  suggestCompactionSegment,
} from '../../../../../src/domain/refs/reftable/reftable-compaction.js';

const GEOMETRIC_FACTOR = 2;

/**
 * The 59 usable transitions of a real 60-step replay against `git 2.55.0`
 * (`git init --ref-format=reftable`, SHA-1/v1): a repository seeded with
 * 3000 refs (base table metric 82072), then driven through 60 sequential
 * single-ref `git update-ref` calls in a scrubbed-env throwaway directory,
 * recording `tables.list` and each table's on-disk size before and after
 * every call. `candidate` is the metric vector immediately before that
 * step's merge decision (the surviving prior tables plus the just-appended
 * table, whose own metric — 143 for a fresh single-record table at this
 * name width — is confirmed constant across every step where it is directly
 * observable, i.e. every step that does *not* itself merge). `start`/`end`
 * are the segment git's own auto-compaction actually chose, recovered from
 * the update_index ranges `tables.list` encodes in each table's filename.
 * The first (61st) transition is dropped: its "before" state included an
 * unrelated locked probe table whose own raw size could not be cleanly
 * isolated, so it is not a clean measurement — 59 remain, each independently
 * self-consistent with its neighbours.
 */
const MEASURED_V1_TRANSITIONS: ReadonlyArray<{
  readonly step: number;
  readonly candidate: readonly number[];
  readonly start: number;
  readonly end: number;
}> = [
  { step: 2, candidate: [82072, 175, 143], start: 1, end: 3 },
  { step: 3, candidate: [82072, 206, 143], start: 1, end: 3 },
  { step: 4, candidate: [82072, 237, 143], start: 1, end: 3 },
  { step: 5, candidate: [82072, 267, 143], start: 1, end: 3 },
  { step: 6, candidate: [82072, 298, 143], start: 0, end: 0 },
  { step: 7, candidate: [82072, 298, 143, 143], start: 1, end: 4 },
  { step: 8, candidate: [82072, 360, 143], start: 0, end: 0 },
  { step: 9, candidate: [82072, 360, 143, 143], start: 1, end: 4 },
  { step: 10, candidate: [82072, 422, 143], start: 0, end: 0 },
  { step: 11, candidate: [82072, 422, 143, 143], start: 1, end: 4 },
  { step: 12, candidate: [82072, 484, 143], start: 0, end: 0 },
  { step: 13, candidate: [82072, 484, 143, 143], start: 1, end: 4 },
  { step: 14, candidate: [82072, 540, 143], start: 0, end: 0 },
  { step: 15, candidate: [82072, 540, 143, 143], start: 1, end: 4 },
  { step: 16, candidate: [82072, 597, 143], start: 0, end: 0 },
  { step: 17, candidate: [82072, 597, 143, 143], start: 2, end: 4 },
  { step: 18, candidate: [82072, 597, 176, 143], start: 1, end: 4 },
  { step: 19, candidate: [82072, 709, 143], start: 0, end: 0 },
  { step: 20, candidate: [82072, 709, 143, 143], start: 2, end: 4 },
  { step: 21, candidate: [82072, 709, 178, 143], start: 2, end: 4 },
  { step: 22, candidate: [82072, 709, 211, 143], start: 2, end: 4 },
  { step: 23, candidate: [82072, 709, 242, 143], start: 1, end: 4 },
  { step: 24, candidate: [82072, 854, 143], start: 0, end: 0 },
  { step: 25, candidate: [82072, 854, 143, 143], start: 2, end: 4 },
  { step: 26, candidate: [82072, 854, 176, 143], start: 2, end: 4 },
  { step: 27, candidate: [82072, 854, 207, 143], start: 2, end: 4 },
  { step: 28, candidate: [82072, 854, 238, 143], start: 2, end: 4 },
  { step: 29, candidate: [82072, 854, 269, 143], start: 2, end: 4 },
  { step: 30, candidate: [82072, 854, 300, 143], start: 0, end: 0 },
  { step: 31, candidate: [82072, 854, 300, 143, 143], start: 1, end: 5 },
  { step: 32, candidate: [82072, 1084, 143], start: 0, end: 0 },
  { step: 33, candidate: [82072, 1084, 143, 143], start: 2, end: 4 },
  { step: 34, candidate: [82072, 1084, 176, 143], start: 2, end: 4 },
  { step: 35, candidate: [82072, 1084, 207, 143], start: 2, end: 4 },
  { step: 36, candidate: [82072, 1084, 238, 143], start: 2, end: 4 },
  { step: 37, candidate: [82072, 1084, 269, 143], start: 2, end: 4 },
  { step: 38, candidate: [82072, 1084, 300, 143], start: 0, end: 0 },
  { step: 39, candidate: [82072, 1084, 300, 143, 143], start: 1, end: 5 },
  { step: 40, candidate: [82072, 1334, 143], start: 0, end: 0 },
  { step: 41, candidate: [82072, 1334, 143, 143], start: 2, end: 4 },
  { step: 42, candidate: [82072, 1334, 176, 143], start: 2, end: 4 },
  { step: 43, candidate: [82072, 1334, 207, 143], start: 2, end: 4 },
  { step: 44, candidate: [82072, 1334, 238, 143], start: 2, end: 4 },
  { step: 45, candidate: [82072, 1334, 269, 143], start: 2, end: 4 },
  { step: 46, candidate: [82072, 1334, 300, 143], start: 0, end: 0 },
  { step: 47, candidate: [82072, 1334, 300, 143, 143], start: 2, end: 5 },
  { step: 48, candidate: [82072, 1334, 362, 143], start: 0, end: 0 },
  { step: 49, candidate: [82072, 1334, 362, 143, 143], start: 2, end: 5 },
  { step: 50, candidate: [82072, 1334, 423, 143], start: 0, end: 0 },
  { step: 51, candidate: [82072, 1334, 423, 143, 143], start: 1, end: 5 },
  { step: 52, candidate: [82072, 1788, 143], start: 0, end: 0 },
  { step: 53, candidate: [82072, 1788, 143, 143], start: 2, end: 4 },
  { step: 54, candidate: [82072, 1788, 176, 143], start: 2, end: 4 },
  { step: 55, candidate: [82072, 1788, 207, 143], start: 2, end: 4 },
  { step: 56, candidate: [82072, 1788, 238, 143], start: 2, end: 4 },
  { step: 57, candidate: [82072, 1788, 269, 143], start: 2, end: 4 },
  { step: 58, candidate: [82072, 1788, 300, 143], start: 0, end: 0 },
  { step: 59, candidate: [82072, 1788, 300, 143, 143], start: 2, end: 5 },
  { step: 60, candidate: [82072, 1788, 362, 143], start: 0, end: 0 },
];

/**
 * A real 10-transition replay against a `--ref-format=reftable
 * --object-format=sha256` repository (git 2.55.0, v2), same methodology,
 * base table metric 61590, per-step fresh-table metric confirmed constant
 * at 168 (`267 - 99`) at every directly-observable step. Every one of the
 * 10 transitions is clean — no probe contamination, unlike step 1 of the v1
 * run above.
 */
const MEASURED_V2_TRANSITIONS: ReadonlyArray<{
  readonly step: number;
  readonly candidate: readonly number[];
  readonly start: number;
  readonly end: number;
}> = [
  { step: 1, candidate: [61590, 168], start: 0, end: 0 },
  { step: 2, candidate: [61590, 168, 168], start: 1, end: 3 },
  { step: 3, candidate: [61590, 213, 168], start: 1, end: 3 },
  { step: 4, candidate: [61590, 256, 168], start: 1, end: 3 },
  { step: 5, candidate: [61590, 299, 168], start: 1, end: 3 },
  { step: 6, candidate: [61590, 341, 168], start: 0, end: 0 },
  { step: 7, candidate: [61590, 341, 168, 168], start: 1, end: 4 },
  { step: 8, candidate: [61590, 427, 168], start: 0, end: 0 },
  { step: 9, candidate: [61590, 427, 168, 168], start: 1, end: 4 },
  { step: 10, candidate: [61590, 513, 168], start: 0, end: 0 },
];

describe('reftable-compaction', () => {
  describe('Given a table’s on-disk byte size', () => {
    describe('When computing the v1 compaction metric', () => {
      it('Then it subtracts the footer plus header-minus-one overhead (91)', () => {
        // Arrange
        const sut = compactionMetric;

        // Act
        const result = sut(82163, 1);

        // Assert
        expect(result).toBe(82072);
      });
    });

    describe('When computing the v2 compaction metric', () => {
      it('Then it subtracts the footer plus header-minus-one overhead (99)', () => {
        // Arrange
        const sut = compactionMetric;

        // Act
        const result = sut(61689, 2);

        // Assert
        expect(result).toBe(61590);
      });
    });
  });

  describe('Given the 59 usable transitions of a real 60-step git 2.55.0 v1 replay', () => {
    describe('When suggesting a compaction segment for the pre-transition metric vector', () => {
      it.each(MEASURED_V1_TRANSITIONS)(
        'Then step $step reproduces git’s own segment [$start, $end)',
        ({ candidate, start, end }) => {
          // Arrange
          const sut = suggestCompactionSegment;

          // Act
          const result = sut(candidate, GEOMETRIC_FACTOR);

          // Assert
          expect(result).toStrictEqual({ start, end });
        },
      );
    });
  });

  describe('Given the 10 transitions of a real git 2.55.0 v2/SHA-256 replay', () => {
    describe('When suggesting a compaction segment for the pre-transition metric vector', () => {
      it.each(MEASURED_V2_TRANSITIONS)(
        'Then step $step reproduces git’s own segment [$start, $end)',
        ({ candidate, start, end }) => {
          // Arrange
          const sut = suggestCompactionSegment;

          // Act
          const result = sut(candidate, GEOMETRIC_FACTOR);

          // Assert
          expect(result).toStrictEqual({ start, end });
        },
      );
    });
  });

  describe('Given a stack of zero or one table', () => {
    describe('When suggesting a compaction segment', () => {
      it('Then an empty stack yields the empty segment', () => {
        // Arrange
        const sut = suggestCompactionSegment;

        // Act
        const result = sut([], GEOMETRIC_FACTOR);

        // Assert
        expect(result).toStrictEqual({ start: 0, end: 0 });
      });

      it('Then a single-table stack yields the empty segment', () => {
        // Arrange
        const sut = suggestCompactionSegment;

        // Act
        const result = sut([100], GEOMETRIC_FACTOR);

        // Assert
        expect(result).toStrictEqual({ start: 0, end: 0 });
      });
    });
  });

  describe('Given a stack where no predecessor anywhere is small enough to merge', () => {
    describe('When suggesting a compaction segment', () => {
      it('Then no boundary is found and the segment is empty — the "found nothing" zero case', () => {
        // Arrange
        const sut = suggestCompactionSegment;

        // Act
        const result = sut([1000, 10], GEOMETRIC_FACTOR);

        // Assert
        expect(result).toStrictEqual({ start: 0, end: 0 });
      });
    });
  });

  describe('Given a stack where every predecessor qualifies all the way back to the oldest table', () => {
    describe('When suggesting a compaction segment', () => {
      it('Then start stays 0 because the accumulation reaches it — the whole stack compacts', () => {
        // Arrange — 25 < 20*2, then 30 < (20+25)*2: both qualify, back to index 0
        const sut = suggestCompactionSegment;

        // Act
        const result = sut([30, 25, 20], GEOMETRIC_FACTOR);

        // Assert
        expect(result).toStrictEqual({ start: 0, end: 3 });
      });
    });
  });

  describe('Given a predecessor exactly equal to its successor times the factor', () => {
    describe('When suggesting a compaction segment', () => {
      it('Then the boundary is not found there — only a STRICTLY smaller predecessor qualifies', () => {
        // Arrange — 100 === 50 * 2 exactly: git's rule is strict `<`, so this
        // pair does not end a merge segment.
        const sut = suggestCompactionSegment;

        // Act
        const result = sut([100, 50], GEOMETRIC_FACTOR);

        // Assert
        expect(result).toStrictEqual({ start: 0, end: 0 });
      });
    });
  });

  describe('Given an accumulated predecessor exactly equal to the running total times the factor', () => {
    describe('When suggesting a compaction segment', () => {
      it('Then the second loop stops extending start there — only a STRICTLY smaller predecessor qualifies', () => {
        // Arrange — boundary found at i=2 (30 < 40*2); the second loop then
        // accumulates 40+30=70, and sizes[0]=140 === 70*2 exactly, so start
        // must stay 1, not extend to 0.
        const sut = suggestCompactionSegment;

        // Act
        const result = sut([140, 30, 40], GEOMETRIC_FACTOR);

        // Assert
        expect(result).toStrictEqual({ start: 1, end: 3 });
      });
    });
  });

  describe('Given a size vector where the second loop must resume at the break index, not one below it', () => {
    describe('When suggesting a compaction segment', () => {
      it('Then the merge stops at the first qualifying predecessor and does not skip it', () => {
        // Arrange — boundary found at i=2 (100 < 60*2); resuming at i=2 (not
        // i=1) re-checks that same pair (guaranteed true) before testing
        // whether 1000 also qualifies against the correctly accumulated
        // 100+60 — it does not (1000 >= 320), so start stays 1, not 0.
        const sut = suggestCompactionSegment;

        // Act
        const result = sut([1000, 100, 60], GEOMETRIC_FACTOR);

        // Assert
        expect(result).toStrictEqual({ start: 1, end: 3 });
      });
    });
  });
});
