import * as ts from 'typescript';
import type { ApiSchema } from '../model';
import { declarationOf, symbolOf, unwrap } from '../util';
import type { ValidatorAdapter, ValidatorContext } from './adapter';

interface ZNode {
  schema: ApiSchema;
  optional: boolean;
  /** Set when the node is exactly a reference to a named schema variable. */
  name?: string;
}

interface Call {
  name: string;
  args: readonly ts.Expression[];
  node: ts.CallExpression;
}

function literalValue(e: ts.Expression | undefined): unknown {
  if (!e) return undefined;
  e = unwrap(e);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (e.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) {
    return -Number(e.operand.text);
  }
  if (ts.isArrayLiteralExpression(e)) {
    const out = e.elements.map((x) => literalValue(x));
    return out.some((x) => x === undefined) ? undefined : out;
  }
  if (ts.isObjectLiteralExpression(e)) {
    const out: Record<string, unknown> = {};
    for (const p of e.properties) {
      if (!ts.isPropertyAssignment(p)) return undefined;
      const k = propName(p.name);
      const v = literalValue(p.initializer);
      if (k === undefined || v === undefined) return undefined;
      out[k] = v;
    }
    return out;
  }
  return undefined;
}

function propName(n: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
  return undefined;
}

const BASE_FORMATS: Record<string, string> = {
  email: 'email',
  uuid: 'uuid',
  url: 'uri',
  datetime: 'date-time',
};

export class ZodAdapter implements ValidatorAdapter {
  readonly name = 'zod';
  private visiting = new Set<ts.Node>();
  private cache = new Map<ts.Node, ZNode>();

  matches(expr: ts.Expression, ctx: ValidatorContext): boolean {
    return this.rootsInZod(expr, ctx, 0);
  }

  toSchema(expr: ts.Expression, ctx: ValidatorContext): ApiSchema | undefined {
    try {
      const node = this.parse(expr, ctx, 0);
      return this.emit(node, ctx);
    } catch (e) {
      ctx.warn(`Could not convert zod schema: ${(e as Error).message}`, expr);
      return undefined;
    }
  }

  // ---------------------------------------------------------------- detection

  private zodNames(sf: ts.SourceFile): Set<string> {
    const names = new Set<string>(['z']);
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      if (!/^zod(\/|$)/.test(st.moduleSpecifier.text)) continue;
      const clause = st.importClause;
      if (!clause) continue;
      if (clause.name) names.add(clause.name.text);
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) names.add(nb.name.text);
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) names.add(el.name.text);
    }
    return names;
  }

  private rootsInZod(expr: ts.Expression, ctx: ValidatorContext, depth: number): boolean {
    if (depth > 8) return false;
    expr = unwrap(expr);
    if (ts.isIdentifier(expr) || (ts.isPropertyAccessExpression(expr) && !this.isChain(expr))) {
      const decl = declarationOf(symbolOf(ctx.checker, expr));
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        return this.rootsInZod(decl.initializer, ctx, depth + 1);
      }
      if (decl && ts.isPropertyAssignment(decl)) return this.rootsInZod(decl.initializer, ctx, depth + 1);
      return false;
    }
    let e: ts.Expression = expr;
    while (ts.isCallExpression(e) || ts.isPropertyAccessExpression(e)) e = e.expression;
    if (!ts.isIdentifier(e)) return false;
    if (this.zodNames(e.getSourceFile()).has(e.text) && (ts.isCallExpression(expr) || ts.isPropertyAccessExpression(expr))) {
      return ts.isCallExpression(expr);
    }
    // chain on top of another named schema: Base.extend({...})
    return this.rootsInZod(e, ctx, depth + 1);
  }

  private isChain(e: ts.Expression): boolean {
    return ts.isCallExpression(unwrap(e));
  }

  // ------------------------------------------------------------------ parsing

  private flatten(expr: ts.Expression): { base: ts.Expression; calls: Call[] } {
    const calls: Call[] = [];
    let e = unwrap(expr);
    while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      calls.push({ name: e.expression.name.text, args: e.arguments, node: e });
      e = unwrap(e.expression.expression);
    }
    return { base: e, calls: calls.reverse() };
  }

  private parse(expr: ts.Expression, ctx: ValidatorContext, depth: number): ZNode {
    if (depth > 20) return { schema: {}, optional: false };
    expr = unwrap(expr);

    // Reference to a named schema (identifier / property access)
    if (ts.isIdentifier(expr) || (ts.isPropertyAccessExpression(expr) && !ts.isCallExpression(expr.expression))) {
      const decl = declarationOf(symbolOf(ctx.checker, expr));
      const init =
        decl && (ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl)) ? decl.initializer : undefined;
      if (decl && init) {
        const cached = this.cache.get(decl);
        if (cached) return { ...cached, name: ts.isIdentifier(expr) ? expr.text : (expr as ts.PropertyAccessExpression).name.text };
        if (this.visiting.has(decl)) return { schema: {}, optional: false };
        this.visiting.add(decl);
        const n = this.parse(init, ctx, depth + 1);
        this.visiting.delete(decl);
        this.cache.set(decl, n);
        const nm = ts.isIdentifier(expr) ? expr.text : (expr as ts.PropertyAccessExpression).name.text;
        return { ...n, name: nm };
      }
      ctx.warn(`Could not resolve schema reference "${expr.getText()}"`, expr);
      return { schema: {}, optional: false };
    }

    const { base, calls } = this.flatten(expr);
    let node: ZNode;
    let modifiers = calls;

    const baseIsZod = this.isZodRoot(base);
    if (baseIsZod && calls.length > 0) {
      const [builder, ...rest] = calls;
      node = this.builder(builder, ctx, depth);
      modifiers = rest;
    } else if (ts.isPropertyAccessExpression(base) && this.isZodRoot(base.expression) && calls.length > 0) {
      // z.coerce.number() / z.iso.datetime()
      const ns = base.name.text;
      const [builder, ...rest] = calls;
      if (ns === 'iso') {
        // z.iso.datetime() / z.iso.date() / z.iso.time() / z.iso.duration()
        const fmt: Record<string, string> = { datetime: 'date-time', date: 'date', time: 'time', duration: 'duration' };
        node = { schema: { type: 'string', format: fmt[builder.name] }, optional: false };
        if (!fmt[builder.name]) delete node.schema.format;
      } else {
        node = this.builder(builder, ctx, depth);
      }
      modifiers = rest;
    } else {
      const inner = this.parse(base, ctx, depth + 1);
      node = { schema: structuredClone(inner.schema), optional: inner.optional, name: calls.length === 0 ? inner.name : undefined };
    }

    for (const m of modifiers) node = this.modifier(node, m, ctx, depth);
    return node;
  }

  private isZodRoot(e: ts.Expression): boolean {
    e = unwrap(e);
    return ts.isIdentifier(e) && this.zodNames(e.getSourceFile()).has(e.text);
  }

  private emit(node: ZNode, ctx: ValidatorContext): ApiSchema {
    if (node.name && node.schema.type === 'object') {
      ctx.components[node.name] = node.schema;
      return { $ref: `#/components/schemas/${node.name}` };
    }
    return node.schema;
  }

  private child(expr: ts.Expression | undefined, ctx: ValidatorContext, depth: number): ZNode {
    if (!expr) return { schema: {}, optional: false };
    return this.parse(expr, ctx, depth + 1);
  }

  private unwrapOptionalSchema(n: ZNode, ctx: ValidatorContext): ApiSchema {
    return this.emit(n, ctx);
  }

  private objectShape(arg: ts.Expression | undefined, ctx: ValidatorContext, depth: number): ApiSchema {
    const properties: Record<string, ApiSchema> = {};
    const required: string[] = [];
    if (arg) {
      const lit = unwrap(arg);
      if (ts.isObjectLiteralExpression(lit)) {
        for (const p of lit.properties) {
          if (ts.isPropertyAssignment(p)) {
            const k = propName(p.name);
            if (k === undefined) continue;
            const n = this.child(p.initializer, ctx, depth);
            properties[k] = this.unwrapOptionalSchema(n, ctx);
            if (!n.optional) required.push(k);
          } else if (ts.isShorthandPropertyAssignment(p)) {
            const n = this.child(p.name, ctx, depth);
            properties[p.name.text] = this.unwrapOptionalSchema(n, ctx);
            if (!n.optional) required.push(p.name.text);
          } else if (ts.isSpreadAssignment(p)) {
            // ...Base.shape
            const e = unwrap(p.expression);
            if (ts.isPropertyAccessExpression(e) && e.name.text === 'shape') {
              const inner = this.child(e.expression, ctx, depth);
              const s = this.inline(inner.schema, ctx);
              Object.assign(properties, s.properties ?? {});
              required.push(...(s.required ?? []));
            }
          }
        }
      }
    }
    const schema: ApiSchema = { type: 'object', properties };
    if (required.length) schema.required = required;
    return schema;
  }

  /** Resolve a $ref'd object back to its inline definition (used for extend/merge/pick/omit). */
  private inline(s: ApiSchema, ctx: ValidatorContext): ApiSchema {
    if (s.$ref) {
      const name = s.$ref.split('/').pop()!;
      return ctx.components[name] ?? s;
    }
    return s;
  }

  private builder(c: Call, ctx: ValidatorContext, depth: number): ZNode {
    const a = c.args;
    const mk = (schema: ApiSchema, optional = false): ZNode => ({ schema, optional });
    switch (c.name) {
      case 'string':
        return mk({ type: 'string' });
      case 'number':
        return mk({ type: 'number' });
      case 'int':
      case 'int32':
        return mk({ type: 'integer' });
      case 'bigint':
        return mk({ type: 'integer', format: 'int64' });
      case 'boolean':
      case 'stringbool':
        return mk({ type: 'boolean' });
      case 'date':
        return mk({ type: 'string', format: 'date-time' });
      case 'null':
        return mk({ type: 'null' });
      case 'undefined':
      case 'void':
        return mk({}, true);
      case 'any':
      case 'unknown':
      case 'never':
      case 'nan':
        return mk({});
      case 'email':
      case 'uuid':
      case 'url':
        return mk({ type: 'string', format: BASE_FORMATS[c.name] });
      case 'cuid':
      case 'cuid2':
      case 'ulid':
      case 'nanoid':
        return mk({ type: 'string' });
      case 'literal': {
        const v = literalValue(a[0]);
        if (v === undefined) return mk({});
        return mk({ type: v === null ? 'null' : typeof v === 'object' ? undefined : typeof v, const: v });
      }
      case 'enum': {
        const v = literalValue(a[0]);
        if (Array.isArray(v)) return mk({ type: 'string', enum: v });
        if (v && typeof v === 'object') return mk({ enum: Object.values(v as object) });
        // z.enum(VALUES): ask the type checker
        if (a[0]) {
          const t = ctx.checker.getTypeAtLocation(a[0]);
          const elems = ctx.checker.isTupleType(t) || ctx.checker.isArrayType(t) ? ctx.checker.getTypeArguments(t as ts.TypeReference) : [];
          const vals = elems.filter((x) => x.isStringLiteral()).map((x) => (x as ts.StringLiteralType).value);
          if (vals.length) return mk({ type: 'string', enum: vals });
        }
        return mk({ type: 'string' });
      }
      case 'nativeEnum':
      case 'enumeration': {
        if (a[0]) {
          const sym = symbolOf(ctx.checker, a[0]);
          if (sym && sym.flags & ts.SymbolFlags.Enum) return mk(ctx.types.schemaOf(ctx.checker.getDeclaredTypeOfSymbol(sym)));
          const t = ctx.checker.getTypeAtLocation(a[0]);
          const sch = ctx.types.schemaOf(t);
          if (sch.type === 'object' && sch.properties) return mk({ enum: Object.keys(sch.properties) });
        }
        return mk({});
      }
      case 'array':
        return mk({ type: 'array', items: this.unwrapOptionalSchema(this.child(a[0], ctx, depth), ctx) });
      case 'set':
        return mk({ type: 'array', uniqueItems: true, items: this.unwrapOptionalSchema(this.child(a[0], ctx, depth), ctx) });
      case 'object':
      case 'strictObject':
      case 'looseObject':
        return mk(this.objectShape(a[0], ctx, depth));
      case 'record':
      case 'map':
        return mk({ type: 'object', additionalProperties: this.unwrapOptionalSchema(this.child(a[a.length - 1], ctx, depth), ctx) });
      case 'tuple': {
        const arr = a[0] && ts.isArrayLiteralExpression(unwrap(a[0])) ? (unwrap(a[0]) as ts.ArrayLiteralExpression).elements : [];
        const items = arr.map((x) => this.unwrapOptionalSchema(this.child(x, ctx, depth), ctx));
        return mk({ type: 'array', prefixItems: items, minItems: items.length, maxItems: items.length });
      }
      case 'union':
      case 'discriminatedUnion': {
        const listArg = c.name === 'union' ? a[0] : a[1];
        const lit = listArg ? unwrap(listArg) : undefined;
        const members =
          lit && ts.isArrayLiteralExpression(lit)
            ? lit.elements.map((x) => this.unwrapOptionalSchema(this.child(x, ctx, depth), ctx))
            : [];
        const allConst = members.length > 0 && members.every((m) => 'const' in m && !m.$ref);
        if (allConst) {
          const types = new Set(members.map((m) => m.type));
          return mk({ type: types.size === 1 ? [...types][0] : undefined, enum: members.map((m) => m.const) });
        }
        const s: ApiSchema = c.name === 'union' ? { anyOf: members } : { oneOf: members };
        if (c.name === 'discriminatedUnion') {
          const key = literalValue(a[0]);
          if (typeof key === 'string') s.discriminator = { propertyName: key };
        }
        return mk(s);
      }
      case 'intersection':
        return mk({ allOf: [this.unwrapOptionalSchema(this.child(a[0], ctx, depth), ctx), this.unwrapOptionalSchema(this.child(a[1], ctx, depth), ctx)] });
      case 'optional': {
        const n = this.child(a[0], ctx, depth);
        return { schema: n.schema, optional: true, name: n.name };
      }
      case 'nullable': {
        const n = this.child(a[0], ctx, depth);
        return { schema: this.nullable(this.unwrapOptionalSchema(n, ctx)), optional: n.optional };
      }
      case 'preprocess':
      case 'pipe':
        return this.child(a[a.length - 1], ctx, depth);
      case 'lazy':
        ctx.warn('z.lazy() schemas are not resolved statically', c.node);
        return mk({});
      default:
        ctx.warn(`Unsupported zod builder z.${c.name}()`, c.node);
        return mk({});
    }
  }

  private nullable(s: ApiSchema): ApiSchema {
    if (s.$ref || s.anyOf || s.oneOf || s.allOf || !s.type) return { anyOf: [s, { type: 'null' }] };
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const out: ApiSchema = { ...s, type: [...types, 'null'] };
    if (out.enum) out.enum = [...out.enum, null];
    return out;
  }

  private modifier(node: ZNode, c: Call, ctx: ValidatorContext, depth: number): ZNode {
    const a = c.args;
    const num = (i = 0) => {
      const v = literalValue(a[i]);
      return typeof v === 'number' ? v : undefined;
    };
    const s = node.schema;
    const kind = Array.isArray(s.type) ? s.type[0] : s.type;
    const touched = (): ZNode => ({ ...node, name: undefined });
    const set = (k: string, v: unknown): ZNode => {
      if (v !== undefined) (s as Record<string, unknown>)[k] = v;
      return touched();
    };
    switch (c.name) {
      case 'optional':
        return { ...node, optional: true };
      case 'nullable':
        return { schema: this.nullable(this.inlineIfNamed(node, ctx)), optional: node.optional };
      case 'nullish':
        return { schema: this.nullable(this.inlineIfNamed(node, ctx)), optional: true };
      case 'default':
      case 'catch': {
        const v = literalValue(a[0]);
        const n = touched();
        if (v !== undefined && c.name === 'default') n.schema.default = v;
        n.optional = c.name === 'default' ? true : node.optional;
        return n;
      }
      case 'describe':
        return set('description', typeof literalValue(a[0]) === 'string' ? literalValue(a[0]) : undefined);
      case 'min':
      case 'gte':
        return set(kind === 'string' ? 'minLength' : kind === 'array' ? 'minItems' : 'minimum', num());
      case 'max':
      case 'lte':
        return set(kind === 'string' ? 'maxLength' : kind === 'array' ? 'maxItems' : 'maximum', num());
      case 'length': {
        const n = num();
        if (kind === 'array') {
          s.minItems = n;
          s.maxItems = n;
        } else {
          s.minLength = n;
          s.maxLength = n;
        }
        return touched();
      }
      case 'gt':
        return set('exclusiveMinimum', num());
      case 'lt':
        return set('exclusiveMaximum', num());
      case 'positive':
        return set('exclusiveMinimum', 0);
      case 'nonnegative':
        return set('minimum', 0);
      case 'negative':
        return set('exclusiveMaximum', 0);
      case 'nonpositive':
        return set('maximum', 0);
      case 'multipleOf':
      case 'step':
        return set('multipleOf', num());
      case 'int':
        s.type = 'integer';
        return touched();
      case 'nonempty':
        return set(kind === 'array' ? 'minItems' : 'minLength', 1);
      case 'email':
      case 'uuid':
      case 'url':
      case 'datetime':
        return set('format', BASE_FORMATS[c.name]);
      case 'date':
        return set('format', 'date');
      case 'time':
        return set('format', 'time');
      case 'ip':
        return set('format', 'ipv4');
      case 'regex': {
        const re = a[0] && unwrap(a[0]);
        if (re && ts.isRegularExpressionLiteral(re)) {
          const m = /^\/(.*)\/[a-z]*$/s.exec(re.text);
          if (m) return set('pattern', m[1]);
        }
        return touched();
      }
      case 'startsWith': {
        const v = literalValue(a[0]);
        return typeof v === 'string' ? set('pattern', '^' + v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : touched();
      }
      case 'endsWith': {
        const v = literalValue(a[0]);
        return typeof v === 'string' ? set('pattern', v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') : touched();
      }
      case 'array':
        return { schema: { type: 'array', items: this.inlineIfNamed(node, ctx) }, optional: false };
      case 'or': {
        const other = this.unwrapOptionalSchema(this.child(a[0], ctx, depth), ctx);
        return { schema: { anyOf: [this.inlineIfNamed(node, ctx), other] }, optional: node.optional };
      }
      case 'and': {
        const other = this.unwrapOptionalSchema(this.child(a[0], ctx, depth), ctx);
        return { schema: { allOf: [this.inlineIfNamed(node, ctx), other] }, optional: node.optional };
      }
      case 'extend':
      case 'augment': {
        const add = this.objectShape(a[0], ctx, depth);
        const base = this.inline(s, ctx);
        return this.mergeObjects(base, add);
      }
      case 'merge': {
        const other = this.child(a[0], ctx, depth);
        return this.mergeObjects(this.inline(s, ctx), this.inline(other.schema, ctx));
      }
      case 'pick':
      case 'omit': {
        const keys = literalValue(a[0]);
        const base = this.inline(s, ctx);
        if (!keys || typeof keys !== 'object' || !base.properties) return touched();
        const set_ = new Set(Object.keys(keys as object));
        const props: Record<string, ApiSchema> = {};
        for (const [k, v] of Object.entries(base.properties)) {
          if ((c.name === 'pick') === set_.has(k)) props[k] = v;
        }
        const out: ApiSchema = { ...base, properties: props, required: (base.required ?? []).filter((k) => k in props) };
        if (!out.required!.length) delete out.required;
        return { schema: out, optional: node.optional };
      }
      case 'partial': {
        const base = { ...this.inline(s, ctx) };
        delete base.required;
        return { schema: base, optional: node.optional };
      }
      case 'required': {
        const base = { ...this.inline(s, ctx) };
        if (base.properties) base.required = Object.keys(base.properties);
        return { schema: base, optional: node.optional };
      }
      case 'strict':
        return set('additionalProperties', false);
      case 'passthrough':
        return set('additionalProperties', true);
      case 'catchall':
        return set('additionalProperties', this.unwrapOptionalSchema(this.child(a[0], ctx, depth), ctx));
      // refinements / transforms don't change the documented input shape
      case 'refine':
      case 'superRefine':
      case 'transform':
      case 'brand':
      case 'readonly':
      case 'trim':
      case 'toLowerCase':
      case 'toUpperCase':
      case 'strip':
      case 'finite':
      case 'safe':
      case 'cuid':
      case 'cuid2':
      case 'ulid':
      case 'openapi':
        return node;
      case 'pipe':
        return this.child(a[0], ctx, depth);
      default:
        ctx.warn(`Unsupported zod modifier .${c.name}()`, c.node);
        return node;
    }
  }

  private inlineIfNamed(node: ZNode, ctx: ValidatorContext): ApiSchema {
    return node.name && node.schema.type === 'object' ? this.emit(node, ctx) : node.schema;
  }

  private mergeObjects(a: ApiSchema, b: ApiSchema): ZNode {
    const props = { ...(a.properties ?? {}), ...(b.properties ?? {}) };
    const required = Array.from(new Set([...(a.required ?? []), ...(b.required ?? [])]));
    const out: ApiSchema = { ...a, type: 'object', properties: props };
    if (required.length) out.required = required;
    return { schema: out, optional: false };
  }
}
