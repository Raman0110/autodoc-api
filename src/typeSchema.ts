import * as ts from 'typescript';
import type { ApiSchema } from './model';

const BINARY = new Set(['Buffer', 'Uint8Array', 'ArrayBuffer', 'Blob', 'File', 'ReadableStream', 'Readable']);
const TF = ts.TypeFlags;

function sanitize(name: string): string {
  return name
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

/**
 * Converts TypeScript types to JSON schema using the compiler's type checker.
 * Named types (interfaces, aliases, enums, generic instantiations) are registered
 * in `components` and referenced with $ref.
 */
export class TypeSchemaBuilder {
  private refs = new Map<ts.Type, string>();
  private names = new Map<string, ts.Type>();

  constructor(
    private checker: ts.TypeChecker,
    public components: Record<string, ApiSchema>,
    private anchor: ts.Node,
  ) {}

  schemaOf(type: ts.Type, opts: { widen?: boolean } = {}): ApiSchema {
    return this.convert(type, !!opts.widen, 0);
  }

  /** True when the type carries no information (any / unknown / never / void). */
  isOpaque(type: ts.Type): boolean {
    return (type.flags & (TF.Any | TF.Unknown | TF.Never | TF.Void | TF.Undefined)) !== 0;
  }

  private ref(name: string): ApiSchema {
    return { $ref: `#/components/schemas/${name}` };
  }

  private register(type: ts.Type, base: string): string {
    const existing = this.refs.get(type);
    if (existing) return existing;
    let name = sanitize(base) || 'Anonymous';
    let i = 2;
    while (this.names.has(name) && this.names.get(name) !== type) name = `${sanitize(base)}_${i++}`;
    this.names.set(name, type);
    this.refs.set(type, name);
    return name;
  }

  private convert(type: ts.Type, widen: boolean, depth: number): ApiSchema {
    if (depth > 24) return {};
    const f = type.flags;
    if (f & (TF.Any | TF.Unknown | TF.Never | TF.Void | TF.Undefined)) return {};
    if (f & TF.Null) return { type: 'null' };
    if (f & TF.Boolean) return { type: 'boolean' };
    if (f & TF.EnumLiteral && type.isUnion()) return this.enumType(type);
    if (type.isUnion()) return this.union(type, widen, depth);
    if (type.isIntersection()) {
      const parts = type.types.map((t) => this.convert(t, widen, depth + 1));
      return parts.length === 1 ? parts[0] : { allOf: parts };
    }
    if (type.isStringLiteral()) return widen ? { type: 'string' } : { type: 'string', const: type.value };
    if (type.isNumberLiteral()) return widen ? { type: 'number' } : { type: 'number', const: type.value };
    if (f & TF.BooleanLiteral) {
      const v = (type as unknown as { intrinsicName: string }).intrinsicName === 'true';
      return widen ? { type: 'boolean' } : { type: 'boolean', const: v };
    }
    if (f & TF.String || f & TF.TemplateLiteral || f & TF.StringMapping) return { type: 'string' };
    if (f & TF.Number) return { type: 'number' };
    if (f & (TF.BigInt | TF.BigIntLiteral)) return { type: 'integer', format: 'int64' };
    if (f & TF.ESSymbolLike) return {};
    if (f & TF.NonPrimitive) return { type: 'object' };
    if (f & (TF.TypeParameter | TF.Index | TF.IndexedAccess | TF.Conditional | TF.Substitution)) return {};
    if (f & TF.Object) return this.object(type as ts.ObjectType, widen, depth);
    return {};
  }

  private enumType(type: ts.UnionType): ApiSchema {
    const sym = type.aliasSymbol ?? type.getSymbol();
    const values = type.types
      .filter((t) => t.isStringLiteral() || t.isNumberLiteral())
      .map((t) => (t as ts.StringLiteralType | ts.NumberLiteralType).value);
    const schema: ApiSchema = {
      type: values.every((v) => typeof v === 'string') ? 'string' : values.every((v) => typeof v === 'number') ? 'number' : undefined,
      enum: values,
    };
    if (!schema.type) delete schema.type;
    if (!sym || sym.name.startsWith('__')) return schema;
    const name = this.register(type, sym.name);
    this.components[name] = schema;
    return this.ref(name);
  }

  private union(type: ts.UnionType, widen: boolean, depth: number): ApiSchema {
    const members = type.types;
    const hasNull = members.some((m) => m.flags & TF.Null);
    const rest = members.filter((m) => !(m.flags & (TF.Undefined | TF.Void | TF.Null)));

    // Members of an enum flattened into a bigger union (e.g. `Role | null`)
    const enumMembers = rest.filter((m) => m.flags & TF.EnumLiteral);
    if (enumMembers.length > 0 && enumMembers.length === rest.length) {
      const parent = (enumMembers[0].symbol as unknown as { parent?: ts.Symbol } | undefined)?.parent;
      const enumType = parent ? this.checker.getDeclaredTypeOfSymbol(parent) : undefined;
      if (enumType && enumType.isUnion() && enumType.types.length === enumMembers.length) {
        return this.nullable(this.enumType(enumType), hasNull);
      }
    }

    const schemas: ApiSchema[] = [];
    const hasTrue = rest.some((m) => m.flags & TF.BooleanLiteral && (m as unknown as { intrinsicName: string }).intrinsicName === 'true');
    const hasFalse = rest.some((m) => m.flags & TF.BooleanLiteral && (m as unknown as { intrinsicName: string }).intrinsicName === 'false');
    const literals: Array<string | number> = [];
    for (const m of rest) {
      if (m.flags & TF.BooleanLiteral && hasTrue && hasFalse) continue;
      if (m.flags & TF.Boolean) {
        schemas.push({ type: 'boolean' });
      } else if (!widen && (m.isStringLiteral() || m.isNumberLiteral())) {
        literals.push(m.value);
      } else {
        schemas.push(this.convert(m, widen, depth + 1));
      }
    }
    if (hasTrue && hasFalse) schemas.push({ type: 'boolean' });
    if (literals.length) {
      const kinds = new Set(literals.map((l) => typeof l));
      if (kinds.size === 1) schemas.push({ type: kinds.has('string') ? 'string' : 'number', enum: literals });
      else for (const l of literals) schemas.push({ type: typeof l === 'string' ? 'string' : 'number', const: l });
    }
    const unique: ApiSchema[] = [];
    const seen = new Set<string>();
    for (const s of schemas) {
      const k = JSON.stringify(s);
      if (!seen.has(k)) {
        seen.add(k);
        unique.push(s);
      }
    }
    let out: ApiSchema;
    if (unique.length === 0) out = hasNull ? { type: 'null' } : {};
    else if (unique.length === 1) out = unique[0];
    else out = { anyOf: unique };
    return unique.length === 0 ? out : this.nullable(out, hasNull);
  }

  private nullable(s: ApiSchema, isNullable: boolean): ApiSchema {
    if (!isNullable) return s;
    if (s.$ref || s.anyOf || s.allOf || s.oneOf || !s.type) {
      return s.anyOf ? { ...s, anyOf: [...s.anyOf, { type: 'null' }] } : { anyOf: [s, { type: 'null' }] };
    }
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const out: ApiSchema = { ...s, type: types.includes('null') ? types : [...types, 'null'] };
    if (out.enum && !out.enum.includes(null)) out.enum = [...out.enum, null];
    return out;
  }

  private typeArgs(type: ts.Type): readonly ts.Type[] {
    return this.checker.getTypeArguments(type as ts.TypeReference);
  }

  private object(type: ts.ObjectType, widen: boolean, depth: number): ApiSchema {
    const checker = this.checker;
    const symName = type.getSymbol()?.getName();

    if (symName === 'Date') return { type: 'string', format: 'date-time' };
    if (symName && BINARY.has(symName)) return { type: 'string', format: 'binary' };
    if (symName === 'Promise' || symName === 'PromiseLike') {
      const [inner] = this.typeArgs(type);
      return inner ? this.convert(inner, widen, depth + 1) : {};
    }
    if (checker.isArrayType(type)) {
      const [inner] = this.typeArgs(type);
      return { type: 'array', items: inner ? this.convert(inner, widen, depth + 1) : {} };
    }
    if (checker.isTupleType(type)) {
      const els = this.typeArgs(type).map((t) => this.convert(t, widen, depth + 1));
      return { type: 'array', prefixItems: els, minItems: els.length, maxItems: els.length };
    }
    if (symName === 'Set' || symName === 'ReadonlySet') {
      const [inner] = this.typeArgs(type);
      return { type: 'array', uniqueItems: true, items: inner ? this.convert(inner, widen, depth + 1) : {} };
    }
    if (symName === 'Map' || symName === 'ReadonlyMap') return { type: 'object' };

    const props = checker.getPropertiesOfType(type).filter((p) => !p.name.startsWith('__@'));
    const indexInfo = checker.getIndexInfoOfType(type, ts.IndexKind.String);
    if (type.getCallSignatures().length > 0 && props.length === 0) return {};

    // Naming
    let base: string | undefined;
    const alias = type.aliasSymbol;
    if (alias && alias.name !== 'Record') {
      base = checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias);
    } else if (!alias) {
      const s = type.getSymbol();
      if (s && !s.name.startsWith('__') && s.name !== 'Object' && s.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class)) {
        base = checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
      }
    }

    const existing = this.refs.get(type);
    if (existing) return this.ref(existing);
    const name = base ? this.register(type, base) : undefined;
    if (name) this.components[name] = {}; // placeholder to terminate cycles

    const childWiden = name ? false : widen;
    const properties: Record<string, ApiSchema> = {};
    const required: string[] = [];
    for (const p of props) {
      const decl = p.valueDeclaration ?? p.declarations?.[0];
      let pt: ts.Type;
      try {
        pt = checker.getTypeOfSymbolAtLocation(p, decl ?? this.anchor);
      } catch {
        continue;
      }
      if (pt.getCallSignatures().length > 0 && pt.getProperties().length === 0) continue; // methods
      const ps = this.convert(pt, childWiden, depth + 1);
      const doc = ts.displayPartsToString(p.getDocumentationComment(checker)).trim();
      if (doc && !ps.$ref && !ps.description) ps.description = doc;
      properties[p.name] = ps;
      if (!(p.flags & ts.SymbolFlags.Optional)) required.push(p.name);
    }

    const schema: ApiSchema = { type: 'object' };
    if (Object.keys(properties).length) schema.properties = properties;
    if (required.length) schema.required = required;
    if (indexInfo) schema.additionalProperties = this.convert(indexInfo.type, childWiden, depth + 1);

    if (name) {
      const sym = type.aliasSymbol ?? type.getSymbol();
      const doc = sym ? ts.displayPartsToString(sym.getDocumentationComment(checker)).trim() : '';
      if (doc) schema.description = doc;
      this.components[name] = schema;
      return this.ref(name);
    }
    return schema;
  }
}
