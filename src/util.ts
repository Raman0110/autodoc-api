import * as ts from 'typescript';

export type FnNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration;

export function isFnLike(n: ts.Node | undefined): n is FnNode {
  return (
    !!n &&
    (ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n))
  );
}

export function unwrap(e: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

export function followAlias(checker: ts.TypeChecker, sym: ts.Symbol | undefined): ts.Symbol | undefined {
  let n = 0;
  while (sym && sym.flags & ts.SymbolFlags.Alias && n++ < 10) {
    try {
      const next = checker.getAliasedSymbol(sym);
      if (!next || next === sym) break;
      sym = next;
    } catch {
      break;
    }
  }
  return sym;
}

/** Resolve an identifier / property access to its (alias-followed) symbol. */
export function symbolOf(checker: ts.TypeChecker, expr: ts.Expression): ts.Symbol | undefined {
  expr = unwrap(expr);
  if (ts.isPropertyAccessExpression(expr)) {
    return followAlias(checker, checker.getSymbolAtLocation(expr.name));
  }
  if (ts.isIdentifier(expr)) {
    return followAlias(checker, checker.getSymbolAtLocation(expr));
  }
  return undefined;
}

export function declarationOf(sym: ts.Symbol | undefined): ts.Declaration | undefined {
  if (!sym) return undefined;
  const decls = sym.declarations ?? [];
  // prefer a declaration with a body (overloads, merged symbols)
  return (
    decls.find((d) => ts.isFunctionDeclaration(d) && !!d.body) ??
    sym.valueDeclaration ??
    decls[0]
  );
}

export function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

/** Name of an identifier / property-access / call expression, used for name heuristics. */
export function expressionName(expr: ts.Expression): string | undefined {
  expr = unwrap(expr);
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isCallExpression(expr)) return calleeName(expr);
  return undefined;
}

const WRAPPER_DENY = new Set(['z', 'zod', 'Joi', 'yup', 'v', 'Type']);

function rootIdentifier(e: ts.Expression): string | undefined {
  while (ts.isCallExpression(e) || ts.isPropertyAccessExpression(e)) e = e.expression;
  return ts.isIdentifier(e) ? e.text : undefined;
}

export function functionFromDeclaration(
  checker: ts.TypeChecker,
  decl: ts.Node | undefined,
  depth = 0,
): FnNode | undefined {
  if (!decl || depth > 6) return undefined;
  if (isFnLike(decl)) return decl;
  if (ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl) || ts.isPropertyDeclaration(decl)) {
    return decl.initializer ? functionFromExpression(checker, decl.initializer, depth + 1) : undefined;
  }
  if (ts.isShorthandPropertyAssignment(decl)) {
    const s = followAlias(checker, checker.getShorthandAssignmentValueSymbol(decl));
    return functionFromDeclaration(checker, declarationOf(s), depth + 1);
  }
  if (ts.isExportAssignment(decl)) return functionFromExpression(checker, decl.expression, depth + 1);
  return undefined;
}

/**
 * Resolve an expression to a function node: inline functions, identifiers,
 * `obj.method` references and wrappers like `asyncHandler(fn)`.
 */
export function functionFromExpression(
  checker: ts.TypeChecker,
  expr: ts.Expression,
  depth = 0,
): FnNode | undefined {
  if (depth > 6) return undefined;
  expr = unwrap(expr);
  if (isFnLike(expr)) return expr;
  if (ts.isCallExpression(expr)) {
    const root = rootIdentifier(expr.expression);
    if (root && WRAPPER_DENY.has(root)) return undefined;
    // asyncHandler(fn) / catchAsync(async (req,res)=>{})
    for (const a of expr.arguments) {
      const fn = functionFromExpression(checker, a, depth + 1);
      if (fn) return fn;
    }
    return undefined;
  }
  if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)) {
    return functionFromDeclaration(checker, declarationOf(symbolOf(checker, expr)), depth + 1);
  }
  return undefined;
}

export function locate(node: ts.Node): { file: string; line: number } {
  const sf = node.getSourceFile();
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { file: sf.fileName, line: line + 1 };
}

export function joinPaths(...parts: string[]): string {
  const joined = parts
    .map((p) => p.trim())
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return '/' + joined;
}

/** Evaluate a (possibly constant-folded) string expression. */
export function evalString(checker: ts.TypeChecker, expr: ts.Expression | undefined): string | undefined {
  if (!expr) return undefined;
  expr = unwrap(expr);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isArrayLiteralExpression(expr)) return expr.elements.length ? evalString(checker, expr.elements[0]) : undefined;
  if (ts.isRegularExpressionLiteral(expr)) return undefined;
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = evalString(checker, expr.left);
    const r = evalString(checker, expr.right);
    return l !== undefined && r !== undefined ? l + r : undefined;
  }
  if (ts.isTemplateExpression(expr)) {
    let out = expr.head.text;
    for (const span of expr.templateSpans) {
      const v = evalString(checker, span.expression);
      if (v === undefined) return undefined;
      out += v + span.literal.text;
    }
    return out;
  }
  try {
    const t = checker.getTypeAtLocation(expr);
    if (t.isStringLiteral()) return t.value;
  } catch {
    /* ignore */
  }
  return undefined;
}

export function evalNumber(checker: ts.TypeChecker, expr: ts.Expression | undefined): number | undefined {
  if (!expr) return undefined;
  expr = unwrap(expr);
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  try {
    const t = checker.getTypeAtLocation(expr);
    if (t.isNumberLiteral()) return t.value;
  } catch {
    /* ignore */
  }
  return undefined;
}

export function jsDocSummary(node: ts.Node): { summary?: string; description?: string } {
  let target: ts.Node = node;
  // `const getUser = async (...) => {}`: docs live on the VariableStatement
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    let p: ts.Node | undefined = node.parent;
    while (p && !ts.isVariableStatement(p) && !ts.isPropertyAssignment(p) && !ts.isSourceFile(p)) p = p.parent;
    if (p && !ts.isSourceFile(p)) target = p;
  }
  const docs = ts.getJSDocCommentsAndTags(target).filter(ts.isJSDoc);
  const text = docs
    .map((d) => (typeof d.comment === 'string' ? d.comment : (d.comment?.map((c) => c.text).join('') ?? '')))
    .join('\n')
    .trim();
  if (!text) return {};
  const [first, ...rest] = text.split(/\r?\n\s*\r?\n/);
  const summary = first.replace(/\s*\r?\n\s*/g, ' ').trim();
  const description = rest.join('\n\n').trim();
  return { summary: summary || undefined, description: description || undefined };
}
