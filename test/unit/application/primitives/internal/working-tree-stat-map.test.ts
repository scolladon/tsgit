import { describe, expect, it } from 'vitest';
import { createWorkingTreeStatMap } from '../../../../../src/application/primitives/internal/working-tree-stat-map.js';
import type { FilePath } from '../../../../../src/domain/objects/object-id.js';
import type { FileStat } from '../../../../../src/ports/file-system.js';

// No property lens fits: createWorkingTreeStatMap is a per-invocation CQS
// collection with no grammar, round-trip pair, or algebraic composition to
// generalise over — a plain example suite covers its full behaviour.

const aStat: FileStat = {
  ctimeMs: 1,
  mtimeMs: 1,
  dev: 1,
  ino: 1,
  mode: 0o100644,
  uid: 0,
  gid: 0,
  size: 1,
  isFile: true,
  isDirectory: false,
  isSymbolicLink: false,
};

describe('createWorkingTreeStatMap', () => {
  describe('Given a fresh map', () => {
    describe('When sampled is called on a path that was never recorded', () => {
      it('Then it returns undefined', () => {
        // Arrange
        const sut = createWorkingTreeStatMap();

        // Act
        const result = sut.sampled('a.txt' as FilePath);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a map with a recorded sample', () => {
    describe('When sampled is called for that same path', () => {
      it('Then it returns the recorded stat', () => {
        // Arrange
        const sut = createWorkingTreeStatMap();
        sut.record('a.txt' as FilePath, aStat);

        // Act
        const result = sut.sampled('a.txt' as FilePath);

        // Assert
        expect(result).toBe(aStat);
      });
    });
  });

  describe('Given two independently created maps', () => {
    describe('When a sample is recorded on one and sampled is called on the other', () => {
      it('Then the other map returns undefined (no shared state)', () => {
        // Arrange
        const recorded = createWorkingTreeStatMap();
        const untouched = createWorkingTreeStatMap();
        recorded.record('a.txt' as FilePath, aStat);

        // Act
        const result = untouched.sampled('a.txt' as FilePath);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});
