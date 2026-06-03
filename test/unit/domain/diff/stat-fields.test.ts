import { describe, expect, it } from 'vitest';
import { computeStatFields } from '../../../../src/domain/diff/stat-fields.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const withNul = (): Uint8Array => new Uint8Array([0x61, 0x00, 0x62]);

describe('computeStatFields', () => {
  describe('Given a pure addition (empty old, one new line)', () => {
    describe('When computeStatFields is called', () => {
      it('Then it reports one added line and zero deleted', () => {
        // Arrange
        const old = enc('');
        const next = enc('a\n');
        // Act
        const sut = computeStatFields(old, next);
        // Assert
        expect(sut).toEqual({ added: 1, deleted: 0, binary: false });
      });
    });
  });

  describe('Given a pure deletion (one old line, empty new)', () => {
    describe('When computeStatFields is called', () => {
      it('Then it reports zero added and one deleted line', () => {
        // Arrange
        const old = enc('a\n');
        const next = enc('');
        // Act
        const sut = computeStatFields(old, next);
        // Assert
        expect(sut).toEqual({ added: 0, deleted: 1, binary: false });
      });
    });
  });

  describe('Given a single-line replacement', () => {
    describe('When computeStatFields is called', () => {
      it('Then it reports one added and one deleted line', () => {
        // Arrange
        const old = enc('a\n');
        const next = enc('b\n');
        // Act
        const sut = computeStatFields(old, next);
        // Assert
        expect(sut).toEqual({ added: 1, deleted: 1, binary: false });
      });
    });
  });

  describe('Given identical content', () => {
    describe('When computeStatFields is called', () => {
      it('Then it reports zero changes and binary false', () => {
        // Arrange
        const same = enc('a\nb\n');
        // Act
        const sut = computeStatFields(same, same);
        // Assert
        expect(sut).toEqual({ added: 0, deleted: 0, binary: false });
      });
    });
  });

  describe('Given a binary old side only', () => {
    describe('When computeStatFields is called', () => {
      it('Then it reports binary with zero counts', () => {
        // Arrange — old has a NUL byte; new is text. Isolates the first guard arm.
        const old = withNul();
        const next = enc('text\n');
        // Act
        const sut = computeStatFields(old, next);
        // Assert
        expect(sut).toEqual({ added: 0, deleted: 0, binary: true });
      });
    });
  });

  describe('Given a binary new side only', () => {
    describe('When computeStatFields is called', () => {
      it('Then it reports binary with zero counts', () => {
        // Arrange — new has a NUL byte; old is text. Isolates the second guard arm.
        const old = enc('text\n');
        const next = withNul();
        // Act
        const sut = computeStatFields(old, next);
        // Assert
        expect(sut).toEqual({ added: 0, deleted: 0, binary: true });
      });
    });
  });
});
