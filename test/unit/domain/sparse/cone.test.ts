import { describe, expect, it } from 'vitest';
import { TsgitError } from '../../../../src/domain/error.js';
import { FilePath } from '../../../../src/domain/objects/object-id.js';
import {
  buildConeSpec,
  coneMatcher,
  parseCone,
  serializeCone,
} from '../../../../src/domain/sparse/cone.js';
import type { SparseSpec } from '../../../../src/domain/sparse/sparse-pattern.js';

type ConeSpec = Extract<SparseSpec, { mode: 'cone' }>;

const path = (p: string): FilePath => FilePath.from(p);

describe('buildConeSpec', () => {
  describe('Given a set of requested directories', () => {
    describe('When built', () => {
      it.each([
        {
          dirs: ['a/b/c'],
          recursive: ['a/b/c'],
          parents: ['a', 'a/b'],
          label: 'a single nested directory: recursive holds it and parents holds its ancestors',
        },
        {
          dirs: ['src/app', 'src/lib'],
          recursive: ['src/app', 'src/lib'],
          parents: ['src'],
          label: 'sibling directories: parents is their shared ancestor',
        },
        {
          // `src` is asked for and is an ancestor of `src/app`.
          dirs: ['src', 'src/app'],
          recursive: ['src', 'src/app'],
          parents: [],
          label:
            'a directory that is also an ancestor of another: it stays recursive and is not a parent',
        },
        {
          dirs: ['docs'],
          recursive: ['docs'],
          parents: [],
          label: 'a root-level directory: parents stays empty (root is implicit)',
        },
      ])('Then $label', ({ dirs, recursive, parents }) => {
        // Arrange + Act
        const sut = buildConeSpec(dirs);

        // Assert
        expect([...sut.recursive].sort()).toEqual(recursive);
        expect([...sut.parents].sort()).toEqual(parents);
      });
    });
  });

  describe('Given a directory needing separator/dedup normalisation', () => {
    describe('When built', () => {
      it.each([
        {
          dirs: ['/src/app/'],
          recursive: ['src/app'],
          label: 'leading and trailing slashes are stripped',
        },
        {
          dirs: ['src\\app'],
          recursive: ['src/app'],
          label: 'backslash separators become POSIX slashes',
        },
        {
          dirs: ['src', 'src'],
          recursive: ['src'],
          label: 'duplicate directories are deduped',
        },
        // Pins the `+` quantifier in the `/^\/+/` strip regex.
        { dirs: ['//src'], recursive: ['src'], label: 'every leading slash is stripped' },
        // Pins the `+` quantifier in the `/\/+$/` strip regex.
        { dirs: ['src//'], recursive: ['src'], label: 'every trailing slash is stripped' },
      ])('Then $label', ({ dirs, recursive }) => {
        // Arrange + Act
        const sut = buildConeSpec(dirs);

        // Assert
        expect([...sut.recursive]).toEqual(recursive);
      });
    });
  });

  describe('Given a directory string rejected with a specific reason', () => {
    describe('When built', () => {
      it.each([
        {
          // `/` normalises to `''`, which splits to a single empty segment.
          dirs: ['/'],
          reason: 'cone directory has an invalid segment: /',
          label: 'a directory that normalises to empty throws an invalid-segment INVALID_OPTION',
        },
        {
          dirs: ['src/./app'],
          reason: 'cone directory has an invalid segment: src/./app',
          label: 'a "." segment throws an invalid-segment INVALID_OPTION',
        },
        {
          dirs: ['srcdir*'],
          reason: 'cone directory must not contain glob metacharacters: srcdir*',
          label: 'a "*" metacharacter throws a glob-metacharacter INVALID_OPTION',
        },
      ])('Then $label', ({ dirs, reason }) => {
        // Arrange + Act
        let caught: unknown;
        try {
          buildConeSpec(dirs);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'INVALID_OPTION',
          option: 'patterns',
          reason,
        });
      });
    });
  });

  describe('Given a directory string rejected by the segment grammar', () => {
    describe('When built', () => {
      it.each([
        { dirs: ['src/../etc'], label: 'a ".." segment throws INVALID_OPTION' },
        { dirs: ['sr?c'], label: 'a "?" metacharacter throws INVALID_OPTION' },
        // A doubled internal slash leaves an empty segment.
        { dirs: ['src//app'], label: 'an empty segment in the middle throws INVALID_OPTION' },
      ])('Then $label', ({ dirs }) => {
        // Arrange + Act
        let caught: unknown;
        try {
          buildConeSpec(dirs);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toMatchObject({
          code: 'INVALID_OPTION',
          option: 'patterns',
        });
      });
    });
  });

  describe('Given a 2000-char cone directory with a bad segment', () => {
    describe('When built', () => {
      it('Then the reflected name in the error reason is clamped to 128 chars', () => {
        // Arrange — a pathologically long directory name; the error reason must
        // not amplify it into a megabyte-class payload.
        const dirs = [`${'a'.repeat(2000)}/..`];

        // Act
        let caught: unknown;
        try {
          buildConeSpec(dirs);
        } catch (error) {
          caught = error;
        }

        // Assert — the reason embeds at most the first 128 chars of the input.
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('INVALID_OPTION');
        if (data.code === 'INVALID_OPTION') {
          expect(data.reason).toBe(`cone directory has an invalid segment: ${'a'.repeat(128)}`);
        }
      });
    });
  });

  describe('Given a cone directory containing a newline', () => {
    describe('When built', () => {
      it('Then it throws a control-character INVALID_OPTION', () => {
        // Arrange — a newline in a cone dir would inject extra lines into the
        // serialised `.git/info/sparse-checkout` file.
        const dirs = ['src\napp'];

        // Act
        let caught: unknown;
        try {
          buildConeSpec(dirs);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('INVALID_OPTION');
        if (data.code === 'INVALID_OPTION') {
          expect(data.option).toBe('patterns');
          expect(data.reason).toBe('cone directory must not contain control characters: src\napp');
        }
      });
    });
  });
});

describe('coneMatcher', () => {
  describe('Given a matcher built for the cone `["src/app"]`, and a path', () => {
    describe('When matched', () => {
      it.each([
        { filePath: 'README.md', expected: true, label: 'a root-level file is included' },
        {
          // `src` is a parent of the recursive `src/app`.
          filePath: 'src/index.ts',
          expected: true,
          label: 'a file directly inside a parent directory is included',
        },
        {
          // `src/other` is neither a parent nor under a recursive dir.
          filePath: 'src/other/file.ts',
          expected: false,
          label: 'a file in a non-recursive subdirectory of a parent directory is excluded',
        },
        {
          filePath: 'src/app/main.ts',
          expected: true,
          label: 'a file inside a recursive directory is included',
        },
        {
          // Exercises the ancestor-of-d branch of underRecursive.
          filePath: 'src/app/components/button/index.ts',
          expected: true,
          label: 'a deeply nested file under a recursive directory is included',
        },
        {
          filePath: 'docs/guide.md',
          expected: false,
          label: 'a file fully outside the cone is excluded',
        },
      ])('Then $label', ({ filePath, expected }) => {
        // Arrange
        const sut = coneMatcher(buildConeSpec(['src/app']));

        // Act
        const result = sut(path(filePath));

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('serializeCone', () => {
  describe('Given the cone for "src/app" and "docs"', () => {
    describe('When serialized', () => {
      it("Then it emits git's exact cone-file text", () => {
        // Arrange
        const sut = buildConeSpec(['src/app', 'docs']);

        // Act
        const result = serializeCone(sut);

        // Assert
        expect(result).toBe('/*\n!/*/\n/docs/\n/src/\n!/src/*/\n/src/app/\n');
      });
    });
  });

  describe('Given a cone with no parents', () => {
    describe('When serialized', () => {
      it('Then no negated wildcard line is emitted', () => {
        // Arrange
        const sut = buildConeSpec(['docs']);

        // Act
        const result = serializeCone(sut);

        // Assert
        expect(result).toBe('/*\n!/*/\n/docs/\n');
      });
    });
  });
});

describe('parseCone', () => {
  describe("Given git's cone-file text", () => {
    describe('When parsed', () => {
      it('Then it round-trips the recursive and parent sets', () => {
        // Arrange
        const original = buildConeSpec(['src/app', 'docs']);
        const text = serializeCone(original);

        // Act
        const sut = parseCone(text);

        // Assert
        expect(sut).toBeDefined();
        expect([...(sut as ConeSpec).recursive].sort()).toEqual(['docs', 'src/app']);
        expect([...(sut as ConeSpec).parents].sort()).toEqual(['src']);
      });
    });
  });

  describe('Given a cone file with a trailing blank line', () => {
    describe('When parsed', () => {
      it('Then the blank line is skipped', () => {
        // Arrange
        const text = '/*\n!/*/\n/docs/\n\n';

        // Act
        const sut = parseCone(text);

        // Assert
        expect(sut).toBeDefined();
        expect([...(sut as ConeSpec).recursive]).toEqual(['docs']);
      });
    });
  });

  describe('Given malformed cone-file text', () => {
    describe('When parsed', () => {
      it.each([
        {
          text: '/x\n!/*/\n/docs/\n',
          label: 'a wrong first header line returns undefined',
        },
        {
          text: '/*\n!/x/\n/docs/\n',
          label: 'a wrong second header line returns undefined',
        },
        {
          // `*.ts` is a non-cone pattern, not a directory line.
          text: '/*\n!/*/\n*.ts\n',
          label: 'a body line that is not a "/<d>/" line returns undefined',
        },
        {
          text: '/*\n!/*/\n/src\n',
          label: 'a body line ending without a slash returns undefined',
        },
        {
          text: '/*\n!/*/\n//\n',
          label: 'an empty "//" directory line returns undefined',
        },
        {
          // `!/src/*/` not preceded by its `/src/` line.
          text: '/*\n!/*/\n!/src/*/\n',
          label: 'an orphan negated wildcard line returns undefined',
        },
        {
          // `/!weird/` starts and ends with `/`, but the inner `!weird` is
          // rejected because it begins with `!` (an exclusion marker, not a dir).
          text: '/*\n!/*/\n/!weird/\n',
          label: 'a slash-bounded line whose inner part starts with "!" returns undefined',
        },
      ])('Then $label', ({ text }) => {
        // Arrange + Act
        const sut = parseCone(text);

        // Assert
        expect(sut).toBeUndefined();
      });
    });
  });

  describe('Given a "/<d>/" line not followed by its negated wildcard', () => {
    describe('When parsed', () => {
      it('Then d is recursive', () => {
        // Arrange
        const text = '/*\n!/*/\n/src/\n';

        // Act
        const sut = parseCone(text);

        // Assert
        expect([...(sut as ConeSpec).recursive]).toEqual(['src']);
        expect([...(sut as ConeSpec).parents]).toEqual([]);
      });
    });
  });

  describe('Given a cone file with CRLF line endings', () => {
    describe('When parsed', () => {
      it('Then it still parses as cone', () => {
        // Arrange — a `\r\n`-terminated file leaves a trailing `\r` on each line;
        // it must be stripped before the cone-grammar checks.
        const text = '/*\r\n!/*/\r\n/src/\r\n!/src/*/\r\n/src/app/\r\n';

        // Act
        const sut = parseCone(text);

        // Assert
        expect(sut).toBeDefined();
        expect([...(sut as ConeSpec).recursive]).toEqual(['src/app']);
        expect([...(sut as ConeSpec).parents]).toEqual(['src']);
      });
    });
  });

  describe('Given a directory line with a mid-line carriage return', () => {
    describe('When parsed', () => {
      it('Then only a trailing CR is stripped (the inner CR survives)', () => {
        // Arrange — `/sr\rc/` carries a `\r` in the MIDDLE of the line, not at its
        // end. The strip is anchored with `$`, so the inner `\r` is preserved and
        // the dir is `sr\rc`. An un-anchored `/\r/` strip would remove it and
        // wrongly yield `src`.
        const text = '/*\n!/*/\n/sr\rc/\n';

        // Act
        const sut = parseCone(text);

        // Assert — the inner CR is part of the recursive directory name.
        expect([...(sut as ConeSpec).recursive]).toEqual(['sr\rc']);
      });
    });
  });
});
