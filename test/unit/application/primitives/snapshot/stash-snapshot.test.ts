import { describe, expect, it } from 'vitest';
import type { TreeSnapshot } from '../../../../../src/application/primitives/snapshot/snapshot.js';
import { createStashSnapshot } from '../../../../../src/application/primitives/snapshot/stash-snapshot.js';

const stubTree = (label: string): TreeSnapshot => ({
  kind: 'tree',
  entries: () => {
    // empty — label is just a marker for reference equality
    void label;
    return (async function* () {
      yield* [];
    })();
  },
});

describe('createStashSnapshot', () => {
  describe('Given an index, workdir, and untracked trio', () => {
    describe('When createStashSnapshot wraps them', () => {
      it('Then kind="stash" and each trio member is exposed verbatim as a property', () => {
        // Arrange
        const index = stubTree('index');
        const workdir = stubTree('workdir');
        const untracked = stubTree('untracked');

        // Act
        const sut = createStashSnapshot({ index, workdir, untracked });

        // Assert
        expect(sut.kind).toBe('stash');
        expect(sut.index).toBe(index);
        expect(sut.workdir).toBe(workdir);
        expect(sut.untracked).toBe(untracked);
      });
    });
  });

  describe('Given a stash created without --include-untracked', () => {
    describe('When createStashSnapshot wraps it with untracked=null', () => {
      it('Then untracked is null and the other two remain accessible', () => {
        // Arrange
        const index = stubTree('index');
        const workdir = stubTree('workdir');

        // Act
        const sut = createStashSnapshot({ index, workdir, untracked: null });

        // Assert
        expect(sut.untracked).toBeNull();
        expect(sut.index).toBe(index);
        expect(sut.workdir).toBe(workdir);
      });
    });
  });
});
