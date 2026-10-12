import { describe, expect, it } from 'vitest';

import type { AttributeValue } from '../../../../src/domain/attributes/attribute-value.js';
import {
  type ConversionAttributes,
  type CrlfAction,
  type EolSettings,
  outputLineEnding,
  resolveCrlfAction,
} from '../../../../src/domain/eol/crlf-action.js';

const U: AttributeValue = 'unspecified';

const attrs = (overrides: Partial<ConversionAttributes> = {}): ConversionAttributes => ({
  text: U,
  crlf: U,
  eol: U,
  ...overrides,
});

const settings = (overrides: Partial<EolSettings> = {}): EolSettings => ({
  autoCrlf: false,
  safeCrlf: 'warn',
  nativeEol: 'lf',
  ...overrides,
});

describe('resolveCrlfAction', () => {
  const CASES_1: ReadonlyArray<[string, Partial<ConversionAttributes>, CrlfAction]> = [
    ['text set', { text: true }, 'text-crlf'],
    ['text unset', { text: false }, 'binary'],
    ['text=input', { text: { set: 'input' } }, 'text-input'],
    ['text=auto', { text: { set: 'auto' } }, 'auto'],
    ['text=foo', { text: { set: 'foo' } }, 'binary'],
    ['text unspecified', { text: U }, 'binary'],
  ];

  describe.each(CASES_1)('Given autocrlf false and %s', (_name, overrides, expected) => {
    describe('When resolving', () => {
      it(`Then the action is ${expected}`, () => {
        // Arrange
        const sut = resolveCrlfAction;
        const eolSettings = settings({ autoCrlf: false, nativeEol: 'crlf' });

        // Act
        const result = sut(attrs(overrides), eolSettings);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  const CASES_2: ReadonlyArray<[string, Partial<ConversionAttributes>, CrlfAction]> = [
    ['crlf set', { crlf: true }, 'text-crlf'],
    ['crlf unset', { crlf: false }, 'binary'],
    ['crlf=input', { crlf: { set: 'input' } }, 'text-input'],
    ['text=foo crlf', { text: { set: 'foo' }, crlf: true }, 'text-crlf'],
    ['text=foo alone', { text: { set: 'foo' } }, 'binary'],
    ['text unset and crlf set', { text: false, crlf: true }, 'binary'],
    ['text set and crlf unset', { text: true, crlf: false }, 'text-crlf'],
  ];

  describe.each(CASES_2)(
    'Given autocrlf false, nativeEol crlf and %s',
    (_name, overrides, expected) => {
      describe('When resolving', () => {
        it(`Then the action is ${expected}`, () => {
          // Arrange
          const sut = resolveCrlfAction;
          const eolSettings = settings({ nativeEol: 'crlf' });

          // Act
          const result = sut(attrs(overrides), eolSettings);

          // Assert
          expect(result).toBe(expected);
        });
      });
    },
  );

  const CASES_3: ReadonlyArray<[string, Partial<ConversionAttributes>, CrlfAction]> = [
    ['text=auto eol=lf', { text: { set: 'auto' }, eol: { set: 'lf' } }, 'auto-input'],
    ['text=auto eol=crlf', { text: { set: 'auto' }, eol: { set: 'crlf' } }, 'auto-crlf'],
    ['text eol=lf', { text: true, eol: { set: 'lf' } }, 'text-input'],
    ['text eol=crlf', { text: true, eol: { set: 'crlf' } }, 'text-crlf'],
    ['text=input eol=crlf', { text: { set: 'input' }, eol: { set: 'crlf' } }, 'text-crlf'],
    ['eol=lf alone', { eol: { set: 'lf' } }, 'text-input'],
    ['eol=crlf alone', { eol: { set: 'crlf' } }, 'text-crlf'],
    ['-text eol=crlf', { text: false, eol: { set: 'crlf' } }, 'binary'],
    ['-text eol=lf', { text: false, eol: { set: 'lf' } }, 'binary'],
    ['text eol=bar', { text: true, eol: { set: 'bar' } }, 'text-crlf'],
    ['text=auto eol=bar', { text: { set: 'auto' }, eol: { set: 'bar' } }, 'auto'],
    ['eol set without value', { eol: true }, 'binary'],
    ['crlf eol=lf', { crlf: true, eol: { set: 'lf' } }, 'text-input'],
  ];

  describe.each(CASES_3)(
    'Given nativeEol crlf, autocrlf false and %s',
    (_name, overrides, expected) => {
      describe('When resolving', () => {
        it(`Then the action is ${expected}`, () => {
          // Arrange
          const sut = resolveCrlfAction;
          const eolSettings = settings({ nativeEol: 'crlf' });

          // Act
          const result = sut(attrs(overrides), eolSettings);

          // Assert
          expect(result).toBe(expected);
        });
      });
    },
  );

  const CASES_4: ReadonlyArray<
    [EolSettings['autoCrlf'], EolSettings['coreEol'], 'lf' | 'crlf', CrlfAction]
  > = [
    [true, undefined, 'lf', 'text-crlf'],
    [true, 'lf', 'lf', 'text-crlf'],
    ['input', undefined, 'crlf', 'text-input'],
    ['input', 'crlf', 'crlf', 'text-input'],
    [false, 'lf', 'crlf', 'text-input'],
    [false, 'crlf', 'lf', 'text-crlf'],
    [false, 'native', 'lf', 'text-input'],
    [false, 'native', 'crlf', 'text-crlf'],
    [false, undefined, 'lf', 'text-input'],
    [false, undefined, 'crlf', 'text-crlf'],
  ];

  describe.each(CASES_4)(
    'Given text set, autocrlf %j, core.eol %j, native %s',
    (autoCrlf, coreEol, nativeEol, expected) => {
      describe('When resolving', () => {
        it(`Then the action is ${expected}`, () => {
          // Arrange
          const sut = resolveCrlfAction;
          const eolSettings = settings({
            autoCrlf,
            nativeEol,
            ...(coreEol === undefined ? {} : { coreEol }),
          });

          // Act
          const result = sut(attrs({ text: true }), eolSettings);

          // Assert
          expect(result).toBe(expected);
        });
      });
    },
  );

  const CASES_5: ReadonlyArray<[EolSettings['autoCrlf'], CrlfAction]> = [
    [false, 'binary'],
    [true, 'auto-crlf'],
    ['input', 'auto-input'],
  ];

  describe.each(CASES_5)('Given no attribute and autocrlf %j', (autoCrlf, expected) => {
    describe('When resolving', () => {
      it(`Then the action is ${expected}`, () => {
        // Arrange
        const sut = resolveCrlfAction;
        const eolSettings = settings({ autoCrlf, coreEol: 'crlf', nativeEol: 'crlf' });

        // Act
        const result = sut(attrs(), eolSettings);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('outputLineEnding', () => {
  const CASES_6: ReadonlyArray<[CrlfAction, EolSettings, 'lf' | 'crlf' | undefined]> = [
    ['binary', settings({ coreEol: 'crlf' }), undefined],
    ['text-crlf', settings(), 'crlf'],
    ['auto-crlf', settings(), 'crlf'],
    ['text-input', settings({ nativeEol: 'crlf' }), 'lf'],
    ['auto-input', settings({ nativeEol: 'crlf' }), 'lf'],
    ['auto', settings({ autoCrlf: true }), 'crlf'],
    ['auto', settings({ autoCrlf: 'input', nativeEol: 'crlf' }), 'lf'],
    ['auto', settings({ coreEol: 'crlf' }), 'crlf'],
    ['auto', settings({ coreEol: 'lf', nativeEol: 'crlf' }), 'lf'],
    ['auto', settings({ coreEol: 'native', nativeEol: 'crlf' }), 'crlf'],
    ['auto', settings({ coreEol: 'native', nativeEol: 'lf' }), 'lf'],
    ['auto', settings({ nativeEol: 'crlf' }), 'crlf'],
    ['auto', settings({ nativeEol: 'lf' }), 'lf'],
  ];

  describe.each(CASES_6)('Given action %s and settings %j', (action, sut, expected) => {
    describe('When asking for the output line ending', () => {
      it(`Then it is ${expected}`, () => {
        // Arrange + Act
        const result = outputLineEnding(action, sut);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
