import { describe, expect, it } from 'vitest';
import {
  firstParentName,
  foldSteps,
  MERGE_TRAVERSAL_WEIGHT,
  mergeParentName,
} from '../../../../src/domain/name-rev/step.js';
import type { NameRevStep, RevName } from '../../../../src/domain/name-rev/types.js';

const base = (overrides: Partial<RevName> = {}): RevName => ({
  ref: 'refs/tags/v1' as RevName['ref'],
  tagDeref: true,
  fromTag: true,
  taggerDate: 1_000,
  generation: 0,
  distance: 0,
  steps: [],
  ...overrides,
});

describe('firstParentName', () => {
  describe('Given a name', () => {
    describe('When advancing along the first parent', () => {
      it('Then generation and distance each grow by one and steps are unchanged', () => {
        // Arrange
        const steps: ReadonlyArray<NameRevStep> = [{ kind: 'parent', number: 2 }];
        const name = base({ generation: 2, distance: 5, steps });

        // Act
        const result = firstParentName(name);

        // Assert
        expect(result.generation).toBe(3);
        expect(result.distance).toBe(6);
        expect(result.steps).toEqual(steps);
        expect(result.ref).toBe(name.ref);
        expect(result.tagDeref).toBe(name.tagDeref);
        expect(result.fromTag).toBe(name.fromTag);
        expect(result.taggerDate).toBe(name.taggerDate);
      });
    });
  });
});

describe('mergeParentName', () => {
  describe('Given a name with a pending generation', () => {
    describe('When crossing to a non-first parent', () => {
      it('Then it flushes the generation then the parent jump and resets generation', () => {
        // Arrange
        const name = base({ generation: 3, distance: 4, steps: [{ kind: 'ancestor', count: 1 }] });

        // Act
        const result = mergeParentName(name, 2);

        // Assert
        expect(result.steps).toEqual([
          { kind: 'ancestor', count: 1 },
          { kind: 'ancestor', count: 3 },
          { kind: 'parent', number: 2 },
        ]);
        expect(result.generation).toBe(0);
        expect(result.distance).toBe(4 + MERGE_TRAVERSAL_WEIGHT);
      });
    });
  });

  describe('Given a name with no pending generation', () => {
    describe('When crossing to a non-first parent', () => {
      it('Then it appends only the parent jump', () => {
        // Arrange
        const name = base({ generation: 0, distance: 7, steps: [] });

        // Act
        const result = mergeParentName(name, 3);

        // Assert
        expect(result.steps).toEqual([{ kind: 'parent', number: 3 }]);
        expect(result.generation).toBe(0);
        expect(result.distance).toBe(7 + MERGE_TRAVERSAL_WEIGHT);
      });
    });
  });
});

describe('MERGE_TRAVERSAL_WEIGHT', () => {
  describe('Given the merge weight constant', () => {
    describe('When read', () => {
      it('Then it is git’s 65535', () => {
        // Arrange + Act + Assert
        expect(MERGE_TRAVERSAL_WEIGHT).toBe(65_535);
      });
    });
  });
});

describe('foldSteps', () => {
  describe('Given a name with a pending generation', () => {
    describe('When folding', () => {
      it('Then it appends the trailing ancestor step', () => {
        // Arrange
        const name = base({ generation: 2, steps: [{ kind: 'parent', number: 2 }] });

        // Act
        const result = foldSteps(name);

        // Assert
        expect(result).toEqual([
          { kind: 'parent', number: 2 },
          { kind: 'ancestor', count: 2 },
        ]);
      });
    });
  });

  describe('Given a name with no pending generation', () => {
    describe('When folding', () => {
      it('Then it returns the completed steps verbatim', () => {
        // Arrange
        const steps: ReadonlyArray<NameRevStep> = [{ kind: 'ancestor', count: 1 }];
        const name = base({ generation: 0, steps });

        // Act
        const result = foldSteps(name);

        // Assert
        expect(result).toEqual(steps);
      });
    });
  });
});
