import { describe, expect, it } from 'vitest';

import {
  HEAVY_READ_ITERATIONS,
  resolveWorkloads,
  UnknownCommandError,
  WORKLOADS,
} from '../../profile-registry.js';

const READ_KEYS = [
  'log',
  'status',
  'pack-read',
  'describe',
  'name-rev',
  'blame',
  'diff',
  'show',
  'cat-file',
  'rev-parse',
] as const;

const WRITE_KEYS = ['commit', 'add', 'merge'] as const;

describe('resolveWorkloads', () => {
  describe('Given no cmd argument', () => {
    describe('When resolveWorkloads(undefined) runs', () => {
      it('Then it returns every registry entry', () => {
        // Arrange
        const sut = resolveWorkloads;

        // Act
        const result = sut(undefined);

        // Assert
        expect(result.map(([name]) => name).sort()).toEqual(Object.keys(WORKLOADS).sort());
      });
    });
  });

  describe("Given a known cmd 'commit'", () => {
    describe("When resolveWorkloads('commit') runs", () => {
      it('Then it returns exactly that one entry', () => {
        // Arrange
        const sut = resolveWorkloads;

        // Act
        const result = sut('commit');

        // Assert
        expect(result).toHaveLength(1);
        expect(result[0]?.[0]).toBe('commit');
      });
    });
  });

  describe("Given an unknown cmd 'nope'", () => {
    describe("When resolveWorkloads('nope') runs", () => {
      it('Then it throws UnknownCommandError whose message lists the valid set', () => {
        // Arrange
        const sut = resolveWorkloads;

        // Act
        let caught: unknown;
        try {
          sut('nope');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(UnknownCommandError);
        expect((caught as Error).message).toContain('usage: profile <cmd>');
        expect((caught as Error).message).toContain('commit');
      });
    });
  });

  describe('Given the registry', () => {
    describe('When inspected', () => {
      it('Then commit/add/merge are kind write', () => {
        // Arrange
        const sut = WORKLOADS;

        // Assert
        for (const key of WRITE_KEYS) {
          expect(sut[key]?.kind).toBe('write');
        }
      });

      it.each(READ_KEYS)('Then %s is kind read', (key) => {
        // Arrange
        const sut = WORKLOADS;

        // Assert
        expect(sut[key]?.kind).toBe('read');
      });

      it('Then blame carries the heavy-read iteration override', () => {
        // Arrange
        const sut = WORKLOADS;

        // Assert
        expect(sut.blame?.iterations).toBe(HEAVY_READ_ITERATIONS);
      });

      it('Then a light read (log) has no iteration override', () => {
        // Arrange
        const sut = WORKLOADS;

        // Assert
        expect(sut.log?.iterations).toBeUndefined();
      });
    });
  });
});
