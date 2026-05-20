import { describe, expect, it } from 'vitest';
import {
  parseExpression,
  type RevExpression,
} from '../../../../../src/application/commands/internal/rev-parse-grammar.js';
import { TsgitError } from '../../../../../src/domain/index.js';

const expectError = (fn: () => unknown, code: string): TsgitError => {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  expect((caught as TsgitError).data.code).toBe(code);
  return caught as TsgitError;
};

describe('internal/rev-parse-grammar', () => {
  describe('parseExpression', () => {
    it("Given '', When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      expectError(() => parseExpression(''), 'REVPARSE_UNRESOLVED');
    });

    it('Given a non-empty string, When parseExpression, Then the empty-string guard does not reject it and it parses as a ref-or-hex', () => {
      // Arrange — kills the StringLiteral mutant on the `raw === ''` guard:
      // if `''` were replaced by any non-empty literal, that literal would be
      // wrongly rejected as REVPARSE_UNRESOLVED instead of parsed as a ref.
      // Act
      const sut = parseExpression('Stryker was here!');

      // Assert
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'Stryker was here!',
        operations: [],
      } satisfies RevExpression);
    });

    it("Given 'HEAD', When parseExpression, Then returns kind=ref base=HEAD with no operations", () => {
      // Act
      const sut = parseExpression('HEAD');

      // Assert
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'HEAD',
        operations: [],
      } satisfies RevExpression);
    });

    it("Given 'main', When parseExpression, Then returns kind=ref base=main", () => {
      const sut = parseExpression('main');
      expect(sut).toEqual({ kind: 'ref-or-hex', base: 'main', operations: [] });
    });

    it("Given ':0:src/foo.ts', When parseExpression, Then returns kind=index-stage with stage=0 and path", () => {
      const sut = parseExpression(':0:src/foo.ts');
      expect(sut).toEqual({ kind: 'index-stage', stage: 0, path: 'src/foo.ts' });
    });

    it("Given ':1:path' / ':2:path' / ':3:path', When parseExpression, Then stage is 1/2/3", () => {
      expect(parseExpression(':1:f.txt')).toEqual({ kind: 'index-stage', stage: 1, path: 'f.txt' });
      expect(parseExpression(':2:f.txt')).toEqual({ kind: 'index-stage', stage: 2, path: 'f.txt' });
      expect(parseExpression(':3:f.txt')).toEqual({ kind: 'index-stage', stage: 3, path: 'f.txt' });
    });

    it("Given ':4:path' (out-of-range stage), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      expectError(() => parseExpression(':4:f.txt'), 'REVPARSE_UNRESOLVED');
    });

    it("Given 'HEAD~3', When parseExpression, Then operations=[ancestor 3]", () => {
      const sut = parseExpression('HEAD~3');
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'HEAD',
        operations: [{ kind: 'ancestor', n: 3 }],
      });
    });

    it("Given 'HEAD^', When parseExpression, Then operations=[parent 1]", () => {
      const sut = parseExpression('HEAD^');
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'HEAD',
        operations: [{ kind: 'parent', n: 1 }],
      });
    });

    it("Given 'HEAD^2', When parseExpression, Then operations=[parent 2]", () => {
      const sut = parseExpression('HEAD^2');
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'HEAD',
        operations: [{ kind: 'parent', n: 2 }],
      });
    });

    it("Given 'HEAD^^^', When parseExpression, Then three parent ops in sequence", () => {
      const sut = parseExpression('HEAD^^^');
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'HEAD',
        operations: [
          { kind: 'parent', n: 1 },
          { kind: 'parent', n: 1 },
          { kind: 'parent', n: 1 },
        ],
      });
    });

    it("Given 'HEAD^{tree}', When parseExpression, Then operations=[peel tree]", () => {
      const sut = parseExpression('HEAD^{tree}');
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'HEAD',
        operations: [{ kind: 'peel', target: 'tree' }],
      });
    });

    it("Given 'HEAD^{commit}', When parseExpression, Then operations=[peel commit]", () => {
      const sut = parseExpression('HEAD^{commit}');
      expect(sut.kind === 'ref-or-hex' && sut.operations[0]).toEqual({
        kind: 'peel',
        target: 'commit',
      });
    });

    it("Given 'HEAD^{blob}' / 'HEAD^{tag}', When parseExpression, Then peel target reflects type", () => {
      expect(
        (parseExpression('HEAD^{blob}') as { operations: ReadonlyArray<{ target: string }> })
          .operations[0]?.target,
      ).toBe('blob');
      expect(
        (parseExpression('HEAD^{tag}') as { operations: ReadonlyArray<{ target: string }> })
          .operations[0]?.target,
      ).toBe('tag');
    });

    it("Given 'HEAD^{garbage}' (unknown type), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      expectError(() => parseExpression('HEAD^{garbage}'), 'REVPARSE_UNRESOLVED');
    });

    it("Given 'HEAD~~' (~ with no number after), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      expectError(() => parseExpression('HEAD~~'), 'REVPARSE_UNRESOLVED');
    });

    it("Given 'HEAD@{1}' (reflog), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      expectError(() => parseExpression('HEAD@{1}'), 'REVPARSE_UNRESOLVED');
    });

    it("Given 'abc' (3 hex chars, looks like a prefix but too short), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      expectError(() => parseExpression('abc'), 'REVPARSE_UNRESOLVED');
    });

    it("Given 'abc1234' (7 hex chars), When parseExpression, Then accepted as ref-or-hex with base=abc1234", () => {
      const sut = parseExpression('abc1234');
      expect(sut).toEqual({ kind: 'ref-or-hex', base: 'abc1234', operations: [] });
    });

    it("Given 'HEAD~3^2', When parseExpression, Then ops=[ancestor 3, parent 2]", () => {
      const sut = parseExpression('HEAD~3^2');
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'HEAD',
        operations: [
          { kind: 'ancestor', n: 3 },
          { kind: 'parent', n: 2 },
        ],
      });
    });

    it("Given 'origin/main' (slash inside ref name), When parseExpression, Then base preserves slash", () => {
      const sut = parseExpression('origin/main');
      expect(sut).toEqual({ kind: 'ref-or-hex', base: 'origin/main', operations: [] });
    });

    it("Given ':0:' (empty path), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      expectError(() => parseExpression(':0:'), 'REVPARSE_UNRESOLVED');
    });

    it("Given ':' alone, When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      expectError(() => parseExpression(':'), 'REVPARSE_UNRESOLVED');
    });

    it("Given 'HEAD~9' (boundary digit 9), When parseExpression, Then ancestor n=9", () => {
      const sut = parseExpression('HEAD~9');
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'HEAD',
        operations: [{ kind: 'ancestor', n: 9 }],
      });
    });

    it("Given 'HEAD~0' (boundary digit 0), When parseExpression, Then ancestor n=0", () => {
      const sut = parseExpression('HEAD~0');
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'HEAD',
        operations: [{ kind: 'ancestor', n: 0 }],
      });
    });

    it("Given 'HEAD~10' (multi-digit), When parseExpression, Then ancestor n=10", () => {
      const sut = parseExpression('HEAD~10');
      const op = (sut as { operations: ReadonlyArray<{ n: number }> }).operations[0];
      expect(op?.n).toBe(10);
    });

    it("Given 'HEAD^{' (peel with no closing brace), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      expectError(() => parseExpression('HEAD^{'), 'REVPARSE_UNRESOLVED');
    });

    it("Given ':0' (stage with no path separator), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      expectError(() => parseExpression(':0'), 'REVPARSE_UNRESOLVED');
    });

    it("Given 'HEAD<garbage' (no operator after base, just an unknown char), When parseExpression, Then base contains the full text", () => {
      // The parser only stops at `~` and `^`. Anything else is part of the base
      // and forwarded to evaluation, where ref/hex resolution will fail.
      const sut = parseExpression('HEAD<garbage');
      expect((sut as { base: string }).base).toBe('HEAD<garbage');
    });

    it("Given 'abc^' (short hex base followed by an operator), When parseExpression, Then accepted as ref-or-hex with operations", () => {
      // Arrange / Act
      // A short hex base only fails when it stands alone (opStart === -1).
      // With an operator chain it is a valid ref-or-hex expression.
      const sut = parseExpression('abc^');

      // Assert
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'abc',
        operations: [{ kind: 'parent', n: 1 }],
      } satisfies RevExpression);
    });

    it("Given 'HEAD^x' (non-operator char inside the operation chain), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      // Arrange / Act / Assert
      // After parsing `^`, the cursor lands on `x`, which is neither `~` nor `^`.
      expectError(() => parseExpression('HEAD^x'), 'REVPARSE_UNRESOLVED');
    });

    it("Given '^1' (empty base before an operator), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      // Arrange / Act / Assert
      expectError(() => parseExpression('^1'), 'REVPARSE_UNRESOLVED');
    });

    it("Given ':5:f.txt' (single-digit out-of-range stage), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      // Arrange / Act / Assert
      expectError(() => parseExpression(':5:f.txt'), 'REVPARSE_UNRESOLVED');
    });

    it("Given 'HEAD^{tag}^{tree}' (chained peels), When parseExpression, Then operations=[peel tag, peel tree]", () => {
      // Arrange / Act
      // The second `^{` must scan for its own `}` starting after `i + 2`, not
      // before — otherwise it would latch onto the first peel's closing brace.
      const sut = parseExpression('HEAD^{tag}^{tree}');

      // Assert
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'HEAD',
        operations: [
          { kind: 'peel', target: 'tag' },
          { kind: 'peel', target: 'tree' },
        ],
      } satisfies RevExpression);
    });

    it("Given 'HEAD~:' (a ':' (0x3A) right after '~'), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      // Arrange / Act / Assert
      // ':' has char code 0x3A, just past the digit range — it must not count
      // as a digit, leaving `~` with no number and triggering the failure.
      expectError(() => parseExpression('HEAD~:'), 'REVPARSE_UNRESOLVED');
    });

    it("Given 'HEAD~123' (multi-digit ancestor), When parseExpression, Then ancestor n=123", () => {
      // Arrange / Act
      const sut = parseExpression('HEAD~123');

      // Assert
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'HEAD',
        operations: [{ kind: 'ancestor', n: 123 }],
      } satisfies RevExpression);
    });

    it("Given 'HEAD^23' (multi-digit parent), When parseExpression, Then parent n=23", () => {
      // Arrange / Act
      const sut = parseExpression('HEAD^23');

      // Assert
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'HEAD',
        operations: [{ kind: 'parent', n: 23 }],
      } satisfies RevExpression);
    });
  });
});
