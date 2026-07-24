/** Unit tests for the refspec parser (v1 subset). */
import { describe, expect, it } from 'vitest';

import { parseRefspec } from '../../../../../src/application/commands/internal/refspec.js';
import { TsgitError } from '../../../../../src/domain/index.js';

describe('parseRefspec — happy paths', () => {
  describe('Given a short branch name', () => {
    describe('When parsed', () => {
      it('Then both sides expand to refs/heads/<name> with normal force', () => {
        // Arrange
        const sut = parseRefspec('main');

        // Assert
        expect(sut).toEqual({
          force: 'normal',
          src: 'refs/heads/main',
          dst: 'refs/heads/main',
          isDelete: false,
        });
      });
    });
  });

  describe('Given a force shorthand "+branch"', () => {
    describe('When parsed', () => {
      it('Then force is "force" and both sides expand', () => {
        // Arrange & Act — kills the `startsWith("+")` → `===` mutant.
        const sut = parseRefspec('+main');

        // Assert
        expect(sut.force).toBe('force');
        expect(sut.src).toBe('refs/heads/main');
        expect(sut.dst).toBe('refs/heads/main');
        expect(sut.isDelete).toBe(false);
      });
    });
  });

  describe('Given a fully-qualified src:dst', () => {
    describe('When parsed', () => {
      it('Then no expansion is applied', () => {
        // Arrange
        const sut = parseRefspec('refs/heads/release:refs/heads/main');

        // Assert
        expect(sut.src).toBe('refs/heads/release');
        expect(sut.dst).toBe('refs/heads/main');
        expect(sut.isDelete).toBe(false);
      });
    });
  });

  describe('Given a short:short form', () => {
    describe('When parsed', () => {
      it('Then both sides expand independently', () => {
        // Arrange & Act
        const sut = parseRefspec('local:remote');

        // Assert
        expect(sut.src).toBe('refs/heads/local');
        expect(sut.dst).toBe('refs/heads/remote');
      });
    });
  });

  describe('Given a delete refspec ":refs/heads/feature"', () => {
    describe('When parsed', () => {
      it('Then isDelete is true and src is empty', () => {
        // Arrange & Act — kills the `srcRaw === ''` guard mutant.
        const sut = parseRefspec(':refs/heads/feature');

        // Assert
        expect(sut.isDelete).toBe(true);
        expect(sut.src).toBe('');
        expect(sut.dst).toBe('refs/heads/feature');
        expect(sut.force).toBe('normal');
      });
    });
  });

  describe('Given a force delete "+:refs/heads/feature"', () => {
    describe('When parsed', () => {
      it('Then force is "force" and isDelete is true', () => {
        // Arrange & Act — covers force + delete composition.
        const sut = parseRefspec('+:refs/heads/feature');

        // Assert
        expect(sut.force).toBe('force');
        expect(sut.isDelete).toBe(true);
        expect(sut.dst).toBe('refs/heads/feature');
      });
    });
  });

  describe('Given a short delete ":feature"', () => {
    describe('When parsed', () => {
      it('Then dst expands to refs/heads/feature', () => {
        // Arrange & Act — short-form expansion happens on the dst even in
        // the delete path (dst can be `feature` short form, kills the
        // expandShort-only-when-non-empty mutant).
        const sut = parseRefspec(':feature');

        // Assert
        expect(sut.dst).toBe('refs/heads/feature');
        expect(sut.isDelete).toBe(true);
      });
    });
  });

  describe('Given a HEAD src "HEAD:refs/heads/staging"', () => {
    describe('When parsed', () => {
      it('Then HEAD is preserved on the src side', () => {
        // Arrange & Act — kills the `name === 'HEAD'` short-circuit mutant
        // inside expandShort (without it HEAD would expand to refs/heads/HEAD).
        const sut = parseRefspec('HEAD:refs/heads/staging');

        // Assert
        expect(sut.src).toBe('HEAD');
        expect(sut.dst).toBe('refs/heads/staging');
      });
    });
  });

  describe('Given a tag refspec', () => {
    describe('When parsed', () => {
      it('Then both sides are preserved verbatim', () => {
        // Arrange & Act
        const sut = parseRefspec('refs/tags/v1.0:refs/tags/v1.0');

        // Assert
        expect(sut.src).toBe('refs/tags/v1.0');
        expect(sut.dst).toBe('refs/tags/v1.0');
      });
    });
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

  describe('Given an invalid refspec string', () => {
    describe('When parsed', () => {
      it.each([
        { raw: '', reason: 'must not be empty', label: 'empty input' },
        { raw: '+', reason: 'after force prefix', label: 'a bare "+" (force prefix only)' },
        { raw: 'a:b:c', reason: 'at most one colon', label: 'a refspec with two colons "a:b:c"' },
        {
          raw: ':',
          reason: 'destination must not be empty',
          label: 'a refspec ":" (empty src AND empty dst)',
        },
        {
          raw: 'main:',
          reason: 'destination must not be empty',
          label: 'a refspec "main:" (empty dst)',
        },
        {
          raw: 'main:HEAD',
          reason: 'must not be HEAD',
          label: 'a refspec "main:HEAD" — HEAD as dst is rejected',
        },
      ])('Then $label throws REFSPEC_INVALID', ({ raw, reason }) => {
        // Arrange + Assert
        assertRefspecInvalid(() => parseRefspec(raw), reason, raw);
      });
    });
  });

  describe('Given empty input', () => {
    describe('When parsed', () => {
      it('Then the reason is EXACTLY the empty-refspec message (not the after-force-prefix variant)', () => {
        // Arrange — the empty-input guard fires on line 47 before the
        // force-prefix logic. Pinning the EXACT reason kills three same-line
        // mutants: the ConditionalExpression→false and BlockStatement→{}
        // mutants both fall through to the "after force prefix" guard, and
        // the StringLiteral mutant replaces the message wholesale.
        let caught: unknown;
        try {
          parseRefspec('');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; raw: string; reason: string };
        expect(data.code).toBe('REFSPEC_INVALID');
        expect(data.raw).toBe('');
        expect(data.reason).toBe('refspec must not be empty');
      });
    });
  });
});
