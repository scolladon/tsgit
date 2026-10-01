/**
 * Registers the TypeScript transpile hooks for the current process. Load it
 * before any `.ts` file: as a Vitest setup file, or with `node --import`.
 * Pair it with `--no-experimental-strip-types`, so a `.ts` file that escapes
 * the hooks fails to load instead of silently slowing the process down.
 */
import { registerHooks } from 'node:module';

import { loadTranspiledTypeScript, resolveTypeScriptSibling } from './typescript-hooks.mjs';

registerHooks({ resolve: resolveTypeScriptSibling, load: loadTranspiledTypeScript });
