import { describe, expect, it } from 'vitest';
import type { BinaryOverride } from '../../../../src/domain/diff/binary-decision.js';
import {
  type DiffDrivers,
  userdiffBinaryOverride,
} from '../../../../src/domain/diff/userdiff-binary.js';

const drivers = (entries: Record<string, { binary?: boolean }>): DiffDrivers =>
  new Map(Object.entries(entries));

const BUILTIN_NAMES = [
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
];

describe('userdiffBinaryOverride', () => {
  describe('Given a diff attribute value and the configured drivers', () => {
    describe('When the binary verdict is resolved', () => {
      const rows: ReadonlyArray<
        readonly [
          string,
          Parameters<typeof userdiffBinaryOverride>[0],
          DiffDrivers,
          BinaryOverride | undefined,
        ]
      > = [
        ['unset', false, drivers({ default: { binary: false } }), 'binary'],
        ['set', true, drivers({ default: { binary: true } }), 'text'],
        ['unspecified without drivers', 'unspecified', undefined, undefined],
        [
          'unspecified with default binary',
          'unspecified',
          drivers({ default: { binary: true } }),
          'binary',
        ],
        [
          'unspecified with default text',
          'unspecified',
          drivers({ default: { binary: false } }),
          'text',
        ],
        ['named driver binary', { set: 'drv' }, drivers({ drv: { binary: true } }), 'binary'],
        ['named driver text', { set: 'drv' }, drivers({ drv: { binary: false } }), 'text'],
        ['named driver without verdict', { set: 'drv' }, drivers({ drv: {} }), undefined],
        [
          'named driver without verdict beside a default verdict',
          { set: 'drv' },
          drivers({ drv: {}, default: { binary: true } }),
          undefined,
        ],
        [
          'unknown name falls to default',
          { set: 'ghost' },
          drivers({ default: { binary: true } }),
          'binary',
        ],
        [
          'builtin name is a driver',
          { set: 'cpp' },
          drivers({ default: { binary: true } }),
          undefined,
        ],
        ['config over builtin', { set: 'cpp' }, drivers({ cpp: { binary: true } }), 'binary'],
        [
          'names are case-sensitive',
          { set: 'CPP' },
          drivers({ default: { binary: true } }),
          'binary',
        ],
      ];

      it.each(rows)('Then %s gives the expected verdict', (_label, value, configured, expected) => {
        // Arrange
        const sut = userdiffBinaryOverride;

        // Act
        const result = sut(value, configured);

        // Assert
        expect(result).toBe(expected);
      });
    });

    describe('When the name is a builtin driver', () => {
      it.each(BUILTIN_NAMES)('Then %s is not resolved to the default driver', (name) => {
        // Arrange
        const sut = userdiffBinaryOverride;

        // Act
        const result = sut({ set: name }, drivers({ default: { binary: true } }));

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});
