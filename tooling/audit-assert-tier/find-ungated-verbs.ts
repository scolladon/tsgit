import * as path from 'node:path';
import * as ts from 'typescript';

/**
 * The complementary half of the assert-tier audit.
 *
 * `analyze-call-sites.ts` fences the verbs that already CALL the bare tier.
 * A verb that calls no tier at all is invisible to it, and that is the
 * strictly weaker position: it inherits neither the acceptance gates nor the
 * bare tier's own repository check. That blind spot is not hypothetical — it
 * is how a public bundle-verification verb reached object state on a
 * repository the trust gate had refused.
 *
 * So this pass states the obligation positively: every exported command verb
 * that takes a `Context` must reach one of the tier symbols, or be named in
 * the allowlist with the measurement that says why canonical git lets it
 * survive.
 *
 * The reachability test is syntactic, and transitive within the module: a
 * verb that delegates to a local helper which gates is gated. That much is
 * required, not a nicety — verbs delegate routinely, and a one-level check
 * reported a wall of false positives whose allowlist nobody would read. It
 * stops at the module boundary, which is a deliberate limit rather than an
 * oversight: a cross-module walk buys little here, because the scope is
 * already narrowed to the barrel-exported command surface.
 */

/** Symbols that establish, or transitively establish, an accepted repository. */
const GATING_SYMBOLS: ReadonlyArray<string> = [
  'assertRepository',
  'assertAcceptedRepository',
  'assertOperationalRepository',
  // Chaining helpers: each reaches one of the three above.
  'assertSparseReady',
  'requireWorkTree',
  'assertNotBare',
];

export interface UngatedVerbFinding {
  readonly module: string;
  readonly verb: string;
  readonly line: number;
}

const takesContext = (node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration) => {
  const [first] = node.parameters;
  if (first === undefined || first.type === undefined) return false;
  return first.type.getText().includes('Context');
};

/** Every identifier mentioned anywhere inside `body`. */
const identifiersIn = (body: ts.Node): ReadonlySet<string> => {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(body);
  return names;
};

/**
 * Whether `body` reaches a gating symbol, following calls to helpers declared
 * in the same module. Verbs legitimately delegate — `addAll` gates by calling
 * `add` — so a one-level check would report a wall of false positives and the
 * allowlist would grow past the point anyone reads it. Bounded by `seen`, so a
 * cycle terminates.
 */
const reachesGate = (
  body: ts.Node,
  localFunctions: ReadonlyMap<string, ts.Node>,
  seen: Set<string>,
): boolean => {
  const names = identifiersIn(body);
  for (const name of names) {
    if (GATING_SYMBOLS.includes(name)) return true;
  }
  for (const name of names) {
    if (seen.has(name)) continue;
    const local = localFunctions.get(name);
    if (local === undefined) continue;
    seen.add(name);
    if (reachesGate(local, localFunctions, seen)) return true;
  }
  return false;
};

/** A function-valued declaration: `const f = () => {}` or `function f() {}`. */
const functionOf = (statement: ts.Statement): ReadonlyArray<readonly [string, ts.Node]> => {
  if (ts.isFunctionDeclaration(statement)) {
    return statement.name === undefined ? [] : [[statement.name.text, statement]];
  }
  if (!ts.isVariableStatement(statement)) return [];
  return statement.declarationList.declarations.flatMap((declaration) => {
    const init = declaration.initializer;
    if (init === undefined || !ts.isIdentifier(declaration.name)) return [];
    if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) return [];
    return [[declaration.name.text, init] as const];
  });
};

/** Every function-valued declaration in the file, gating or not. */
const localFunctionsIn = (sourceFile: ts.SourceFile): ReadonlyMap<string, ts.Node> =>
  new Map(sourceFile.statements.flatMap(functionOf));

const hasExportModifier = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/**
 * The names the command barrel re-exports — the public command surface, and
 * the only set this obligation binds.
 *
 * "Exported and takes a Context" is too wide: command modules also export
 * helpers for their own reuse (`merge.ts` exports five), and those are
 * legitimately gate-less because the verb that calls them established the
 * tier. The barrel is the repo's own statement of which names are commands,
 * so it is the honest scope rather than a heuristic.
 */
const barrelExportedNames = (program: ts.Program, barrelPath: string): ReadonlySet<string> => {
  const barrel = program.getSourceFile(barrelPath);
  if (barrel === undefined) return new Set();
  const named = barrel.statements.flatMap((statement) => {
    if (!ts.isExportDeclaration(statement)) return [];
    const clause = statement.exportClause;
    if (clause === undefined || !ts.isNamedExports(clause)) return [];
    return clause.elements.map((element) => element.name.text);
  });
  return new Set(named);
};

/** A candidate verb: an exported, `Context`-taking, body-carrying declaration. */
interface VerbDeclaration {
  readonly name: string;
  readonly fn: ts.Node;
  readonly at: ts.Node;
}

// An overload SIGNATURE has no body; the gate lives in the implementation, so
// judging the signature would report every overloaded verb.
const fromFunctionDeclaration = (statement: ts.FunctionDeclaration): VerbDeclaration | undefined =>
  statement.body !== undefined && statement.name !== undefined && takesContext(statement)
    ? { name: statement.name.text, fn: statement, at: statement }
    : undefined;

const fromVariableStatement = (statement: ts.VariableStatement): VerbDeclaration | undefined =>
  statement.declarationList.declarations.flatMap((declaration) => {
    const init = declaration.initializer;
    if (init === undefined || !ts.isIdentifier(declaration.name)) return [];
    if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) return [];
    if (!takesContext(init)) return [];
    return [{ name: declaration.name.text, fn: init as ts.Node, at: declaration as ts.Node }];
  })[0];

const verbDeclarationOf = (statement: ts.Statement): VerbDeclaration | undefined => {
  if (!hasExportModifier(statement)) return undefined;
  if (ts.isFunctionDeclaration(statement)) return fromFunctionDeclaration(statement);
  return ts.isVariableStatement(statement) ? fromVariableStatement(statement) : undefined;
};

const ungatedVerbsInFile = (
  sourceFile: ts.SourceFile,
  moduleName: string,
  commandNames: ReadonlySet<string>,
): ReadonlyArray<UngatedVerbFinding> => {
  const localFunctions = localFunctionsIn(sourceFile);
  const seen = new Set<string>();
  const findings: UngatedVerbFinding[] = [];
  for (const statement of sourceFile.statements) {
    const verb = verbDeclarationOf(statement);
    if (verb === undefined || !commandNames.has(verb.name) || seen.has(verb.name)) continue;
    seen.add(verb.name);
    if (reachesGate(verb.fn, localFunctions, new Set([verb.name]))) continue;
    const { line } = sourceFile.getLineAndCharacterOfPosition(verb.at.getStart(sourceFile));
    findings.push({ module: moduleName, verb: verb.name, line: line + 1 });
  }
  return findings;
};

/**
 * Every barrel-exported `Context`-taking command verb in `filePaths` that
 * reaches no gating symbol, directly or through a helper in its own module.
 */
export const findUngatedVerbs = (
  program: ts.Program,
  filePaths: ReadonlyArray<string>,
  repoRoot: string,
): ReadonlyArray<UngatedVerbFinding> => {
  const commandNames = barrelExportedNames(
    program,
    path.join(repoRoot, 'src/application/commands/index.ts'),
  );
  return filePaths.flatMap((filePath) => {
    const sourceFile = program.getSourceFile(filePath);
    if (sourceFile === undefined) return [];
    const moduleName = path.relative(repoRoot, filePath).replaceAll(path.sep, '/');
    return [...ungatedVerbsInFile(sourceFile, moduleName, commandNames)];
  });
};
