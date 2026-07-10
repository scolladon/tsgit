import { describe, expect, it } from 'vitest';

import { parseDigest, partitionWriteDigest } from '../../profile-digest.js';

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
          '     37   56.1%   100.0%  LazyCompile: *walkCommitsByDate /repo/dist/esm/application/primitives/walk-commits.js:12:34',
          '',
          ' [Summary]:',
          '     37   56.1%   100.0%  JavaScript',
          '     23   34.8%          Shared libraries',
          '      6    9.1%          Unaccounted',
        ].join('\n');

        // Act
        const result = parseDigest(digestText);

        // Assert
        expect(result).toEqual([{ frame: 'walkCommitsByDate', self: 1 }]);
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
          '     10   15.0%    25.0%  LazyCompile: *readBlob /repo/dist/esm/application/primitives/read-object.js:20:10',
          '     30   45.0%    75.0%  LazyCompile: *walkCommitsByDate /repo/dist/esm/application/primitives/walk-commits.js:12:34',
          '',
          ' [Summary]:',
          '     40   60.0%   100.0%  JavaScript',
        ].join('\n');

        // Act
        const result = parseDigest(digestText);

        // Assert
        expect(result).toEqual([
          { frame: 'walkCommitsByDate', self: 0.75 },
          { frame: 'readBlob', self: 0.25 },
        ]);
      });
    });
  });

  describe('Given a digest whose only tsgit frame has self below the 1% floor', () => {
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
        expect(result).toEqual([]);
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
          '    999   99.9%    99.9%  LazyCompile: *walkCommitsByDate /repo/dist/esm/application/primitives/walk-commits.js:12:34',
          '      1    0.1%     0.1%  LazyCompile: *rareHelper /repo/dist/esm/application/primitives/rare-helper.js:3:1',
          '',
          ' [Summary]:',
          '   1000  100.0%   100.0%  JavaScript',
        ].join('\n');

        // Act
        const result = parseDigest(digestText);

        // Assert
        expect(result).toEqual([{ frame: 'walkCommitsByDate', self: 1 }]);
      });
    });
  });
});

describe('partitionWriteDigest', () => {
  describe('Given a write digest containing a build-only frame (bootstrapRepository) and a command frame (writeCommitObject)', () => {
    describe('When partitionWriteDigest runs with the default denylist', () => {
      it('Then the build-only frame is in setupShares and the command frame is in hotShares', () => {
        // Arrange
        const digestText = [
          ...digestHeader,
          ' [JavaScript]:',
          '   ticks  total  nonlib   name',
          '     10   25.0%    25.0%  LazyCompile: *bootstrapRepository /repo/dist/esm/application/commands/internal/bootstrap.js:41:1',
          '     30   75.0%    75.0%  LazyCompile: *writeCommitObject /repo/dist/esm/application/primitives/write-commit-object.js:9:1',
          '',
          ' [Summary]:',
          '     40  100.0%   100.0%  JavaScript',
        ].join('\n');

        // Act
        const result = partitionWriteDigest(digestText);

        // Assert
        expect(result.hotShares).toEqual([{ frame: 'writeCommitObject', self: 0.75 }]);
        expect(result.setupShares).toEqual([{ frame: 'bootstrapRepository', self: 0.25 }]);
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
          '     50  100.0%   100.0%  LazyCompile: *writeObject /repo/dist/esm/application/primitives/write-object.js:15:1',
          '',
          ' [Summary]:',
          '     50  100.0%   100.0%  JavaScript',
        ].join('\n');

        // Act
        const result = partitionWriteDigest(digestText);

        // Assert
        expect(result.hotShares).toEqual([{ frame: 'writeObject', self: 1 }]);
        expect(result.setupShares).toEqual([]);
      });
    });
  });
});
