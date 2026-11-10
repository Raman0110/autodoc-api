import type { DocsMeta } from './model';

/**
 * Optional escape hatch. Wrap a handler to attach human-written metadata that
 * cannot be inferred. It returns the handler untouched, so it has no runtime cost
 * and AutoDoc reads the call statically.
 *
 *   router.post("/users", validate(schema), docs(createUser, { summary: "Create a user" }));
 */
export function docs<T>(handler: T, _meta: DocsMeta): T {
  return handler;
}
