import type { ApiEndpoint, ApiModel } from './model';
import { pathParamNames } from './express/controller';

export type CheckStatus = 'ok' | 'warn' | 'miss' | 'na';
export interface CoverageCheck {
  label: string;
  status: CheckStatus;
  weight: number;
}
export interface EndpointCoverage {
  endpoint: ApiEndpoint;
  score: number;
  checks: CoverageCheck[];
}
export interface CoverageReport {
  endpoints: EndpointCoverage[];
  overall: number;
}

const BODY_METHODS = new Set(['post', 'put', 'patch']);

export function computeCoverage(e: ApiEndpoint): EndpointCoverage {
  const checks: CoverageCheck[] = [];
  const add = (label: string, status: CheckStatus, weight = 1) => checks.push({ label, status, weight });

  add('route detected', 'ok');

  const names = pathParamNames(e.path);
  if (names.length) {
    const params = e.parameters.filter((p) => p.in === 'path');
    const typed = names.every((n) => {
      const p = params.find((x) => x.name === n);
      return p && p.source !== 'path-template';
    });
    add(typed ? 'path parameters detected' : 'path parameter types not found (defaulted to string)', typed ? 'ok' : 'warn');
  }

  if (BODY_METHODS.has(e.method)) {
    if (!e.requestBody) add('request body could not be detected', 'warn');
    else if (e.requestBody.confidence === 'low') add('request body only partially inferred', 'warn');
    else add('request schema detected', 'ok');
  }

  const success = e.responses.filter((r) => r.status < 400);
  const resolved = success.find((r) => r.noContent || (r.schema && Object.keys(r.schema).length > 0 && r.confidence !== 'low'));
  if (resolved) {
    add(`${resolved.status} response detected`, 'ok');
  } else if (success.length && success.some((r) => r.source !== 'default')) {
    add('response type could not be resolved', 'warn');
  } else {
    add('no success response detected', 'miss');
  }
  if (e.responses.some((r) => r.status >= 400)) add(`${e.responses.filter((r) => r.status >= 400).map((r) => r.status).join(', ')} error response(s) detected`, 'ok', 0.5);

  if (e.security.length) {
    const sure = e.security.every((s) => s.confidence === 'high');
    add(sure ? 'authentication detected' : 'authentication method uncertain (inferred from middleware name)', sure ? 'ok' : 'warn', 0.5);
  }

  const applicable = checks.filter((c) => c.status !== 'na');
  const total = applicable.reduce((n, c) => n + c.weight, 0);
  const got = applicable.reduce((n, c) => n + c.weight * (c.status === 'ok' ? 1 : c.status === 'warn' ? 0.5 : 0), 0);
  return { endpoint: e, score: total ? Math.round((got / total) * 100) : 100, checks };
}

export function coverageReport(model: ApiModel): CoverageReport {
  const endpoints = model.endpoints.map(computeCoverage);
  const overall = endpoints.length ? Math.round(endpoints.reduce((n, c) => n + c.score, 0) / endpoints.length) : 0;
  return { endpoints, overall };
}
