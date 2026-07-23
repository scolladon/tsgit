import { describe, expect, it } from 'vitest';

import { parseUpdateMode } from '../../../../src/domain/submodule/update-mode.js';

describe('Given a raw submodule.<name>.update value', () => {
  describe('When the value is a recognised mode', () => {
    it.each(['checkout', 'rebase', 'merge', 'none'])('Then `%s` parses', (mode) => {
      // Arrange + Act + Assert
      expect(parseUpdateMode(mode)).toBe(mode);
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
