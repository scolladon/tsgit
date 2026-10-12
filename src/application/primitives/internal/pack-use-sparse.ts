import type { Context } from '../../../ports/context.js';
import { readConfig } from '../config-read.js';
import { assertValidBooleanConfig } from './boolean-config-guard.js';

/**
 * `pack.useSparse` (git default `true`), guarded first: a refused value is
 * left absent in the parsed config, so the default alone cannot tell it
 * from an unset key.
 */
export const packUseSparse = async (ctx: Context): Promise<boolean> => {
  await assertValidBooleanConfig(ctx, 'pack', undefined, ['useSparse']);
  return (await readConfig(ctx)).pack?.useSparse ?? true;
};
