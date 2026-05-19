import { describe, expect, it } from 'vitest';
import {
  enforceLiteralMustMatch,
  resolvePathspec,
} from '../../../../../src/application/commands/internal/resolve-pathspec.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import type { FilePath } from '../../../../../src/domain/objects/object-id.js';

const path = (s: string): FilePath => s as FilePath;

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

describe('resolvePathspec', () => {
  it('Given a single literal, When resolved, Then hasGlob=false and the literal is must-match', () => {
    const sut = resolvePathspec(['src/foo.ts']);

    expect(sut.hasGlob).toBe(false);
    expect(sut.literalMustMatch).toEqual(['src/foo.ts']);
  });

  it('Given a single glob, When resolved, Then hasGlob=true and literalMustMatch is empty', () => {
    const sut = resolvePathspec(['*.ts']);

    expect(sut.hasGlob).toBe(true);
    expect(sut.literalMustMatch).toEqual([]);
  });

  it('Given a mix of literal + glob + negation, When resolved, Then literalMustMatch contains only positive literals', () => {
    const sut = resolvePathspec(['src/foo', '*.ts', '!*.test.ts', '!src/skip']);

    expect(sut.literalMustMatch).toEqual(['src/foo']);
    expect(sut.hasGlob).toBe(true);
  });

  it('Given a `!`-only spec, When resolved, Then literalMustMatch is empty (negations are not must-match)', () => {
    const sut = resolvePathspec(['!*.ts', '!src/skip']);

    expect(sut.literalMustMatch).toEqual([]);
    expect(sut.hasGlob).toBe(false);
  });

  it('Given a pattern with `..`, When resolved, Then throws PATHSPEC_OUTSIDE_REPO', () => {
    expectError(() => resolvePathspec(['../escape']), 'PATHSPEC_OUTSIDE_REPO');
  });

  it('Given a `!`-prefixed pattern with `..`, When resolved, Then the body validation still throws', () => {
    expectError(() => resolvePathspec(['!../escape']), 'PATHSPEC_OUTSIDE_REPO');
  });

  it('Given an empty pattern (`""`), When resolved, Then throws PATHSPEC_OUTSIDE_REPO via the validator', () => {
    expectError(() => resolvePathspec(['']), 'PATHSPEC_OUTSIDE_REPO');
  });

  it('Given a bare `"!"`, When resolved, Then the empty body throws PATHSPEC_OUTSIDE_REPO', () => {
    expectError(() => resolvePathspec(['!']), 'PATHSPEC_OUTSIDE_REPO');
  });

  it('Given a pattern exceeding the per-pattern length cap, When resolved, Then throws INVALID_OPTION', () => {
    // Arrange — components are each ≤ 255 bytes (passes the working-tree
    // path validator) but the overall pattern is > 256 bytes (trips
    // the pathspec-specific cap that bounds regex compilation cost).
    const seg = 'a'.repeat(100);
    const huge = `${seg}/${seg}/${seg}`;
    expect(huge.length).toBeGreaterThan(256);

    // Act
    const err = expectError(() => resolvePathspec([huge]), 'INVALID_OPTION');

    // Assert
    const data = err.data as { option: string; reason: string };
    expect(data.option).toBe('paths');
    expect(data.reason).toMatch(/max length/i);
  });

  it('Given a pattern with more than the **-token cap, When resolved, Then throws INVALID_OPTION', () => {
    // Arrange — `**/**/**/**/**/**` has six `**` tokens; cap is 4.
    const pattern = '**/**/**/**/**/**';

    // Act
    const err = expectError(() => resolvePathspec([pattern]), 'INVALID_OPTION');

    // Assert
    const data = err.data as { option: string; reason: string };
    expect(data.option).toBe('paths');
    expect(data.reason).toMatch(/\*\*-token count/);
  });

  it('Given a pattern with exactly the **-token cap (4 tokens), When resolved, Then accepts (boundary)', () => {
    // Kills the `>` → `>=` mutant on the **-cap.
    expect(() => resolvePathspec(['**/**/**/**'])).not.toThrow();
  });
});

describe('enforceLiteralMustMatch', () => {
  it('Given a literal that appears verbatim in matched, When checked, Then no throw', () => {
    expect(() =>
      enforceLiteralMustMatch([path('src/foo.ts')], [path('src/foo.ts'), path('other')]),
    ).not.toThrow();
  });

  it('Given a literal whose descendant appears in matched (literal acts as dir prefix), When checked, Then no throw', () => {
    expect(() => enforceLiteralMustMatch([path('src')], [path('src/foo.ts')])).not.toThrow();
  });

  it('Given a literal with no direct or prefix match, When checked, Then throws PATHSPEC_NO_MATCH with the missing literal', () => {
    const err = expectError(
      () => enforceLiteralMustMatch([path('nope.txt')], [path('other.ts')]),
      'PATHSPEC_NO_MATCH',
    );
    expect((err.data as { pattern: string }).pattern).toBe('nope.txt');
  });

  it('Given multiple literals where one is missing, When checked, Then throws with the missing one', () => {
    const err = expectError(
      () => enforceLiteralMustMatch([path('found'), path('missing')], [path('found/x')]),
      'PATHSPEC_NO_MATCH',
    );
    expect((err.data as { pattern: string }).pattern).toBe('missing');
  });

  it('Given no literals (empty list), When checked, Then no throw regardless of matched', () => {
    expect(() => enforceLiteralMustMatch([], [])).not.toThrow();
  });
});
