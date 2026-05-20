/** Unit tests for the refspec parser (v1 subset). */
import { describe, expect, it } from 'vitest';

import { parseRefspec } from '../../../../../src/application/commands/internal/refspec.js';
import { TsgitError } from '../../../../../src/domain/index.js';

describe('parseRefspec — happy paths', () => {
  it('Given a short branch name, When parsed, Then both sides expand to refs/heads/<name> with normal force', () => {
    // Act
    const sut = parseRefspec('main');

    // Assert
    expect(sut).toEqual({
      force: 'normal',
      src: 'refs/heads/main',
      dst: 'refs/heads/main',
      isDelete: false,
    });
  });

  it('Given a force shorthand "+branch", When parsed, Then force is "force" and both sides expand', () => {
    // Arrange & Act — kills the `startsWith("+")` → `===` mutant.
    const sut = parseRefspec('+main');

    // Assert
    expect(sut.force).toBe('force');
    expect(sut.src).toBe('refs/heads/main');
    expect(sut.dst).toBe('refs/heads/main');
    expect(sut.isDelete).toBe(false);
  });

  it('Given a fully-qualified src:dst, When parsed, Then no expansion is applied', () => {
    // Act
    const sut = parseRefspec('refs/heads/release:refs/heads/main');

    // Assert
    expect(sut.src).toBe('refs/heads/release');
    expect(sut.dst).toBe('refs/heads/main');
    expect(sut.isDelete).toBe(false);
  });

  it('Given a short:short form, When parsed, Then both sides expand independently', () => {
    // Arrange & Act
    const sut = parseRefspec('local:remote');

    // Assert
    expect(sut.src).toBe('refs/heads/local');
    expect(sut.dst).toBe('refs/heads/remote');
  });

  it('Given a delete refspec ":refs/heads/feature", When parsed, Then isDelete is true and src is empty', () => {
    // Arrange & Act — kills the `srcRaw === ''` guard mutant.
    const sut = parseRefspec(':refs/heads/feature');

    // Assert
    expect(sut.isDelete).toBe(true);
    expect(sut.src).toBe('');
    expect(sut.dst).toBe('refs/heads/feature');
    expect(sut.force).toBe('normal');
  });

  it('Given a force delete "+:refs/heads/feature", When parsed, Then force is "force" and isDelete is true', () => {
    // Arrange & Act — covers force + delete composition.
    const sut = parseRefspec('+:refs/heads/feature');

    // Assert
    expect(sut.force).toBe('force');
    expect(sut.isDelete).toBe(true);
    expect(sut.dst).toBe('refs/heads/feature');
  });

  it('Given a short delete ":feature", When parsed, Then dst expands to refs/heads/feature', () => {
    // Arrange & Act — short-form expansion happens on the dst even in
    // the delete path (dst can be `feature` short form, kills the
    // expandShort-only-when-non-empty mutant).
    const sut = parseRefspec(':feature');

    // Assert
    expect(sut.dst).toBe('refs/heads/feature');
    expect(sut.isDelete).toBe(true);
  });

  it('Given a HEAD src "HEAD:refs/heads/staging", When parsed, Then HEAD is preserved on the src side', () => {
    // Arrange & Act — kills the `name === 'HEAD'` short-circuit mutant
    // inside expandShort (without it HEAD would expand to refs/heads/HEAD).
    const sut = parseRefspec('HEAD:refs/heads/staging');

    // Assert
    expect(sut.src).toBe('HEAD');
    expect(sut.dst).toBe('refs/heads/staging');
  });

  it('Given a tag refspec, When parsed, Then both sides are preserved verbatim', () => {
    // Arrange & Act
    const sut = parseRefspec('refs/tags/v1.0:refs/tags/v1.0');

    // Assert
    expect(sut.src).toBe('refs/tags/v1.0');
    expect(sut.dst).toBe('refs/tags/v1.0');
  });
});

describe('parseRefspec — errors', () => {
  const assertRefspecInvalid = (
    fn: () => unknown,
    expectedReason: string,
    expectedRaw: string,
  ): void => {
    let caught: unknown;
    try {
      fn();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TsgitError);
    const data = (caught as TsgitError).data as { code: string; raw: string; reason: string };
    expect(data.code).toBe('REFSPEC_INVALID');
    expect(data.raw).toBe(expectedRaw);
    expect(data.reason).toContain(expectedReason);
  };

  it('Given empty input, When parsed, Then throws REFSPEC_INVALID with "must not be empty"', () => {
    assertRefspecInvalid(() => parseRefspec(''), 'must not be empty', '');
  });

  it('Given a bare "+" (force prefix only), When parsed, Then throws REFSPEC_INVALID', () => {
    assertRefspecInvalid(() => parseRefspec('+'), 'after force prefix', '+');
  });

  it('Given a refspec with two colons "a:b:c", When parsed, Then throws REFSPEC_INVALID', () => {
    assertRefspecInvalid(() => parseRefspec('a:b:c'), 'at most one colon', 'a:b:c');
  });

  it('Given a refspec ":" (empty src AND empty dst), When parsed, Then throws on empty dst', () => {
    assertRefspecInvalid(() => parseRefspec(':'), 'destination must not be empty', ':');
  });

  it('Given a refspec "main:" (empty dst), When parsed, Then throws REFSPEC_INVALID', () => {
    assertRefspecInvalid(() => parseRefspec('main:'), 'destination must not be empty', 'main:');
  });

  it('Given a refspec "main:HEAD", When parsed, Then throws REFSPEC_INVALID — HEAD as dst is rejected', () => {
    // Arrange — pins the canonical-git behavior. Push to HEAD is unsupported;
    // catching it here avoids server-side refusal with an opaque message.
    assertRefspecInvalid(() => parseRefspec('main:HEAD'), 'must not be HEAD', 'main:HEAD');
  });
});
