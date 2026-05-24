import { describe, expect, it } from 'vitest';
import { detectNondeterministic } from '../../../parity-fixtures/detect-nondeterministic.ts';

const file = (path: string, source: string) => ({ path, source });

describe('detectNondeterministic', () => {
  describe('Given a clean scenario module', () => {
    describe('When scanned', () => {
      it('Then no findings are emitted', () => {
        // Arrange
        const source = `
import { AUTHOR } from '../fixtures.ts';
export const data = { author: AUTHOR, message: 'seed' };
`;

        // Act
        const sut = detectNondeterministic([file('test/parity/scenarios/clean.scenario.ts', source)]);

        // Assert
        expect(sut).toEqual([]);
      });
    });
  });

  describe('Given a module that calls Date.now()', () => {
    describe('When scanned', () => {
      it('Then a finding flags the line as Date.now', () => {
        // Arrange
        const source = "export const t = Date.now();\n";

        // Act
        const sut = detectNondeterministic([file('test/parity/scenarios/x.scenario.ts', source)]);

        // Assert
        expect(sut).toEqual([
          {
            path: 'test/parity/scenarios/x.scenario.ts',
            line: 1,
            kind: 'Date.now',
          },
        ]);
      });
    });
  });

  describe('Given a module that references Math.random', () => {
    describe('When scanned', () => {
      it('Then a finding flags the line as Math.random', () => {
        // Arrange
        const source = "export const r = () => Math.random() * 100;\n";

        // Act
        const sut = detectNondeterministic([file('test/parity/scenarios/x.scenario.ts', source)]);

        // Assert
        expect(sut).toEqual([
          {
            path: 'test/parity/scenarios/x.scenario.ts',
            line: 1,
            kind: 'Math.random',
          },
        ]);
      });
    });
  });

  describe('Given a module that calls performance.now()', () => {
    describe('When scanned', () => {
      it('Then a finding flags the line as performance.now', () => {
        // Arrange
        const source = "export const t = performance.now();\n";

        // Act
        const sut = detectNondeterministic([file('test/parity/scenarios/x.scenario.ts', source)]);

        // Assert
        expect(sut).toEqual([
          {
            path: 'test/parity/scenarios/x.scenario.ts',
            line: 1,
            kind: 'performance.now',
          },
        ]);
      });
    });
  });

  describe('Given a module with new Date() (no args)', () => {
    describe('When scanned', () => {
      it('Then a finding flags the line as new Date()', () => {
        // Arrange
        const source = "export const t = new Date();\n";

        // Act
        const sut = detectNondeterministic([file('test/parity/scenarios/x.scenario.ts', source)]);

        // Assert
        expect(sut).toEqual([
          {
            path: 'test/parity/scenarios/x.scenario.ts',
            line: 1,
            kind: 'new Date()',
          },
        ]);
      });
    });
  });

  describe('Given a module with new Date(<non-string-arg>)', () => {
    describe('When scanned', () => {
      it('Then a finding flags the line as new Date(<non-literal>)', () => {
        // Arrange
        const source = "export const t = new Date(timestamp);\n";

        // Act
        const sut = detectNondeterministic([file('test/parity/scenarios/x.scenario.ts', source)]);

        // Assert
        expect(sut).toEqual([
          {
            path: 'test/parity/scenarios/x.scenario.ts',
            line: 1,
            kind: 'new Date(<non-literal>)',
          },
        ]);
      });
    });
  });

  describe('Given a module with new Date(<pinned-string-literal>)', () => {
    describe('When scanned', () => {
      it('Then no finding (pinned-literal is deterministic)', () => {
        // Arrange
        const source = "export const t = new Date('2026-01-01');\n";

        // Act
        const sut = detectNondeterministic([file('test/parity/scenarios/x.scenario.ts', source)]);

        // Assert
        expect(sut).toEqual([]);
      });
    });
  });

  describe('Given multiple offending lines in the same module', () => {
    describe('When scanned', () => {
      it('Then every line emits its own finding, preserving order', () => {
        // Arrange
        const source = "const a = Date.now();\nconst b = Math.random();\n";

        // Act
        const sut = detectNondeterministic([file('test/parity/scenarios/x.scenario.ts', source)]);

        // Assert
        expect(sut).toEqual([
          { path: 'test/parity/scenarios/x.scenario.ts', line: 1, kind: 'Date.now' },
          { path: 'test/parity/scenarios/x.scenario.ts', line: 2, kind: 'Math.random' },
        ]);
      });
    });
  });

  describe('Given a Date.now() call inside a line comment', () => {
    describe('When scanned', () => {
      it('Then no finding (comment-only matches are ignored)', () => {
        // Arrange
        const source = "// Date.now() is forbidden — this is a note.\n";

        // Act
        const sut = detectNondeterministic([file('test/parity/scenarios/x.scenario.ts', source)]);

        // Assert
        expect(sut).toEqual([]);
      });
    });
  });
});
