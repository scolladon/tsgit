import { describe, expect, it } from 'vitest';

import { formatGitDate } from '../../../../src/domain/show/git-date.js';

describe('formatGitDate', () => {
  describe('Given a timestamp and a positive timezone offset, When formatGitDate runs', () => {
    it('Then the wall-clock is shifted into that zone', () => {
      // Arrange
      const timestamp = 1700000000;

      // Act
      const sut = formatGitDate(timestamp, '+0200');

      // Assert
      expect(sut).toBe('Wed Nov 15 00:13:20 2023 +0200');
    });
  });

  describe('Given a timestamp and a UTC offset, When formatGitDate runs', () => {
    it('Then the UTC wall-clock is rendered', () => {
      // Arrange
      const timestamp = 1700000000;

      // Act
      const sut = formatGitDate(timestamp, '+0000');

      // Assert
      expect(sut).toBe('Tue Nov 14 22:13:20 2023 +0000');
    });
  });

  describe('Given a single-digit day-of-month, When formatGitDate runs', () => {
    it('Then the day is unpadded', () => {
      // Arrange
      const timestamp = 1685700000;

      // Act
      const sut = formatGitDate(timestamp, '+0000');

      // Assert
      expect(sut).toBe('Fri Jun 2 10:00:00 2023 +0000');
    });
  });

  describe('Given a negative timezone offset, When formatGitDate runs', () => {
    it('Then the wall-clock is shifted backwards and the offset printed verbatim', () => {
      // Arrange
      const timestamp = 1700000000;

      // Act
      const sut = formatGitDate(timestamp, '-0500');

      // Assert
      expect(sut).toBe('Tue Nov 14 17:13:20 2023 -0500');
    });
  });

  describe('Given a pre-epoch timestamp, When formatGitDate runs', () => {
    it('Then a 1969 date is rendered', () => {
      // Arrange
      const timestamp = -100000;

      // Act
      const sut = formatGitDate(timestamp, '+0000');

      // Assert
      expect(sut).toBe('Tue Dec 30 20:13:20 1969 +0000');
    });
  });

  describe('Given an offset with non-zero minutes, When formatGitDate runs', () => {
    it('Then the minute component of the offset shifts the wall-clock', () => {
      // Arrange
      const timestamp = 1700000000;

      // Act
      const sut = formatGitDate(timestamp, '+0530');

      // Assert
      expect(sut).toBe('Wed Nov 15 03:43:20 2023 +0530');
    });
  });
});
