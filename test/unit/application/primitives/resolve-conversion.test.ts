import { describe, expect, it, vi } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { invalidateConfigCache } from '../../../../src/application/primitives/config-read.js';
import type { AttributeProvider } from '../../../../src/application/primitives/internal/read-gitattributes.js';
import {
  type Conversion,
  convertsInCore,
  IDENTITY_CONVERSION,
  isIdentityConversion,
  readEolSettings,
  resolveConversion,
} from '../../../../src/application/primitives/resolve-conversion.js';
import { buildMacroRegistry } from '../../../../src/domain/attributes/macros.js';
import { parseGitattributes } from '../../../../src/domain/attributes/parse-gitattributes.js';
import type { EolSettings } from '../../../../src/domain/eol/crlf-action.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../src/ports/context.js';

const writeConfig = (ctx: Context, config: string) =>
  ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);

const SETTINGS: EolSettings = { autoCrlf: false, safeCrlf: 'warn', nativeEol: 'lf' };

const providerFor = (text: string) => {
  const parsed = parseGitattributes(text);
  const sources = parsed.rules.length === 0 ? [] : [{ basedir: '', rules: parsed.rules }];
  const sourcesForPath = vi.fn<AttributeProvider['sourcesForPath']>(async () => ({
    sources,
    macros: buildMacroRegistry(parsed.macros),
  }));
  return { sourcesForPath };
};

describe('readEolSettings', () => {
  describe('Given repository config without core keys', () => {
    describe('When reading the eol settings', () => {
      it('Then the defaults apply and coreEol is absent', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const sut = readEolSettings;
        const settings = await sut(ctx);

        // Assert
        expect(settings).toEqual({ autoCrlf: false, safeCrlf: 'warn', nativeEol: 'lf' });
        expect('coreEol' in settings).toBe(false);
      });
    });
  });

  describe('Given ctx.nativeEol crlf and core.eol native', () => {
    describe('When reading the eol settings', () => {
      it('Then nativeEol is crlf and coreEol is native', async () => {
        // Arrange
        const base = createMemoryContext();
        const ctx: Context = { ...base, nativeEol: 'crlf' };
        await writeConfig(ctx, '[core]\n\teol = native\n');

        // Act
        const sut = readEolSettings;
        const settings = await sut(ctx);

        // Assert
        expect(settings).toEqual({
          autoCrlf: false,
          coreEol: 'native',
          safeCrlf: 'warn',
          nativeEol: 'crlf',
        });
      });
    });
  });

  describe('Given core.autocrlf input and core.safecrlf false', () => {
    describe('When reading the eol settings', () => {
      it('Then both values are carried', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeConfig(ctx, '[core]\n\tautocrlf = input\n\tsafecrlf = false\n');

        // Act
        const sut = readEolSettings;
        const settings = await sut(ctx);

        // Assert
        expect(settings.autoCrlf).toBe('input');
        expect(settings.safeCrlf).toBe(false);
      });
    });
  });
});

describe('readEolSettings memoisation', () => {
  describe('Given an unchanged repository config', () => {
    describe('When reading the eol settings twice', () => {
      it('Then the same settings object comes back', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeConfig(ctx, '[core]\n\tautocrlf = true\n');
        const sut = readEolSettings;

        // Act
        const first = await sut(ctx);
        const second = await sut(ctx);

        // Assert
        expect(second).toBe(first);
      });
    });
  });

  describe('Given the config cache is invalidated between two reads', () => {
    describe('When reading the eol settings', () => {
      it('Then a fresh settings object reflects the new config', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeConfig(ctx, '[core]\n\tautocrlf = true\n');
        const sut = readEolSettings;
        const first = await sut(ctx);
        await writeConfig(ctx, '[core]\n\tautocrlf = input\n');
        invalidateConfigCache(ctx);

        // Act
        const second = await sut(ctx);

        // Assert
        expect(second).not.toBe(first);
        expect(second.autoCrlf).toBe('input');
      });
    });
  });

  describe('Given two contexts of one session with different native line endings', () => {
    describe('When each reads the eol settings', () => {
      it('Then each sees its own nativeEol', async () => {
        // Arrange
        const lf = createMemoryContext();
        const crlf: Context = { ...lf, nativeEol: 'crlf' };
        const sut = readEolSettings;

        // Act
        const first = await sut(lf);
        const second = await sut(crlf);

        // Assert
        expect([first.nativeEol, second.nativeEol]).toEqual(['lf', 'crlf']);
      });
    });
  });
});

describe('resolveConversion', () => {
  describe('Given a provider whose sources are empty and autocrlf false', () => {
    describe('When resolving the conversion', () => {
      it('Then the result is the IDENTITY_CONVERSION constant', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const provider = providerFor('');

        // Act
        const result = await resolveConversion(ctx, provider, 'a.txt' as FilePath, SETTINGS);

        // Assert
        expect(result).toBe(IDENTITY_CONVERSION);
      });
    });
  });

  describe('Given empty sources and autocrlf true', () => {
    describe('When resolving the conversion', () => {
      it('Then crlf is auto-crlf', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const provider = providerFor('');

        // Act
        const result = await resolveConversion(ctx, provider, 'a.txt' as FilePath, {
          ...SETTINGS,
          autoCrlf: true,
        });

        // Assert
        expect(result).toEqual({ filter: { kind: 'identity' }, crlf: 'auto-crlf', ident: false });
      });
    });
  });

  describe('Given * text eol=crlf ident filter=t with [filter "t"] clean configured', () => {
    describe('When resolving the conversion', () => {
      it('Then filter, crlf and ident come from one attribute lookup', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeConfig(ctx, '[filter "t"]\n\tclean = x\n');
        const provider = providerFor('* text eol=crlf ident filter=t\n');

        // Act
        const result = await resolveConversion(ctx, provider, 'a.txt' as FilePath, SETTINGS);

        // Assert
        expect(result).toEqual({
          filter: { kind: 'external', name: 't', clean: 'x', required: false },
          crlf: 'text-crlf',
          ident: true,
        });
        expect(provider.sourcesForPath).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given * binary text', () => {
    describe('When resolving the conversion', () => {
      it('Then the later text wins over the macro expansion', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const provider = providerFor('* binary text\n');

        // Act
        const result = await resolveConversion(ctx, provider, 'a.txt' as FilePath, SETTINGS);

        // Assert
        expect(result.crlf).toBe('text-input');
      });
    });
  });

  describe('Given * -text eol=crlf', () => {
    describe('When resolving the conversion', () => {
      it('Then crlf is binary', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const provider = providerFor('* -text eol=crlf\n');

        // Act
        const result = await resolveConversion(ctx, provider, 'a.txt' as FilePath, SETTINGS);

        // Assert
        expect(result.crlf).toBe('binary');
      });
    });
  });

  describe('Given * crlf=input with no text attribute', () => {
    describe('When resolving the conversion', () => {
      it('Then the legacy crlf attribute declares text-input', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const provider = providerFor('* crlf=input\n');

        // Act
        const result = await resolveConversion(ctx, provider, 'a.txt' as FilePath, SETTINGS);

        // Assert
        expect(result.crlf).toBe('text-input');
      });
    });
  });

  describe('Given * -crlf under core.autocrlf true', () => {
    describe('When resolving the conversion', () => {
      it('Then the legacy crlf attribute declares binary', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const provider = providerFor('* -crlf\n');

        // Act
        const result = await resolveConversion(ctx, provider, 'a.txt' as FilePath, {
          ...SETTINGS,
          autoCrlf: true,
        });

        // Assert
        expect(result.crlf).toBe('binary');
      });
    });
  });

  describe('Given * ident=false-ish values', () => {
    describe('When ident is unset or set to a string', () => {
      it.each([{ attrs: '* -ident\n' }, { attrs: '* ident=yes\n' }, { attrs: '* text\n' }])(
        'Then ident is not engaged for $attrs',
        async ({ attrs }) => {
          // Arrange
          const ctx = createMemoryContext();
          const provider = providerFor(attrs);

          // Act
          const result = await resolveConversion(ctx, provider, 'a.txt' as FilePath, SETTINGS);

          // Assert
          expect(result.ident).toBe(false);
        },
      );
    });
  });

  describe('Given eagerSectionValidation and a malformed unrelated driver', () => {
    describe('When resolving with empty sources', () => {
      it.each([
        { eager: true, refuses: true },
        { eager: false, refuses: false },
      ])('Then refusal is $refuses for eager=$eager', async ({ eager, refuses }) => {
        // Arrange
        const ctx = createMemoryContext();
        await writeConfig(ctx, '[filter "u"]\n\trequired = maybe\n');
        const provider = providerFor('');

        // Act
        const attempt = resolveConversion(ctx, provider, 'a.txt' as FilePath, SETTINGS, {
          eagerSectionValidation: eager,
        });

        // Assert
        if (refuses) await expect(attempt).rejects.toBeInstanceOf(TsgitError);
        else await expect(attempt).resolves.toBe(IDENTITY_CONVERSION);
        expect(provider.sourcesForPath).toHaveBeenCalledTimes(refuses ? 0 : 1);
      });
    });
  });

  describe('Given filterDriversConfigured false and a malformed driver the path names', () => {
    describe('When resolving with eagerSectionValidation', () => {
      it('Then it returns the identity filter and does not refuse', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeConfig(ctx, '[filter "x"]\n\trequired = bogus\n');
        const provider = providerFor('a.txt filter=x\n');

        // Act
        const sut = await resolveConversion(ctx, provider, 'a.txt' as FilePath, SETTINGS, {
          eagerSectionValidation: true,
          filterDriversConfigured: false,
        });

        // Assert
        expect(sut.filter).toEqual({ kind: 'identity' });
      });
    });
  });
});

const conversion = (overrides: Partial<Conversion>): Conversion => ({
  ...IDENTITY_CONVERSION,
  ...overrides,
});

const driver = (commands: object) =>
  ({ kind: 'external', name: 'd', required: false, ...commands }) as const;

describe('convertsInCore', () => {
  describe('Given a conversion', () => {
    describe('When asking whether it converts in core', () => {
      it.each([
        { label: 'crlf auto', value: conversion({ crlf: 'auto' }), expected: true },
        { label: 'crlf auto-crlf', value: conversion({ crlf: 'auto-crlf' }), expected: true },
        { label: 'crlf auto-input', value: conversion({ crlf: 'auto-input' }), expected: false },
        { label: 'crlf text-crlf', value: conversion({ crlf: 'text-crlf' }), expected: false },
        { label: 'ident only', value: conversion({ ident: true }), expected: false },
        {
          label: 'driver with smudge',
          value: conversion({ filter: driver({ smudge: 's' }) }),
          expected: true,
        },
        { label: 'identity', value: IDENTITY_CONVERSION, expected: false },
      ])('Then $label is $expected', ({ value, expected }) => {
        // Arrange
        const sut = convertsInCore;

        // Act
        const result = sut(value);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('isIdentityConversion', () => {
  describe('Given a conversion', () => {
    describe('When asking whether it is the identity', () => {
      it.each([
        { label: 'the identity constant', value: IDENTITY_CONVERSION, expected: true },
        {
          label: 'a fresh identity-shaped value',
          value: { ...IDENTITY_CONVERSION },
          expected: true,
        },
        { label: 'a crlf action', value: conversion({ crlf: 'text-input' }), expected: false },
        { label: 'ident', value: conversion({ ident: true }), expected: false },
        {
          label: 'an external driver',
          value: conversion({ filter: driver({ clean: 'c' }) }),
          expected: false,
        },
      ])('Then $label is $expected', ({ value, expected }) => {
        // Arrange
        const sut = isIdentityConversion;

        // Act
        const result = sut(value);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
