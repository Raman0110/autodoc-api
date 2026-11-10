/**
 * Normalized API model. Deliberately independent of Express and of OpenAPI:
 * framework scanners produce ApiEndpoint[], the OpenAPI generator consumes it.
 */

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'options' | 'head';
export type Confidence = 'high' | 'medium' | 'low';

/** JSON-Schema (2020-12) subset, which is what OpenAPI 3.1 uses. */
export interface ApiSchema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  description?: string;
  properties?: Record<string, ApiSchema>;
  required?: string[];
  items?: ApiSchema;
  prefixItems?: ApiSchema[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: ApiSchema[];
  oneOf?: ApiSchema[];
  allOf?: ApiSchema[];
  additionalProperties?: boolean | ApiSchema;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  default?: unknown;
  discriminator?: { propertyName: string };
  [key: string]: unknown;
}

export interface Provenance {
  confidence: Confidence;
  /** Where the information came from, e.g. "zod-validator", "typescript-response-type". */
  source: string;
}

export interface ApiParameter extends Provenance {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
  schema: ApiSchema;
  description?: string;
}

export interface ApiRequestBody extends Provenance {
  contentType: string;
  required: boolean;
  schema: ApiSchema;
}

export interface ApiResponse extends Provenance {
  status: number;
  description?: string;
  contentType?: string;
  /** Undefined = no body (or body could not be determined when confidence is low). */
  schema?: ApiSchema;
  /** True when the response is known to have no body (204, redirects...). */
  noContent?: boolean;
}

export interface SecurityRequirement extends Provenance {
  scheme: string;
  scopes: string[];
}

export interface EndpointMetadata extends Provenance {
  file: string;
  line: number;
  handlerName?: string;
  warnings: string[];
}

export interface ApiEndpoint {
  method: HttpMethod;
  /** Express-style path, e.g. /api/users/:id */
  path: string;
  operationId: string;
  parameters: ApiParameter[];
  requestBody?: ApiRequestBody;
  responses: ApiResponse[];
  security: SecurityRequirement[];
  tags: string[];
  summary?: string;
  description?: string;
  deprecated?: boolean;
  metadata: EndpointMetadata;
}

export interface SecuritySchemeDef {
  type: string;
  scheme?: string;
  bearerFormat?: string;
  in?: string;
  name?: string;
}

export interface ApiModel {
  framework: { name: string; version?: string };
  endpoints: ApiEndpoint[];
  schemas: Record<string, ApiSchema>;
  securitySchemes: Record<string, SecuritySchemeDef>;
  warnings: string[];
  stats: {
    filesScanned: number;
    routeFiles: number;
    validators: Record<string, number>;
    responseTypesResolved: number;
    statusCodesDetected: number;
    authReferences: number;
  };
}

export interface DocsMeta {
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  operationId?: string;
  responses?: Record<string, string | { description?: string }>;
}
