export interface EnvReader {
  /** A single named environment variable's value, or `undefined` when unset. */
  readonly get: (name: string) => string | undefined;
}
