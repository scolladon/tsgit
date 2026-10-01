const REGISTER_TYPESCRIPT_HOOKS = new URL('./register-typescript-hooks.mjs', import.meta.url).href;

/**
 * Node arguments for the `--prof` child that profiles `cmd`. The child loads
 * its TypeScript through the transpile hooks with Node's stripper disabled:
 * once the stripper has run, the whole process executes hot code slower,
 * which would skew every sampled frame.
 */
export const profileChildArgs = (scriptPath: string, cmd: string): readonly string[] => [
  '--prof',
  '--no-experimental-strip-types',
  '--import',
  REGISTER_TYPESCRIPT_HOOKS,
  scriptPath,
  '--child',
  cmd,
];
