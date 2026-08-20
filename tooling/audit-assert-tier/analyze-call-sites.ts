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
      // The CONTAINING declarator, not the first: `export const a = …, b = …`
      // would otherwise attribute a call inside `b` to `a`, which matters
      // because `a` may be allowlisted while `b` is not.
      const declaration =
        current.declarationList.declarations.find(
          (candidate) =>
            node.getStart() >= candidate.getStart() && node.getEnd() <= candidate.getEnd(),
        ) ?? current.declarationList.declarations[0];
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
  // A reference is in callee position when it IS the callee of a call — not
  // merely nested somewhere inside one.
  const isCallee = (ref: ts.Node): boolean =>
    ref.parent !== undefined && ts.isCallExpression(ref.parent) && ref.parent.expression === ref;

  // An import/export specifier mentions the symbol without using it, and the
  // symbol's own declaration is a definition rather than a reference — the
  // target export declares itself, so without this the audit reports the very
  // line it is auditing.
  const isModuleBinding = (ref: ts.Node): boolean => {
    const parent = ref.parent;
    if (parent === undefined) return false;
    if (
      ts.isImportSpecifier(parent) ||
      ts.isExportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent)
    ) {
      return true;
    }
    return (
      (ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent)) && parent.name === ref
    );
  };

  const consider = (ref: ts.Node): void => {
    const symbol = checker.getSymbolAtLocation(ref);
    if (symbol === undefined || resolveFinalSymbol(checker, symbol) !== targetSymbol) return;
    if (isModuleBinding(ref)) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(ref.getStart(sourceFile));
    // A reference that is not a callee — aliased into a variable, passed as a
    // callback — cannot be attributed to a verb, so it is reported rather than
    // silently dropped. Bare-identifier matching alone would miss both this
    // and a namespace-import call (`repoState.assertRepository(ctx)`), which is
    // an idiomatic shape in this codebase.
    found.push({
      module: moduleName,
      verb: isCallee(ref) ? enclosingExportedVerb(ref) : undefined,
      line: line + 1,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      consider(node);
      // Walk the object side only; visiting `.name` would double-count.
      visit(node.expression);
      return;
    }
    if (ts.isIdentifier(node)) consider(node);
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
