import { describe, expect, it } from 'vitest';

import { parseUpdateMode } from '../../../../src/domain/submodule/update-mode.js';

describe('Given a raw submodule.<name>.update value', () => {
  describe('When the value is a recognised mode', () => {
    it('Then `checkout` parses', () => {
      // Arrange + Act + Assert
      expect(parseUpdateMode('checkout')).toBe('checkout');
    });

    it('Then `rebase` parses', () => {
      // Arrange + Act + Assert
      expect(parseUpdateMode('rebase')).toBe('rebase');
    });

    it('Then `merge` parses', () => {
      // Arrange + Act + Assert
      expect(parseUpdateMode('merge')).toBe('merge');
    });

    it('Then `none` parses', () => {
      // Arrange + Act + Assert
      expect(parseUpdateMode('none')).toBe('none');
    });
  });

  describe('When the value is a command form', () => {
    it('Then a `!command` value is rejected', () => {
      // Arrange + Act + Assert
      expect(parseUpdateMode('!touch /tmp/x')).toBeUndefined();
    });
  });

  describe('When the value is an unknown token', () => {
    it('Then it is rejected', () => {
      // Arrange + Act + Assert
      expect(parseUpdateMode('banana')).toBeUndefined();
    });
  });
});
