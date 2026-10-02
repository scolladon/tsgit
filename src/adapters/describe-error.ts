/** The human-readable reason carried by an adapter failure, whatever was thrown. */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
