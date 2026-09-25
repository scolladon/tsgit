import { afterEach, describe, expect, it, vi } from 'vitest';
import { realSyncFsOps } from '../../../../src/adapters/node/fs-operations.js';
import {
  createSyncIoPolicy,
  createTurnBudget,
  runWithinBudget,
  syncIoPolicyFor,
} from '../../../../src/adapters/node/sync-io-budget.js';
import { TsgitError } from '../../../../src/domain/error.js';

type IoOption = 'sync-fast-path' | 'threadpool';

const expectInvalidIo = (io: IoOption, reasonContains: string): void => {
  try {
    syncIoPolicyFor(io);
    expect.unreachable('expected syncIoPolicyFor to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(TsgitError);
    const data = (err as TsgitError).data;
    expect(data.code).toBe('INVALID_OPTION');
    if (data.code === 'INVALID_OPTION') {
      expect(data.option).toBe('io');
      expect(data.reason).toContain(reasonContains);
    }
  }
};

const manualClock = () => {
  let t = 0;
  return {
    clock: () => t,
    advance: (deltaMs: number) => {
      t += deltaMs;
    },
  };
};

const collectingScheduler = () => {
  const marks: Array<() => void> = [];
  return { schedule: (cb: () => void) => marks.push(cb), marks };
};

describe('createTurnBudget', () => {
  describe('Given a fresh 1 ms budget', () => {
    describe('When admit runs before any charge', () => {
      it('Then it returns undefined', () => {
        // Arrange
        const { clock } = manualClock();
        const { schedule } = collectingScheduler();
        const budget = createTurnBudget(1, clock, schedule);

        // Act
        const result = budget.admit();

        // Assert
        expect(result).toBeUndefined();
      });
    });

    describe('When now is read', () => {
      it("Then it returns the injected clock's current value", () => {
        // Arrange
        const { clock, advance } = manualClock();
        const { schedule } = collectingScheduler();
        const budget = createTurnBudget(1, clock, schedule);
        advance(0.7);

        // Act
        const result = budget.now();

        // Assert
        expect(result).toBe(0.7);
      });
    });
  });

  describe('Given one 0.1 ms sync op charged at the start of a turn and 1.1 ms of uncharged work since', () => {
    describe('When admit runs', () => {
      it('Then it returns the shared next-turn promise', () => {
        // Arrange
        const { clock, advance } = manualClock();
        const { schedule } = collectingScheduler();
        const budget = createTurnBudget(1, clock, schedule);
        advance(0.1);
        budget.charge(0);
        advance(1.1);

        // Act
        const result = budget.admit();

        // Assert
        expect(result).toBeInstanceOf(Promise);
      });
    });
  });

  describe("Given the clock has advanced 0.4 ms since the turn's first charge", () => {
    describe('When admit runs', () => {
      it('Then it still returns undefined', () => {
        // Arrange
        const { clock, advance } = manualClock();
        const { schedule } = collectingScheduler();
        const budget = createTurnBudget(1, clock, schedule);
        advance(0.4);
        budget.charge(0);

        // Act
        const result = budget.admit();

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given two charges occur in the same turn with different start times', () => {
    describe('When admit runs', () => {
      it("Then elapsed time is measured from the FIRST charge's start, not the second", () => {
        // Arrange
        const { clock, advance } = manualClock();
        const { schedule } = collectingScheduler();
        const budget = createTurnBudget(1, clock, schedule);
        advance(0.1);
        budget.charge(0);
        advance(0.4);
        budget.charge(0.5);
        advance(0.5);

        // Act
        const result = budget.admit();

        // Assert
        expect(result).toBeInstanceOf(Promise);
      });
    });
  });

  describe("Given the clock has advanced exactly the budget since the turn's first charge", () => {
    describe('When admit runs', () => {
      it('Then it returns a pending promise', () => {
        // Arrange
        const { clock, advance } = manualClock();
        const { schedule } = collectingScheduler();
        const budget = createTurnBudget(1, clock, schedule);
        advance(1);
        budget.charge(0);

        // Act
        const result = budget.admit();

        // Assert
        expect(result).toBeInstanceOf(Promise);
      });
    });
  });

  describe('Given the budget is already exceeded', () => {
    describe('When three callers call admit', () => {
      it('Then they receive the same pending promise', () => {
        // Arrange
        const { clock, advance } = manualClock();
        const { schedule } = collectingScheduler();
        const budget = createTurnBudget(1, clock, schedule);
        advance(2);
        budget.charge(0);

        // Act
        const first = budget.admit();
        const second = budget.admit();
        const third = budget.admit();

        // Assert
        expect(second).toBe(first);
        expect(third).toBe(first);
      });
    });
  });

  describe('Given two charges occur in the same turn', () => {
    describe('When charge is called twice', () => {
      it('Then exactly one marker is scheduled', () => {
        // Arrange
        const { clock, advance } = manualClock();
        const { schedule, marks } = collectingScheduler();
        const budget = createTurnBudget(1, clock, schedule);

        // Act
        advance(0.1);
        budget.charge(0);
        advance(0.1);
        budget.charge(0.1);

        // Assert
        expect(marks.length).toBe(1);
      });
    });
  });

  describe('Given a charge that stays under budget', () => {
    describe('When the marker fires', () => {
      it('Then the turn resets without a pending promise to resolve', () => {
        // Arrange
        const { clock, advance } = manualClock();
        const { schedule, marks } = collectingScheduler();
        const budget = createTurnBudget(1, clock, schedule);
        advance(0.2);
        budget.charge(0);

        // Act
        const fireMarker = () => marks[0]?.();

        // Assert
        expect(fireMarker).not.toThrow();
        expect(budget.admit()).toBeUndefined();
      });
    });
  });

  describe('Given the budget is exceeded and a marker is armed', () => {
    describe('When the marker fires', () => {
      it('Then the pending promise resolves', async () => {
        // Arrange
        const { clock, advance } = manualClock();
        const { schedule, marks } = collectingScheduler();
        const budget = createTurnBudget(1, clock, schedule);
        advance(2);
        budget.charge(0);
        const pending = budget.admit();

        // Act
        marks[0]?.();

        // Assert
        await expect(pending).resolves.toBeUndefined();
      });

      it('Then the next admit call returns undefined', () => {
        // Arrange
        const { clock, advance } = manualClock();
        const { schedule, marks } = collectingScheduler();
        const budget = createTurnBudget(1, clock, schedule);
        advance(2);
        budget.charge(0);
        budget.admit();

        // Act
        marks[0]?.();
        const result = budget.admit();

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a turn has ended and a new sync op is charged', () => {
    describe("When admit runs within the new turn's budget", () => {
      it('Then it returns undefined, pinned to the new charge, not the stale one', () => {
        // Arrange
        const { clock, advance } = manualClock();
        const { schedule, marks } = collectingScheduler();
        const budget = createTurnBudget(1, clock, schedule);
        advance(2);
        budget.charge(0);
        budget.admit();
        marks[0]?.();

        // Act
        advance(0.3);
        budget.charge(2.2);

        // Assert
        expect(budget.admit()).toBeUndefined();
      });
    });
  });

  describe('Given a budget of 0 ms', () => {
    describe('When a sync op is charged', () => {
      it('Then it arms exactly one marker', () => {
        // Arrange
        const { clock } = manualClock();
        const { schedule, marks } = collectingScheduler();
        const budget = createTurnBudget(0, clock, schedule);

        // Act
        budget.charge(0);

        // Assert
        expect(marks.length).toBe(1);
      });
    });

    describe('When admit runs after a charge', () => {
      it('Then it returns a pending promise', () => {
        // Arrange
        const { clock } = manualClock();
        const { schedule } = collectingScheduler();
        const budget = createTurnBudget(0, clock, schedule);
        budget.charge(0);

        // Act
        const result = budget.admit();

        // Assert
        expect(result).toBeInstanceOf(Promise);
      });
    });

    describe('When the marker fires', () => {
      it('Then the pending promise resolves', async () => {
        // Arrange
        const { clock } = manualClock();
        const { schedule, marks } = collectingScheduler();
        const budget = createTurnBudget(0, clock, schedule);
        budget.charge(0);
        const pending = budget.admit();

        // Act
        marks[0]?.();

        // Assert
        await expect(pending).resolves.toBeUndefined();
      });
    });
  });
});

describe('runWithinBudget', () => {
  describe('Given the budget admits immediately', () => {
    describe('When runWithinBudget runs a synchronous op', () => {
      it('Then the op has already run before the returned promise resolves', async () => {
        // Arrange
        const { clock } = manualClock();
        const { schedule } = collectingScheduler();
        const budget = createTurnBudget(1, clock, schedule);
        let ranBeforeAwait = false;
        const op = () => {
          ranBeforeAwait = true;
          return 'value';
        };

        // Act
        const result = runWithinBudget(budget, op);

        // Assert
        expect(ranBeforeAwait).toBe(true);
        await result;
      });

      it("Then the returned promise resolves to the op's result", async () => {
        // Arrange
        const { clock } = manualClock();
        const { schedule } = collectingScheduler();
        const budget = createTurnBudget(1, clock, schedule);

        // Act
        const result = await runWithinBudget(budget, () => 'value');

        // Assert
        expect(result).toBe('value');
      });

      it("Then charge measures elapsed time from the budget's own clock", async () => {
        // Arrange
        const { clock, advance } = manualClock();
        const { schedule } = collectingScheduler();
        const budget = createTurnBudget(1, clock, schedule);
        const op = () => advance(1);

        // Act
        await runWithinBudget(budget, op);
        const result = budget.admit();

        // Assert
        expect(result).toBeInstanceOf(Promise);
      });
    });
  });

  describe('Given the budget is already exceeded', () => {
    describe('When runWithinBudget runs an op', () => {
      it('Then the op does not run until the marker fires', async () => {
        // Arrange
        const { clock, advance } = manualClock();
        const { schedule, marks } = collectingScheduler();
        const budget = createTurnBudget(1, clock, schedule);
        advance(2);
        budget.charge(0);
        let ran = false;
        const op = () => {
          ran = true;
          return 'value';
        };

        // Act
        const promise = runWithinBudget(budget, op);

        // Assert
        expect(ran).toBe(false);
        marks[0]?.();
        const result = await promise;
        expect(ran).toBe(true);
        expect(result).toBe('value');
      });
    });
  });

  describe('Given an op that throws', () => {
    describe('When runWithinBudget runs it', () => {
      it('Then it rejects with the same error instance and still charges', async () => {
        // Arrange
        const { clock, advance } = manualClock();
        const { schedule } = collectingScheduler();
        const budget = createTurnBudget(1, clock, schedule);
        const error = new Error('boom');
        const op = () => {
          advance(1);
          throw error;
        };

        // Act
        let caught: unknown;
        try {
          await runWithinBudget(budget, op);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBe(error);
        expect(budget.admit()).toBeInstanceOf(Promise);
      });
    });
  });

  describe('Given N concurrent ops of cost c fan out onto the same budget', () => {
    describe('When the waiters parked on the shared pending promise resume together', () => {
      it('Then no turn runs more ops than ceil(budget / cost) + 1', async () => {
        // Arrange — every caller shares ONE pending promise once the budget
        // is spent (`pending ??= createDeferred()`); a single-admit caller
        // that never re-checks after waking runs its whole backlog in one
        // turn, so cost is charged as a clock advance INSIDE the op —
        // exactly what lets a re-admitting sibling observe the spend.
        const budgetMs = 1;
        const cost = 0.5;
        const opCount = 100;
        const maxPerTurn = Math.ceil(budgetMs / cost) + 1;
        const { clock, advance } = manualClock();
        const { schedule, marks } = collectingScheduler();
        const budget = createTurnBudget(budgetMs, clock, schedule);
        const perTurnCounts: number[] = [];
        let ranThisTurn = 0;
        const op = () => {
          ranThisTurn += 1;
          advance(cost);
        };

        // Act — the synchronous fan-out is itself the first turn (whatever
        // admits for free before the first caller parks); each subsequent
        // marker fire replays the next turn's cascade of admits/re-parks.
        const runs = Array.from({ length: opCount }, () => runWithinBudget(budget, op));
        perTurnCounts.push(ranThisTurn);
        let fired = 0;
        while (fired < marks.length) {
          ranThisTurn = 0;
          marks[fired]?.();
          fired += 1;
          await Promise.resolve();
          perTurnCounts.push(ranThisTurn);
        }
        await Promise.all(runs);

        // Assert
        const total = perTurnCounts.reduce((sum, count) => sum + count, 0);
        expect(total).toBe(opCount);
        for (const count of perTurnCounts) {
          expect(count).toBeLessThanOrEqual(maxPerTurn);
        }
      });
    });
  });
});

describe('createSyncIoPolicy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Given no options', () => {
    describe('When building the default policy', () => {
      it('Then maxSyncReadBytes is 64 KiB', () => {
        // Arrange & Act
        const result = createSyncIoPolicy();

        // Assert
        expect(result.maxSyncReadBytes).toBe(64 * 1024);
      });

      it('Then ops is the real sync fs operations', () => {
        // Arrange & Act
        const result = createSyncIoPolicy();

        // Assert
        expect(result.ops).toBe(realSyncFsOps);
      });

      it('Then the budget admits immediately before any charge', () => {
        // Arrange & Act
        const result = createSyncIoPolicy();

        // Assert
        expect(result.budget.admit()).toBeUndefined();
      });

      it('Then the budget gates after one millisecond of charged clock time', () => {
        // Arrange
        vi.spyOn(performance, 'now').mockReturnValue(1);
        const policy = createSyncIoPolicy();

        // Act
        policy.budget.charge(0);
        const result = policy.budget.admit();

        // Assert
        expect(result).toBeInstanceOf(Promise);
      });
    });
  });
});

describe('syncIoPolicyFor', () => {
  describe('Given io is undefined', () => {
    describe('When resolving the policy', () => {
      it('Then it returns a fresh sync policy', () => {
        // Arrange
        const sut = syncIoPolicyFor;

        // Act
        const result = sut(undefined);

        // Assert
        expect(result?.maxSyncReadBytes).toBe(64 * 1024);
      });
    });
  });

  describe("Given io is 'sync-fast-path'", () => {
    describe('When resolving the policy', () => {
      it('Then it returns a fresh sync policy', () => {
        // Arrange
        const sut = syncIoPolicyFor;

        // Act
        const result = sut('sync-fast-path');

        // Assert
        expect(result?.maxSyncReadBytes).toBe(64 * 1024);
      });
    });
  });

  describe("Given io is 'threadpool'", () => {
    describe('When resolving the policy', () => {
      it('Then it returns undefined', () => {
        // Arrange
        const sut = syncIoPolicyFor;

        // Act
        const result = sut('threadpool');

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given io is an unrecognised string', () => {
    describe('When resolving the policy', () => {
      it("Then it throws INVALID_OPTION naming 'io'", () => {
        // Arrange + Act + Assert
        expectInvalidIo('async' as unknown as IoOption, "must be 'sync-fast-path' or 'threadpool'");
      });
    });
  });

  describe('Given io is the boolean true', () => {
    describe('When resolving the policy', () => {
      it("Then it throws INVALID_OPTION naming 'io'", () => {
        // Arrange + Act + Assert
        expectInvalidIo(true as unknown as IoOption, "must be 'sync-fast-path' or 'threadpool'");
      });
    });
  });

  describe('Given io is the number 1', () => {
    describe('When resolving the policy', () => {
      it("Then it throws INVALID_OPTION naming 'io'", () => {
        // Arrange + Act + Assert
        expectInvalidIo(1 as unknown as IoOption, "must be 'sync-fast-path' or 'threadpool'");
      });
    });
  });
});
