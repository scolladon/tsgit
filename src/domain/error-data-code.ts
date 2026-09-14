/**
 * Reads an error's `data.code` structurally, never via `instanceof`.
 *
 * Every caller classifies errors thrown by `ctx.fs`, and in a mixed-module-graph
 * harness (source-graph code over a dist-bundle Context) the adapter's
 * `TsgitError` is a different class identity than the importing module's — so an
 * `instanceof` test fails and the error is rethrown where it should have been
 * folded. The `data.code` shape is the stable contract; class identity is not.
 */
export function errorDataCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const data = (error as { readonly data?: { readonly code?: unknown } }).data;
  return typeof data?.code === 'string' ? data.code : undefined;
}
