import type { LoadHookSync, ResolveHookSync } from 'node:module';

/** Retries a missing relative `.js` import from a TypeScript file as its `.ts` sibling. */
export declare const resolveTypeScriptSibling: ResolveHookSync;

/** Loads a `file:` TypeScript URL as the ES module `typescript` transpiles it to. */
export declare const loadTranspiledTypeScript: LoadHookSync;
