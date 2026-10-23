import { describe, expect, it } from 'vitest';
import {
  type PositivePathspec,
  positiveOf,
  reachesSkipWorktree,
  resolveCommandPathspec,
  trackPositives,
  unmatchedPositives,
} from '../../../../../src/application/commands/internal/pathspec-intake.js';
import { resolvePathspec } from '../../../../../src/application/commands/internal/resolve-pathspec.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import { type IndexEntry, STAGE0_FLAGS } from '../../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../../src/domain/objects/index.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/object-id.js';
import { compilePathspec, type PathspecEntry } from '../../../../../src/domain/pathspec/index.js';
import { MATCH_LEVEL } from '../../../../../src/domain/pathspec/wildcard.js';

describe('resolveCommandPathspec', () => {
  describe('Given positive, negated and duplicate patterns', () => {
    describe('When resolved', () => {
      it('Then the positives keep argument order, spelling and duplicates', () => {
        // Arrange
        const sut = resolveCommandPathspec;
        const paths = ['src/foo', '*.ts', '!*.test.ts', './d', 'src/foo'];

        // Act
        const result = sut({}, paths);

        // Assert
        expect(result.positives.map((p) => p.spelling)).toEqual([
          'src/foo',
          '*.ts',
          './d',
          'src/foo',
        ]);
        expect(result.positives.map((p) => p.entry.body)).toEqual([
          'src/foo',
          '*.ts',
          'd',
          'src/foo',
        ]);
        expect(result.positives.every((p) => p.probesDisk)).toBe(true);
      });

      it('Then the other fields equal resolvePathspec', () => {
        // Arrange
        const sut = resolveCommandPathspec;
        const paths = ['src/foo', '*.ts', '!*.test.ts', './d', 'src/foo'];

        // Act
        const result = sut({}, paths);

        // Assert
        const expected = resolvePathspec(paths);
        expect(result.matcher.map((e) => e.pattern)).toEqual(
          expected.matcher.map((e) => e.pattern),
        );
        expect(result.literalMustMatch).toEqual(expected.literalMustMatch);
        expect(result.hasGlob).toBe(expected.hasGlob);
        expect(result.symlinkScanTargets).toEqual(expected.symlinkScanTargets);
      });
    });
  });

  describe('Given the whole-tree pattern', () => {
    describe('When resolved', () => {
      it('Then one positive has an empty body and the typed spelling', () => {
        // Arrange
        const sut = resolveCommandPathspec;

        // Act
        const result = sut({}, ['.']);

        // Assert
        expect(result.positives.map((p) => [p.entry.body, p.spelling])).toEqual([['', '.']]);
      });
    });
  });

  describe('Given only a negated pattern', () => {
    describe('When resolved', () => {
      it('Then there is no positive', () => {
        // Arrange
        const sut = resolveCommandPathspec;

        // Act
        const result = sut({}, ['!x']);

        // Assert
        expect(result.positives).toEqual([]);
      });
    });
  });
});

describe('positiveOf', () => {
  describe('Given an entry whose body holds a backslash', () => {
    describe('When built', () => {
      it('Then it does not probe the disk', () => {
        // Arrange
        const sut = positiveOf;
        const [entry] = compilePathspec(['a\\*b']);

        // Act
        const result = sut(entry as PathspecEntry, 'a\\*b');

        // Assert
        expect(result.probesDisk).toBe(false);
      });
    });
  });
});

describe('resolveCommandPathspec on a POSIX host', () => {
  describe('Given a pattern holding a backslash', () => {
    describe('When resolved', () => {
      it('Then it resolves and its positive never probes the disk', () => {
        // Arrange
        const sut = resolveCommandPathspec;

        // Act
        const result = sut({}, ['a\\*b']);

        // Assert
        expect(result.positives.map((p) => [p.spelling, p.probesDisk])).toEqual([['a\\*b', false]]);
      });
    });
  });
});

describe('resolveCommandPathspec on a Windows host', () => {
  describe('Given a negated pattern holding a backslash', () => {
    describe('When resolved', () => {
      it('Then it is refused as outside the repository, naming the body', () => {
        // Arrange
        const sut = resolveCommandPathspec;
        let caught: unknown;

        // Act
        try {
          sut({ windowsPathSyntax: true }, ['ok', '!a\\b']);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'PATHSPEC_OUTSIDE_REPO',
          path: 'a\\b',
        });
      });
    });
  });

  describe('Given backslash-free patterns', () => {
    describe('When resolved', () => {
      it('Then they resolve', () => {
        // Arrange
        const sut = resolveCommandPathspec;

        // Act
        const result = sut({ windowsPathSyntax: true }, ['ok', '!a/b']);

        // Assert
        expect(result.positives.map((p) => p.spelling)).toEqual(['ok']);
      });
    });
  });
});

describe('unmatchedPositives', () => {
  const positives = resolveCommandPathspec({}, ['a', 'b', 'c']).positives;

  describe('Given the second positive is seen', () => {
    describe('When filtered', () => {
      it('Then the first and third remain in order', () => {
        // Arrange
        const sut = unmatchedPositives;

        // Act
        const result = sut(positives, (p) => p.spelling === 'b');

        // Assert
        expect(result.map((p) => p.spelling)).toEqual(['a', 'c']);
      });
    });
  });

  describe('Given every positive is seen', () => {
    describe('When filtered', () => {
      it('Then none remain', () => {
        // Arrange
        const sut = unmatchedPositives;

        // Act
        const result = sut(positives, () => true);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });
});

describe('trackPositives', () => {
  const fileAt = (path: string) => path as FilePath;
  const trackerOver = (...paths: string[]) => {
    const { matcher, positives } = resolveCommandPathspec({}, paths);
    return { matcher, positives, sut: trackPositives(matcher, positives) };
  };

  describe('Given a tracker that observed nothing', () => {
    describe('When asked what was reached', () => {
      it('Then no positive is seen and every level is NONE', () => {
        // Arrange
        const { positives, sut } = trackerOver('a.txt', 'dir');

        // Act
        const seen = positives.map((positive) => sut.seen(positive));

        // Assert
        expect(seen).toEqual([false, false]);
        expect(sut.highest()).toEqual([MATCH_LEVEL.NONE, MATCH_LEVEL.NONE]);
      });
    });
  });

  describe('Given a path reaching one positive', () => {
    describe('When observed', () => {
      it('Then the verdict is returned and only that positive is seen', () => {
        // Arrange
        const { positives, sut } = trackerOver('a.txt', 'b.txt');

        // Act
        const verdict = sut.observe(fileAt('a.txt'));

        // Assert
        expect(verdict.matched).toBe(true);
        expect(verdict.levels).toEqual([MATCH_LEVEL.EXACT, MATCH_LEVEL.NONE]);
        expect(positives.map((positive) => sut.seen(positive))).toEqual([true, false]);
        expect(sut.highest()).toEqual([MATCH_LEVEL.EXACT, MATCH_LEVEL.NONE]);
      });
    });
  });

  describe('Given a positive reached at several levels', () => {
    describe('When the paths are observed in any order', () => {
      it('Then highest keeps the maximum level reached', () => {
        // Arrange
        const { sut } = trackerOver('dir');

        // Act
        sut.observe(fileAt('dir/inner.txt'));
        sut.observe(fileAt('dir'));
        sut.observe(fileAt('other'));

        // Assert
        expect(sut.highest()).toEqual([MATCH_LEVEL.EXACT]);
      });
    });

    describe('When only a path beneath the directory is observed', () => {
      it('Then the level is RECURSIVE', () => {
        // Arrange
        const { sut } = trackerOver('dir');

        // Act
        sut.observe(fileAt('dir/inner.txt'));

        // Assert
        expect(sut.highest()).toEqual([MATCH_LEVEL.RECURSIVE]);
      });
    });

    describe('When only a wildcard reaches the path', () => {
      it('Then the level is FNMATCH', () => {
        // Arrange
        const { sut } = trackerOver('*.txt');

        // Act
        sut.observe(fileAt('a.txt'));

        // Assert
        expect(sut.highest()).toEqual([MATCH_LEVEL.FNMATCH]);
      });
    });
  });

  describe('Given a negated entry beside a positive', () => {
    describe('When a path the negation excludes is observed', () => {
      it('Then the verdict is the negated one and the positives keep their own order', () => {
        // Arrange
        const { positives, sut } = trackerOver('*.ts', '!skip.ts', 'x.ts');

        // Act
        const verdict = sut.observe(fileAt('skip.ts'));

        // Assert
        expect(verdict.matched).toBe(false);
        expect(positives.map((positive) => positive.spelling)).toEqual(['*.ts', 'x.ts']);
        expect(sut.highest()).toEqual([MATCH_LEVEL.FNMATCH, MATCH_LEVEL.NONE]);
        expect(positives.map((positive) => sut.seen(positive))).toEqual([true, false]);
      });
    });

    describe('When a path reaching the positive placed after the negation is observed', () => {
      it('Then its level lands in its own slot, not at its matcher index', () => {
        // Arrange
        const { sut } = trackerOver('*.ts', '!skip.ts', 'x.ts');

        // Act
        sut.observe(fileAt('x.ts'));

        // Assert
        expect(sut.highest()).toEqual([MATCH_LEVEL.FNMATCH, MATCH_LEVEL.EXACT]);
      });
    });
  });

  describe('Given a positive object the tracker was not built from', () => {
    describe('When its seen state is read', () => {
      it('Then it counts as unseen', () => {
        // Arrange
        const { positives, sut } = trackerOver('*.ts');
        const foreign = { ...(positives[0] as PositivePathspec) };
        sut.observe(fileAt('a.ts'));

        // Act
        const result = sut.seen(foreign);

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});

const skipWorktreeEntry = (path: string): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode: FILE_MODE.REGULAR,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id: '0'.repeat(40) as ObjectId,
  flags: { ...STAGE0_FLAGS, skipWorktree: true },
  path: path as FilePath,
});

const positiveFor = (pattern: string): PositivePathspec =>
  positiveOf(compilePathspec([pattern])[0] as PathspecEntry, pattern);

describe('reachesSkipWorktree', () => {
  describe('Given a wildcard positive and a skip-worktree entry it matches', () => {
    describe('When asked', () => {
      it('Then it reaches it', () => {
        // Arrange
        const sut = reachesSkipWorktree;

        // Act
        const result = sut(positiveFor('*.log'), [skipWorktreeEntry('x.log')]);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a positive that matches no skip-worktree entry', () => {
    describe('When asked', () => {
      it('Then it does not reach one', () => {
        // Arrange
        const sut = reachesSkipWorktree;

        // Act
        const result = sut(positiveFor('k*'), [skipWorktreeEntry('x.log')]);

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});
