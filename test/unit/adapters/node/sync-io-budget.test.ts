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
        const sut = createTurnBudget(1, clock, schedule);

        // Act
        const result = sut.admit();

        // Assert
        expect(result).toBeUndefined();
      });
    });

    describe('When now is read', () => {
      it("Then it returns the injected clock's current value", () => {
        // Arrange
        const { clock, advance } = manualClock();
        const { schedule } = collectingScheduler();
        const sut = createTurnBudget(1, clock, schedule);
        advance(0.7);

        // Act
        const result = sut.now();

        // Assert
        expect(result).toBe(0.7);
      });
    });
  });

  describe('Given charges totalling 0.4 ms against a 1 ms budget', () => {
    describe('When admit runs', () => {
      it('Then it still returns undefined', () => {
        // Arrange
        const { clock, advance } = manualClock();
        const { schedule } = collectingScheduler();
        const sut = createTurnBudget(1, clock, schedule);
        advance(0.4);
        sut.charge(0);

        // Act
        const result = sut.admit();

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given charges totalling exactly the budget', () => {
    describe('When admit runs', () => {
      it('Then it returns a pending promise', () => {
        // Arrange
        const { clock, advance } = manualClock();
        const { schedule } = collectingScheduler();
        const sut = createTurnBudget(1, clock, schedule);
        advance(1);
        sut.charge(0);

        // Act
        const result = sut.admit();

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
        const sut = createTurnBudget(1, clock, schedule);
        advance(2);
        sut.charge(0);

        // Act
        const first = sut.admit();
        const second = sut.admit();
        const third = sut.admit();

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
        const sut = createTurnBudget(1, clock, schedule);

        // Act
        advance(0.1);
        sut.charge(0);
        advance(0.1);
        sut.charge(0.1);

        // Assert
        expect(marks.length).toBe(1);
      });
    });
  });

  describe('Given a charge that stays under budget', () => {
    describe('When the marker fires', () => {
      it('Then spent resets without a pending promise to resolve', () => {
        // Arrange
        const { clock, advance } = manualClock();
        const { schedule, marks } = collectingScheduler();
        const sut = createTurnBudget(1, clock, schedule);
        advance(0.2);
        sut.charge(0);

        // Act
        const fireMarker = () => marks[0]?.();

        // Assert
        expect(fireMarker).not.toThrow();
        expect(sut.admit()).toBeUndefined();
      });
    });
  });

  describe('Given the budget is exceeded and a marker is armed', () => {
    describe('When the marker fires', () => {
      it('Then the pending promise resolves', async () => {
        // Arrange
        const { clock, advance } = manualClock();
        const { schedule, marks } = collectingScheduler();
        const sut = createTurnBudget(1, clock, schedule);
        advance(2);
        sut.charge(0);
        const pending = sut.admit();

        // Act
        marks[0]?.();

        // Assert
        await expect(pending).resolves.toBeUndefined();
      });

      it('Then the next admit call returns undefined', () => {
        // Arrange
        const { clock, advance } = manualClock();
        const { schedule, marks } = collectingScheduler();
        const sut = createTurnBudget(1, clock, schedule);
        advance(2);
        sut.charge(0);
        sut.admit();

        // Act
        marks[0]?.();
        const result = sut.admit();

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a budget of 0 ms', () => {
    describe('When admit is called', () => {
      it('Then it arms exactly one marker', () => {
        // Arrange
        const { clock } = manualClock();
        const { schedule, marks } = collectingScheduler();
        const sut = createTurnBudget(0, clock, schedule);

        // Act
        sut.admit();

        // Assert
        expect(marks.length).toBe(1);
      });

      it('Then it returns a pending promise', () => {
        // Arrange
        const { clock } = manualClock();
        const { schedule } = collectingScheduler();
        const sut = createTurnBudget(0, clock, schedule);

        // Act
        const result = sut.admit();

        // Assert
        expect(result).toBeInstanceOf(Promise);
      });
    });

    describe('When the marker fires', () => {
      it('Then the pending promise resolves', async () => {
        // Arrange
        const { clock } = manualClock();
        const { schedule, marks } = collectingScheduler();
        const sut = createTurnBudget(0, clock, schedule);
        const pending = sut.admit();

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
        const sut = createTurnBudget(1, clock, schedule);
        let ranBeforeAwait = false;
        const op = () => {
          ranBeforeAwait = true;
          return 'value';
        };

        // Act
        const result = runWithinBudget(sut, op);

        // Assert
        expect(ranBeforeAwait).toBe(true);
        await result;
      });

      it("Then the returned promise resolves to the op's result", async () => {
        // Arrange
        const { clock } = manualClock();
        const { schedule } = collectingScheduler();
        const sut = createTurnBudget(1, clock, schedule);

        // Act
        const result = await runWithinBudget(sut, () => 'value');

        // Assert
        expect(result).toBe('value');
      });

      it("Then charge measures elapsed time from the budget's own clock", async () => {
        // Arrange
        const { clock, advance } = manualClock();
        const { schedule } = collectingScheduler();
        const sut = createTurnBudget(1, clock, schedule);
        const op = () => advance(1);

        // Act
        await runWithinBudget(sut, op);
        const result = sut.admit();

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
        const sut = createTurnBudget(1, clock, schedule);
        advance(2);
        sut.charge(0);
        let ran = false;
        const op = () => {
          ran = true;
          return 'value';
        };

        // Act
        const promise = runWithinBudget(sut, op);

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
        const sut = createTurnBudget(1, clock, schedule);
        const error = new Error('boom');
        const op = () => {
          advance(1);
          throw error;
        };

        // Act
        let caught: unknown;
        try {
          await runWithinBudget(sut, op);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBe(error);
        expect(sut.admit()).toBeInstanceOf(Promise);
      });
    });
  });
});

describe('createSyncIoPolicy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
      const sut = createSyncIoPolicy();

      // Act
      sut.budget.charge(0);
      const result = sut.budget.admit();

      // Assert
      expect(result).toBeInstanceOf(Promise);
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
