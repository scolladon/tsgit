import { describe, expect, it } from 'vitest';
import {
  positiveOf,
  resolveCommandPathspec,
  unmatchedPositives,
} from '../../../../../src/application/commands/internal/pathspec-intake.js';
import { resolvePathspec } from '../../../../../src/application/commands/internal/resolve-pathspec.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import { compilePathspec, type PathspecEntry } from '../../../../../src/domain/pathspec/index.js';

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
