import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  convertToGit,
  convertToWorkingTree,
  renormalizeBuffer,
  workingTreeStreamTransform,
} from '../../../../../src/application/primitives/internal/convert-blob.js';
import {
  type Conversion,
  IDENTITY_CONVERSION,
} from '../../../../../src/application/primitives/resolve-conversion.js';
import type { FilterChoice } from '../../../../../src/application/primitives/resolve-filter-driver.js';
import type { ChunkTransform } from '../../../../../src/domain/eol/chunk-transform.js';
import type { EolSettings } from '../../../../../src/domain/eol/crlf-action.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/object-id.js';
import type { CommandRunner } from '../../../../../src/ports/command-runner.js';
import { buildSeededContext, writeRawObjectBytes } from '../fixtures.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const PATH = 'a.txt' as FilePath;
const SETTINGS: EolSettings = { autoCrlf: false, safeCrlf: false, nativeEol: 'lf' };
const conversion = (crlf: Conversion['crlf'], ident = false): Conversion => ({
  ...IDENTITY_CONVERSION,
  crlf,
  ident,
});

describe('convertToGit', () => {
  describe('Given a text-input conversion and CRLF bytes', () => {
    describe('When converting on route write', () => {
      it('Then the bytes are LF', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = convertToGit;

        // Act
        const result = await sut(ctx, {
          path: PATH,
          bytes: enc('a\r\nb\r\n'),
          conversion: conversion('text-input'),
          route: 'write',
          settings: SETTINGS,
        });

        // Assert
        expect(dec(result.bytes)).toBe('a\nb\n');
        expect('notice' in result).toBe(false);
      });
    });
  });

  describe('Given an ident conversion and an expanded keyword', () => {
    describe('When converting on route write', () => {
      it('Then the keyword is collapsed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = convertToGit;

        // Act
        const result = await sut(ctx, {
          path: PATH,
          bytes: enc('$Id: abc $\n'),
          conversion: conversion('binary', true),
          route: 'write',
          settings: SETTINGS,
        });

        // Assert
        expect(dec(result.bytes)).toBe('$Id$\n');
      });
    });
  });

  describe('Given an identity conversion', () => {
    describe('When converting on route write', () => {
      it('Then the same reference comes back', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const bytes = enc('a\r\n');
        const sut = convertToGit;

        // Act
        const result = await sut(ctx, {
          path: PATH,
          bytes,
          conversion: IDENTITY_CONVERSION,
          route: 'write',
          settings: SETTINGS,
        });

        // Assert
        expect(result.bytes).toBe(bytes);
      });
    });
  });
});

const CRLF_TEXT = 'a\r\nb\r\n';
const withSafe = (safeCrlf: EolSettings['safeCrlf']): EolSettings => ({ ...SETTINGS, safeCrlf });
const lossy = (route: 'write' | 'compare' | 'renormalize', safeCrlf: EolSettings['safeCrlf']) =>
  convertToGit(createMemoryContext(), {
    path: PATH,
    bytes: enc(CRLF_TEXT),
    conversion: conversion('text-input'),
    route,
    settings: withSafe(safeCrlf),
  });

describe('convertToGit safecrlf', () => {
  describe('Given a lossy conversion and core.safecrlf=true', () => {
    describe('When converting on route write', () => {
      it('Then it refuses with the loss', async () => {
        // Arrange
        const sut = lossy;

        // Act
        let data: TsgitError['data'] | undefined;
        try {
          await sut('write', true);
        } catch (error) {
          data = (error as TsgitError).data;
        }

        // Assert
        expect(data).toMatchObject({
          code: 'EOL_ROUND_TRIP_UNSAFE',
          path: PATH,
          loss: 'crlf-to-lf',
          crlf: 2,
          loneLf: 0,
        });
      });
    });
  });

  describe('Given a lossy conversion and core.safecrlf=warn', () => {
    describe('When converting on route write', () => {
      it('Then the notice carries the loss and the bytes are converted', async () => {
        // Arrange
        const sut = lossy;

        // Act
        const result = await sut('write', 'warn');

        // Assert
        expect(result.notice).toEqual({ path: PATH, loss: 'crlf-to-lf', crlf: 2, loneLf: 0 });
        expect(dec(result.bytes)).toBe('a\nb\n');
      });
    });
  });

  describe('Given a lossy conversion and core.safecrlf=false', () => {
    describe('When converting on route write', () => {
      it('Then no notice is produced', async () => {
        // Arrange
        const sut = lossy;

        // Act
        const result = await sut('write', false);

        // Assert
        expect('notice' in result).toBe(false);
      });
    });
  });

  describe.each(['compare', 'renormalize'] as const)('Given route %s', (route) => {
    describe.each([true, 'warn'] as const)('When core.safecrlf=%s', (safeCrlf) => {
      it('Then it neither throws nor notices', async () => {
        // Arrange
        const sut = lossy;

        // Act
        const result = await sut(route, safeCrlf);

        // Assert
        expect('notice' in result).toBe(false);
        expect(dec(result.bytes)).toBe('a\nb\n');
      });
    });
  });
});

describe('convertToGit index rule', () => {
  const convertAuto = async (
    route: 'write' | 'renormalize',
    indexContent: string | undefined,
  ): Promise<string> => {
    const ctx = await buildSeededContext();
    const indexBlob: ObjectId | undefined =
      indexContent === undefined
        ? undefined
        : await writeRawObjectBytes(ctx, 'blob', enc(indexContent));
    const result = await convertToGit(ctx, {
      path: PATH,
      bytes: enc(CRLF_TEXT),
      conversion: conversion('auto'),
      route,
      settings: SETTINGS,
      ...(indexBlob !== undefined && { indexBlob }),
    });
    return dec(result.bytes);
  };

  describe('Given auto and a stored text blob holding CRLF', () => {
    describe('When converting on route write', () => {
      it('Then the CRLF is kept', async () => {
        // Arrange
        const sut = convertAuto;

        // Act
        const result = await sut('write', 'x\r\ny\n');

        // Assert
        expect(result).toBe(CRLF_TEXT);
      });
    });

    describe('When converting on route renormalize', () => {
      it('Then the CRLF is converted', async () => {
        // Arrange
        const sut = convertAuto;

        // Act
        const result = await sut('renormalize', 'x\r\ny\n');

        // Assert
        expect(result).toBe('a\nb\n');
      });
    });
  });

  describe('Given auto and a stored blob without CRLF', () => {
    describe('When converting on route write', () => {
      it('Then the CRLF is converted', async () => {
        // Arrange
        const sut = convertAuto;

        // Act
        const result = await sut('write', 'x\ny\n');

        // Assert
        expect(result).toBe('a\nb\n');
      });
    });
  });

  describe('Given auto and a stored binary blob holding CRLF', () => {
    describe('When converting on route write', () => {
      it('Then the CRLF is converted', async () => {
        // Arrange
        const sut = convertAuto;

        // Act
        const result = await sut('write', 'x\0\r\ny\n');

        // Assert
        expect(result).toBe('a\nb\n');
      });
    });
  });

  describe('Given auto and no stored blob', () => {
    describe('When converting on route write', () => {
      it('Then the CRLF is converted', async () => {
        // Arrange
        const sut = convertAuto;

        // Act
        const result = await sut('write', undefined);

        // Assert
        expect(result).toBe('a\nb\n');
      });
    });
  });
});

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array =>
  Uint8Array.from(parts.flatMap((part) => [...part]));

const recordingRunner = () => {
  const smudgeInputs: Uint8Array[] = [];
  const runner: CommandRunner = {
    run: async ({ command, stdin }) => {
      const input = stdin ?? new Uint8Array(0);
      if (command === 'clean') {
        return { exitCode: 0, stdout: concat(enc('Z\r\n$Id: q $\r\n'), input) };
      }
      smudgeInputs.push(input);
      return { exitCode: 0, stdout: input };
    },
    spawn: () => {
      throw new Error('spawn is not scripted');
    },
  };
  return { runner, smudgeInputs };
};

const driver = (fields: Partial<Extract<FilterChoice, { kind: 'external' }>>): FilterChoice => ({
  kind: 'external',
  name: 'd',
  required: false,
  ...fields,
});
const BLOB = '1f9175cd3f40aaaab30f6537f3cd516f273bad9f' as ObjectId;
const CRLF_SETTINGS: EolSettings = { ...SETTINGS, autoCrlf: true };

describe('order of operations', () => {
  describe('Given clean, CRLF and ident steps over a worktree file', () => {
    describe('When converting to git then back to the working tree', () => {
      it('Then the blob and the smudge input follow git order', async () => {
        // Arrange
        const { runner, smudgeInputs } = recordingRunner();
        const ctx = createMemoryContext({ command: runner });
        const steps: Conversion = {
          filter: driver({ clean: 'clean', smudge: 'smudge' }),
          crlf: 'text-crlf',
          ident: true,
        };

        // Act
        const toGit = await convertToGit(ctx, {
          path: PATH,
          bytes: enc('aR\r\nb\r\n'),
          conversion: steps,
          route: 'write',
          settings: CRLF_SETTINGS,
        });
        const sut = convertToWorkingTree;
        const result = await sut(ctx, {
          target: { path: PATH, blob: BLOB, bytes: toGit.bytes },
          conversion: steps,
          settings: CRLF_SETTINGS,
        });

        // Assert
        expect(dec(toGit.bytes)).toBe('Z\n$Id$\naR\nb\n');
        expect(dec(smudgeInputs[0] as Uint8Array)).toBe(`Z\r\n$Id: ${BLOB} $\r\naR\r\nb\r\n`);
        expect(dec(result)).toBe(dec(smudgeInputs[0] as Uint8Array));
      });
    });
  });
});

describe('convertToWorkingTree normalizing', () => {
  const run = async (filter: FilterChoice, normalizing: boolean): Promise<string> => {
    const ctx = createMemoryContext();
    const result = await convertToWorkingTree(ctx, {
      target: { path: PATH, blob: BLOB, bytes: enc('a\n') },
      conversion: { filter, crlf: 'text-crlf', ident: false },
      settings: CRLF_SETTINGS,
      normalizing,
    });
    return dec(result);
  };

  describe.each([
    ['an identity filter', { kind: 'identity' } as FilterChoice, 'a\n'],
    ['a clean-only driver', driver({ clean: 'clean' }), 'a\n'],
    ['a smudge driver', driver({ smudge: 'smudge' }), 'a\r\n'],
    ['a process driver', driver({ process: 'smudge' }), 'a\r\n'],
  ])('Given %s', (_name, filter, expected) => {
    describe('When normalizing', () => {
      it('Then CRLF is applied only when a smudge or process driver is named', async () => {
        // Arrange
        const sut = run;

        // Act
        const result = await sut(filter, true);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given an identity filter and a CRLF action', () => {
    describe('When not normalizing', () => {
      it('Then CRLF is applied', async () => {
        // Arrange
        const sut = run;

        // Act
        const result = await sut({ kind: 'identity' }, false);

        // Assert
        expect(result).toBe('a\r\n');
      });
    });
  });
});

const streamed = (transform: ChunkTransform, input: string): string =>
  dec(concat(...transform.push(enc(input)), ...transform.flush()));

const DIVERGENCE_BLOB = '$$Id$\n$Id:a b$\n$Id: a\tb $\n$Id$Id$\n';

describe('workingTreeStreamTransform', () => {
  describe.each([
    ['an identity conversion', IDENTITY_CONVERSION],
    ['an auto-crlf action', conversion('auto-crlf')],
    ['an auto action', conversion('auto')],
    ['a smudge driver', { ...conversion('text-crlf'), filter: driver({ smudge: 's' }) }],
    ['a clean-only driver', { ...conversion('text-crlf'), filter: driver({ clean: 'c' }) }],
    ['a text-input action without ident', conversion('text-input')],
  ])('Given %s', (_name, given) => {
    describe('When asking for the transform', () => {
      it('Then there is none', () => {
        // Arrange
        const sut = workingTreeStreamTransform;

        // Act
        const result = sut(given, BLOB, CRLF_SETTINGS);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given text-crlf with ident over the divergence blob', () => {
    describe('When streaming it', () => {
      it('Then the streamed expander runs before the LF to CRLF expansion', () => {
        // Arrange
        const sut = workingTreeStreamTransform(conversion('text-crlf', true), BLOB, SETTINGS);

        // Act
        const result = streamed(sut as ChunkTransform, DIVERGENCE_BLOB);

        // Assert
        expect(result).toBe(`$$Id$\r\n$Id: ${BLOB} $\r\n$Id: a\tb $\r\n$Id: ${BLOB} $Id$\r\n`);
      });
    });
  });

  describe('Given text-crlf with ident over a blob ending in a partial keyword', () => {
    describe('When streaming it', () => {
      it('Then the flushed partial keyword still passes through the LF to CRLF step', () => {
        // Arrange
        const sut = workingTreeStreamTransform(conversion('text-crlf', true), BLOB, SETTINGS);

        // Act
        const result = streamed(sut as ChunkTransform, 'a\n$Id');

        // Assert
        expect(result).toBe('a\r\n$Id');
      });
    });
  });

  describe('Given auto-input with ident over the divergence blob', () => {
    describe('When streaming it', () => {
      it('Then only the ident expansion applies', () => {
        // Arrange
        const sut = workingTreeStreamTransform(conversion('auto-input', true), BLOB, SETTINGS);

        // Act
        const result = streamed(sut as ChunkTransform, DIVERGENCE_BLOB);

        // Assert
        expect(result).toBe(`$$Id$\n$Id: ${BLOB} $\n$Id: a\tb $\n$Id: ${BLOB} $Id$\n`);
      });
    });
  });

  describe('Given text-crlf without ident', () => {
    describe('When streaming a chunk split inside a CRLF', () => {
      it('Then only lone LFs gain a CR', () => {
        // Arrange
        const sut = workingTreeStreamTransform(conversion('text-crlf'), BLOB, SETTINGS);
        const transform = sut as ChunkTransform;

        // Act
        const result = dec(
          concat(
            ...transform.push(enc('a\r')),
            ...transform.push(enc('\nb\n')),
            ...transform.flush(),
          ),
        );

        // Assert
        expect(result).toBe('a\r\nb\r\n');
      });
    });
  });
});

describe('renormalizeBuffer', () => {
  describe('Given a CRLF blob under text=auto', () => {
    describe('When renormalizing', () => {
      it('Then the bytes are LF', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = renormalizeBuffer;

        // Act
        const result = await sut(ctx, PATH, enc('a\r\nb\r\n'), conversion('auto'), SETTINGS);

        // Assert
        expect(dec(result)).toBe('a\nb\n');
      });
    });
  });

  describe('Given an identity conversion', () => {
    describe('When renormalizing', () => {
      it('Then the same reference comes back', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const bytes = enc('a\r\n');
        const sut = renormalizeBuffer;

        // Act
        const result = await sut(ctx, PATH, bytes, IDENTITY_CONVERSION, SETTINGS);

        // Assert
        expect(result).toBe(bytes);
      });
    });
  });

  describe('Given an ident conversion and a smudge driver', () => {
    describe('When renormalizing', () => {
      it('Then the smudge sees the keyword expanded with the hash of the bytes', async () => {
        // Arrange
        const { runner, smudgeInputs } = recordingRunner();
        const ctx = createMemoryContext({ command: runner });
        const hash = await ctx.hash.hashHex(enc('blob 5\0$Id$\n'));
        const given: Conversion = {
          filter: driver({ smudge: 'smudge' }),
          crlf: 'binary',
          ident: true,
        };
        const sut = renormalizeBuffer;

        // Act
        const result = await sut(ctx, PATH, enc('$Id$\n'), given, SETTINGS);

        // Assert
        expect(dec(smudgeInputs[0] as Uint8Array)).toBe(`$Id: ${hash} $\n`);
        expect(dec(result)).toBe('$Id$\n');
      });
    });
  });
});

describe('convertToWorkingTree identity', () => {
  describe('Given an identity conversion', () => {
    describe('When converting', () => {
      it('Then the same reference comes back', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const bytes = enc('a\n');
        const sut = convertToWorkingTree;

        // Act
        const result = await sut(ctx, {
          target: { path: PATH, blob: BLOB, bytes },
          conversion: IDENTITY_CONVERSION,
          settings: CRLF_SETTINGS,
        });

        // Assert
        expect(result).toBe(bytes);
      });
    });
  });
});
