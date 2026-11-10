import type * as ts from 'typescript';
import type { ApiSchema } from '../model';
import type { TypeSchemaBuilder } from '../typeSchema';

export interface ValidatorContext {
  checker: ts.TypeChecker;
  types: TypeSchemaBuilder;
  components: Record<string, ApiSchema>;
  warn(message: string, node?: ts.Node): void;
}

/**
 * Converts validator-specific schema definitions into AutoDoc's internal
 * (JSON-schema based) representation. One adapter per validation library keeps
 * the documentation engine independent of any of them.
 */
export interface ValidatorAdapter {
  readonly name: string;
  /** Does this expression (identifier, call chain...) evaluate to a schema of this library? */
  matches(expr: ts.Expression, ctx: ValidatorContext): boolean;
  /**
   * Convert the schema. Named schemas (identifiers) are registered in
   * ctx.components and returned as $ref.
   */
  toSchema(expr: ts.Expression, ctx: ValidatorContext): ApiSchema | undefined;
}
