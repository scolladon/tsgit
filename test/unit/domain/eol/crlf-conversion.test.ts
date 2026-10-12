import { describe, expect, it, vi } from 'vitest';

import type { CrlfAction, EolSettings } from '../../../../src/domain/eol/crlf-action.js';
import { crlfToGit, crlfToWorkingTree } from '../../../../src/domain/eol/crlf-conversion.js';

const bytes = (...parts: ReadonlyArray<string | number>): Uint8Array =>
  Uint8Array.from(
    parts.flatMap((part) =>
      typeof part === 'number' ? [part] : [...part].map((c) => c.charCodeAt(0)),
    ),
  );

const settings = (overrides: Partial<EolSettings> = {}): EolSettings => ({
  autoCrlf: false,
  safeCrlf: 'warn',
  nativeEol: 'lf',
  ...overrides,
});

const FIXTURES = {
  lf: bytes('a\nb\n'),
  crlf: bytes('a\r\nb\r\n'),
  mixed: bytes('a\r\nb\n'),
  nul: bytes('a', 0, '\r\nb\r\n'),
  loneCr: bytes('a\rb\r\n'),
} as const;

type FixtureName = keyof typeof FIXTURES;

const toLf = (name: FixtureName): Uint8Array => {
  const expected: Record<FixtureName, Uint8Array> = {
    lf: FIXTURES.lf,
    crlf: bytes('a\nb\n'),
    mixed: bytes('a\nb\n'),
    nul: bytes('a', 0, '\nb\n'),
    loneCr: bytes('a\rb\n'),
  };
  return expected[name];
};

const noIndexCrlf = (): Promise<boolean> => Promise.resolve(false);

const run = (
  input: Uint8Array,
  action: CrlfAction,
  overrides: { renormalize?: boolean; indexHasCrlf?: () => Promise<boolean> } = {},
) =>
  crlfToGit({
    bytes: input,
    action,
    settings: settings(),
    renormalize: overrides.renormalize ?? false,
    indexHasCrlf: overrides.indexHasCrlf ?? noIndexCrlf,
  });

describe('crlfToGit blob bytes', () => {
  const CASES_1: ReadonlyArray<[CrlfAction, ReadonlyArray<FixtureName>]> = [
    ['text-input', ['crlf', 'mixed', 'nul', 'loneCr']],
    ['text-crlf', ['crlf', 'mixed', 'nul', 'loneCr']],
    ['auto', ['crlf', 'mixed']],
    ['auto-input', ['crlf', 'mixed']],
    ['auto-crlf', ['crlf', 'mixed']],
    ['binary', []],
  ];

  describe.each(CASES_1)('Given the add fixtures and action %s', (action, converted) => {
    describe.each(Object.keys(FIXTURES) as ReadonlyArray<FixtureName>)(
      'When fixture %s is added',
      (name) => {
        const isConverted = converted.includes(name);
        it(`Then the blob ${isConverted ? 'has CRLF reduced to LF' : 'equals the working tree bytes'}`, async () => {
          // Arrange
          const input = FIXTURES[name];

          // Act
          const result = await run(input, action);

          // Assert
          expect(result.bytes).toEqual(isConverted ? toLf(name) : input);
          if (!isConverted) expect(result.bytes).toBe(input);
        });
      },
    );
  });

  const CASES_2: ReadonlyArray<[string, CrlfAction, string, string]> = [
    ['trailing lone CR', 'text-input', 'a\r', 'a\r'],
    ['CRLF without final newline', 'text-input', 'a\r\nb', 'a\nb'],
    ['CRLF without final newline', 'auto-input', 'a\r\nb', 'a\nb'],
    ['trailing lone CR after CRLF', 'text-input', 'a\r\nb\r', 'a\nb\r'],
    ['lone CR dropped by nothing', 'text-input', 'a\r\r\nb', 'a\r\nb'],
  ];

  describe.each(CASES_2)('Given the %s edge under %s', (_name, action, source, expected) => {
    describe('When added', () => {
      it('Then the blob follows the pinned bytes', async () => {
        // Arrange
        const input = bytes(source);

        // Act
        const result = await run(input, action);

        // Assert
        expect(result.bytes).toEqual(bytes(expected));
      });
    });
  });

  describe('Given empty bytes', () => {
    describe('When added under text-input', () => {
      it('Then the same reference is returned without a loss', async () => {
        // Arrange
        const input = new Uint8Array(0);

        // Act
        const result = await run(input, 'text-input');

        // Assert
        expect(result.bytes).toBe(input);
        expect(result.roundTrip).toBeUndefined();
      });
    });
  });

  describe('Given the same CRLF input', () => {
    describe('When converted', () => {
      it('Then the result is a freshly allocated exact-size array', async () => {
        // Arrange
        const input = bytes('xa\r\nb\r\n').subarray(1);

        // Act
        const result = await run(input, 'text-input');

        // Assert
        expect(result.bytes.byteOffset).toBe(0);
        expect(result.bytes.buffer.byteLength).toBe(result.bytes.length);
      });
    });
  });
});

describe('crlfToGit index CRLF rule', () => {
  describe('Given an auto action and CRLF content', () => {
    describe('When the index blob already has CRLF', () => {
      it('Then the CRLF is kept', async () => {
        // Arrange
        const indexHasCrlf = vi.fn(() => Promise.resolve(true));

        // Act
        const result = await run(FIXTURES.crlf, 'auto-input', { indexHasCrlf });

        // Assert
        expect(result.bytes).toEqual(FIXTURES.crlf);
        expect(indexHasCrlf).toHaveBeenCalledTimes(1);
      });
    });

    describe('When renormalizing', () => {
      it('Then the thunk is never consulted and CRLF is converted', async () => {
        // Arrange
        const indexHasCrlf = vi.fn(() => Promise.resolve(true));

        // Act
        const result = await run(FIXTURES.crlf, 'auto-input', { renormalize: true, indexHasCrlf });

        // Assert
        expect(result.bytes).toEqual(toLf('crlf'));
        expect(indexHasCrlf).toHaveBeenCalledTimes(0);
      });
    });
  });

  describe('Given an auto action and content without CRLF', () => {
    describe('When added', () => {
      it('Then the thunk is never consulted', async () => {
        // Arrange
        const indexHasCrlf = vi.fn(() => Promise.resolve(true));

        // Act
        await run(FIXTURES.lf, 'auto-input', { indexHasCrlf });

        // Assert
        expect(indexHasCrlf).toHaveBeenCalledTimes(0);
      });
    });
  });

  describe('Given a text action and CRLF content', () => {
    describe('When the index blob has CRLF', () => {
      it('Then the thunk is ignored and CRLF is converted', async () => {
        // Arrange
        const indexHasCrlf = vi.fn(() => Promise.resolve(true));

        // Act
        const result = await run(FIXTURES.crlf, 'text-input', { indexHasCrlf });

        // Assert
        expect(result.bytes).toEqual(toLf('crlf'));
        expect(indexHasCrlf).toHaveBeenCalledTimes(0);
      });
    });
  });

  describe('Given a binary-classed auto input with CRLF', () => {
    describe('When added', () => {
      it('Then it is returned unchanged before the thunk is consulted', async () => {
        // Arrange
        const indexHasCrlf = vi.fn(() => Promise.resolve(false));

        // Act
        const result = await run(FIXTURES.nul, 'auto-input', { indexHasCrlf });

        // Assert
        expect(result.bytes).toBe(FIXTURES.nul);
        expect(result.roundTrip).toBeUndefined();
        expect(indexHasCrlf).toHaveBeenCalledTimes(0);
      });
    });
  });
});

describe('crlfToGit round trip loss', () => {
  const CASES_3: ReadonlyArray<[string, Uint8Array, CrlfAction, unknown]> = [
    ['MIXED', FIXTURES.mixed, 'auto-crlf', { loss: 'lf-to-crlf', crlf: 1, loneLf: 1 }],
    ['LF', FIXTURES.lf, 'auto-crlf', { loss: 'lf-to-crlf', crlf: 0, loneLf: 2 }],
    ['CRLF', FIXTURES.crlf, 'auto-input', { loss: 'crlf-to-lf', crlf: 2, loneLf: 0 }],
    ['CRLF', FIXTURES.crlf, 'text-input', { loss: 'crlf-to-lf', crlf: 2, loneLf: 0 }],
  ];

  describe.each(CASES_3)('Given %s under %s', (_name, input, action, expected) => {
    describe('When added', () => {
      it('Then the loss carries the original stats counts', async () => {
        // Arrange
        const sut = crlfToGit;
        const eolSettings = settings({ autoCrlf: action === 'auto-crlf' ? true : 'input' });

        // Act
        const result = await sut({
          bytes: input,
          action,
          settings: eolSettings,
          renormalize: false,
          indexHasCrlf: noIndexCrlf,
        });

        // Assert
        expect(result.roundTrip).toEqual(expected);
      });
    });
  });

  const CASES_4: ReadonlyArray<[string, Uint8Array, CrlfAction]> = [
    ['LF', FIXTURES.lf, 'text-input'],
    ['CRLF', FIXTURES.crlf, 'text-crlf'],
    ['binary NUL under auto-crlf', FIXTURES.nul, 'auto-crlf'],
    ['CRLF under binary', FIXTURES.crlf, 'binary'],
  ];

  describe.each(CASES_4)('Given %s under %s', (_name, input, action) => {
    describe('When added with crlf output settings', () => {
      it('Then no loss is reported', async () => {
        // Arrange
        const sut = crlfToGit;
        const eolSettings = settings({ autoCrlf: true });

        // Act
        const result = await sut({
          bytes: input,
          action,
          settings: eolSettings,
          renormalize: false,
          indexHasCrlf: noIndexCrlf,
        });

        // Assert
        expect(result.roundTrip).toBeUndefined();
      });
    });
  });

  describe('Given CRLF content kept by the index rule under auto-input', () => {
    describe('When added', () => {
      it('Then the kept CRLF is reported as no loss', async () => {
        // Arrange
        const indexHasCrlf = (): Promise<boolean> => Promise.resolve(true);

        // Act
        const result = await run(FIXTURES.crlf, 'auto-input', { indexHasCrlf });

        // Assert
        expect(result.bytes).toBe(FIXTURES.crlf);
        expect(result.roundTrip).toBeUndefined();
      });
    });
  });
});

const checkoutBlobs = {
  lf: bytes('a\nb\n'),
  crlf: bytes('a\r\nb\r\n'),
  mixed: bytes('a\r\nb\n'),
  nul: bytes('a', 0, '\r\nb\r\n'),
  loneCr: bytes('a\rb\r\n'),
  nulLf: bytes('a', 0, '\nb\n'),
  loneCrLf: bytes('a\rb\n'),
  trailCr: bytes('a\r'),
  noEol: bytes('a\nb'),
} as const;

type BlobName = keyof typeof checkoutBlobs;

describe('crlfToWorkingTree', () => {
  const CASES_5: ReadonlyArray<
    [CrlfAction, ReadonlyArray<[BlobName, string]>, ReadonlyArray<BlobName>]
  > = [
    [
      'text-crlf',
      [
        ['lf', 'a\r\nb\r\n'],
        ['mixed', 'a\r\nb\r\n'],
        ['loneCrLf', 'a\rb\r\n'],
        ['nulLf', 'a\0\r\nb\r\n'],
        ['noEol', 'a\r\nb'],
      ],
      ['crlf', 'nul', 'loneCr', 'trailCr'],
    ],
    [
      'auto-crlf',
      [['lf', 'a\r\nb\r\n']],
      ['crlf', 'mixed', 'nul', 'loneCr', 'nulLf', 'loneCrLf', 'trailCr'],
    ],
    [
      'auto',
      [['lf', 'a\r\nb\r\n']],
      ['crlf', 'mixed', 'nul', 'loneCr', 'nulLf', 'loneCrLf', 'trailCr'],
    ],
  ];

  describe.each(CASES_5)(
    'Given crlf output settings and action %s',
    (action, converted, identity) => {
      const crlfSettings = settings({ autoCrlf: true, coreEol: 'crlf', nativeEol: 'crlf' });

      describe.each(converted)('When blob %s is checked out', (name, expected) => {
        it('Then every LF not preceded by CR becomes CRLF in a fresh exact-size array', () => {
          // Arrange
          const input = checkoutBlobs[name];

          // Act
          const result = crlfToWorkingTree(input, action, crlfSettings);

          // Assert
          expect(result).toEqual(bytes(expected));
          expect(result.byteOffset).toBe(0);
          expect(result.buffer.byteLength).toBe(result.length);
        });
      });

      describe.each(identity)('When blob %s is checked out', (name) => {
        it('Then the same reference is returned', () => {
          // Arrange
          const input = checkoutBlobs[name];

          // Act
          const result = crlfToWorkingTree(input, action, crlfSettings);

          // Assert
          expect(result).toBe(input);
        });
      });
    },
  );

  const CASES_6: ReadonlyArray<CrlfAction> = ['binary', 'text-input', 'auto-input'];

  describe.each(CASES_6)('Given action %s', (action) => {
    describe('When an LF blob is checked out', () => {
      it('Then the same reference is returned', () => {
        // Arrange
        const input = checkoutBlobs.lf;

        // Act
        const result = crlfToWorkingTree(input, action, settings({ autoCrlf: true }));

        // Assert
        expect(result).toBe(input);
      });
    });
  });

  describe('Given the auto action and an lf output setting', () => {
    describe('When an LF blob is checked out', () => {
      it('Then the same reference is returned', () => {
        // Arrange
        const input = checkoutBlobs.lf;

        // Act
        const result = crlfToWorkingTree(input, 'auto', settings({ coreEol: 'lf' }));

        // Assert
        expect(result).toBe(input);
      });
    });
  });

  describe('Given empty bytes under text-crlf', () => {
    describe('When checked out', () => {
      it('Then the same reference is returned', () => {
        // Arrange
        const input = new Uint8Array(0);

        // Act
        const result = crlfToWorkingTree(input, 'text-crlf', settings());

        // Assert
        expect(result).toBe(input);
      });
    });
  });
});
