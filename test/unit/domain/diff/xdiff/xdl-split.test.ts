import { describe, expect, it } from 'vitest';
import type { Prepared } from '../../../../../src/domain/diff/xdiff/xdl-prepare.js';
import {
  hasBackwardSnakeRun,
  hasForwardSnakeRun,
  markChanges,
} from '../../../../../src/domain/diff/xdiff/xdl-split.js';

interface Classes {
  readonly ours: Int32Array;
  readonly theirs: Int32Array;
  readonly classCount: number;
}

/** Builds `LineClasses` directly from class ids — `markChanges` only ever
 *  compares ids for equality, so a unit test never needs real line bytes. */
function classesOf(ours: ReadonlyArray<number>, theirs: ReadonlyArray<number>): Classes {
  const classCount = Math.max(0, ...ours, ...theirs) + 1;
  return { ours: Int32Array.from(ours), theirs: Int32Array.from(theirs), classCount };
}

/** An identity `Prepared` view — every line kept, none pre-discarded — so
 *  these tests exercise the split search in isolation from cleanupRecords,
 *  exactly as if `cleanupRecords` had discarded nothing. */
function identityPrepared(length: number): {
  readonly changed: Uint8Array;
  readonly referenceIndex: Int32Array;
} {
  const referenceIndex = new Int32Array(length);
  for (let i = 0; i < length; i++) referenceIndex[i] = i;
  return { changed: new Uint8Array(length), referenceIndex };
}

function runMarkChanges(classes: Classes): {
  readonly oursChanged: Uint8Array;
  readonly theirsChanged: Uint8Array;
} {
  const prepared: Prepared = {
    ours: identityPrepared(classes.ours.length),
    theirs: identityPrepared(classes.theirs.length),
  };
  markChanges(classes, prepared, 'git-default');
  return { oursChanged: prepared.ours.changed, theirsChanged: prepared.theirs.changed };
}

describe('markChanges', () => {
  describe('Given identical class ids on both sides', () => {
    describe('When markChanges is called', () => {
      it('Then nothing is marked changed', () => {
        // Arrange
        const sut = runMarkChanges;
        const classes = classesOf([0, 1, 2], [0, 1, 2]);

        // Act
        const { oursChanged, theirsChanged } = sut(classes);

        // Assert
        expect(Array.from(oursChanged)).toEqual([0, 0, 0]);
        expect(Array.from(theirsChanged)).toEqual([0, 0, 0]);
      });
    });
  });

  describe('Given theirs empty and ours non-empty', () => {
    describe('When markChanges is called', () => {
      it('Then every ours line is changed and theirs stays empty', () => {
        // Arrange
        const sut = runMarkChanges;
        const classes = classesOf([0, 1, 2], []);

        // Act
        const { oursChanged, theirsChanged } = sut(classes);

        // Assert
        expect(Array.from(oursChanged)).toEqual([1, 1, 1]);
        expect(Array.from(theirsChanged)).toEqual([]);
      });
    });
  });

  describe('Given ours empty and theirs non-empty', () => {
    describe('When markChanges is called', () => {
      it('Then every theirs line is changed and ours stays empty', () => {
        // Arrange
        const sut = runMarkChanges;
        const classes = classesOf([], [0, 1, 2]);

        // Act
        const { oursChanged, theirsChanged } = sut(classes);

        // Assert
        expect(Array.from(oursChanged)).toEqual([]);
        expect(Array.from(theirsChanged)).toEqual([1, 1, 1]);
      });
    });
  });

  describe('Given fully disjoint class ids, ours one line longer than theirs', () => {
    describe('When markChanges is called', () => {
      it('Then every line on both sides is changed', () => {
        // Arrange — the unequal lengths (off1-off2 !== lim1-lim2) exercise
        // the odd/even split of which direction's crossing check can fire.
        const sut = runMarkChanges;
        const classes = classesOf([0, 1, 2, 3], [4, 5, 6]);

        // Act
        const { oursChanged, theirsChanged } = sut(classes);

        // Assert
        expect(Array.from(oursChanged)).toEqual([1, 1, 1, 1]);
        expect(Array.from(theirsChanged)).toEqual([1, 1, 1]);
      });
    });
  });

  describe('Given an interleaved pair sharing a middle id', () => {
    describe('When markChanges is called', () => {
      it('Then only the shared id in the middle is left unmarked', () => {
        // Arrange — classic Myers LCS shape: a b c d e / a X c Y e
        const sut = runMarkChanges;
        const classes = classesOf([0, 1, 2, 3, 4], [0, 5, 2, 6, 4]);

        // Act
        const { oursChanged, theirsChanged } = sut(classes);

        // Assert
        expect(Array.from(oursChanged)).toEqual([0, 1, 0, 1, 0]);
        expect(Array.from(theirsChanged)).toEqual([0, 1, 0, 1, 0]);
      });
    });
  });

  // The snake heuristic (XDL_HEUR_MIN_COST) and the cost cap (XDL_MAX_COST_MIN)
  // are both 256, and mxcost = max(bogosqrt(ndiags), 256): below ndiags ~ 65536
  // the two constants collide exactly, so the cost cap always fires one round
  // before the heuristic's `ec > heurMin` could ever hold. Only a box whose
  // total size pushes bogosqrt(ndiags) past 256 opens a window where the
  // heuristic gets tried first — this fixture is sized to land in that window.
  const DISJOINT_HALF = 300;
  const SHARED_RUN = 32_300;

  /** ours/theirs = [disjoint prefix][shared run][disjoint suffix] — every
   *  prefix/suffix id is unique to its side, so no match is possible there;
   *  the shared run is the only content that can ever stay unmarked. */
  function sandwichedShare(): Classes {
    const ours: number[] = [];
    const theirs: number[] = [];
    let id = 0;
    for (let i = 0; i < DISJOINT_HALF; i++) ours.push(id++);
    for (let i = 0; i < DISJOINT_HALF; i++) theirs.push(id++);
    const sharedBase = id;
    for (let i = 0; i < SHARED_RUN; i++) {
      ours.push(sharedBase + i);
      theirs.push(sharedBase + i);
    }
    id = sharedBase + SHARED_RUN;
    for (let i = 0; i < DISJOINT_HALF; i++) ours.push(id++);
    for (let i = 0; i < DISJOINT_HALF; i++) theirs.push(id++);
    return classesOf(ours, theirs);
  }

  /** Walks both post-split changed maps in lockstep: every kept (unchanged)
   *  position must carry the SAME class id on both sides, in order — the
   *  "valid, if not necessarily minimal, script" invariant the cost cap and
   *  the snake heuristic both preserve. */
  function keptIdsMatch(
    classes: Classes,
    oursChanged: Uint8Array,
    theirsChanged: Uint8Array,
  ): boolean {
    let i = 0;
    let j = 0;
    const keptOurs: number[] = [];
    const keptTheirs: number[] = [];
    while (i < oursChanged.length || j < theirsChanged.length) {
      if (i < oursChanged.length && oursChanged[i] !== 0) {
        i++;
        continue;
      }
      if (j < theirsChanged.length && theirsChanged[j] !== 0) {
        j++;
        continue;
      }
      if (i < oursChanged.length && j < theirsChanged.length) {
        keptOurs.push(classes.ours[i]!);
        keptTheirs.push(classes.theirs[j]!);
        i++;
        j++;
      }
    }
    return keptOurs.length === keptTheirs.length && keptOurs.every((id, k) => id === keptTheirs[k]);
  }

  describe('Given a long shared run sandwiched between two large disjoint blocks (past the cost cap AND the snake heuristic window)', () => {
    describe('When markChanges is called', () => {
      it('Then every disjoint-block line is changed on both sides', () => {
        // Arrange
        const sut = runMarkChanges;
        const classes = sandwichedShare();

        // Act
        const { oursChanged, theirsChanged } = sut(classes);

        // Assert — the disjoint prefix and suffix can never match anything,
        // so a valid (if not necessarily minimal) script always marks them.
        const prefix = Array.from(oursChanged.subarray(0, DISJOINT_HALF));
        const suffix = Array.from(oursChanged.subarray(oursChanged.length - DISJOINT_HALF));
        const theirsPrefix = Array.from(theirsChanged.subarray(0, DISJOINT_HALF));
        const theirsSuffix = Array.from(
          theirsChanged.subarray(theirsChanged.length - DISJOINT_HALF),
        );
        expect(prefix.every((v) => v === 1)).toBe(true);
        expect(suffix.every((v) => v === 1)).toBe(true);
        expect(theirsPrefix.every((v) => v === 1)).toBe(true);
        expect(theirsSuffix.every((v) => v === 1)).toBe(true);
      });

      it('Then the result is a valid edit script (applying it to ours reproduces theirs)', () => {
        // Arrange
        const sut = runMarkChanges;
        const classes = sandwichedShare();

        // Act
        const { oursChanged, theirsChanged } = sut(classes);

        // Assert
        expect(keptIdsMatch(classes, oursChanged, theirsChanged)).toBe(true);
      });
    });
  });

  // Same shape, asymmetric prefix/suffix lengths: this specific imbalance is
  // what makes the FORWARD half of the search (rather than backward) reach
  // the shared run with a corner distance disproportionate to the rounds
  // spent — the snake heuristic's own "interesting" trigger — while the
  // symmetric fixture above exercises the backward half instead.
  function asymmetricSandwichedShare(): Classes {
    const ours: number[] = [];
    const theirs: number[] = [];
    let id = 0;
    for (let i = 0; i < 100; i++) ours.push(id++);
    for (let i = 0; i < 200; i++) theirs.push(id++);
    const sharedBase = id;
    for (let i = 0; i < SHARED_RUN; i++) {
      ours.push(sharedBase + i);
      theirs.push(sharedBase + i);
    }
    id = sharedBase + SHARED_RUN;
    for (let i = 0; i < 400; i++) ours.push(id++);
    for (let i = 0; i < 400; i++) theirs.push(id++);
    return classesOf(ours, theirs);
  }

  describe('Given an asymmetric shared-run sandwich (unequal prefixes, equal suffixes)', () => {
    describe('When markChanges is called', () => {
      it('Then the result is still a valid edit script', () => {
        // Arrange
        const sut = runMarkChanges;
        const classes = asymmetricSandwichedShare();

        // Act
        const { oursChanged, theirsChanged } = sut(classes);

        // Assert
        expect(keptIdsMatch(classes, oursChanged, theirsChanged)).toBe(true);
      });
    });
  });

  // Places a real (21-line, over snakeCnt) matching run on the split's OWN
  // edge diagonal (d = ec, the diagonal reached by pure inserts/deletes with
  // no snake help so far): at ec = 257, that diagonal's `dd` distance from
  // fmid is also 257, so the heuristic's `v = reach - dd` for this candidate
  // stays small even though `gotSnake` is genuinely true — the one case
  // `findForwardHeuristicSplit`/`findBackwardHeuristicSplit` correctly
  // decline (falling through toward the cost cap) rather than a candidate
  // hasForwardSnakeRun/hasBackwardSnakeRun themselves reject.
  function edgeDiagonalDecoy(): Classes {
    const uniqueA: number[] = [];
    let id = 0;
    for (let i = 0; i < 257; i++) uniqueA.push(id++);
    const sharedBase = id;
    const shared: number[] = [];
    for (let i = 0; i < 21; i++) shared.push(sharedBase + i);
    id = sharedBase + 21;
    const uniqueB: number[] = [];
    for (let i = 0; i < 236; i++) uniqueB.push(id++);
    const uniqueC: number[] = [];
    for (let i = 0; i < 32_700; i++) uniqueC.push(id++);
    const uniqueD: number[] = [];
    for (let i = 0; i < 32_721; i++) uniqueD.push(id++);
    return classesOf([...uniqueA, ...shared, ...uniqueC], [...shared, ...uniqueB, ...uniqueD]);
  }

  describe('Given a real but off-diagonal matching run that the heuristic correctly declines', () => {
    describe('When markChanges is called', () => {
      it('Then the result is still a valid edit script', () => {
        // Arrange
        const sut = runMarkChanges;
        const classes = edgeDiagonalDecoy();

        // Act
        const { oursChanged, theirsChanged } = sut(classes);

        // Assert
        expect(keptIdsMatch(classes, oursChanged, theirsChanged)).toBe(true);
      });
    });
  });
});

// hasForwardSnakeRun/hasBackwardSnakeRun are git's inner snake-confirmation
// loops (xdiffi.c:167-173, :191-197): a candidate diagonal the heuristic
// scan flags by corner distance is only genuinely "interesting" once a real
// run of `snakeCnt` consecutive matches confirms it. Exercised directly
// (rather than only through a `markChanges` fixture large enough to reach
// the heuristic window) so both the confirmed and the rejected outcome are
// each pinned on their own, minimal input.
describe('hasForwardSnakeRun', () => {
  describe('Given a run of exactly snakeCnt matching ids ending at (i1, i2)', () => {
    describe('When hasForwardSnakeRun is called', () => {
      it('Then it confirms the snake', () => {
        // Arrange — ours/theirs agree at indices 2, 3, 4 (three consecutive matches
        // walking back from i1=5, i2=5)
        const sut = hasForwardSnakeRun;
        const classes = classesOf([0, 1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5]);

        // Act
        const result = sut(classes, 5, 5, 3);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a run shorter than snakeCnt ending at (i1, i2)', () => {
    describe('When hasForwardSnakeRun is called', () => {
      it('Then it rejects the candidate', () => {
        // Arrange — ours/theirs only agree at indices 3, 4 before diverging at
        // index 2, one short of the snakeCnt(3) confirmation
        const sut = hasForwardSnakeRun;
        const classes = classesOf([0, 1, 2, 3, 4, 5], [0, 1, 99, 3, 4, 5]);

        // Act
        const result = sut(classes, 5, 5, 3);

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});

describe('hasBackwardSnakeRun', () => {
  describe('Given a run of exactly snakeCnt matching ids starting at (i1, i2)', () => {
    describe('When hasBackwardSnakeRun is called', () => {
      it('Then it confirms the snake', () => {
        // Arrange — ours/theirs agree at indices 0, 1, 2 (three consecutive matches
        // walking forward from i1=0, i2=0)
        const sut = hasBackwardSnakeRun;
        const classes = classesOf([0, 1, 2, 8, 9], [0, 1, 2, 3, 4]);

        // Act
        const result = sut(classes, 0, 0, 3);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a run shorter than snakeCnt starting at (i1, i2)', () => {
    describe('When hasBackwardSnakeRun is called', () => {
      it('Then it rejects the candidate', () => {
        // Arrange — ours/theirs only agree at indices 0, 1 before diverging at
        // index 2, one short of the snakeCnt(3) confirmation
        const sut = hasBackwardSnakeRun;
        const classes = classesOf([0, 1, 99, 8, 9], [0, 1, 2, 3, 4]);

        // Act
        const result = sut(classes, 0, 0, 3);

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});
