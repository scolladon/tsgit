import { describe, expect, it } from 'vitest';
import { diffPresplitLines } from '../../../../../src/domain/diff/line-diff.js';
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

  describe('Given one ours line against many mutually disjoint theirs lines', () => {
    describe('When markChanges is called', () => {
      it('Then the forward diagonal range still clamps at the box edge instead of growing past it every round', () => {
        // Arrange — growForwardRange only stops widening `max` once it
        // reaches `dmax` (the box's own edge); a mutant that keeps widening
        // it every round walks the shared k-vector buffer past the forward
        // half's own slots and into the backward half's sentinels, so no
        // crossing is ever detected and xdlSplit's search never terminates.
        // 12 mutually-disjoint theirs lines against a single ours line is
        // enough real edit distance for that corruption to become
        // observable (verified by direct computation against this module).
        const sut = runMarkChanges;
        const classes = classesOf([14], [32, 63, 26, 16, 11, 24, 47, 46, 6, 7, 56, 9]);

        // Act
        const { oursChanged, theirsChanged } = sut(classes);

        // Assert
        expect(Array.from(oursChanged)).toEqual([1]);
        expect(Array.from(theirsChanged)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
      });
    });
  });

  describe('Given a small pair whose backward search reaches a diagonal tie', () => {
    describe('When markChanges is called', () => {
      it('Then the tie-break keeps its strict inequality, not a loosened one', () => {
        // Arrange — scanBackward's own start-diagonal choice
        // (`backwardAt(d-1) < backwardAt(d+1)`) picks a neighbour on a tie
        // the same way scanForward's mirror comparison does; loosening it to
        // `<=` changes which neighbour's snake gets extended and produces a
        // different split for this exact pair (verified by direct
        // computation against this module).
        const sut = runMarkChanges;
        const classes = classesOf([0, 2, 1, 1, 0], [0, 0, 2]);

        // Act
        const { oursChanged, theirsChanged } = sut(classes);

        // Assert
        expect(Array.from(oursChanged)).toEqual([0, 1, 1, 1, 0]);
        expect(Array.from(theirsChanged)).toEqual([0, 0, 1]);
      });
    });
  });

  describe('Given a tiny pair that only a genuinely-iterative search resolves correctly', () => {
    describe('When markChanges is called', () => {
      it('Then the cost cap only fires once ec actually reaches mxcost, not on the very first round', () => {
        // Arrange — trySplitCutoff's `ec >= env.mxcost` gate is what lets
        // the ordinary forward/backward search run for up to 256 rounds
        // before falling back to the (non-minimal) cost-capped split; a
        // mutant that forces this gate true unconditionally takes the
        // cost-capped fallback at ec = 1, before the real search has found
        // anything, producing a different split for this exact pair
        // (verified by direct computation against this module).
        const sut = runMarkChanges;
        const classes = classesOf([4, 1, 1], [1, 4, 2]);

        // Act
        const { oursChanged, theirsChanged } = sut(classes);

        // Assert
        expect(Array.from(oursChanged)).toEqual([1, 1, 0]);
        expect(Array.from(theirsChanged)).toEqual([0, 1, 1]);
      });
    });
  });

  describe('Given a small pair whose true edit distance is below the XDL_MAX_COST_MIN floor', () => {
    describe('When markChanges is called', () => {
      it('Then mxcost stays pinned at the 256 floor rather than shrinking to bogosqrt(ndiags)', () => {
        // Arrange — mxcost is `Math.max(bogosqrt(ndiags), XDL_MAX_COST_MIN)`;
        // for a small box bogosqrt(ndiags) is far below 256, so Math.max
        // must pick the 256 floor. Swapping in Math.min instead lets the
        // (much smaller) bogosqrt value cap the search, so it gives up and
        // takes a non-minimal cost-capped split after only a handful of
        // rounds instead of exhausting the real search first (verified by
        // direct computation against this module).
        const sut = runMarkChanges;
        const classes = classesOf([1, 3, 4, 2, 5, 2, 2, 0, 2, 1, 0, 2, 0, 2, 4, 1, 1, 0], [2]);

        // Act
        const { oursChanged, theirsChanged } = sut(classes);

        // Assert
        expect(Array.from(oursChanged)).toEqual([
          1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
        ]);
        expect(Array.from(theirsChanged)).toEqual([0]);
      });
    });
  });

  describe("Given two large mutually-disjoint sides sized past furthestForwardReach/furthestBackwardReach's own safe range", () => {
    describe('When markChanges is called', () => {
      it('Then the furthest-reach corner distance (i1 + i2) is computed along the search diagonal, not against it', () => {
        // Arrange — furthestForwardReach's/furthestBackwardReach's own
        // `i2 = i1 - d` recovers the OTHER coordinate on diagonal `d`; a
        // mutant that flips the sign computes a nonsensical i2, corrupting
        // every downstream grid write the cost-cap fallback makes from it.
        // 201 mutually-disjoint ours lines against 312 mutually-disjoint
        // theirs lines is enough real edit distance to force that fallback
        // and make the corruption observable — it stops the search from
        // ever terminating (verified by direct computation against this
        // module).
        const sut = runMarkChanges;
        const classes = classesOf(
          Array.from({ length: 201 }, (_, i) => i),
          Array.from({ length: 312 }, (_, i) => 1000 + i),
        );

        // Act
        const { oursChanged, theirsChanged } = sut(classes);

        // Assert
        expect(Array.from(oursChanged).every((v) => v === 1)).toBe(true);
        expect(Array.from(theirsChanged).every((v) => v === 1)).toBe(true);
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

      it('Then the shared run is entered exactly at its own first line, not one line early or late', () => {
        // Arrange — "valid edit script" alone tolerates a search that sweeps
        // the shared run's own first line (index DISJOINT_HALF) into the
        // disjoint prefix's change instead of matching it: dropping a
        // genuinely-matching pair is still reconstructible as a delete+
        // insert. Pinning oursChanged[300] === 0 is the tighter, git-faithful
        // check — verified by direct computation against this module (every
        // mutant that disturbs the forward/backward heuristic scans or their
        // furthest-reach/cost-cap fallback flips exactly this line to 1).
        const sut = runMarkChanges;
        const classes = sandwichedShare();

        // Act
        const { oursChanged } = sut(classes);

        // Assert
        expect(oursChanged[DISJOINT_HALF]).toBe(0);
      });

      it('Then the shared run stays intact deep inside the cost-capped search, not just at its own edge', () => {
        // Arrange — index 32387 sits ~32,087 lines into the 32,300-line
        // shared run, well past where trimBox's own leading-snake trim could
        // reach; only the recursive cost-capped search resolves it. Verified
        // by direct computation against this module.
        const sut = runMarkChanges;
        const classes = sandwichedShare();

        // Act
        const { oursChanged } = sut(classes);

        // Assert
        expect(oursChanged[32_387]).toBe(0);
      });

      it('Then a minimal-mode search leaves the same deep shared-run line intact too', () => {
        // Arrange — mode: 'minimal' forces the root box's own needMin flag;
        // a mutant that drops that flag (or the `mode === 'minimal'` check
        // feeding it) only shows up under this mode, not git-default.
        // Verified by direct computation against this module.
        const classes = sandwichedShare();
        const prepared: Prepared = {
          ours: identityPrepared(classes.ours.length),
          theirs: identityPrepared(classes.theirs.length),
        };
        const sut = markChanges;

        // Act
        sut(classes, prepared, 'minimal');

        // Assert
        expect(prepared.ours.changed[32_388]).toBe(0);
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

      it('Then the 21-line shared run is entered exactly at its own first line', () => {
        // Arrange — same "valid but too loose" gap as the sandwiched-share
        // boundary check above: uniqueA is 257 lines, so index 257 is the
        // shared run's own first line. Verified by direct computation
        // against this module (every mutant that disturbs the forward/
        // backward heuristic scans, their furthest-reach loops, or the
        // cost-cap fallback flips exactly this line to 1).
        const sut = runMarkChanges;
        const classes = edgeDiagonalDecoy();

        // Act
        const { oursChanged } = sut(classes);

        // Assert
        expect(oursChanged[257]).toBe(0);
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

// Some furthestForwardReach arithmetic mutants never diverge through
// markChanges alone (the identity-Prepared fixtures above bypass
// cleanupRecords, and this particular arithmetic only misbehaves once
// classify/cleanupRecords has shaped the kept-space view a specific way) —
// they only show up through the full diffPresplitLines pipeline. Each
// fixture below is a delta-debug-minimized witness (no smaller or more
// structured reproduction was found); line content is `line-<id>` so
// distinct ids are guaranteed to classify as distinct lines.
function linesOf(ids: ReadonlyArray<number>): ReadonlyArray<Uint8Array> {
  const encoder = new TextEncoder();
  return ids.map((id) => encoder.encode(`line-${id}\n`));
}

describe("Given a delta-debug-minimized pair that reaches furthestForwardReach's own tie-break", () => {
  describe('When diffPresplitLines is called', () => {
    it('Then a tied corner distance keeps its strict inequality, not a loosened one', () => {
      // Arrange — furthestForwardReach's `if (best < i1 + i2)` only replaces
      // the current best reach on a STRICT improvement; loosening it to `<=`
      // lets a later, merely-equal diagonal overwrite an earlier one with a
      // different i1/i2 split, changing which (still equally-far) point the
      // cost-capped fallback returns. Verified by direct computation against
      // this module.
      const sut = diffPresplitLines;
      const oursIds = [
        12, 30, 18, 23, 1, 23, 33, 6, 18, 20, 31, 10, 29, 13, 37, 9, 15, 27, 34, 2, 8, 3, 22, 31,
        29, 8, 25, 24, 39, 39, 25, 5, 38, 29, 9, 37, 29, 22, 39, 19, 1, 30, 26, 36, 14, 6, 37, 24,
        15, 32, 31, 6, 36, 35, 36, 4, 18, 36, 28, 9, 11, 32, 3,
      ];
      const theirsIds = [
        11, 10, 11, 14, 33, 22, 38, 3, 32, 12, 33, 35, 34, 26, 34, 1, 12, 8, 10, 26, 32, 29, 22, 32,
        1, 1, 31, 36, 25, 36, 20, 3, 6, 18, 39, 36, 34, 25, 22, 14, 11, 22, 34, 12, 3, 10, 39, 14,
        29, 3, 15, 4, 29, 27, 35, 27, 37, 4, 31, 8, 14, 13, 4, 13, 32, 28, 27, 22, 38, 12, 3, 13,
        37, 35, 14, 5, 32, 1, 31, 3, 18, 1, 11, 24, 24, 26, 25, 39, 11, 34, 28, 3, 38, 15, 26, 34,
        15, 34, 35, 34, 3, 23, 32, 36, 22, 29, 26, 27, 4, 31, 23, 13, 5, 4, 32, 23, 35, 28, 33, 27,
        27, 32, 3, 11, 27, 20, 34, 3, 19, 1, 15, 27, 4, 20, 9, 31, 22, 19, 19, 23, 28, 14, 8, 3, 8,
        19, 18, 8, 3, 15, 10, 33, 15, 31, 33, 20, 39, 39, 18, 35, 31, 1, 10, 26, 10, 37, 13, 34, 36,
        27, 28, 37, 39, 10, 18, 19, 15, 28, 18, 28, 31, 31, 37, 14, 11, 5, 35, 33, 8, 37, 36, 5, 20,
        29, 27, 11, 18, 22, 1, 12, 18, 3, 31, 8, 31, 26, 4, 35, 19, 28, 29, 8, 10, 11, 10, 18, 6,
        19, 31, 13, 36, 26, 10, 4, 24, 11, 2, 6, 2, 8, 37, 22, 13, 31, 11, 37, 32, 34, 18, 35, 32,
        34, 27, 37, 12, 9, 2, 23, 23, 35, 27, 24, 22, 2, 36, 2, 28, 3, 18, 30, 35, 32, 27, 34, 35,
        18, 35, 9, 26, 37, 3, 18, 32, 20, 34, 1, 20, 28, 39, 37, 36, 3, 32, 36, 6, 25, 39, 11, 1,
        30, 5, 11, 5, 30, 22, 5, 26, 22, 5, 28, 11, 13, 23, 5, 8, 4, 14, 11, 34, 30, 8, 1, 12, 19,
        9, 4, 23, 27, 4, 22, 9, 5, 23, 4, 32, 13, 13, 34, 25, 27, 11, 26, 6, 26, 14, 29, 9, 12, 9,
        18, 4, 1, 35, 1, 15, 9, 12, 23, 39, 14, 11, 36, 20, 6, 38, 14, 38, 39, 9, 25, 13, 22, 3, 30,
        34, 24, 12, 8, 2, 8, 12, 26, 13, 1, 38, 24, 37, 14, 4, 4, 35, 28, 31, 27, 34, 36, 37, 27,
        30, 25, 25, 22, 38, 35, 35, 36, 3, 28, 23, 34, 12, 38, 36, 27, 36, 3, 1, 23, 5, 35, 6, 14,
        28, 30, 19, 11, 10, 29, 31, 11, 22, 15, 9, 14, 5, 20, 2, 10, 31, 13, 11, 36, 2, 37, 12, 31,
        22, 15, 34, 27, 25, 4, 34, 5, 35, 27, 25, 33, 39, 24, 26, 31, 12, 18, 12, 1, 24, 24, 14, 24,
        33, 31, 38, 4, 12, 31, 10, 26, 36, 39, 31, 18, 38, 10, 37, 9, 8, 11, 32, 23, 11, 12, 22, 38,
        15, 36, 1, 23, 2, 34, 37, 35, 10, 20, 11, 3, 32, 34, 35, 11, 3, 14, 15, 35, 18, 27, 1, 12,
        39, 9, 39, 26, 32, 23, 26, 19, 10, 2, 13, 2, 24, 36, 5, 10, 11, 4,
      ];

      // Act
      const result = sut(linesOf(oursIds), linesOf(theirsIds));
      const hunk = result.hunks[58];

      // Assert
      expect(hunk).toEqual({
        kind: 'ours-only',
        oursStart: 51,
        oursEnd: 53,
        theirsStart: 181,
        theirsEnd: 181,
      });
    });
  });
});

describe("Given a delta-debug-minimized pair that reaches furthestForwardReach's corner-distance sign", () => {
  describe('When diffPresplitLines is called', () => {
    it('Then the corner distance is i1 + i2 along the diagonal, not i1 - i2 across it', () => {
      // Arrange — furthestForwardReach's `best < i1 + i2` compares corner
      // distances; flipping the sign turns it into an unrelated i1 - i2
      // ordering, so the cost-capped fallback picks a wildly different
      // (much later) diagonal as "furthest". Verified by direct computation
      // against this module.
      const sut = diffPresplitLines;
      const oursIds = [
        21, 29, 1, 22, 31, 15, 20, 0, 4, 16, 8, 37, 35, 10, 26, 14, 7, 32, 11, 39, 2, 18, 5, 36, 28,
        9, 3, 30, 38, 17, 27, 24, 25, 19, 34,
      ];
      const theirsIds = [
        11, 10, 21, 11, 14, 22, 38, 21, 3, 32, 35, 34, 26, 34, 1, 0, 8, 10, 26, 32, 29, 22, 32, 1,
        1, 31, 36, 25, 36, 20, 3, 18, 39, 36, 34, 25, 22, 14, 11, 22, 34, 3, 10, 39, 14, 29, 3, 17,
        15, 4, 29, 27, 35, 27, 37, 4, 31, 8, 14, 0, 4, 21, 32, 28, 27, 22, 38, 3, 37, 35, 14, 5, 32,
        21, 16, 1, 31, 3, 18, 1, 11, 24, 24, 26, 25, 39, 11, 34, 16, 28, 3, 38, 15, 26, 34, 15, 34,
        35, 7, 34, 0, 3, 32, 36, 16, 22, 29, 26, 27, 4, 7, 31, 5, 4, 32, 35, 7, 28, 27, 27, 32, 3,
        11, 27, 21, 20, 34, 3, 19, 1, 17, 15, 27, 4, 16, 20, 9, 31, 22, 0, 19, 19, 28, 14, 16, 8, 3,
        8, 19, 18, 8, 0, 3, 15, 10, 15, 31, 20, 17, 39, 39, 18, 35, 31, 17, 1, 10, 36, 0, 27, 28,
        37, 39, 10, 18, 19, 15, 28, 0, 18, 28, 31, 31, 37, 14, 11, 5, 35, 8, 37, 36, 5, 20, 21, 29,
        27, 11, 18, 22, 1, 17, 0, 18, 3, 17, 31, 8, 31, 26, 4, 35, 7, 19, 28, 29, 8, 21, 10, 11, 10,
        18, 19, 31, 36, 26, 10, 4, 24, 11, 2, 2, 8, 37, 22, 31, 11, 37, 32, 17, 34, 32, 34, 27, 37,
        9, 2, 17, 35, 27, 24, 16, 22, 2, 36, 2, 28, 3, 18, 30, 35, 32, 27, 34, 21, 35, 18, 35, 17,
        9, 26, 37, 3, 16, 18, 32, 17, 20, 17, 34, 1, 20, 28, 39, 37, 36, 3, 32, 0, 36, 25, 39, 11,
        1, 30, 5, 21, 11, 5, 17, 30, 22, 5, 26, 22, 0, 5, 17, 28, 7, 11, 5, 8, 4, 14, 11, 34, 30, 8,
        1, 19, 9, 16, 4, 27, 4, 22, 9, 5, 4, 32, 7, 34, 25, 27, 11, 26, 26, 14, 29, 17, 9, 9, 18, 4,
        1, 21, 35, 21, 1, 7, 15, 9, 39, 14, 11, 36, 20, 16, 38, 14, 38, 39, 9, 25, 22, 3, 30, 34,
        24, 8, 2, 8, 26, 0, 1, 17, 38, 24, 37, 14, 4, 4, 35, 28, 31, 27, 16, 34, 36, 37, 27, 30, 25,
        25, 22, 38, 35, 35, 0, 17, 36, 3, 28, 17, 34, 38, 36, 27, 36, 3, 1, 5, 35, 14, 28, 17, 30,
        19, 11, 10, 29, 31, 11, 22, 15, 9, 7, 14, 5, 20, 2, 10, 31, 11, 36, 2, 37, 21, 31, 22, 15,
        34, 27, 25, 4, 34, 5, 35, 27, 21, 25, 39, 24, 26, 31, 18, 1, 24, 24, 14, 24, 31, 38, 4, 31,
        10, 26, 36, 39, 31, 17, 18, 38, 10, 37, 9, 0, 8, 11, 32, 11, 22, 0, 38, 15, 36, 1, 2, 34,
        16, 37, 35, 10, 20, 11, 3, 32, 34, 16, 35, 17, 11, 3, 16, 14, 15, 35, 18, 16, 17, 27, 1, 39,
        9, 39, 26, 21, 32, 26, 19, 10, 2, 17, 2, 24, 16, 36, 5, 10, 11, 0, 4,
      ];

      // Act
      const result = sut(linesOf(oursIds), linesOf(theirsIds));

      // Assert
      expect(result.hunks[0]).toEqual({
        kind: 'theirs-only',
        oursStart: 0,
        oursEnd: 0,
        theirsStart: 0,
        theirsEnd: 2,
      });
    });
  });

  describe('When diffPresplitLines is called on the same fixture', () => {
    it("Then costCappedSplit's own i2 (forwardReach.sum - forwardReach.i1) keeps its sign too", () => {
      // Arrange — same fixture reused for a second, independent arithmetic
      // mutant one level up: costCappedSplit derives the chosen split's i2
      // as `forwardReach.sum - forwardReach.i1`; flipping that subtraction
      // to addition produces a nonsensical i2 for the returned split point.
      // Verified by direct computation against this module.
      const sut = diffPresplitLines;
      const oursIds = [
        21, 29, 1, 22, 31, 15, 20, 0, 4, 16, 8, 37, 35, 10, 26, 14, 7, 32, 11, 39, 2, 18, 5, 36, 28,
        9, 3, 30, 38, 17, 27, 24, 25, 19, 34,
      ];
      const theirsIds = [
        11, 10, 21, 11, 14, 22, 38, 21, 3, 32, 35, 34, 26, 34, 1, 0, 8, 10, 26, 32, 29, 22, 32, 1,
        1, 31, 36, 25, 36, 20, 3, 18, 39, 36, 34, 25, 22, 14, 11, 22, 34, 3, 10, 39, 14, 29, 3, 17,
        15, 4, 29, 27, 35, 27, 37, 4, 31, 8, 14, 0, 4, 21, 32, 28, 27, 22, 38, 3, 37, 35, 14, 5, 32,
        21, 16, 1, 31, 3, 18, 1, 11, 24, 24, 26, 25, 39, 11, 34, 16, 28, 3, 38, 15, 26, 34, 15, 34,
        35, 7, 34, 0, 3, 32, 36, 16, 22, 29, 26, 27, 4, 7, 31, 5, 4, 32, 35, 7, 28, 27, 27, 32, 3,
        11, 27, 21, 20, 34, 3, 19, 1, 17, 15, 27, 4, 16, 20, 9, 31, 22, 0, 19, 19, 28, 14, 16, 8, 3,
        8, 19, 18, 8, 0, 3, 15, 10, 15, 31, 20, 17, 39, 39, 18, 35, 31, 17, 1, 10, 36, 0, 27, 28,
        37, 39, 10, 18, 19, 15, 28, 0, 18, 28, 31, 31, 37, 14, 11, 5, 35, 8, 37, 36, 5, 20, 21, 29,
        27, 11, 18, 22, 1, 17, 0, 18, 3, 17, 31, 8, 31, 26, 4, 35, 7, 19, 28, 29, 8, 21, 10, 11, 10,
        18, 19, 31, 36, 26, 10, 4, 24, 11, 2, 2, 8, 37, 22, 31, 11, 37, 32, 17, 34, 32, 34, 27, 37,
        9, 2, 17, 35, 27, 24, 16, 22, 2, 36, 2, 28, 3, 18, 30, 35, 32, 27, 34, 21, 35, 18, 35, 17,
        9, 26, 37, 3, 16, 18, 32, 17, 20, 17, 34, 1, 20, 28, 39, 37, 36, 3, 32, 0, 36, 25, 39, 11,
        1, 30, 5, 21, 11, 5, 17, 30, 22, 5, 26, 22, 0, 5, 17, 28, 7, 11, 5, 8, 4, 14, 11, 34, 30, 8,
        1, 19, 9, 16, 4, 27, 4, 22, 9, 5, 4, 32, 7, 34, 25, 27, 11, 26, 26, 14, 29, 17, 9, 9, 18, 4,
        1, 21, 35, 21, 1, 7, 15, 9, 39, 14, 11, 36, 20, 16, 38, 14, 38, 39, 9, 25, 22, 3, 30, 34,
        24, 8, 2, 8, 26, 0, 1, 17, 38, 24, 37, 14, 4, 4, 35, 28, 31, 27, 16, 34, 36, 37, 27, 30, 25,
        25, 22, 38, 35, 35, 0, 17, 36, 3, 28, 17, 34, 38, 36, 27, 36, 3, 1, 5, 35, 14, 28, 17, 30,
        19, 11, 10, 29, 31, 11, 22, 15, 9, 7, 14, 5, 20, 2, 10, 31, 11, 36, 2, 37, 21, 31, 22, 15,
        34, 27, 25, 4, 34, 5, 35, 27, 21, 25, 39, 24, 26, 31, 18, 1, 24, 24, 14, 24, 31, 38, 4, 31,
        10, 26, 36, 39, 31, 17, 18, 38, 10, 37, 9, 0, 8, 11, 32, 11, 22, 0, 38, 15, 36, 1, 2, 34,
        16, 37, 35, 10, 20, 11, 3, 32, 34, 16, 35, 17, 11, 3, 16, 14, 15, 35, 18, 16, 17, 27, 1, 39,
        9, 39, 26, 21, 32, 26, 19, 10, 2, 17, 2, 24, 16, 36, 5, 10, 11, 0, 4,
      ];

      // Act
      const result = sut(linesOf(oursIds), linesOf(theirsIds));

      // Assert
      expect(result.hunks[46]).toEqual({
        kind: 'ours-only',
        oursStart: 32,
        oursEnd: 34,
        theirsStart: 250,
        theirsEnd: 250,
      });
    });
  });
});
