import { describe, expect, it } from 'vitest';
import { indexMailmap, mapUser } from '../../../../src/domain/mailmap/map-user.js';
import { parseMailmap } from '../../../../src/domain/mailmap/parse-mailmap.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ident = (name: string, mail: string) => ({
  name: encoder.encode(name),
  mail: encoder.encode(mail),
});
const show = (mapped: { name: Uint8Array; mail: Uint8Array }) =>
  `${decoder.decode(mapped.name)} <${decoder.decode(mapped.mail)}>`;
const indexOf = (mailmap: string) => indexMailmap(parseMailmap(mailmap));

describe('mapUser', () => {
  describe('Given an email-only rule, When mapping any name', () => {
    it('Then the name and email are replaced', () => {
      // Arrange
      const sut = mapUser;
      const index = indexOf('Proper <proper@e> <old@e>');

      // Act
      const result = show(sut(index, ident('Whoever', 'old@e')));

      // Assert
      expect(result).toBe('Proper <proper@e>');
    });
  });

  describe('Given a name-only replacement, When mapping', () => {
    it('Then the email keeps the input spelling', () => {
      // Arrange
      const sut = mapUser;
      const index = indexOf('Proper <a@e>');

      // Act
      const result = show(sut(index, ident('Old', 'A@E')));

      // Assert
      expect(result).toBe('Proper <A@E>');
    });
  });

  describe('Given an email-only replacement, When mapping', () => {
    it('Then the name is kept', () => {
      // Arrange
      const sut = mapUser;
      const index = indexOf('<new@e> <old@e>');

      // Act
      const result = show(sut(index, ident('Keep', 'old@e')));

      // Assert
      expect(result).toBe('Keep <new@e>');
    });
  });

  describe('Given a name+email rule and an email-only rule on one email, When mapping the named ident', () => {
    it('Then the name+email rule wins', () => {
      // Arrange
      const sut = mapUser;
      const index = indexOf('Simple <s@e> <old@e>\nNamed <n@e> Old Name <old@e>');

      // Act
      const result = show(sut(index, ident('Old Name', 'old@e')));

      // Assert
      expect(result).toBe('Named <n@e>');
    });
  });

  describe('Given the same two rules, When mapping another name', () => {
    it('Then the email-only rule applies', () => {
      // Arrange
      const sut = mapUser;
      const index = indexOf('Simple <s@e> <old@e>\nNamed <n@e> Old Name <old@e>');

      // Act
      const result = show(sut(index, ident('Other', 'old@e')));

      // Assert
      expect(result).toBe('Simple <s@e>');
    });
  });

  describe('Given only a name+email rule, When mapping another name', () => {
    it('Then the ident is unmapped', () => {
      // Arrange
      const sut = mapUser;
      const index = indexOf('Named <n@e> Old Name <old@e>');

      // Act
      const result = show(sut(index, ident('Other', 'old@e')));

      // Assert
      expect(result).toBe('Other <old@e>');
    });
  });

  describe('Given a name+email rule listed before the email-only rule, When mapping the named ident', () => {
    it('Then the name+email rule still wins', () => {
      // Arrange
      const sut = mapUser;
      const index = indexOf('Named <n@e> Old Name <old@e>\nSimple <s@e> <old@e>');

      // Act
      const result = show(sut(index, ident('Old Name', 'old@e')));

      // Assert
      expect(result).toBe('Named <n@e>');
    });
  });

  describe('Given mixed-case input, When mapping', () => {
    it('Then both email and name match case-insensitively', () => {
      // Arrange
      const sut = mapUser;
      const index = indexOf('Named <n@e> Old Name <Old@E>');

      // Act
      const result = show(sut(index, ident('OLD name', 'oLD@e')));

      // Assert
      expect(result).toBe('Named <n@e>');
    });
  });

  describe('Given a name-only name+email rule, When mapping', () => {
    it('Then the matched name rule keeps the email', () => {
      // Arrange
      const sut = mapUser;
      const index = indexOf('Named <old@e> Old Name <old@e>');

      // Act
      const result = show(sut(index, ident('Old Name', 'old@e')));

      // Assert
      expect(result).toBe('Named <old@e>');
    });
  });

  describe('Given later rules for one email, When mapping', () => {
    it('Then later name and email replacements override per field', () => {
      // Arrange
      const sut = mapUser;
      const index = indexOf('First <f@e> <old@e>\nSecond <old@e>\n<third@e> <old@e>');

      // Act
      const result = show(sut(index, ident('x', 'old@e')));

      // Assert
      expect(result).toBe('Second <third@e>');
    });
  });

  describe('Given a repeated name+email key, When mapping', () => {
    it('Then the last rule replaces the earlier one entirely', () => {
      // Arrange
      const sut = mapUser;
      const index = indexOf('A <a@e> Old <old@e>\n<b@e> Old <old@e>');

      // Act
      const result = show(sut(index, ident('Old', 'old@e')));

      // Assert
      expect(result).toBe('Old <b@e>');
    });
  });

  describe('Given an email-only entry without replacements, When mapping', () => {
    it('Then the ident is unmapped', () => {
      // Arrange
      const sut = mapUser;
      const index = indexOf('<old@e>');

      // Act
      const result = show(sut(index, ident('N', 'old@e')));

      // Assert
      expect(result).toBe('N <old@e>');
    });
  });

  describe('Given an unknown email, When mapping', () => {
    it('Then the ident is returned as is', () => {
      // Arrange
      const sut = mapUser;
      const index = indexOf('Proper <p@e> <old@e>');
      const input = ident('N', 'unknown@e');

      // Act
      const result = show(sut(index, ident('N', 'unknown@e')));

      // Assert
      expect(result).toBe(show(input));
    });
  });

  describe('Given the empty email key, When mapping an empty email', () => {
    it('Then it matches the empty key', () => {
      // Arrange
      const sut = mapUser;
      const index = indexOf('Proper <p@e> <>\nProper2 <p@e> <>');

      // Act
      const result = show(sut(index, ident('x', '')));

      // Assert
      expect(result).toBe('Proper2 <p@e>');
    });
  });

  describe('Given an empty mailmap, When mapping', () => {
    it('Then the very same ident is returned', () => {
      // Arrange
      const sut = mapUser;
      const index = indexMailmap([]);
      const input = ident('N', 'a@e');

      // Act
      const result = sut(index, input);

      // Assert
      expect(result).toBe(input);
    });
  });
});
