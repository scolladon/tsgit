import { describe, expect, it } from 'vitest';

import { parseDigest, partitionWriteDigest } from '../../profile-digest.js';

// The profiler imports the names-preserved bundle, so every tsgit frame's
// location is that single file at a distinct line — the parser keys on the
// symbol, not the path, so distinct line numbers keep frames on distinct rows.
const BUNDLE = 'file:///repo/dist-profile/esm/index.node.js';

const digestHeader = [
  'Statistical profiling result from isolate-0x1234-v8.log, (66 ticks, 31 unaccounted, 0 excluded).',
  '',
];

describe('parseDigest', () => {
  describe('Given a digest with one tsgit dist frame and shared-library + Unaccounted noise', () => {
    describe('When parseDigest runs', () => {
      it('Then only the tsgit frame is returned with self === 1.00', () => {
        // Arrange
        const digestText = [
          ...digestHeader,
          ' [Shared libraries]:',
          '   ticks  total  nonlib   name',
          '     23   34.8%          /System/Library/Frameworks/CoreAudio.framework/Versions/A/CoreAudio',
          '      6    9.1%          /Users/dev/.n/bin/node',
          '',
          ' [JavaScript]:',
          '   ticks  total  nonlib   name',
          `     37   56.1%   100.0%  LazyCompile: *walkCommitsByDate ${BUNDLE}:120:34`,
          '',
          ' [Summary]:',
          '     37   56.1%   100.0%  JavaScript',
          '     23   34.8%          Shared libraries',
          '      6    9.1%          Unaccounted',
        ].join('\n');

        // Act
        const result = parseDigest(digestText);

        // Assert
        expect(result.hotShares).toEqual([{ frame: 'walkCommitsByDate', self: 1, ticks: 37 }]);
      });
    });
  });

  describe('Given a digest with two tsgit frames at 3:1 tick ratio', () => {
    describe('When parseDigest runs', () => {
      it('Then shares are [0.75, 0.25] ordered descending', () => {
        // Arrange
        const digestText = [
          ...digestHeader,
          ' [JavaScript]:',
          '   ticks  total  nonlib   name',
          `     10   15.0%    25.0%  LazyCompile: *readBlob ${BUNDLE}:200:10`,
          `     30   45.0%    75.0%  LazyCompile: *walkCommitsByDate ${BUNDLE}:120:34`,
          '',
          ' [Summary]:',
          '     40   60.0%   100.0%  JavaScript',
        ].join('\n');

        // Act
        const result = parseDigest(digestText);

        // Assert
        expect(result.hotShares).toEqual([
          { frame: 'walkCommitsByDate', self: 0.75, ticks: 30 },
          { frame: 'readBlob', self: 0.25, ticks: 10 },
        ]);
      });
    });
  });

  describe('Given a digest whose only JavaScript frame is node-internal noise', () => {
    describe('When parseDigest runs', () => {
      it('Then it returns an empty array', () => {
        // Arrange — no tsgit frame is present at all (every candidate line
        // is shared-library/Unaccounted/Builtin noise), so the kept-frame
        // sum is zero and there is nothing to normalise. This pins that the
        // parser returns an empty array rather than fabricate a frame — the
        // "zero survivors" half of DC-A.
        const digestText = [
          ...digestHeader,
          ' [Shared libraries]:',
          '   ticks  total  nonlib   name',
          '     23   34.8%          /System/Library/Frameworks/CoreAudio.framework/Versions/A/CoreAudio',
          '',
          ' [JavaScript]:',
          '   ticks  total  nonlib   name',
          '      6    9.1%    16.2%  Builtin: InterpreterEntryTrampoline',
          '',
          ' [Summary]:',
          '      6    9.1%          JavaScript',
          '     23   34.8%          Shared libraries',
          '     37   56.1%          Unaccounted',
        ].join('\n');

        // Act
        const result = parseDigest(digestText);

        // Assert
        expect(result.hotShares).toEqual([]);
      });
    });
  });

  describe('Given a digest with a dominant tsgit frame and a minor tsgit frame whose share falls below the 1% floor', () => {
    describe('When parseDigest runs', () => {
      it('Then only the dominant frame is returned, proving the floor drops the minor frame instead of rounding it up', () => {
        // Arrange — 999:1 tick ratio over the kept tsgit surface: the minor
        // frame normalises to 1/1000 = 0.001 (below NOISE_FLOOR_SELF=0.01)
        // and must be dropped, while the dominant frame normalises to
        // 999/1000 = 0.999, which rounds to 1.00.
        const digestText = [
          ...digestHeader,
          ' [JavaScript]:',
          '   ticks  total  nonlib   name',
          `    999   99.9%    99.9%  LazyCompile: *walkCommitsByDate ${BUNDLE}:120:34`,
          `      1    0.1%     0.1%  LazyCompile: *rareHelper ${BUNDLE}:900:1`,
          '',
          ' [Summary]:',
          '   1000  100.0%   100.0%  JavaScript',
        ].join('\n');

        // Act
        const result = parseDigest(digestText);

        // Assert
        expect(result.hotShares).toEqual([{ frame: 'walkCommitsByDate', self: 1, ticks: 999 }]);
      });
    });
  });

  describe('Given a digest with a tsgit frame whose share is exactly the 1% floor', () => {
    describe('When parseDigest runs', () => {
      it('Then the frame is kept, proving the floor is inclusive (>=, not >)', () => {
        // Arrange — 1:99 tick ratio: the minor frame normalises to exactly
        // 0.01, which must be KEPT (the floor is `>= 0.01`). Pins both the 0.01
        // constant and the inclusive boundary — a `>=`→`>` mutant drops it.
        const digestText = [
          ...digestHeader,
          ' [JavaScript]:',
          '   ticks  total  nonlib   name',
          `     99   99.0%   99.0%  JS: *walkCommitsByDate ${BUNDLE}:120:34`,
          `      1    1.0%    1.0%  JS: *boundaryFrame ${BUNDLE}:500:1`,
          '',
          ' [Summary]:',
          '    100  100.0%   100.0%  JavaScript',
        ].join('\n');

        // Act
        const result = parseDigest(digestText);

        // Assert
        expect(result.hotShares).toEqual([
          { frame: 'walkCommitsByDate', self: 0.99, ticks: 99 },
          { frame: 'boundaryFrame', self: 0.01, ticks: 1 },
        ]);
      });
    });
  });

  describe('Given a digest where one tsgit frame appears on two rows under different V8 tier markers', () => {
    describe('When parseDigest runs', () => {
      it('Then the markers are stripped and the frame is a single entry whose ticks are summed', () => {
        // Arrange — V8 samples `readSlice` in three tiers (`~` unoptimised, `^`,
        // `+`), 20 + 10 + 10 ticks; `walkTree` (`*` optimised) is 60. Every
        // marker must be stripped so all three readSlice rows collapse to one
        // entry: 40/100 = 0.40, never split rows or a `~`/`^`/`+`-prefixed leak.
        const digestText = [
          ...digestHeader,
          ' [JavaScript]:',
          '   ticks  total  nonlib   name',
          `     60   60.0%   60.0%  JS: *walkTree ${BUNDLE}:300:5`,
          `     20   20.0%   20.0%  JS: ~readSlice ${BUNDLE}:410:9`,
          `     10   10.0%   10.0%  JS: ^readSlice ${BUNDLE}:410:9`,
          `     10   10.0%   10.0%  JS: +readSlice ${BUNDLE}:410:9`,
          '',
          ' [Summary]:',
          '    100  100.0%   100.0%  JavaScript',
        ].join('\n');

        // Act
        const result = parseDigest(digestText);

        // Assert
        expect(result.hotShares).toEqual([
          { frame: 'walkTree', self: 0.6, ticks: 60 },
          { frame: 'readSlice', self: 0.4, ticks: 40 },
        ]);
      });
    });
  });
});

describe('Given a digest with known tick counts', () => {
  describe('When parseDigest runs', () => {
    it("Then it reports each frame's raw tick count", () => {
      // Arrange — 30:10 tick ratio; each returned share must carry its own
      // raw ticks alongside the normalised self share.
      const digestText = [
        ...digestHeader,
        ' [JavaScript]:',
        '   ticks  total  nonlib   name',
        `     30   75.0%    75.0%  LazyCompile: *walkCommitsByDate ${BUNDLE}:120:34`,
        `     10   25.0%    25.0%  LazyCompile: *readBlob ${BUNDLE}:200:10`,
        '',
        ' [Summary]:',
        '     40  100.0%   100.0%  JavaScript',
      ].join('\n');

      // Act
      const result = parseDigest(digestText);

      // Assert
      expect(result.hotShares).toEqual([
        { frame: 'walkCommitsByDate', self: 0.75, ticks: 30 },
        { frame: 'readBlob', self: 0.25, ticks: 10 },
      ]);
    });

    it('Then it reports the surviving tick total as totalTicks', () => {
      // Arrange — same digest as above; totalTicks is the sum of ticks over
      // every extracted tsgit frame, the denominator the shares were
      // computed from.
      const digestText = [
        ...digestHeader,
        ' [JavaScript]:',
        '   ticks  total  nonlib   name',
        `     30   75.0%    75.0%  LazyCompile: *walkCommitsByDate ${BUNDLE}:120:34`,
        `     10   25.0%    25.0%  LazyCompile: *readBlob ${BUNDLE}:200:10`,
        '',
        ' [Summary]:',
        '     40  100.0%   100.0%  JavaScript',
      ].join('\n');

      // Act
      const result = parseDigest(digestText);

      // Assert
      expect(result.totalTicks).toBe(40);
    });
  });
});

describe('Given a digest whose surviving tick total is below the floor', () => {
  describe('When parseDigest runs', () => {
    it('Then the partition is marked under-sampled', () => {
      // Arrange — 499 ticks, one below UNDER_SAMPLED_TICK_FLOOR (500).
      const digestText = [
        ...digestHeader,
        ' [JavaScript]:',
        '   ticks  total  nonlib   name',
        `    499  100.0%   100.0%  LazyCompile: *walkCommitsByDate ${BUNDLE}:120:34`,
        '',
        ' [Summary]:',
        '    499  100.0%   100.0%  JavaScript',
      ].join('\n');

      // Act
      const result = parseDigest(digestText);

      // Assert
      expect(result.underSampled).toBe(true);
    });
  });
});

describe('Given a digest whose surviving tick total is exactly at the floor', () => {
  describe('When parseDigest runs', () => {
    it('Then the partition is not marked under-sampled, proving the boundary is strict (>= floor is not under-sampled)', () => {
      // Arrange — exactly UNDER_SAMPLED_TICK_FLOOR (500) ticks. A `<`→`<=`
      // mutant on the underSampled comparison would flip this case to true.
      const digestText = [
        ...digestHeader,
        ' [JavaScript]:',
        '   ticks  total  nonlib   name',
        `    500  100.0%   100.0%  LazyCompile: *walkCommitsByDate ${BUNDLE}:120:34`,
        '',
        ' [Summary]:',
        '    500  100.0%   100.0%  JavaScript',
      ].join('\n');

      // Act
      const result = parseDigest(digestText);

      // Assert
      expect(result.underSampled).toBe(false);
    });
  });
});

describe('partitionWriteDigest', () => {
  describe('Given a write digest containing build-only frames (openRepository, bootstrapRepository) and a command frame (writeCommitObject)', () => {
    describe('When partitionWriteDigest runs with the default denylist', () => {
      it('Then the build-only frames are in setupShares and the command frame is in hotShares', () => {
        // Arrange
        const digestText = [
          ...digestHeader,
          ' [JavaScript]:',
          '   ticks  total  nonlib   name',
          `     10   20.0%    20.0%  LazyCompile: *openRepository ${BUNDLE}:30:1`,
          `     10   20.0%    20.0%  LazyCompile: *bootstrapRepository ${BUNDLE}:410:1`,
          `     30   60.0%    60.0%  LazyCompile: *writeCommitObject ${BUNDLE}:90:1`,
          '',
          ' [Summary]:',
          '     50  100.0%   100.0%  JavaScript',
        ].join('\n');

        // Act
        const result = partitionWriteDigest(digestText);

        // Assert
        expect(result.hotShares).toEqual([{ frame: 'writeCommitObject', self: 0.6, ticks: 30 }]);
        expect(result.setupShares).toEqual([
          { frame: 'openRepository', self: 0.2, ticks: 10 },
          { frame: 'bootstrapRepository', self: 0.2, ticks: 10 },
        ]);
      });
    });
  });

  describe('Given a caller-supplied setup-frame denylist', () => {
    describe('When partitionWriteDigest runs with that explicit set', () => {
      it('Then the override is honoured, not the default SETUP_FRAMES', () => {
        // Arrange — `customFrame` is NOT in the default denylist; a bespoke set
        // must route it to setupShares, proving the parameter is wired through.
        const digestText = [
          ...digestHeader,
          ' [JavaScript]:',
          '   ticks  total  nonlib   name',
          `     40   80.0%    80.0%  JS: *writeCommitObject ${BUNDLE}:90:1`,
          `     10   20.0%    20.0%  JS: *customFrame ${BUNDLE}:700:1`,
          '',
          ' [Summary]:',
          '     50  100.0%   100.0%  JavaScript',
        ].join('\n');

        // Act
        const result = partitionWriteDigest(digestText, new Set(['customFrame']));

        // Assert
        expect(result.hotShares).toEqual([{ frame: 'writeCommitObject', self: 0.8, ticks: 40 }]);
        expect(result.setupShares).toEqual([{ frame: 'customFrame', self: 0.2, ticks: 10 }]);
      });
    });
  });

  describe('Given a write digest containing a shared object-write frame (writeObject) that is NOT in the denylist', () => {
    describe('When partitionWriteDigest runs', () => {
      it('Then writeObject lands in hotShares (conservative attribution)', () => {
        // Arrange
        const digestText = [
          ...digestHeader,
          ' [JavaScript]:',
          '   ticks  total  nonlib   name',
          `     50  100.0%   100.0%  LazyCompile: *writeObject ${BUNDLE}:150:1`,
          '',
          ' [Summary]:',
          '     50  100.0%   100.0%  JavaScript',
        ].join('\n');

        // Act
        const result = partitionWriteDigest(digestText);

        // Assert
        expect(result.hotShares).toEqual([{ frame: 'writeObject', self: 1, ticks: 50 }]);
        expect(result.setupShares).toEqual([]);
      });
    });
  });
});
