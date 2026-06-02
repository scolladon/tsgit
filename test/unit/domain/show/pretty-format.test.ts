import { describe, expect, it } from 'vitest';

import { framingFor, parsePretty } from '../../../../src/domain/show/pretty-format.js';

describe('Given parsePretty', () => {
  describe('When a built-in name is given', () => {
    it('Then it resolves to a builtin spec', () => {
      // Arrange + Act + Assert
      expect(parsePretty('oneline')).toEqual({ kind: 'builtin', name: 'oneline' });
      expect(parsePretty('mboxrd')).toEqual({ kind: 'builtin', name: 'mboxrd' });
    });
  });

  describe('When a format: / tformat: spec is given', () => {
    it('Then it captures the template and terminator flag', () => {
      // Arrange + Act + Assert
      expect(parsePretty('format:%H')).toEqual({
        kind: 'custom',
        template: '%H',
        terminator: false,
      });
      expect(parsePretty('tformat:%h %s')).toEqual({
        kind: 'custom',
        template: '%h %s',
        terminator: true,
      });
    });
  });

  describe('When the spec is an unknown name', () => {
    it('Then it returns undefined', () => {
      // Arrange + Act + Assert
      expect(parsePretty('nope')).toBeUndefined();
    });
  });
});

describe('Given framingFor', () => {
  describe('When the format varies', () => {
    it('Then each format yields its terminator / blank flags', () => {
      // Arrange + Act + Assert
      expect(framingFor({ kind: 'builtin', name: 'medium' })).toEqual({
        terminator: true,
        blankBeforePatch: true,
      });
      expect(framingFor({ kind: 'builtin', name: 'oneline' })).toEqual({
        terminator: true,
        blankBeforePatch: false,
      });
      expect(framingFor({ kind: 'builtin', name: 'email' })).toEqual({
        terminator: false,
        blankBeforePatch: false,
      });
      expect(framingFor({ kind: 'builtin', name: 'mboxrd' })).toEqual({
        terminator: false,
        blankBeforePatch: false,
      });
      expect(framingFor({ kind: 'custom', template: '%H', terminator: false })).toEqual({
        terminator: false,
        blankBeforePatch: false,
      });
      expect(framingFor({ kind: 'custom', template: '%H', terminator: true })).toEqual({
        terminator: true,
        blankBeforePatch: true,
      });
    });
  });
});
