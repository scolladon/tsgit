import { describe, expect, it } from 'vitest';
import {
  type AllowEntry,
  type Coverage,
  type WriteSurface,
  computeGaps,
} from '../../../audit-write-surfaces/compute-gaps.js';

const surface = (name: string): WriteSurface => ({
  name,
  kind: 'byte-identical',
  format: 'git-format',
  declaredIn: `src/${name}.ts`,
});

const cover = (name: string, paths: ReadonlyArray<string>): Coverage => ({
  surface: name,
  coveredBy: paths,
});

const exempt = (name: string): AllowEntry => ({
  surface: name,
  reason: 'deferred',
  deferredTo: '20.x',
});

describe('computeGaps', () => {
  describe('Given every declared surface has matching coverage and no exemptions', () => {
    describe('When computed', () => {
      it('Then every surface appears in covered and gaps is empty', () => {
        // Arrange
        const surfaces = [surface('tree'), surface('commit')];
        const covered = [cover('tree', ['t/tree.ts']), cover('commit', ['t/commit.ts'])];

        // Act
        const sut = computeGaps({ surfaces, covered, exempt: [] });

        // Assert
        expect(sut.gaps).toHaveLength(0);
        expect(sut.covered.map((c) => c.name)).toEqual(['commit', 'tree']);
        expect(sut.covered[0]?.coveredBy).toEqual(['t/commit.ts']);
      });
    });
  });

  describe('Given a declared surface with no coverage and no exemption', () => {
    describe('When computed', () => {
      it('Then it appears in gaps', () => {
        // Arrange
        const surfaces = [surface('tree'), surface('commit')];
        const covered = [cover('tree', ['t/tree.ts'])];

        // Act
        const sut = computeGaps({ surfaces, covered, exempt: [] });

        // Assert
        expect(sut.gaps.map((g) => g.name)).toEqual(['commit']);
      });
    });
  });

  describe('Given a declared surface with no coverage but an exemption', () => {
    describe('When computed', () => {
      it('Then it appears in exempt and NOT in gaps', () => {
        // Arrange
        const surfaces = [surface('tree')];

        // Act
        const sut = computeGaps({ surfaces, covered: [], exempt: [exempt('tree')] });

        // Assert
        expect(sut.gaps).toHaveLength(0);
        expect(sut.exempt.map((e) => e.surface)).toEqual(['tree']);
      });
    });
  });

  describe('Given an exemption for a surface that is not declared', () => {
    describe('When computed', () => {
      it('Then it appears in allowlistRot', () => {
        // Arrange
        const surfaces = [surface('tree')];

        // Act
        const sut = computeGaps({
          surfaces,
          covered: [],
          exempt: [exempt('tree'), exempt('removedSurface')],
        });

        // Assert
        expect(sut.allowlistRot).toEqual(['removedSurface']);
      });
    });
  });

  describe('Given a coverage claim for a surface that is not declared', () => {
    describe('When computed', () => {
      it('Then it appears in orphanCoverage', () => {
        // Arrange
        const surfaces = [surface('tree')];
        const covered = [cover('tree', ['t/tree.ts']), cover('strayName', ['t/stray.ts'])];

        // Act
        const sut = computeGaps({ surfaces, covered, exempt: [] });

        // Assert
        expect(sut.orphanCoverage.map((o) => o.surface)).toEqual(['strayName']);
      });
    });
  });

  describe('Given multiple surfaces in arbitrary input order', () => {
    describe('When computed', () => {
      it('Then every output list is sorted by surface name', () => {
        // Arrange
        const surfaces = [surface('zebra'), surface('apple'), surface('mango')];
        const covered = [
          cover('mango', ['t/mango.ts']),
          cover('apple', ['t/apple.ts']),
          cover('zebra', ['t/zebra.ts']),
        ];

        // Act
        const sut = computeGaps({ surfaces, covered, exempt: [] });

        // Assert
        expect(sut.covered.map((c) => c.name)).toEqual(['apple', 'mango', 'zebra']);
      });
    });
  });

  describe('Given a covered surface with coveredBy paths in unsorted order', () => {
    describe('When computed', () => {
      it('Then coveredBy is returned sorted', () => {
        // Arrange
        const surfaces = [surface('tree')];
        const covered = [cover('tree', ['z.ts', 'a.ts', 'm.ts'])];

        // Act
        const sut = computeGaps({ surfaces, covered, exempt: [] });

        // Assert
        expect(sut.covered[0]?.coveredBy).toEqual(['a.ts', 'm.ts', 'z.ts']);
      });
    });
  });
});
