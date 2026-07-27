/**
 * Classifies every export a built declaration file surfaces as value-shaped
 * (has a runtime representation) or type-only (erased at compile time).
 * Every given entry is parsed under ONE shared TS program, so the rollup-dts
 * chunk files their declarations reference are bound once, not once per
 * entry.
 */
import * as ts from 'typescript';

export interface DeclaredExport {
  readonly name: string;
  readonly isValue: boolean;
}

export interface EntryDeclarations {
  readonly sourceFile: ts.SourceFile;
  readonly exports: readonly DeclaredExport[];
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  allowJs: false,
  checkJs: false,
  declaration: false,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
  skipLibCheck: true,
  noEmit: true,
};

// `checker.getAliasedSymbol` resolves to the ALIASED DECLARATION's semantic
// flags, which reflect what the symbol IS, not how this file exports it —
// an `export type { readBlob }` specifier still resolves to a function
// declaration with the Value flag set. A syntactic `export type` (whole
// declaration or a single `type`-prefixed specifier) makes the export
// type-only regardless of the target's own nature, so it must short-circuit
// the semantic check.
const isSyntacticallyTypeOnly = (symbol: ts.Symbol): boolean =>
  (symbol.declarations ?? []).some((declaration) => {
    if (!ts.isExportSpecifier(declaration)) return false;
    return declaration.isTypeOnly || declaration.parent.parent.isTypeOnly;
  });

const classify = (checker: ts.TypeChecker, symbol: ts.Symbol): DeclaredExport => {
  if (isSyntacticallyTypeOnly(symbol)) {
    return { name: symbol.name, isValue: false };
  }
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return { name: symbol.name, isValue: (target.flags & ts.SymbolFlags.Value) !== 0 };
};

/**
 * Parses every given `.d.ts`/`.d.cts` entry path under one TS program and
 * returns each entry's own declared exports, keyed by that same path.
 */
export const analyzeDeclaredExports = (
  dtsPaths: readonly string[],
): ReadonlyMap<string, EntryDeclarations> => {
  const program = ts.createProgram([...dtsPaths], COMPILER_OPTIONS);
  const checker = program.getTypeChecker();

  return new Map(
    dtsPaths.map((dtsPath) => {
      const sourceFile = program.getSourceFile(dtsPath);
      if (!sourceFile) {
        throw new Error(`dts-value-exports: could not load declaration file ${dtsPath}`);
      }
      const fileSymbol = checker.getSymbolAtLocation(sourceFile);
      const exports = fileSymbol
        ? checker.getExportsOfModule(fileSymbol).map((symbol) => classify(checker, symbol))
        : [];
      return [dtsPath, { sourceFile, exports }];
    }),
  );
};

/** Declared value exports absent from the given runtime module's own export names. */
export const findUndefinedValueExports = (
  declaredExports: readonly DeclaredExport[],
  runtimeNames: ReadonlySet<string>,
): readonly string[] =>
  declaredExports
    .filter((exportEntry) => exportEntry.isValue && !runtimeNames.has(exportEntry.name))
    .map((exportEntry) => exportEntry.name);

/**
 * The reverse audit: runtime value exports that the declaration file fails to
 * declare AS VALUES — either missing entirely or downgraded to `export type`.
 * Guards against the postprocessor's worst failure mode (silently narrowing
 * the public API by over-downgrading a genuine runtime export).
 */
export const findUndeclaredRuntimeExports = (
  declaredExports: readonly DeclaredExport[],
  runtimeNames: ReadonlySet<string>,
): readonly string[] => {
  const declaredValueNames = new Set(
    declaredExports.filter((exportEntry) => exportEntry.isValue).map((entry) => entry.name),
  );
  return [...runtimeNames].filter((name) => name !== 'default' && !declaredValueNames.has(name));
};
