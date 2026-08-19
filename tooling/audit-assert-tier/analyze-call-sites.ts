/**
 * Resolves the primitives module's `assertRepository` binding under an
 * already-built TS program, then walks every given file's AST for call
 * expressions on that binding — reached directly, through any re-export
 * chain, and under any local alias — and attributes each to its nearest
 * ENCLOSING EXPORTED declaration (`export const x = …` / `export function
 * x() {}`). Binding resolution is via the type checker's alias chain
 * (`checker.getAliasedSymbol`), never import-path matching — that is what
 * makes a re-export shim and a renamed import both transparent.
 *
 * A call that cannot be attributed to an exported declaration carries
 * `verb: undefined` — the exact shape a bypass would take, so the caller
 * (`compute-findings.ts`) must treat it as a finding rather than skip it
 * silently.
 */
import * as path from 'node:path';
import * as ts from 'typescript';

export interface CallSite {
  readonly module: string;
  readonly verb: string | undefined;
  readonly line: number;
}

export interface AnalyzeConfig {
  /** Absolute path; must be one of the given `filePaths`. */
  readonly targetModule: string;
  readonly targetExportName: string;
}

const hasExportModifier = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

/** The nearest ancestor exported `VariableStatement`/`FunctionDeclaration`'s
 * declared name, or `undefined` when no such ancestor exists before the
 * source file itself. */
const enclosingExportedVerb = (node: ts.Node): string | undefined => {
  let current = node.parent as ts.Node | undefined;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (ts.isVariableStatement(current) && hasExportModifier(current)) {
      const [declaration] = current.declarationList.declarations;
      return declaration !== undefined && ts.isIdentifier(declaration.name)
        ? declaration.name.text
        : undefined;
    }
    if (ts.isFunctionDeclaration(current) && hasExportModifier(current)) {
      return current.name?.text;
    }
    current = current.parent;
  }
  return undefined;
};

/** Follows an alias chain to its final (non-alias) symbol. A no-op for a
 * symbol that is not an alias. */
const resolveFinalSymbol = (checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol => {
  let resolved = symbol;
  while ((resolved.flags & ts.SymbolFlags.Alias) !== 0) {
    const next = checker.getAliasedSymbol(resolved);
    if (next === resolved) break;
    resolved = next;
  }
  return resolved;
};

const findTargetSymbol = (
  program: ts.Program,
  checker: ts.TypeChecker,
  config: AnalyzeConfig,
): ts.Symbol => {
  const sourceFile = program.getSourceFile(config.targetModule);
  if (sourceFile === undefined) {
    throw new Error(`audit-assert-tier: could not load target module ${config.targetModule}`);
  }
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  const target = moduleSymbol
    ? checker
        .getExportsOfModule(moduleSymbol)
        .find((symbol) => symbol.name === config.targetExportName)
    : undefined;
  if (target === undefined) {
    throw new Error(
      `audit-assert-tier: ${config.targetModule} does not export ${config.targetExportName}`,
    );
  }
  return target;
};

const callSitesInFile = (
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  repoRoot: string,
  targetSymbol: ts.Symbol,
): readonly CallSite[] => {
  const moduleName = path.relative(repoRoot, sourceFile.fileName).replaceAll(path.sep, '/');
  const found: CallSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const symbol = checker.getSymbolAtLocation(node.expression);
      if (symbol !== undefined && resolveFinalSymbol(checker, symbol) === targetSymbol) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        found.push({ module: moduleName, verb: enclosingExportedVerb(node), line: line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
};

/** Collects every call site on `config.targetModule`'s `config.targetExportName`
 * export across `filePaths`, attributed by exported declaration. */
export const analyzeCallSites = (
  program: ts.Program,
  filePaths: readonly string[],
  repoRoot: string,
  config: AnalyzeConfig,
): readonly CallSite[] => {
  const checker = program.getTypeChecker();
  const targetSymbol = findTargetSymbol(program, checker, config);
  return filePaths.flatMap((filePath) => {
    const sourceFile = program.getSourceFile(filePath);
    return sourceFile === undefined
      ? []
      : callSitesInFile(checker, sourceFile, repoRoot, targetSymbol);
  });
};
