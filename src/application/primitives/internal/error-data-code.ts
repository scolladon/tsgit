/**
 * Structural, never `instanceof`: the probes below classify errors thrown by
 * `ctx.fs`, and in mixed-module-graph test harnesses (a source-graph
 * registry over a dist-bundle Context) the adapter's `TsgitError` class is
 * a different identity than this module's. The `data.code` shape is the
 * stable contract; class identity is not.
 */
export function errorDataCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const data = (error as { readonly data?: { readonly code?: unknown } }).data;
  return typeof data?.code === 'string' ? data.code : undefined;
}
