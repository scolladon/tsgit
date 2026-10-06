import { describe, expect, it } from 'vitest';
import { parseGitBoolOrInt } from '../../../../src/domain/config/config-ini.js';

describe('parseGitBoolOrInt', () => {
  describe.each([
    ['a valueless key', null, 1],
    ['an empty value', '', 0],
    ['true', 'true', 1],
    ['YES', 'YES', 1],
    ['on', 'on', 1],
    ['false', 'false', 0],
    ['No', 'No', 0],
    ['off', 'off', 0],
  ])('Given %s', (_label, value, expected) => {
    describe('When parsed', () => {
      it('Then it reads as a boolean', () => {
        // Arrange
        const sut = parseGitBoolOrInt;

        // Act
        const result = sut(value);

        // Assert
        expect(result).toEqual({ ok: true, value: expected, isBool: true });
      });
    });
  });

  describe.each([
    ['1', 1],
    ['0', 0],
    ['-1', -1],
    ['1k', 1024],
    ['0x10', 16],
    ['2147483647', 2_147_483_647],
    ['-2147483648', -2_147_483_648],
  ])('Given the integer %s', (value, expected) => {
    describe('When parsed', () => {
      it('Then it reads as that integer, not a boolean', () => {
        // Arrange
        const sut = parseGitBoolOrInt;

        // Act
        const result = sut(value);

        // Assert
        expect(result).toEqual({ ok: true, value: expected, isBool: false });
      });
    });
  });

  describe.each([
    ['foo', 'invalid unit'],
    ['2147483648', 'out of range'],
    ['-2147483649', 'out of range'],
    ['99999999999999999999', 'out of range'],
  ])('Given %s', (value, reason) => {
    describe('When parsed', () => {
      it("Then it refuses with git_config_int's reason", () => {
        // Arrange
        const sut = parseGitBoolOrInt;

        // Act
        const result = sut(value);

        // Assert
        expect(result).toEqual({ ok: false, reason });
      });
    });
  });
});
