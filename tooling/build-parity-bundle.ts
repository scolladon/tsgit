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

import { rollup } from 'rollup';
import typescript from '@rollup/plugin-typescript';

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
