import { describe, expect, it } from 'vitest';
import { TsgitError } from '../../../src/domain/error.js';
import { resolveAlgorithm } from '../../../src/repository/resolve-algorithm.js';

describe('resolveAlgorithm', () => {
  describe('Given no option, no declared format, and no service algorithm', () => {
    describe('When resolveAlgorithm runs', () => {
      it("Then returns 'sha1' (R6 — the default)", () => {
        // Arrange / Act
        const result = resolveAlgorithm({});

        // Assert
        expect(result).toBe('sha1');
      });
    });
  });

  describe('Given only a declared format (the layout channel, no option)', () => {
    describe('When resolveAlgorithm runs', () => {
      it('Then returns the declared value', () => {
        // Arrange / Act
        const result = resolveAlgorithm({ declared: 'sha256' });

        // Assert
        expect(result).toBe('sha256');
      });
    });
  });

  describe('Given only an option (no declared format, no service)', () => {
    describe('When resolveAlgorithm runs', () => {
      it('Then returns the option value', () => {
        // Arrange / Act
        const result = resolveAlgorithm({ option: 'sha256' });

        // Assert
        expect(result).toBe('sha256');
      });
    });
  });

  describe('Given only a service algorithm (a caller-supplied hash override, no option, no declared format)', () => {
    describe('When resolveAlgorithm runs', () => {
      it('Then returns the service value', () => {
        // Arrange / Act
        const result = resolveAlgorithm({ service: 'sha256' });

        // Assert
        expect(result).toBe('sha256');
      });
    });
  });

  describe('Given an option that agrees with the declared format', () => {
    describe('When resolveAlgorithm runs', () => {
      it('Then it resolves without refusing (agreement is not a conflict)', () => {
        // Arrange / Act
        const result = resolveAlgorithm({ option: 'sha256', declared: 'sha256' });

        // Assert
        expect(result).toBe('sha256');
      });
    });
  });

  describe('Given an option that disagrees with the declared format', () => {
    describe('When resolveAlgorithm runs', () => {
      it('Then throws OBJECT_FORMAT_CONFLICT{ requested: option, declared, source: "option" }', () => {
        // Arrange
        let caught: unknown;

        // Act
        try {
          resolveAlgorithm({ option: 'sha1', declared: 'sha256' });
          expect.fail('expected OBJECT_FORMAT_CONFLICT');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'OBJECT_FORMAT_CONFLICT',
          requested: 'sha1',
          declared: 'sha256',
          source: 'option',
        });
      });
    });
  });

  describe('Given a service algorithm that disagrees with the declared format', () => {
    describe('When resolveAlgorithm runs', () => {
      it('Then throws OBJECT_FORMAT_CONFLICT{ requested: service, declared, source: "hash" }', () => {
        // Arrange
        let caught: unknown;

        // Act
        try {
          resolveAlgorithm({ service: 'sha256', declared: 'sha1' });
          expect.fail('expected OBJECT_FORMAT_CONFLICT');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'OBJECT_FORMAT_CONFLICT',
          requested: 'sha256',
          declared: 'sha1',
          source: 'hash',
        });
      });
    });
  });

  describe('Given a service algorithm that disagrees with the option', () => {
    describe('When resolveAlgorithm runs', () => {
      it('Then throws OBJECT_FORMAT_CONFLICT{ requested: service, declared: option, source: "hash" }', () => {
        // Arrange
        let caught: unknown;

        // Act
        try {
          resolveAlgorithm({ service: 'sha1', option: 'sha256' });
          expect.fail('expected OBJECT_FORMAT_CONFLICT');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'OBJECT_FORMAT_CONFLICT',
          requested: 'sha1',
          declared: 'sha256',
          source: 'hash',
        });
      });
    });
  });

  describe('Given a service algorithm that agrees with both the option and the declared format', () => {
    describe('When resolveAlgorithm runs', () => {
      it('Then resolves without refusing', () => {
        // Arrange / Act
        const result = resolveAlgorithm({
          service: 'sha256',
          option: 'sha256',
          declared: 'sha256',
        });

        // Assert
        expect(result).toBe('sha256');
      });
    });
  });
});
