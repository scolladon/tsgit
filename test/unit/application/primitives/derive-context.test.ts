import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { deriveContext } from '../../../../src/application/primitives/derive-context.js';
import { SHA256_CONFIG } from '../../../../src/domain/objects/hash-config.js';
import type { HashService } from '../../../../src/ports/hash-service.js';

describe('deriveContext', () => {
  describe('Given a derivation that changes gitDir (and, with it, the common dir)', () => {
    describe('When deriveContext runs', () => {
      it('Then the session is fresh', () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const derived = deriveContext(ctx, {
          layout: { ...ctx.layout, gitDir: '/elsewhere/.git' },
        });

        // Assert
        expect(derived.session).not.toBe(ctx.session);
      });
    });
  });

  describe('Given a worktree-shaped derivation that changes gitDir but keeps the common dir', () => {
    describe('When deriveContext runs', () => {
      it('Then the session is preserved', () => {
        // Arrange
        const ctx = createMemoryContext();
        const common = ctx.layout.commonDir ?? ctx.layout.gitDir;

        // Act
        const derived = deriveContext(ctx, {
          layout: { ...ctx.layout, gitDir: '/repo/.git/worktrees/wt1', commonDir: common },
        });

        // Assert
        expect(derived.session).toBe(ctx.session);
      });
    });
  });

  describe('Given a derivation that changes the fs root set with no accompanying layout change', () => {
    describe('When deriveContext runs', () => {
      it('Then the session is fresh', () => {
        // Arrange
        const ctx = createMemoryContext();
        const otherFs = ctx.fs;

        // Act
        const derived = deriveContext(ctx, { fs: otherFs });

        // Assert
        expect(derived.session).not.toBe(ctx.session);
      });
    });
  });

  describe('Given a derivation that changes only the hash service (hashConfig untouched)', () => {
    describe('When deriveContext runs', () => {
      it('Then the session is fresh', () => {
        // Arrange
        const ctx = createMemoryContext();
        const sha256Hash = { ...ctx.hash, algorithm: 'sha256' } as HashService;

        // Act
        const derived = deriveContext(ctx, { hash: sha256Hash });

        // Assert
        expect(derived.session).not.toBe(ctx.session);
      });
    });
  });

  describe('Given a derivation that changes only hashConfig (hash service untouched)', () => {
    describe('When deriveContext runs', () => {
      it('Then the session is fresh', () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const derived = deriveContext(ctx, { hashConfig: SHA256_CONFIG });

        // Assert
        expect(derived.session).not.toBe(ctx.session);
      });
    });
  });

  describe('Given a derivation that changes the hash algorithm', () => {
    describe('When deriveContext runs without an override', () => {
      it('Then the session is fresh', () => {
        // Arrange
        const ctx = createMemoryContext();
        const sha256Hash = { ...ctx.hash, algorithm: 'sha256' } as HashService;

        // Act
        const derived = deriveContext(ctx, { hash: sha256Hash, hashConfig: SHA256_CONFIG });

        // Assert
        expect(derived.session).not.toBe(ctx.session);
      });
    });

    describe('When deriveContext runs with keepSessionAcrossHashChange', () => {
      it('Then the session is preserved', () => {
        // Arrange
        const ctx = createMemoryContext();
        const sha256Hash = { ...ctx.hash, algorithm: 'sha256' } as HashService;

        // Act
        const derived = deriveContext(
          ctx,
          { hash: sha256Hash, hashConfig: SHA256_CONFIG },
          { keepSessionAcrossHashChange: true },
        );

        // Assert
        expect(derived.session).toBe(ctx.session);
      });
    });
  });

  describe('Given a derivation that changes only deltaCache', () => {
    describe('When deriveContext runs', () => {
      it('Then the session is preserved', () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const derived = deriveContext(ctx, { deltaCache: ctx.deltaCache });

        // Assert
        expect(derived.session).toBe(ctx.session);
      });
    });
  });

  describe('Given no changes at all', () => {
    describe('When deriveContext runs', () => {
      it('Then the result is frozen', () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const derived = deriveContext(ctx, {});

        // Assert
        expect(Object.isFrozen(derived)).toBe(true);
      });
    });
  });
});
