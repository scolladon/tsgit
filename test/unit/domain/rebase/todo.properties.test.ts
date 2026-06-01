import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseRebaseTodo, serializeRebaseTodo } from '../../../../src/domain/rebase/index.js';
import { arbRebaseTodoList } from './arbitraries.js';

describe('rebase todo properties', () => {
  describe('Given an arbitrary rebase todo list, When serialized then parsed', () => {
    it('Then the round-trip preserves the entries', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbRebaseTodoList(), (entries) => {
          expect(parseRebaseTodo(serializeRebaseTodo(entries))).toEqual(entries);
        }),
        { numRuns: 200 },
      );
    });
  });
});
