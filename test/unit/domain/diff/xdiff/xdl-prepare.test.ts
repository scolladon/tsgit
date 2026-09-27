import { describe, expect, it } from 'vitest';
import {
  bogosqrt,
  cleanMmatch,
  cleanupRecords,
  trimEnds,
} from '../../../../../src/domain/diff/xdiff/xdl-prepare.js';

interface Classes {
  readonly ours: Int32Array;
  readonly theirs: Int32Array;
  readonly classCount: number;
}

/** Builds `LineClasses` directly from class ids — every function under test
 *  here only ever compares ids, so a unit test never needs real line bytes. */
function classesOf(ours: ReadonlyArray<number>, theirs: ReadonlyArray<number>): Classes {
  const classCount = Math.max(0, ...ours, ...theirs) + 1;
  return { ours: Int32Array.from(ours), theirs: Int32Array.from(theirs), classCount };
}

describe('bogosqrt', () => {
  describe.each([
    [0, 1],
    [1, 2],
    [3, 2],
    [4, 4],
    [15, 4],
    [16, 8],
    [20_006, 256],
  ])('Given n = %i', (n, expected) => {
    describe('When bogosqrt is called', () => {
      it(`Then it returns ${expected}`, () => {
        // Arrange
        const input = n;

        // Act
        const result = bogosqrt(input);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('trimEnds', () => {
  describe('Given a shared leading and trailing run around a differing middle', () => {
    describe('When trimEnds is called', () => {
      it('Then dstart and dend bound exactly the differing middle', () => {
        // Arrange — ours/theirs agree at indices 0,1 and at the last index,
        // differ only at index 2
        const ours = Int32Array.from([0, 1, 2, 9]);
        const theirs = Int32Array.from([0, 1, 3, 9]);

        // Act
        const result = trimEnds(ours, theirs);

        // Assert
        expect(result).toEqual({ dstart: 2, oursDend: 2, theirsDend: 2 });
      });
    });
  });

  describe('Given two fully identical sides', () => {
    describe('When trimEnds is called', () => {
      it('Then dstart runs past dend on both sides', () => {
        // Arrange
        const ours = Int32Array.from([0, 1, 2]);
        const theirs = Int32Array.from([0, 1, 2]);

        // Act
        const result = trimEnds(ours, theirs);

        // Assert
        expect(result).toEqual({ dstart: 3, oursDend: 2, theirsDend: 2 });
      });
    });
  });

  describe('Given two sides sharing nothing at the same position', () => {
    describe('When trimEnds is called', () => {
      it('Then dstart is 0 and dend is each side’s own last index', () => {
        // Arrange
        const ours = Int32Array.from([0, 1]);
        const theirs = Int32Array.from([2, 3]);

        // Act
        const result = trimEnds(ours, theirs);

        // Assert
        expect(result).toEqual({ dstart: 0, oursDend: 1, theirsDend: 1 });
      });
    });
  });

  describe('Given sides of unequal length with a shared trailing run', () => {
    describe('When trimEnds is called', () => {
      it('Then each side’s dend is computed from its own length', () => {
        // Arrange — ours has one extra leading line, both share only the
        // final id (the second-to-last line differs: ours has 2, theirs 3)
        const ours = Int32Array.from([1, 2, 9]);
        const theirs = Int32Array.from([3, 9]);

        // Act
        const result = trimEnds(ours, theirs);

        // Assert — no shared prefix (ours[0]=1 vs theirs[0]=2), one shared
        // trailing line (id 9)
        expect(result).toEqual({ dstart: 0, oursDend: 1, theirsDend: 0 });
      });
    });
  });
});

const DISCARD = 0;
const KEEP = 1;
const INVESTIGATE = 2;

describe('cleanMmatch', () => {
  describe('Given the run before the investigate line holds no discard', () => {
    describe('When cleanMmatch is called', () => {
      it('Then it declines regardless of the run after', () => {
        // Arrange — before: KEEP immediately; after: two discards (would
        // discard on its own, if reached)
        const action = Uint8Array.from([KEEP, KEEP, INVESTIGATE, DISCARD, DISCARD]);

        // Act
        const result = cleanMmatch(action, 2, action.length);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given the run after the investigate line holds no discard', () => {
    describe('When cleanMmatch is called', () => {
      it('Then it declines even though the run before holds discards', () => {
        // Arrange — before: two discards; after: KEEP immediately
        const action = Uint8Array.from([DISCARD, DISCARD, INVESTIGATE, KEEP, KEEP]);

        // Act
        const result = cleanMmatch(action, 2, action.length);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given six discards surrounding the investigate line (3 before, 3 after)', () => {
    describe('When cleanMmatch is called', () => {
      it('Then it declines — 2·4 is not below 2 + 6', () => {
        // Arrange
        const action = Uint8Array.from([
          DISCARD,
          DISCARD,
          DISCARD,
          INVESTIGATE,
          DISCARD,
          DISCARD,
          DISCARD,
        ]);

        // Act
        const result = cleanMmatch(action, 3, action.length);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given seven discards surrounding the investigate line (4 before, 3 after)', () => {
    describe('When cleanMmatch is called', () => {
      it('Then it discards — 2·4 is below 2 + 7', () => {
        // Arrange
        const action = Uint8Array.from([
          DISCARD,
          DISCARD,
          DISCARD,
          DISCARD,
          INVESTIGATE,
          DISCARD,
          DISCARD,
          DISCARD,
        ]);

        // Act
        const result = cleanMmatch(action, 4, action.length);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  // XDL_SIMSCAN_WINDOW caps each side's scan at 100 positions: a run of
  // exactly 100 discards before the investigate line, and one of 101, must
  // both be capped to 100 counted discards. Tuned so the capped total (100 +
  // 2 after-discards = 102, against 34 investigate) sits exactly at the
  // ratio's keep/discard boundary (3·34 = 102): if the window ever counted
  // the 101st discard (total 103), the same fixture would flip to discard.
  const AFTER_SIDE = [DISCARD, DISCARD, ...Array.from({ length: 32 }, () => INVESTIGATE)];

  function buildBeforeRun(length: number): Uint8Array {
    const before = Array.from({ length }, () => DISCARD);
    return Uint8Array.from([...before, INVESTIGATE, ...AFTER_SIDE]);
  }

  describe('Given a discard run of exactly the window length (100) before the investigate line', () => {
    describe('When cleanMmatch is called', () => {
      it('Then it declines at the tuned boundary', () => {
        // Arrange
        const action = buildBeforeRun(100);

        // Act
        const result = cleanMmatch(action, 100, action.length);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a discard run one line past the window length (101) before the investigate line', () => {
    describe('When cleanMmatch is called', () => {
      it('Then it still declines — the window caps the 101st discard out of the count', () => {
        // Arrange
        const action = buildBeforeRun(101);

        // Act
        const result = cleanMmatch(action, 101, action.length);

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});

function uniqueClasses(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, k) => start + k);
}

describe('cleanupRecords', () => {
  describe('Given a multi-match line at mlim, surrounded by 7 no-match lines (git’s smallest non-minimal case)', () => {
    describe('When cleanupRecords is called', () => {
      it('Then the multi-match line is discarded and every no-match line is discarded', () => {
        // Arrange — theirs: u1 u2 u3 u4 f u5 u6 u7 (mlim = bogosqrt(8) = 4),
        // ours: f f f f (f occurs 4 times in ours >= mlim)
        const F = 0;
        const theirs = [...uniqueClasses(1, 4), F, ...uniqueClasses(5, 3)];
        const ours = [F, F, F, F];
        const classes = classesOf(ours, theirs);
        const trimmed = trimEnds(classes.ours, classes.theirs);

        // Act
        const result = cleanupRecords(classes, trimmed, 'git-default');

        // Assert
        expect(Array.from(result.theirs.changed)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
        expect(Array.from(result.theirs.referenceIndex)).toEqual([]);
        expect(Array.from(result.ours.changed)).toEqual([0, 0, 0, 0]);
        expect(Array.from(result.ours.referenceIndex)).toEqual([0, 1, 2, 3]);
      });
    });
  });

  describe('Given the same shape but f occurs only 3 times in ours (one below mlim)', () => {
    describe('When cleanupRecords is called', () => {
      it('Then f is kept outright, without ever reaching the multi-match check', () => {
        // Arrange
        const F = 0;
        const theirs = [...uniqueClasses(1, 4), F, ...uniqueClasses(5, 3)];
        const ours = [F, F, F];
        const classes = classesOf(ours, theirs);
        const trimmed = trimEnds(classes.ours, classes.theirs);

        // Act
        const result = cleanupRecords(classes, trimmed, 'git-default');

        // Assert
        expect(Array.from(result.theirs.changed)).toEqual([1, 1, 1, 1, 0, 1, 1, 1]);
        expect(Array.from(result.theirs.referenceIndex)).toEqual([4]);
      });
    });
  });

  describe('Given the same multi-match line but surrounded by only 6 no-match lines', () => {
    describe('When cleanupRecords is called', () => {
      it('Then the multi-match line stays kept', () => {
        // Arrange — theirs: u1 u2 u3 f u4 u5 u6 (3 before, 3 after)
        const F = 0;
        const theirs = [...uniqueClasses(1, 3), F, ...uniqueClasses(4, 3)];
        const ours = [F, F, F, F];
        const classes = classesOf(ours, theirs);
        const trimmed = trimEnds(classes.ours, classes.theirs);

        // Act
        const result = cleanupRecords(classes, trimmed, 'git-default');

        // Assert
        expect(Array.from(result.theirs.changed)).toEqual([1, 1, 1, 0, 1, 1, 1]);
        expect(Array.from(result.theirs.referenceIndex)).toEqual([3]);
      });
    });
  });

  describe('Given a line with no match at all on the other side', () => {
    describe('When cleanupRecords is called', () => {
      it('Then it is discarded unconditionally', () => {
        // Arrange
        const classes = classesOf([0, 1], [2, 3]);
        const trimmed = trimEnds(classes.ours, classes.theirs);

        // Act
        const result = cleanupRecords(classes, trimmed, 'git-default');

        // Assert
        expect(Array.from(result.ours.changed)).toEqual([1, 1]);
        expect(Array.from(result.ours.referenceIndex)).toEqual([]);
        expect(Array.from(result.theirs.changed)).toEqual([1, 1]);
        expect(Array.from(result.theirs.referenceIndex)).toEqual([]);
      });
    });
  });

  describe('Given a fully trimmed pair (no differing middle at all)', () => {
    describe('When cleanupRecords is called', () => {
      it('Then nothing is discarded and referenceIndex stays empty', () => {
        // Arrange
        const classes = classesOf([0, 1, 2], [0, 1, 2]);
        const trimmed = trimEnds(classes.ours, classes.theirs);

        // Act
        const result = cleanupRecords(classes, trimmed, 'git-default');

        // Assert — the whole file was trimmed away before cleanupRecords
        // ever ran; nothing here is discarded OR kept, since neither array
        // is ever visited
        expect(Array.from(result.ours.changed)).toEqual([0, 0, 0]);
        expect(Array.from(result.ours.referenceIndex)).toEqual([]);
        expect(Array.from(result.theirs.changed)).toEqual([0, 0, 0]);
        expect(Array.from(result.theirs.referenceIndex)).toEqual([]);
      });
    });
  });

  describe('Given the mlim-triggering shape under mode "minimal"', () => {
    describe('When cleanupRecords is called', () => {
      it('Then mlim is infinite, so the multi-match line is kept instead of investigated', () => {
        // Arrange — same fixture that discards under 'git-default' above
        const F = 0;
        const theirs = [...uniqueClasses(1, 4), F, ...uniqueClasses(5, 3)];
        const ours = [F, F, F, F];
        const classes = classesOf(ours, theirs);
        const trimmed = trimEnds(classes.ours, classes.theirs);

        // Act
        const result = cleanupRecords(classes, trimmed, 'minimal');

        // Assert — f is never even classified INVESTIGATE, so it is kept
        // outright regardless of the surrounding no-match lines
        expect(Array.from(result.theirs.changed)).toEqual([1, 1, 1, 1, 0, 1, 1, 1]);
        expect(Array.from(result.theirs.referenceIndex)).toEqual([4]);
      });
    });
  });
});
