import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseTodo, serializeTodo } from '../../../../src/domain/sequencer/index.js';
import { arbTodoList } from './arbitraries.js';

describe('sequencer todo properties', () => {
  describe('Given an arbitrary todo list, When serialized then parsed', () => {
    it('Then the round-trip preserves the entries', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbTodoList(), (entries) => {
          expect(parseTodo(serializeTodo(entries))).toEqual(entries);
        }),
        { numRuns: 200 },
      );
    });
  });
});
