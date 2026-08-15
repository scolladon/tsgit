import { describe, expect, it } from 'vitest';
import {
  bestOfRounds,
  compareToBaseline,
  DEFAULT_THRESHOLD_PCT,
  escapeCell,
  gatedEntries,
  hotGatedEntries,
  operationOf,
  parseHotOperations,
  resolveThresholdPct,
} from '../../bench-check.js';
import type { SnapshotEntry } from '../../bench-to-snapshot.js';

const entry = (name: string, value: number): SnapshotEntry => ({
  name,
  unit: 'ms',
  value,
});

describe('bestOfRounds', () => {
  describe('Given several rounds measuring the same scenario', () => {
    describe('When bestOfRounds reduces them', () => {
      it('Then the fastest observation wins, whichever round it came from', () => {
        // Arrange — the fastest sits in the middle, so neither a first-wins
        // nor a last-wins reduction could produce this answer.
        const rounds = [[entry('a > tsgit', 9)], [entry('a > tsgit', 4)], [entry('a > tsgit', 7)]];
        const sut = bestOfRounds;

        // Act
        const result = sut(rounds);

        // Assert
        expect(result).toEqual([entry('a > tsgit', 4)]);
      });
    });
  });

  describe('Given rounds covering different scenarios', () => {
    describe('When bestOfRounds reduces them', () => {
      it('Then every scenario survives, each at its own fastest', () => {
        // Arrange
        const rounds = [
          [entry('a > tsgit', 5), entry('b > tsgit', 8)],
          [entry('a > tsgit', 6), entry('b > tsgit', 3)],
        ];
        const sut = bestOfRounds;

        // Act
        const result = sut(rounds);

        // Assert
        expect([...result].sort((x, y) => x.name.localeCompare(y.name))).toEqual([
          entry('a > tsgit', 5),
          entry('b > tsgit', 3),
        ]);
      });
    });
  });

  describe('Given a scenario present in only one round', () => {
    describe('When bestOfRounds reduces them', () => {
      it('Then it is reported from the round that has it rather than dropped', () => {
        // Arrange — a bench that failed to record in one round must not erase
        // the evidence collected by the others.
        const rounds = [[entry('a > tsgit', 5)], [entry('a > tsgit', 6), entry('b > tsgit', 2)]];
        const sut = bestOfRounds;

        // Act
        const result = sut(rounds);

        // Assert
        expect(result).toContainEqual(entry('b > tsgit', 2));
      });
    });
  });

  describe('Given no rounds at all', () => {
    describe('When bestOfRounds reduces them', () => {
      it('Then the result is empty rather than a thrown error', () => {
        // Arrange
        const sut = bestOfRounds;

        // Act
        const result = sut([]);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });
});

describe('compareToBaseline', () => {
  describe('Given a scenario that regresses above the threshold', () => {
    describe('When compareToBaseline runs', () => {
      it('Then the row is flagged regress and failed is true', () => {
        // Arrange
        const base = [entry('x > tsgit', 100)];
        const current = [entry('x > tsgit', 120)];
        const sut = compareToBaseline;

        // Act
        const result = sut(base, current, { thresholdPct: 10 });

        // Assert
        expect(result.rows[0]?.baseMs).toBe(100);
        expect(result.rows[0]?.currentMs).toBe(120);
        expect(result.rows[0]?.deltaPct).toBe(20);
        expect(result.rows[0]?.verdict).toBe('regress');
        expect(result.failed).toBe(true);
      });
    });
  });

  describe('Given a scenario that stays below the threshold', () => {
    describe('When compareToBaseline runs', () => {
      it('Then the row passes and failed is false', () => {
        // Arrange
        const base = [entry('x > tsgit', 100)];
        const current = [entry('x > tsgit', 105)];
        const sut = compareToBaseline;

        // Act
        const result = sut(base, current, { thresholdPct: 10 });

        // Assert
        expect(result.rows[0]?.baseMs).toBe(100);
        expect(result.rows[0]?.currentMs).toBe(105);
        expect(result.rows[0]?.deltaPct).toBe(5);
        expect(result.rows[0]?.verdict).toBe('pass');
        expect(result.failed).toBe(false);
      });
    });
  });

  describe('Given a scenario whose delta lands exactly at the threshold', () => {
    describe('When compareToBaseline runs', () => {
      it('Then the row passes (strict greater-than, not greater-or-equal)', () => {
        // Arrange
        const base = [entry('x > tsgit', 100)];
        const current = [entry('x > tsgit', 110)];
        const sut = compareToBaseline;

        // Act
        const result = sut(base, current, { thresholdPct: 10 });

        // Assert
        expect(result.rows[0]?.deltaPct).toBe(10);
        expect(result.rows[0]?.verdict).toBe('pass');
        expect(result.failed).toBe(false);
      });
    });
  });

  describe('Given a scenario whose delta lands one step above the threshold', () => {
    describe('When compareToBaseline runs', () => {
      it('Then the row regresses', () => {
        // Arrange
        const base = [entry('x > tsgit', 100)];
        const current = [entry('x > tsgit', 111)];
        const sut = compareToBaseline;

        // Act
        const result = sut(base, current, { thresholdPct: 10 });

        // Assert
        expect(result.rows[0]?.deltaPct).toBe(11);
        expect(result.rows[0]?.verdict).toBe('regress');
        expect(result.failed).toBe(true);
      });
    });
  });

  describe('Given a scenario that improves', () => {
    describe('When compareToBaseline runs', () => {
      it('Then the row never regresses (asymmetric comparator)', () => {
        // Arrange
        const base = [entry('x > tsgit', 100)];
        const current = [entry('x > tsgit', 50)];
        const sut = compareToBaseline;

        // Act
        const result = sut(base, current, { thresholdPct: 10 });

        // Assert
        expect(result.rows[0]?.deltaPct).toBe(-50);
        expect(result.rows[0]?.verdict).toBe('pass');
        expect(result.failed).toBe(false);
      });
    });
  });

  describe('Given a scenario present only in current', () => {
    describe('When compareToBaseline runs', () => {
      it('Then the row is verdict new with null baseMs and deltaPct', () => {
        // Arrange
        const base: SnapshotEntry[] = [];
        const current = [entry('y > tsgit', 42)];
        const sut = compareToBaseline;

        // Act
        const result = sut(base, current, { thresholdPct: 10 });

        // Assert
        expect(result.rows[0]?.verdict).toBe('new');
        expect(result.rows[0]?.baseMs).toBeNull();
        expect(result.rows[0]?.deltaPct).toBeNull();
        expect(result.failed).toBe(false);
      });
    });
  });

  describe('Given a scenario present only in base', () => {
    describe('When compareToBaseline runs', () => {
      it('Then the row is verdict missing with null currentMs and deltaPct', () => {
        // Arrange
        const base = [entry('z > tsgit', 42)];
        const current: SnapshotEntry[] = [];
        const sut = compareToBaseline;

        // Act
        const result = sut(base, current, { thresholdPct: 10 });

        // Assert
        expect(result.rows[0]?.verdict).toBe('missing');
        expect(result.rows[0]?.currentMs).toBeNull();
        expect(result.rows[0]?.deltaPct).toBeNull();
        expect(result.failed).toBe(false);
      });
    });
  });

  describe('Given a scenario whose base value is zero', () => {
    describe('When compareToBaseline runs', () => {
      it('Then the row is verdict missing with a null (never Infinity) deltaPct', () => {
        // Arrange
        const base = [entry('w > tsgit', 0)];
        const current = [entry('w > tsgit', 5)];
        const sut = compareToBaseline;

        // Act
        const result = sut(base, current, { thresholdPct: 10 });

        // Assert
        expect(result.rows[0]?.verdict).toBe('missing');
        expect(result.rows[0]?.deltaPct).toBeNull();
        expect(result.failed).toBe(false);
      });
    });
  });

  describe('Given entries from both tsgit and isomorphic-git', () => {
    describe('When gatedEntries filters them', () => {
      it('Then only the tsgit-suffixed entry remains', () => {
        // Arrange
        const mixed = [entry('s > tsgit', 10), entry('s > isomorphic-git', 20)];
        const sut = gatedEntries;

        // Act
        const result = sut(mixed);

        // Assert
        expect(result).toEqual([entry('s > tsgit', 10)]);
      });
    });
  });

  describe('Given gated tsgit-only entries fed into compareToBaseline', () => {
    describe('When compareToBaseline runs', () => {
      it('Then no row key ends in isomorphic-git', () => {
        // Arrange
        const mixedBase = [entry('s > tsgit', 10), entry('s > isomorphic-git', 20)];
        const mixedCurrent = [entry('s > tsgit', 11), entry('s > isomorphic-git', 22)];
        const sut = compareToBaseline;

        // Act
        const result = sut(gatedEntries(mixedBase), gatedEntries(mixedCurrent), {
          thresholdPct: 10,
        });

        // Assert
        expect(result.rows.every((row) => !row.key.endsWith('isomorphic-git'))).toBe(true);
      });
    });
  });

  describe('Given a scenario whose current value is not finite', () => {
    describe('When compareToBaseline runs', () => {
      it('Then the row is verdict missing, not a silently-passing NaN delta', () => {
        // Arrange
        const base = [entry('x > tsgit', 100)];
        const current = [entry('x > tsgit', Number.NaN)];
        const sut = compareToBaseline;

        // Act
        const result = sut(base, current, { thresholdPct: 10 });

        // Assert
        expect(result.rows[0]?.verdict).toBe('missing');
        expect(result.rows[0]?.deltaPct).toBeNull();
        expect(result.failed).toBe(false);
      });
    });
  });

  describe('Given a scenario key duplicated on one side', () => {
    describe('When compareToBaseline runs', () => {
      it('Then the last value wins (Map build semantics)', () => {
        // Arrange
        const base = [entry('x > tsgit', 100), entry('x > tsgit', 200)];
        const current = [entry('x > tsgit', 200)];
        const sut = compareToBaseline;

        // Act
        const result = sut(base, current, { thresholdPct: 10 });

        // Assert — one row, base resolved to the last duplicate (200), so 0% delta
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]?.baseMs).toBe(200);
        expect(result.rows[0]?.deltaPct).toBe(0);
        expect(result.rows[0]?.verdict).toBe('pass');
      });
    });
  });

  describe('Given no entries on either side', () => {
    describe('When compareToBaseline runs', () => {
      it('Then rows is empty and failed is false', () => {
        // Arrange
        const base: SnapshotEntry[] = [];
        const current: SnapshotEntry[] = [];
        const sut = compareToBaseline;

        // Act
        const result = sut(base, current, { thresholdPct: 10 });

        // Assert
        expect(result.rows).toEqual([]);
        expect(result.failed).toBe(false);
      });
    });
  });
});

describe('resolveThresholdPct', () => {
  describe('Given a valid numeric override', () => {
    describe('When resolveThresholdPct runs', () => {
      it('Then it parses the override value', () => {
        // Arrange
        const sut = resolveThresholdPct;

        // Act
        const result = sut('15');

        // Assert
        expect(result).toBe(15);
      });
    });
  });

  describe('Given an empty override', () => {
    describe('When resolveThresholdPct runs', () => {
      it('Then it falls back to the default (empty is treated as unset)', () => {
        // Arrange
        const sut = resolveThresholdPct;

        // Act
        const result = sut('');

        // Assert
        expect(result).toBe(DEFAULT_THRESHOLD_PCT);
      });
    });
  });

  describe('Given a non-numeric override', () => {
    describe('When resolveThresholdPct runs', () => {
      it('Then it throws a clear positive-finite error', () => {
        // Arrange
        const sut = resolveThresholdPct;

        // Act
        let caught: unknown;
        try {
          sut('abc');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as Error).message).toBe(
          'REGRESSION_THRESHOLD must be a positive finite number, got: abc',
        );
      });
    });
  });

  describe('Given a non-finite override', () => {
    describe('When resolveThresholdPct runs', () => {
      it('Then Infinity is rejected (the old NaN-only guard let it through)', () => {
        // Arrange
        const sut = resolveThresholdPct;

        // Act + Assert
        expect(() => sut('Infinity')).toThrow('must be a positive finite number');
      });
    });
  });

  describe('Given a non-positive override', () => {
    describe('When resolveThresholdPct runs', () => {
      it('Then zero is rejected (a zero threshold would flag every non-improvement)', () => {
        // Arrange
        const sut = resolveThresholdPct;

        // Act + Assert
        expect(() => sut('0')).toThrow('must be a positive finite number');
      });

      it('Then a negative override is rejected', () => {
        // Arrange
        const sut = resolveThresholdPct;

        // Act + Assert
        expect(() => sut('-5')).toThrow('must be a positive finite number');
      });
    });
  });
});

describe('escapeCell', () => {
  describe('Given a scenario name containing a pipe and an at-mention', () => {
    describe('When escapeCell runs', () => {
      it('Then pipes are escaped and the name is wrapped as an inline-code span', () => {
        // Arrange
        const sut = escapeCell;

        // Act
        const result = sut('evil | @maintainer > tsgit');

        // Assert — backticks neutralise the @autolink; the pipe is escaped so the table holds
        expect(result).toBe('`evil \\| @maintainer > tsgit`');
      });
    });
  });

  describe('Given a scenario name containing a backtick', () => {
    describe('When escapeCell runs', () => {
      it('Then the code fence widens so the span cannot be broken open', () => {
        // Arrange
        const sut = escapeCell;

        // Act
        const result = sut('a`b');

        // Assert — a two-backtick, space-padded fence keeps the embedded backtick inert
        expect(result).toBe('`` a`b ``');
      });
    });
  });
});

describe('operationOf', () => {
  describe('Given a key from a hot tiered bench file', () => {
    describe('When operationOf runs', () => {
      it('Then it extracts the log operation from the bench basename', () => {
        // Arrange
        const sut = operationOf;

        // Act
        const result = sut('test/bench/log.bench.ts > When log() walks every commit > tsgit');

        // Assert
        expect(result).toBe('log');
      });

      it('Then it extracts the pack-read operation from a hyphenated basename', () => {
        // Arrange
        const sut = operationOf;

        // Act
        const result = sut(
          'test/bench/pack-read.bench.ts > When readBlob() reads from a cold pack > tsgit',
        );

        // Assert
        expect(result).toBe('pack-read');
      });
    });
  });

  describe('Given a key whose leading segment does not end in .bench.ts', () => {
    describe('When operationOf runs', () => {
      it('Then it returns an empty string', () => {
        // Arrange
        const sut = operationOf;

        // Act
        const result = sut('weird > tsgit');

        // Assert
        expect(result).toBe('');
      });
    });
  });
});

describe('hotGatedEntries', () => {
  const hot = ['log', 'pack-read'];

  describe('Given a tsgit entry whose operation is in the hot list', () => {
    describe('When hotGatedEntries filters', () => {
      it('Then the entry survives', () => {
        // Arrange
        const entries = [entry('test/bench/log.bench.ts > Given a repo > tsgit', 10)];
        const sut = hotGatedEntries;

        // Act
        const result = sut(entries, hot);

        // Assert
        expect(result).toEqual(entries);
      });
    });
  });

  describe('Given tsgit entries whose operation is not in the hot list', () => {
    describe('When hotGatedEntries filters', () => {
      it('Then the entries are dropped', () => {
        // Arrange
        const entries = [
          entry('test/bench/show.bench.ts > Given a repo > tsgit', 10),
          entry('test/bench/status-dirty.bench.ts > Given a dirty tree > tsgit', 10),
        ];
        const sut = hotGatedEntries;

        // Act
        const result = sut(entries, hot);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given an isomorphic-git entry whose operation is in the hot list', () => {
    describe('When hotGatedEntries filters', () => {
      it('Then the entry is dropped by the tsgit-suffix guard before the hot filter', () => {
        // Arrange
        const entries = [
          entry('test/bench/pack-read.bench.ts > Given a repo > isomorphic-git', 10),
        ];
        const sut = hotGatedEntries;

        // Act
        const result = sut(entries, hot);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });
});

describe('parseHotOperations', () => {
  describe('Given a valid registry object', () => {
    describe('When parseHotOperations runs', () => {
      it('Then it returns the hotOperations array', () => {
        // Arrange
        const sut = parseHotOperations;

        // Act
        const result = sut({ hotOperations: ['log', 'status'] });

        // Assert
        expect(result).toEqual(['log', 'status']);
      });
    });
  });

  describe('Given a registry object missing hotOperations', () => {
    describe('When parseHotOperations runs', () => {
      it('Then it throws with the specific missing-field message', () => {
        // Arrange
        const sut = parseHotOperations;

        // Act
        let caught: unknown;
        try {
          sut({});
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as Error).message).toBe(
          'hot-paths.json: "hotOperations" must be an array of operation strings',
        );
      });
    });
  });

  describe('Given hotOperations that is not an array', () => {
    describe('When parseHotOperations runs', () => {
      it('Then it throws with the specific type message', () => {
        // Arrange
        const sut = parseHotOperations;

        // Act
        let caught: unknown;
        try {
          sut({ hotOperations: 'log' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as Error).message).toBe(
          'hot-paths.json: "hotOperations" must be an array of operation strings',
        );
      });
    });
  });

  describe('Given hotOperations containing a non-string element', () => {
    describe('When parseHotOperations runs', () => {
      it('Then it throws with the specific type message', () => {
        // Arrange
        const sut = parseHotOperations;

        // Act
        let caught: unknown;
        try {
          sut({ hotOperations: ['log', 42] });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as Error).message).toBe(
          'hot-paths.json: "hotOperations" must be an array of operation strings',
        );
      });
    });
  });

  describe('Given a null registry (a literal null JSON file)', () => {
    describe('When parseHotOperations runs', () => {
      it('Then it throws with the specific type message', () => {
        // Arrange
        const sut = parseHotOperations;

        // Act
        let caught: unknown;
        try {
          sut(null);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as Error).message).toBe(
          'hot-paths.json: "hotOperations" must be an array of operation strings',
        );
      });
    });
  });
});
