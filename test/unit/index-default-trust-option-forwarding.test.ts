/**
 * Unit coverage for the memory shim's trust-option plumbing
 * (`src/index.default.ts`): `trust`, `trustedDirectories`, and
 * `bareRepositories` must reach `resolveLayout` ONLY when the caller
 * actually set them — `exactOptionalPropertyTypes` forbids the
 * explicit-undefined form, and a dropped option silently disables a
 * security gate.
 *
 * `resolveLayout`'s OWN option-assembly re-applies the identical
 * `!== undefined` guard one layer down (`src/repository/resolve-layout.ts`),
 * so a leaked `{ field: undefined }` key from this shim is invisible to
 * every downstream consumer (`evaluateTrust`, `isImplicitBare`) — it gets
 * filtered again before it can matter, and the memory adapter's probe never
 * implements `isOwnedByCaller` at all, so the trust verdict itself is always
 * `trusted` regardless of content. The only oracle that can see this shim's
 * own conditional-spread mutants is a spy on `resolveLayout`'s call
 * arguments, asserted by KEY PRESENCE (`in`), not `toEqual` (which treats an
 * undefined-valued key as absent).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/repository/resolve-layout.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/repository/resolve-layout.js')>();
  return { ...actual, resolveLayout: vi.fn(actual.resolveLayout) };
});

const { resolveLayout } = await import('../../src/repository/resolve-layout.js');
const { openRepository } = await import('../../src/index.default.js');

const resolveLayoutSpy = vi.mocked(resolveLayout);

/** The 4th positional argument (`opts`) of the last `resolveLayout` call. */
const capturedOpts = (): Record<string, unknown> => {
  const call = resolveLayoutSpy.mock.calls[0];
  if (call === undefined) throw new Error('resolveLayout was not called');
  return call[3] as unknown as Record<string, unknown>;
};

describe('Given no trust-related options', () => {
  describe('When openRepository runs', () => {
    it('Then trust, trustedDirectories, and bareRepositories are absent as keys from the resolveLayout call', async () => {
      // Arrange
      resolveLayoutSpy.mockClear();
      const sut = openRepository;

      // Act
      await sut();
      const opts = capturedOpts();

      // Assert
      expect('trust' in opts).toBe(false);
      expect('trustedDirectories' in opts).toBe(false);
      expect('bareRepositories' in opts).toBe(false);
    });
  });
});

describe('Given trust, trustedDirectories, and bareRepositories are all explicitly set', () => {
  describe('When openRepository runs', () => {
    it('Then each reaches resolveLayout with its own forwarded or canonicalised value', async () => {
      // Arrange
      resolveLayoutSpy.mockClear();
      const sut = openRepository;

      // Act — the wildcard entry must survive canonicalisation literally,
      // while the plain path entry is collapsed ('..' resolved away) —
      // proof that the '*' skip branch actually ran for the wildcard and
      // the resolve branch actually ran for the other entry.
      await sut({
        trust: 'always',
        trustedDirectories: ['*', '/repo/../elsewhere'],
        bareRepositories: 'explicit',
      });
      const opts = capturedOpts();

      // Assert
      expect(opts.trust).toBe('always');
      expect(opts.trustedDirectories).toStrictEqual(['*', '/elsewhere']);
      expect(opts.bareRepositories).toBe('explicit');
    });
  });
});
