import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, availableParallelism: vi.fn(actual.availableParallelism) };
});

const { availableParallelism } = await import('node:os');
const { nativeMachineFacts } = await import('../../../../src/adapters/node/node-concurrency.js');

const availableParallelismSpy = vi.mocked(availableParallelism);

const UV_THREADPOOL_SIZE = 'UV_THREADPOOL_SIZE';

describe('nativeMachineFacts', () => {
  afterEach(() => {
    delete process.env[UV_THREADPOOL_SIZE];
    availableParallelismSpy.mockClear();
  });

  describe('Given os.availableParallelism reports a core count', () => {
    describe('When reading machine facts', () => {
      it('Then cores carries that count', () => {
        // Arrange
        availableParallelismSpy.mockReturnValue(11);
        const sut = nativeMachineFacts;

        // Act
        const result = sut();

        // Assert
        expect(result.cores).toBe(11);
      });
    });
  });

  describe('Given UV_THREADPOOL_SIZE is unset', () => {
    describe('When reading machine facts', () => {
      it('Then threadpoolWidth defaults to 4', () => {
        // Arrange
        availableParallelismSpy.mockReturnValue(11);
        const sut = nativeMachineFacts;

        // Act
        const result = sut();

        // Assert
        expect(result.threadpoolWidth).toBe(4);
      });
    });
  });

  describe('Given UV_THREADPOOL_SIZE=1', () => {
    describe('When reading machine facts', () => {
      it('Then threadpoolWidth is 1', () => {
        // Arrange
        availableParallelismSpy.mockReturnValue(11);
        process.env[UV_THREADPOOL_SIZE] = '1';
        const sut = nativeMachineFacts;

        // Act
        const result = sut();

        // Assert
        expect(result.threadpoolWidth).toBe(1);
      });
    });
  });

  describe('Given UV_THREADPOOL_SIZE is not a number', () => {
    describe('When reading machine facts', () => {
      it('Then threadpoolWidth defaults to 4', () => {
        // Arrange
        availableParallelismSpy.mockReturnValue(11);
        process.env[UV_THREADPOOL_SIZE] = 'not-a-number';
        const sut = nativeMachineFacts;

        // Act
        const result = sut();

        // Assert
        expect(result.threadpoolWidth).toBe(4);
      });
    });
  });
});
