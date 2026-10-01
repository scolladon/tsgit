import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type {
  LoadFnOutput,
  LoadHookContext,
  ResolveFnOutput,
  ResolveHookContext,
} from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { loadTranspiledTypeScript, resolveTypeScriptSibling } from '../../typescript-hooks.mjs';

const TS_PARENT = 'file:///repo/test/bench/diff.bench.ts';
const RESOLVED: ResolveFnOutput = { url: 'file:///repo/src/index.node.ts' };
const LOADED: LoadFnOutput = { format: 'module', source: 'delegated' };

const resolveContext = (parentURL: string | undefined): ResolveHookContext => ({
  conditions: ['node', 'import'],
  importAttributes: {},
  parentURL,
});

const LOAD_CONTEXT: LoadHookContext = {
  conditions: ['node', 'import'],
  format: undefined,
  importAttributes: {},
};

const failure = (code: string): Error =>
  Object.assign(new Error(`resolution failed: ${code}`), { code });

/** A `nextResolve` that fails the first call with `error`, then resolves. */
const failingOnce = (error: Error) =>
  vi
    .fn<(specifier: string, context?: Partial<ResolveHookContext>) => ResolveFnOutput>()
    .mockImplementationOnce(() => {
      throw error;
    })
    .mockReturnValue(RESOLVED);

const thrownBy = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('resolveTypeScriptSibling', () => {
  describe('Given the specifier resolves as written, When it is resolved', () => {
    it('Then the default resolution is returned untouched', () => {
      // Arrange
      const sut = resolveTypeScriptSibling;
      const context = resolveContext(TS_PARENT);
      const nextResolve = vi.fn().mockReturnValue(RESOLVED);

      // Act
      const result = sut('./support/bench-dsl.js', context, nextResolve);

      // Assert
      expect(result).toBe(RESOLVED);
      expect(nextResolve).toHaveBeenCalledExactlyOnceWith('./support/bench-dsl.js', context);
    });
  });

  describe('Given a TypeScript parent imports a missing sibling-relative .js file', () => {
    describe('When it is resolved', () => {
      it('Then the .ts sibling is resolved instead', () => {
        // Arrange
        const sut = resolveTypeScriptSibling;
        const context = resolveContext(TS_PARENT);
        const nextResolve = failingOnce(failure('ERR_MODULE_NOT_FOUND'));

        // Act
        const result = sut('./support/bench-dsl.js', context, nextResolve);

        // Assert
        expect(result).toBe(RESOLVED);
        expect(nextResolve).toHaveBeenLastCalledWith('./support/bench-dsl.ts', context);
      });
    });
  });

  describe('Given a TypeScript parent imports a missing parent-relative .js file, When it is resolved', () => {
    it('Then the .ts file is resolved instead', () => {
      // Arrange
      const sut = resolveTypeScriptSibling;
      const context = resolveContext(TS_PARENT);
      const nextResolve = failingOnce(failure('ERR_MODULE_NOT_FOUND'));

      // Act
      sut('../../src/index.node.js', context, nextResolve);

      // Assert
      expect(nextResolve).toHaveBeenLastCalledWith('../../src/index.node.ts', context);
    });
  });

  describe('Given the TypeScript parent URL carries a query string, When a missing .js file is resolved', () => {
    it('Then the .ts file is resolved instead', () => {
      // Arrange
      const sut = resolveTypeScriptSibling;
      const context = resolveContext(`${TS_PARENT}?vitest=1727780000000`);
      const nextResolve = failingOnce(failure('ERR_MODULE_NOT_FOUND'));

      // Act
      sut('./fixtures.js', context, nextResolve);

      // Assert
      expect(nextResolve).toHaveBeenLastCalledWith('./fixtures.ts', context);
    });
  });

  describe.each([
    ['a bare package specifier', 'tinybench/dist/index.js', TS_PARENT, 'ERR_MODULE_NOT_FOUND'],
    ['a relative non-.js specifier', './fixture.json', TS_PARENT, 'ERR_MODULE_NOT_FOUND'],
    ['a JavaScript parent', './sibling.js', 'file:///repo/dist/index.js', 'ERR_MODULE_NOT_FOUND'],
    ['an entry point with no parent', './entry.js', undefined, 'ERR_MODULE_NOT_FOUND'],
    [
      'a non-file TypeScript parent',
      './sibling.js',
      'https://example.test/x.ts',
      'ERR_MODULE_NOT_FOUND',
    ],
    [
      'a failure other than a missing module',
      './sibling.js',
      TS_PARENT,
      'ERR_INVALID_MODULE_SPECIFIER',
    ],
  ])('Given %s fails to resolve', (_label, specifier, parentURL, code) => {
    describe('When it is resolved', () => {
      it('Then the original resolution error propagates without a retry', () => {
        // Arrange
        const sut = resolveTypeScriptSibling;
        const error = failure(code);
        const nextResolve = failingOnce(error);

        // Act
        const thrown = thrownBy(() => sut(specifier, resolveContext(parentURL), nextResolve));

        // Assert
        expect(thrown).toBe(error);
        expect(nextResolve).toHaveBeenCalledOnce();
      });
    });
  });
});

describe('loadTranspiledTypeScript', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tsgit-typescript-hooks-'));
  const tsFile = path.join(dir, 'typed.ts');
  writeFileSync(tsFile, 'export const answer: number = 42;\nexport type Unused = string;\n');

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('Given a TypeScript file URL, When it is loaded', () => {
    it('Then its transpiled ES module source short-circuits the default loader', () => {
      // Arrange
      const sut = loadTranspiledTypeScript;
      const nextLoad = vi.fn().mockReturnValue(LOADED);

      // Act
      const result = sut(pathToFileURL(tsFile).href, LOAD_CONTEXT, nextLoad);

      // Assert
      expect(result).toEqual({
        format: 'module',
        source: 'export const answer = 42;\n',
        shortCircuit: true,
      });
      expect(nextLoad).not.toHaveBeenCalled();
    });
  });

  describe('Given a TypeScript file URL carrying a query string, When it is loaded', () => {
    it('Then the file behind the query is transpiled', () => {
      // Arrange
      const sut = loadTranspiledTypeScript;
      const nextLoad = vi.fn().mockReturnValue(LOADED);

      // Act
      const result = sut(`${pathToFileURL(tsFile).href}?vitest=1`, LOAD_CONTEXT, nextLoad);

      // Assert
      expect(result.source).toBe('export const answer = 42;\n');
    });
  });

  describe.each([
    ['a JavaScript file URL', 'file:///repo/dist/esm/index.node.js'],
    ['a builtin', 'node:fs'],
    ['a non-file TypeScript URL', 'https://example.test/remote.ts'],
  ])('Given %s', (_label, url) => {
    describe('When it is loaded', () => {
      it('Then the default loader handles it', () => {
        // Arrange
        const sut = loadTranspiledTypeScript;
        const nextLoad = vi.fn().mockReturnValue(LOADED);

        // Act
        const result = sut(url, LOAD_CONTEXT, nextLoad);

        // Assert
        expect(result).toBe(LOADED);
        expect(nextLoad).toHaveBeenCalledExactlyOnceWith(url, LOAD_CONTEXT);
      });
    });
  });
});
