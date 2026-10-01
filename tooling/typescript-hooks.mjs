/**
 * Synchronous module hooks that let plain Node load this repo's TypeScript
 * without its built-in type stripper.
 *
 * Benchmarks and profiles must not run Node's stripper: once it has run, the
 * process executes unrelated hot code 25-40 % slower (Node 22), so every
 * measurement taken there is skewed. These hooks transpile with the
 * `typescript` package instead, and map the `.js` specifiers the sources use
 * onto their `.ts` files. Plain JavaScript, so loading them needs no stripper.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const FILE_PROTOCOL = 'file:';
const JS_EXTENSION = '.js';
const TS_EXTENSION = '.ts';
const MODULE_NOT_FOUND = 'ERR_MODULE_NOT_FOUND';
const RELATIVE_PREFIXES = ['./', '../'];
const COMPILER_OPTIONS = {
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2022,
  verbatimModuleSyntax: true,
};

/** @param {string} url */
const isTypeScriptFileUrl = (url) => {
  const { protocol, pathname } = new URL(url);
  return protocol === FILE_PROTOCOL && pathname.endsWith(TS_EXTENSION);
};

/** @param {string} specifier */
const isRelativeJsSpecifier = (specifier) =>
  RELATIVE_PREFIXES.some((prefix) => specifier.startsWith(prefix)) &&
  specifier.endsWith(JS_EXTENSION);

/** @param {string | undefined} parentURL */
const isImportedFromTypeScript = (parentURL) =>
  parentURL !== undefined && isTypeScriptFileUrl(parentURL);

/**
 * @param {unknown} error
 * @param {string} specifier
 * @param {string | undefined} parentURL
 */
const isMissingTypeScriptSibling = (error, specifier, parentURL) =>
  error instanceof Error &&
  /** @type {NodeJS.ErrnoException} */ (error).code === MODULE_NOT_FOUND &&
  isRelativeJsSpecifier(specifier) &&
  isImportedFromTypeScript(parentURL);

/** @param {string} specifier */
const toTypeScriptSpecifier = (specifier) =>
  `${specifier.slice(0, -JS_EXTENSION.length)}${TS_EXTENSION}`;

/** @type {import('node:module').ResolveHookSync} */
export const resolveTypeScriptSibling = (specifier, context, nextResolve) => {
  try {
    return nextResolve(specifier, context);
  } catch (error) {
    if (!isMissingTypeScriptSibling(error, specifier, context.parentURL)) throw error;
    return nextResolve(toTypeScriptSpecifier(specifier), context);
  }
};

/** @type {import('node:module').LoadHookSync} */
export const loadTranspiledTypeScript = (url, context, nextLoad) => {
  if (!isTypeScriptFileUrl(url)) return nextLoad(url, context);
  const fileName = fileURLToPath(url);
  const { outputText } = ts.transpileModule(readFileSync(fileName, 'utf8'), {
    compilerOptions: COMPILER_OPTIONS,
    fileName,
  });
  return { format: 'module', source: outputText, shortCircuit: true };
};
