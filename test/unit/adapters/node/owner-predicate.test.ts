import { describe, expect, it } from 'vitest';

import {
  type OwnerProbe,
  ownedByCallerPredicate,
} from '../../../../src/adapters/node/owner-predicate.js';

describe('ownedByCallerPredicate', () => {
  describe('Given a caller uid and a path owner uid that match', () => {
    const probe: OwnerProbe = {
      callerUid: () => 501,
      ownerUid: async () => 501,
    };

    describe('When the predicate runs', () => {
      it('Then it resolves true', async () => {
        // Arrange
        const sut = ownedByCallerPredicate(probe);

        // Act
        const result = await sut('/repo/.git');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a non-root caller and a root-owned path (the truthiness trap)', () => {
    const probe: OwnerProbe = {
      callerUid: () => 501,
      ownerUid: async () => 0,
    };

    describe('When the predicate runs', () => {
      it('Then it resolves false', async () => {
        // Arrange
        const sut = ownedByCallerPredicate(probe);

        // Act
        const result = await sut('/repo/.git');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a root caller reading root-owned metadata', () => {
    const probe: OwnerProbe = {
      callerUid: () => 0,
      ownerUid: async () => 0,
    };

    describe('When the predicate runs', () => {
      it('Then it resolves true (uid 0 compared by identity, not truthiness)', async () => {
        // Arrange
        const sut = ownedByCallerPredicate(probe);

        // Act
        const result = await sut('/repo/.git');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a root caller reading metadata owned by another uid', () => {
    const probe: OwnerProbe = {
      callerUid: () => 0,
      ownerUid: async () => 501,
    };

    describe('When the predicate runs', () => {
      it('Then it resolves false', async () => {
        // Arrange
        const sut = ownedByCallerPredicate(probe);

        // Act
        const result = await sut('/repo/.git');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe("Given a path that cannot be stat'd (absent)", () => {
    const probe: OwnerProbe = {
      callerUid: () => 501,
      ownerUid: async () => undefined,
    };

    describe('When the predicate runs', () => {
      it('Then it resolves true — nothing to distrust', async () => {
        // Arrange
        const sut = ownedByCallerPredicate(probe);

        // Act
        const result = await sut('/repo/missing');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a platform with no POSIX owner model (callerUid returns undefined)', () => {
    describe('When the predicate runs', () => {
      it('Then it resolves true without calling ownerUid', async () => {
        // Arrange
        let ownerUidCalls = 0;
        const probe: OwnerProbe = {
          callerUid: () => undefined,
          ownerUid: async () => {
            ownerUidCalls += 1;
            return 501;
          },
        };
        const sut = ownedByCallerPredicate(probe);

        // Act
        const result = await sut('/repo/.git');

        // Assert
        expect(result).toBe(true);
        expect(ownerUidCalls).toBe(0);
      });
    });
  });
});
