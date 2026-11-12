import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type DiffDriverBinary,
  userdiffBinaryOverride,
} from '../../../../src/domain/diff/userdiff-binary.js';

const BUILTIN_NAMES: ReadonlySet<string> = new Set([
  'ada',
  'bash',
  'bibtex',
  'cpp',
  'csharp',
  'css',
  'dts',
  'elixir',
  'fortran',
  'fountain',
  'golang',
  'html',
  'java',
  'kotlin',
  'markdown',
  'matlab',
  'objc',
  'pascal',
  'perl',
  'php',
  'python',
  'r',
  'ruby',
  'rust',
  'scheme',
  'swift',
  'tex',
]);

const arbDriver: fc.Arbitrary<DiffDriverBinary> = fc
  .option(fc.boolean(), { nil: undefined })
  .map((binary) => (binary === undefined ? {} : { binary }));
const arbDrivers = fc.option(
  fc
    .dictionary(fc.string(), arbDriver)
    .map((dict) => new Map<string, DiffDriverBinary>(Object.entries(dict))),
  { nil: undefined },
);

describe('userdiff-binary properties', () => {
  describe('Given a forced diff attribute value (invariant lens)', () => {
    describe('When any drivers are configured', () => {
      it('Then the drivers never change the verdict', () => {
        // Arrange
        const sut = userdiffBinaryOverride;

        // Act / Assert
        fc.assert(
          fc.property(fc.boolean(), arbDrivers, (value, drivers) => {
            const result = sut(value, drivers);
            expect(result).toBe(value ? 'text' : 'binary');
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given a driver name that is neither builtin nor configured (invariant lens)', () => {
    describe('When the verdict is resolved', () => {
      it('Then it equals the verdict of an unspecified attribute', () => {
        // Arrange
        const sut = userdiffBinaryOverride;

        // Act / Assert
        fc.assert(
          fc.property(
            arbDrivers,
            fc.string().filter((name) => !BUILTIN_NAMES.has(name)),
            (drivers, name) => {
              fc.pre(drivers?.has(name) !== true);
              const result = sut({ set: name }, drivers);
              expect(result).toBe(sut('unspecified', drivers));
            },
          ),
          { numRuns: 50 },
        );
      });
    });
  });
});
