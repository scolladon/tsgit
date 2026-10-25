import { describe, expect, it } from 'vitest';
import {
  LIVE_PIN_KEYS,
  REBASE_MERGES_RESET_PINS,
  REBASE_RESET_PINS,
  REBASE_START_PINS,
  RESET_MERGE_PINS,
} from '../../integration/stopped-state-pins.js';

/** Rows compared with live git alone because the plan pins no verdict for them. */
const LIVE_ONLY = {
  reset: new Set<string>([]),
  rebaseReset: new Set<string>([
    'pick changes entry/skip/Y3/same',
    'pick changes entry/skip/Y3/reset-updates',
    'pick changes entry/skip/Y3/reset-adds',
    'pick changes entry/skip/Y3/reset-deletes',
  ]),
  rebaseStart: new Set<string>([]),
  rebaseMergesReset: new Set<string>([]),
};

const TABLES = [
  ['reset', RESET_MERGE_PINS],
  ['rebaseReset', REBASE_RESET_PINS],
  ['rebaseStart', REBASE_START_PINS],
  ['rebaseMergesReset', REBASE_MERGES_RESET_PINS],
] as const;

describe('Given a pin table of git verdicts', () => {
  describe.each(TABLES)('When the %s table is checked against its matrix', (name, pins) => {
    it('Then every live key is pinned or named live-only', () => {
      // Arrange
      const sut = LIVE_PIN_KEYS[name];

      // Act
      const unaccounted = sut.filter((key) => !(key in pins) && !LIVE_ONLY[name].has(key));

      // Assert
      expect(unaccounted).toEqual([]);
    });

    it('Then no pinned key is outside the matrix and no live-only key is also pinned', () => {
      // Arrange
      const live = new Set(LIVE_PIN_KEYS[name]);

      // Act
      const unused = Object.keys(pins).filter((key) => !live.has(key));
      const shadowed = [...LIVE_ONLY[name]].filter((key) => key in pins || !live.has(key));

      // Assert
      expect({ unused, shadowed }).toEqual({ unused: [], shadowed: [] });
    });
  });
});
