import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { foldSteps } from '../../../../src/domain/name-rev/step.js';
import type { NameRevStep } from '../../../../src/domain/name-rev/types.js';
import { revNameArb } from './arbitraries.js';

const render = (steps: ReadonlyArray<NameRevStep>): string =>
  steps.map((s) => (s.kind === 'ancestor' ? `~${s.count}` : `^${s.number}`)).join('');

// Test-owned parser of git's `~`/`^` suffix grammar — production never parses.
const parse = (suffix: string): NameRevStep[] => {
  const steps: NameRevStep[] = [];
  for (const token of suffix.match(/[~^]\d+/g) ?? []) {
    const value = Number(token.slice(1));
    steps.push(
      token[0] === '~' ? { kind: 'ancestor', count: value } : { kind: 'parent', number: value },
    );
  }
  return steps;
};

describe('Given an arbitrary name folded to a path', () => {
  describe('When the path is rendered to ~/^ tokens and re-parsed', () => {
    it('Then the step sequence round-trips', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(revNameArb, (name) => {
          const steps = foldSteps(name);
          expect(parse(render(steps))).toEqual(steps);
        }),
        { numRuns: 200 },
      );
    });
  });
});
