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
      // Arrange + Assert
      expectError(() => parseExpression(''), 'REVPARSE_UNRESOLVED');
    });

    it('Given a non-empty string, When parseExpression, Then the empty-string guard does not reject it and it parses as a ref-or-hex', () => {
      // Arrange — kills the StringLiteral mutant on the `raw === ''` guard:
      // if `''` were replaced by any non-empty literal, that literal would be
      // wrongly rejected as REVPARSE_UNRESOLVED instead of parsed as a ref.
      const sut = parseExpression('Stryker was here!');

      // Assert
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'Stryker was here!',
        operations: [],
      } satisfies RevExpression);
    });

    it("Given 'HEAD', When parseExpression, Then returns kind=ref base=HEAD with no operations", () => {
      // Arrange
      const sut = parseExpression('HEAD');

      // Assert
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'HEAD',
        operations: [],
      } satisfies RevExpression);
    });

    it("Given 'main', When parseExpression, Then returns kind=ref base=main", () => {
      // Arrange
      const sut = parseExpression('main');
      // Assert
      expect(sut).toEqual({ kind: 'ref-or-hex', base: 'main', operations: [] });
    });

    it("Given ':0:src/foo.ts', When parseExpression, Then returns kind=index-stage with stage=0 and path", () => {
      // Arrange
      const sut = parseExpression(':0:src/foo.ts');
      // Assert
      expect(sut).toEqual({ kind: 'index-stage', stage: 0, path: 'src/foo.ts' });
    });

    it("Given ':1:path' / ':2:path' / ':3:path', When parseExpression, Then stage is 1/2/3", () => {
      // Arrange + Assert
      expect(parseExpression(':1:f.txt')).toEqual({ kind: 'index-stage', stage: 1, path: 'f.txt' });
      expect(parseExpression(':2:f.txt')).toEqual({ kind: 'index-stage', stage: 2, path: 'f.txt' });
      expect(parseExpression(':3:f.txt')).toEqual({ kind: 'index-stage', stage: 3, path: 'f.txt' });
    });

    it("Given ':4:path' (out-of-range stage), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      // Arrange + Assert
      expectError(() => parseExpression(':4:f.txt'), 'REVPARSE_UNRESOLVED');
    });

    it("Given 'HEAD~3', When parseExpression, Then operations=[ancestor 3]", () => {
      // Arrange
      const sut = parseExpression('HEAD~3');
      // Assert
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'HEAD',
        operations: [{ kind: 'ancestor', n: 3 }],
      });
    });

    it("Given 'HEAD^', When parseExpression, Then operations=[parent 1]", () => {
      // Arrange
      const sut = parseExpression('HEAD^');
      // Assert
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'HEAD',
        operations: [{ kind: 'parent', n: 1 }],
      });
    });

    it("Given 'HEAD^2', When parseExpression, Then operations=[parent 2]", () => {
      // Arrange
      const sut = parseExpression('HEAD^2');
      // Assert
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'HEAD',
        operations: [{ kind: 'parent', n: 2 }],
      });
    });

    it("Given 'HEAD^^^', When parseExpression, Then three parent ops in sequence", () => {
      // Arrange
      const sut = parseExpression('HEAD^^^');
      // Assert
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
      // Arrange
      const sut = parseExpression('HEAD^{tree}');
      // Assert
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'HEAD',
        operations: [{ kind: 'peel', target: 'tree' }],
      });
    });

    it("Given 'HEAD^{commit}', When parseExpression, Then operations=[peel commit]", () => {
      // Arrange
      const sut = parseExpression('HEAD^{commit}');
      // Assert
      expect(sut.kind === 'ref-or-hex' && sut.operations[0]).toEqual({
        kind: 'peel',
        target: 'commit',
      });
    });

    it("Given 'HEAD^{blob}' / 'HEAD^{tag}', When parseExpression, Then peel target reflects type", () => {
      // Arrange + Assert
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
      // Arrange + Assert
      expectError(() => parseExpression('HEAD^{garbage}'), 'REVPARSE_UNRESOLVED');
    });

    it("Given 'HEAD~~' (~ with no number after), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      // Arrange + Assert
      expectError(() => parseExpression('HEAD~~'), 'REVPARSE_UNRESOLVED');
    });

    it("Given 'HEAD@{1}' (reflog index), When parseExpression, Then base=HEAD with an index reflog selector", () => {
      // Arrange
      const sut = parseExpression('HEAD@{1}');

      // Assert
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'HEAD',
        reflog: { kind: 'index', n: 1 },
        operations: [],
      } satisfies RevExpression);
    });

    it("Given 'HEAD@{0}' (boundary index zero), When parseExpression, Then the index selector carries n=0", () => {
      // Arrange
      const sut = parseExpression('HEAD@{0}');

      // Assert
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'HEAD',
        reflog: { kind: 'index', n: 0 },
        operations: [],
      } satisfies RevExpression);
    });

    it("Given 'HEAD@{12}' (multi-digit index), When parseExpression, Then the index selector carries n=12", () => {
      // Arrange
      const sut = parseExpression('HEAD@{12}');

      // Assert
      const reflog = (sut as { reflog?: { kind: string; n: number } }).reflog;
      expect(reflog).toEqual({ kind: 'index', n: 12 });
    });

    it("Given 'main@{0}^' (reflog selector then a parent op), When parseExpression, Then both the selector and the operation chain are parsed", () => {
      // Arrange
      const sut = parseExpression('main@{0}^');

      // Assert
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'main',
        reflog: { kind: 'index', n: 0 },
        operations: [{ kind: 'parent', n: 1 }],
      } satisfies RevExpression);
    });

    it("Given 'HEAD@{2.days.ago}~3' (date selector then ancestor op), When parseExpression, Then the date selector keeps its raw body and the op chain follows", () => {
      // Arrange
      const sut = parseExpression('HEAD@{2.days.ago}~3');

      // Assert
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'HEAD',
        reflog: { kind: 'date', raw: '2.days.ago' },
        operations: [{ kind: 'ancestor', n: 3 }],
      } satisfies RevExpression);
    });

    it("Given '@{yesterday}' (a date selector with no base), When parseExpression, Then base is empty and the selector is a date", () => {
      // Arrange
      const sut = parseExpression('@{yesterday}');

      // Assert
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: '',
        reflog: { kind: 'date', raw: 'yesterday' },
        operations: [],
      } satisfies RevExpression);
    });

    it("Given '@{1}' (a bare index selector), When parseExpression, Then base is empty and the selector is an index", () => {
      // Arrange
      const sut = parseExpression('@{1}');

      // Assert
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: '',
        reflog: { kind: 'index', n: 1 },
        operations: [],
      } satisfies RevExpression);
    });

    it("Given 'main@{2026-05-01 12:30:00}' (a date body with spaces), When parseExpression, Then the whole body is captured as the raw date", () => {
      // Arrange
      const sut = parseExpression('main@{2026-05-01 12:30:00}');

      // Assert
      const reflog = (sut as { reflog?: { kind: string; raw: string } }).reflog;
      expect(reflog).toEqual({ kind: 'date', raw: '2026-05-01 12:30:00' });
    });

    it("Given 'HEAD@{}' (an empty selector body), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      // Arrange / Act / Assert — an empty body is neither an index nor a date.
      expectError(() => parseExpression('HEAD@{}'), 'REVPARSE_UNRESOLVED');
    });

    it("Given 'HEAD@{2' (an unbalanced '@{' with no closing brace), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      // Arrange / Act / Assert
      expectError(() => parseExpression('HEAD@{2'), 'REVPARSE_UNRESOLVED');
    });

    it("Given 'HEAD@{1x}' (a body that is digits then a letter), When parseExpression, Then it is a date selector, not an index", () => {
      // Arrange / Act
      // Index discrimination is all-digits; `1x` is not, so it falls to date.
      const sut = parseExpression('HEAD@{1x}');

      // Assert
      const reflog = (sut as { reflog?: { kind: string; raw: string } }).reflog;
      expect(reflog).toEqual({ kind: 'date', raw: '1x' });
    });

    it("Given 'HEAD@{12' (a multi-character body with no closing brace), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      // Arrange / Act / Assert — isolates the missing-`}` guard from the
      // empty-body guard: the body here ('12') is non-empty, so only the
      // `close === -1` check can reject it.
      expectError(() => parseExpression('HEAD@{12'), 'REVPARSE_UNRESOLVED');
    });

    it("Given 'x}}@{0}' (a base containing close braces before '@{'), When parseExpression, Then the body is read from after '@{', not from the base", () => {
      // Arrange / Act — the `}` search must start after `@{`. A search anchored
      // earlier would latch onto a brace inside the base and read an empty body.
      const sut = parseExpression('x}}@{0}');

      // Assert — base keeps its braces; the selector body is the digit after `@{`.
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'x}}',
        reflog: { kind: 'index', n: 0 },
        operations: [],
      } satisfies RevExpression);
    });

    it("Given 'abc' (3 hex chars, looks like a prefix but too short), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      // Arrange + Assert
      expectError(() => parseExpression('abc'), 'REVPARSE_UNRESOLVED');
    });

    it("Given 'abc1234' (7 hex chars), When parseExpression, Then accepted as ref-or-hex with base=abc1234", () => {
      // Arrange
      const sut = parseExpression('abc1234');
      // Assert
      expect(sut).toEqual({ kind: 'ref-or-hex', base: 'abc1234', operations: [] });
    });

    it("Given 'HEAD~3^2', When parseExpression, Then ops=[ancestor 3, parent 2]", () => {
      // Arrange
      const sut = parseExpression('HEAD~3^2');
      // Assert
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
      // Arrange
      const sut = parseExpression('origin/main');
      // Assert
      expect(sut).toEqual({ kind: 'ref-or-hex', base: 'origin/main', operations: [] });
    });

    it("Given ':0:' (empty path), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      // Arrange + Assert
      expectError(() => parseExpression(':0:'), 'REVPARSE_UNRESOLVED');
    });

    it("Given ':' alone, When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      // Arrange + Assert
      expectError(() => parseExpression(':'), 'REVPARSE_UNRESOLVED');
    });

    it("Given 'HEAD~9' (boundary digit 9), When parseExpression, Then ancestor n=9", () => {
      // Arrange
      const sut = parseExpression('HEAD~9');
      // Assert
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'HEAD',
        operations: [{ kind: 'ancestor', n: 9 }],
      });
    });

    it("Given 'HEAD~0' (boundary digit 0), When parseExpression, Then ancestor n=0", () => {
      // Arrange
      const sut = parseExpression('HEAD~0');
      // Assert
      expect(sut).toEqual({
        kind: 'ref-or-hex',
        base: 'HEAD',
        operations: [{ kind: 'ancestor', n: 0 }],
      });
    });

    it("Given 'HEAD~10' (multi-digit), When parseExpression, Then ancestor n=10", () => {
      // Arrange
      const sut = parseExpression('HEAD~10');
      const op = (sut as { operations: ReadonlyArray<{ n: number }> }).operations[0];
      // Assert
      expect(op?.n).toBe(10);
    });

    it("Given 'HEAD^{' (peel with no closing brace), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      // Arrange + Assert
      expectError(() => parseExpression('HEAD^{'), 'REVPARSE_UNRESOLVED');
    });

    it("Given ':0' (stage with no path separator), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      // Arrange + Assert
      expectError(() => parseExpression(':0'), 'REVPARSE_UNRESOLVED');
    });

    it("Given 'HEAD<garbage' (no operator after base, just an unknown char), When parseExpression, Then base contains the full text", () => {
      // Arrange
      // The parser only stops at `~` and `^`. Anything else is part of the base
      // and forwarded to evaluation, where ref/hex resolution will fail.
      const sut = parseExpression('HEAD<garbage');
      // Assert
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

    it("Given 'HEAD~2z' (a digit then a letter after '~'), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      // Arrange / Act / Assert
      // `isDigit` must reject 'z' (0x7a): the digit-consuming loop stops after
      // '2', leaving the cursor on 'z', which is neither '~' nor '^' — the
      // else branch fails. A mutant that over-accepts non-digits would pull
      // 'z' into the number and the parse would succeed instead of throwing.
      expectError(() => parseExpression('HEAD~2z'), 'REVPARSE_UNRESOLVED');
    });

    it("Given 'HEAD^3z' (a digit then a letter after '^'), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      // Arrange / Act / Assert
      // Same guard for `parseCaret`'s digit loop: 'z' must not count as a
      // digit, so the cursor lands on 'z' and the else branch fails.
      expectError(() => parseExpression('HEAD^3z'), 'REVPARSE_UNRESOLVED');
    });

    it("Given 'HEAD~1.' (a digit then a '.' (0x2E) after '~'), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      // Arrange / Act / Assert
      // `isDigit` checks BOTH bounds: `code >= 0x30 && code <= 0x39`. '.' is
      // 0x2E — below the lower bound. The digit loop must stop after '1',
      // leaving the cursor on '.', which is neither '~' nor '^', so the else
      // branch in `parseOperations` fails. A mutant dropping the lower-bound
      // check (`code >= 0x30` -> true) would over-accept '.' (≤ 0x39), pull it
      // into the ancestor count, and the parse would succeed instead.
      expectError(() => parseExpression('HEAD~1.'), 'REVPARSE_UNRESOLVED');
    });

    it("Given 'HEAD^2/' (a digit then a '/' (0x2F) after '^'), When parseExpression, Then throws REVPARSE_UNRESOLVED", () => {
      // Arrange / Act / Assert
      // Same lower-bound guard for `parseCaret`'s digit loop: '/' is 0x2F,
      // below 0x30. It must stop the digit run after '2', stranding the cursor
      // on '/' so the else branch fails. A mutant dropping `code >= 0x30`
      // would accept '/' as a digit and the parse would succeed.
      expectError(() => parseExpression('HEAD^2/'), 'REVPARSE_UNRESOLVED');
    });
  });
});
