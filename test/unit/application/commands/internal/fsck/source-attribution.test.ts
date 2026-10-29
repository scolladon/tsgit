import { describe, expect, it } from 'vitest';
import { auditedSources } from '../../../../../../src/application/commands/internal/fsck/source-attribution.js';
import type {
  ObjectSource,
  ObjectStore,
} from '../../../../../../src/application/primitives/object-store.js';

const sut = auditedSources;

const sourceAt = (objectsDir: string, local: boolean): ObjectSource =>
  ({ objectsDir, local }) as unknown as ObjectSource;

const local = sourceAt('/repo/.git/objects', true);
const donor = sourceAt('/donor/objects', false);
const store = { sources: [donor, local] } as unknown as Pick<ObjectStore, 'sources'>;

describe('Given a store with a local source and an alternate', () => {
  describe('When the audited sources are taken with full: false', () => {
    it('Then only the local source is kept', () => {
      // Arrange
      const opts = { full: false };

      // Act
      const result = sut(store, opts);

      // Assert
      expect(result).toEqual([local]);
    });
  });

  describe('When the audited sources are taken without a full option', () => {
    it('Then every source is kept in order', () => {
      // Arrange
      const opts = {};

      // Act
      const result = sut(store, opts);

      // Assert
      expect(result).toEqual([donor, local]);
    });
  });

  describe('When the audited sources are taken with full: true', () => {
    it('Then every source is kept in order', () => {
      // Arrange
      const opts = { full: true };

      // Act
      const result = sut(store, opts);

      // Assert
      expect(result).toEqual([donor, local]);
    });
  });
});
