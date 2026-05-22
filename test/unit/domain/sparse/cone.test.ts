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
  it('Given a single nested directory, When built, Then recursive holds it and parents holds its ancestors', () => {
    // Arrange
    const dirs = ['a/b/c'];

    // Act
    const sut = buildConeSpec(dirs);

    // Assert
    expect([...sut.recursive].sort()).toEqual(['a/b/c']);
    expect([...sut.parents].sort()).toEqual(['a', 'a/b']);
  });

  it('Given sibling directories, When built, Then parents is their shared ancestor', () => {
    // Arrange
    const dirs = ['src/app', 'src/lib'];

    // Act
    const sut = buildConeSpec(dirs);

    // Assert
    expect([...sut.recursive].sort()).toEqual(['src/app', 'src/lib']);
    expect([...sut.parents].sort()).toEqual(['src']);
  });

  it('Given a directory that is also an ancestor of another, When built, Then it stays recursive and is not a parent', () => {
    // Arrange — `src` is asked for and is an ancestor of `src/app`.
    const dirs = ['src', 'src/app'];

    // Act
    const sut = buildConeSpec(dirs);

    // Assert
    expect([...sut.recursive].sort()).toEqual(['src', 'src/app']);
    expect([...sut.parents]).toEqual([]);
  });

  it('Given a root-level directory, When built, Then parents stays empty (root is implicit)', () => {
    // Arrange
    const dirs = ['docs'];

    // Act
    const sut = buildConeSpec(dirs);

    // Assert
    expect([...sut.recursive]).toEqual(['docs']);
    expect([...sut.parents]).toEqual([]);
  });

  it('Given a directory with leading and trailing slashes, When built, Then they are stripped', () => {
    // Arrange
    const dirs = ['/src/app/'];

    // Act
    const sut = buildConeSpec(dirs);

    // Assert
    expect([...sut.recursive]).toEqual(['src/app']);
  });

  it('Given a directory with backslash separators, When built, Then they become POSIX slashes', () => {
    // Arrange
    const dirs = ['src\\app'];

    // Act
    const sut = buildConeSpec(dirs);

    // Assert
    expect([...sut.recursive]).toEqual(['src/app']);
  });

  it('Given duplicate directories, When built, Then they are deduped', () => {
    // Arrange
    const dirs = ['src', 'src'];

    // Act
    const sut = buildConeSpec(dirs);

    // Assert
    expect([...sut.recursive]).toEqual(['src']);
  });

  it('Given a directory that normalises to empty, When built, Then it throws an invalid-segment INVALID_OPTION', () => {
    // Arrange — `/` normalises to `''`, which splits to a single empty segment.
    const dirs = ['/'];

    // Act
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
      reason: 'cone directory has an invalid segment: /',
    });
  });

  it('Given a directory with doubled leading slashes, When built, Then every leading slash is stripped', () => {
    // Arrange — pins the `+` quantifier in the `/^\/+/` strip regex.
    const dirs = ['//src'];

    // Act
    const sut = buildConeSpec(dirs);

    // Assert
    expect([...sut.recursive]).toEqual(['src']);
  });

  it('Given a directory with doubled trailing slashes, When built, Then every trailing slash is stripped', () => {
    // Arrange — pins the `+` quantifier in the `/\/+$/` strip regex.
    const dirs = ['src//'];

    // Act
    const sut = buildConeSpec(dirs);

    // Assert
    expect([...sut.recursive]).toEqual(['src']);
  });

  it('Given a directory with a "." segment, When built, Then it throws an invalid-segment INVALID_OPTION', () => {
    // Arrange
    const dirs = ['src/./app'];

    // Act
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
      reason: 'cone directory has an invalid segment: src/./app',
    });
  });

  it('Given a directory with a ".." segment, When built, Then it throws INVALID_OPTION', () => {
    // Arrange
    const dirs = ['src/../etc'];

    // Act
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

  it('Given a directory with a "*" metacharacter, When built, Then it throws a glob-metacharacter INVALID_OPTION', () => {
    // Arrange
    const dirs = ['srcdir*'];

    // Act
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
      reason: 'cone directory must not contain glob metacharacters: srcdir*',
    });
  });

  it('Given a directory with a "?" metacharacter, When built, Then it throws INVALID_OPTION', () => {
    // Arrange
    const dirs = ['sr?c'];

    // Act
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

  it('Given an empty segment in the middle, When built, Then it throws INVALID_OPTION', () => {
    // Arrange — a doubled internal slash leaves an empty segment.
    const dirs = ['src//app'];

    // Act
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

  it('Given a 2000-char cone directory with a bad segment, When built, Then the reflected name in the error reason is clamped to 128 chars', () => {
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

  it('Given a cone directory containing a newline, When built, Then it throws a control-character INVALID_OPTION', () => {
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
      expect(data.reason).toBe('cone directory must not contain control characters: src\napp');
    }
  });
});

describe('coneMatcher', () => {
  it('Given a root-level file, When matched, Then it is included', () => {
    // Arrange
    const sut = coneMatcher(buildConeSpec(['src/app']));

    // Act
    const result = sut(path('README.md'));

    // Assert
    expect(result).toBe(true);
  });

  it('Given a file directly inside a parent directory, When matched, Then it is included', () => {
    // Arrange — `src` is a parent of the recursive `src/app`.
    const sut = coneMatcher(buildConeSpec(['src/app']));

    // Act
    const result = sut(path('src/index.ts'));

    // Assert
    expect(result).toBe(true);
  });

  it('Given a file in a non-recursive subdirectory of a parent directory, When matched, Then it is excluded', () => {
    // Arrange — `src/other` is neither a parent nor under a recursive dir.
    const sut = coneMatcher(buildConeSpec(['src/app']));

    // Act
    const result = sut(path('src/other/file.ts'));

    // Assert
    expect(result).toBe(false);
  });

  it('Given a file inside a recursive directory, When matched, Then it is included', () => {
    // Arrange
    const sut = coneMatcher(buildConeSpec(['src/app']));

    // Act
    const result = sut(path('src/app/main.ts'));

    // Assert
    expect(result).toBe(true);
  });

  it('Given a deeply nested file under a recursive directory, When matched, Then it is included', () => {
    // Arrange — exercises the ancestor-of-d branch of underRecursive.
    const sut = coneMatcher(buildConeSpec(['src/app']));

    // Act
    const result = sut(path('src/app/components/button/index.ts'));

    // Assert
    expect(result).toBe(true);
  });

  it('Given a file fully outside the cone, When matched, Then it is excluded', () => {
    // Arrange
    const sut = coneMatcher(buildConeSpec(['src/app']));

    // Act
    const result = sut(path('docs/guide.md'));

    // Assert
    expect(result).toBe(false);
  });
});

describe('serializeCone', () => {
  it('Given the cone for "src/app" and "docs", When serialized, Then it emits git\'s exact cone-file text', () => {
    // Arrange
    const sut = buildConeSpec(['src/app', 'docs']);

    // Act
    const result = serializeCone(sut);

    // Assert
    expect(result).toBe('/*\n!/*/\n/docs/\n/src/\n!/src/*/\n/src/app/\n');
  });

  it('Given a cone with no parents, When serialized, Then no negated wildcard line is emitted', () => {
    // Arrange
    const sut = buildConeSpec(['docs']);

    // Act
    const result = serializeCone(sut);

    // Assert
    expect(result).toBe('/*\n!/*/\n/docs/\n');
  });
});

describe('parseCone', () => {
  it("Given git's cone-file text, When parsed, Then it round-trips the recursive and parent sets", () => {
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

  it('Given a cone file with a trailing blank line, When parsed, Then the blank line is skipped', () => {
    // Arrange
    const text = '/*\n!/*/\n/docs/\n\n';

    // Act
    const sut = parseCone(text);

    // Assert
    expect(sut).toBeDefined();
    expect([...(sut as ConeSpec).recursive]).toEqual(['docs']);
  });

  it('Given text with a wrong first header line, When parsed, Then it returns undefined', () => {
    // Arrange
    const text = '/x\n!/*/\n/docs/\n';

    // Act
    const sut = parseCone(text);

    // Assert
    expect(sut).toBeUndefined();
  });

  it('Given text with a wrong second header line, When parsed, Then it returns undefined', () => {
    // Arrange
    const text = '/*\n!/x/\n/docs/\n';

    // Act
    const sut = parseCone(text);

    // Assert
    expect(sut).toBeUndefined();
  });

  it('Given a body line that is not a "/<d>/" line, When parsed, Then it returns undefined', () => {
    // Arrange — `*.ts` is a non-cone pattern, not a directory line.
    const text = '/*\n!/*/\n*.ts\n';

    // Act
    const sut = parseCone(text);

    // Assert
    expect(sut).toBeUndefined();
  });

  it('Given a body line ending without a slash, When parsed, Then it returns undefined', () => {
    // Arrange
    const text = '/*\n!/*/\n/src\n';

    // Act
    const sut = parseCone(text);

    // Assert
    expect(sut).toBeUndefined();
  });

  it('Given an empty "//" directory line, When parsed, Then it returns undefined', () => {
    // Arrange
    const text = '/*\n!/*/\n//\n';

    // Act
    const sut = parseCone(text);

    // Assert
    expect(sut).toBeUndefined();
  });

  it('Given an orphan negated wildcard line, When parsed, Then it returns undefined', () => {
    // Arrange — `!/src/*/` not preceded by its `/src/` line.
    const text = '/*\n!/*/\n!/src/*/\n';

    // Act
    const sut = parseCone(text);

    // Assert
    expect(sut).toBeUndefined();
  });

  it('Given a slash-bounded line whose inner part starts with "!", When parsed, Then it returns undefined', () => {
    // Arrange — `/!weird/` starts and ends with `/`, but the inner `!weird`
    // is rejected because it begins with `!` (an exclusion marker, not a dir).
    const text = '/*\n!/*/\n/!weird/\n';

    // Act
    const sut = parseCone(text);

    // Assert
    expect(sut).toBeUndefined();
  });

  it('Given a "/<d>/" line not followed by its negated wildcard, When parsed, Then d is recursive', () => {
    // Arrange
    const text = '/*\n!/*/\n/src/\n';

    // Act
    const sut = parseCone(text);

    // Assert
    expect([...(sut as ConeSpec).recursive]).toEqual(['src']);
    expect([...(sut as ConeSpec).parents]).toEqual([]);
  });

  it('Given a cone file with CRLF line endings, When parsed, Then it still parses as cone', () => {
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

  it('Given a directory line with a mid-line carriage return, When parsed, Then only a trailing CR is stripped (the inner CR survives)', () => {
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
