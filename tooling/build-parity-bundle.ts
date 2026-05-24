#!/usr/bin/env node
/**
 * Standalone rollup driver for the browser parity bundle.
 *
 * Reads `test/browser/parity-scenarios.bundle.ts`, follows its imports into
 * `test/parity/scenarios/**`, and emits a single ESM bundle at
 * `test/browser/parity-scenarios.bundle.js` that Playwright's `index.html`
 * imports via `<script type="module">`.
 *
 * Decoupled from `rollup.config.ts` because the parity bundle is test
 * infrastructure, not a publishable artifact — it would otherwise leak
 * into the npm package's exports. See ADR-127.
 */
import * as path from 'node:path';
import * as process from 'node:process';

import { rollup, type Plugin } from 'rollup';
import type {
  RollupTypescriptOptions,
} from '@rollup/plugin-typescript';
import * as typescriptPlugin from '@rollup/plugin-typescript';

// The package ships a dual CJS/ESM build whose .d.ts uses
// `export default function` — under Node16 module resolution without
// `esModuleInterop`, TypeScript types the default import as the namespace
// itself, not the callable. The runtime shape at CJS is the function (see
// `module.exports = Object.assign(exports.default, exports)`), so a typed
// `.default` reach-through restores the call shape without a runtime cost.
const typescript = (typescriptPlugin as unknown as {
  default: (options?: RollupTypescriptOptions) => Plugin;
}).default;

const ROOT = process.cwd();
const ENTRY = path.join(ROOT, 'test/browser/parity-scenarios.bundle.ts');
const OUTPUT = path.join(ROOT, 'test/browser/parity-scenarios.bundle.js');

const main = async (): Promise<void> => {
  const bundle = await rollup({
    input: ENTRY,
    plugins: [
      typescript({
        tsconfig: false,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        allowImportingTsExtensions: true,
        rewriteRelativeImportExtensions: true,
        declaration: false,
        sourceMap: true,
        // Test bundle — strict but no .d.ts emitted.
        strict: true,
      }),
    ],
  });
  await bundle.write({
    file: OUTPUT,
    format: 'esm',
    sourcemap: true,
  });
  await bundle.close();
  process.stdout.write(`parity-bundle: wrote ${path.relative(ROOT, OUTPUT)}\n`);
};

await main();
