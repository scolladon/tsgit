import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';
import { defineConfig } from 'rollup';
import dts from 'rollup-plugin-dts';
import { visualizer } from 'rollup-plugin-visualizer';

const entryPoints = {
  index: 'src/index.ts',
  'index.node': 'src/index.node.ts',
  'index.browser': 'src/index.browser.ts',
  'index.default': 'src/index.default.ts',
  'primitives/index': 'src/application/primitives/index.ts',
  'commands/index': 'src/application/commands/index.ts',
  'operators/index': 'src/operators/index.ts',
  'transport/index': 'src/transport/index.ts',
  'adapters/node/index': 'src/adapters/node/index.ts',
  'adapters/browser/index': 'src/adapters/browser/index.ts',
  'adapters/memory/index': 'src/adapters/memory/index.ts',
};

const external = [/^node:/];

const terserOptions = {
  ecma: 2020,
  compress: {
    ecma: 2020,
    passes: 3,
    pure_getters: true,
    unsafe_math: true,
    unsafe_arrows: true,
    unsafe_methods: true,
    unsafe_undefined: true,
    unsafe: true,
    unsafe_comps: true,
    unsafe_proto: true,
    unsafe_regexp: true,
    unsafe_symbols: true,
    hoist_props: true,
    keep_fargs: false,
    booleans_as_integers: true,
    module: true,
    toplevel: true,
  },
  mangle: {
    module: true,
    toplevel: true,
  },
  format: {
    ecma: 2020,
    comments: false,
  },
};

const treeshakeOptions = {
  moduleSideEffects: false,
  propertyReadSideEffects: false,
};

const tsPluginOptions = {
  tsconfig: './tsconfig.build.json',
  compilerOptions: {
    outDir: undefined,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    module: 'ESNext',
    moduleResolution: 'bundler',
  },
};

export default defineConfig([
  {
    input: entryPoints,
    output: [
      {
        dir: 'dist/esm',
        format: 'esm',
        sourcemap: false,
        preserveModules: false,
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
      {
        dir: 'dist/cjs',
        format: 'cjs',
        sourcemap: false,
        preserveModules: false,
        entryFileNames: '[name].cjs',
        chunkFileNames: 'chunks/[name]-[hash].cjs',
        exports: 'named',
      },
    ],
    external,
    plugins: [
      resolve(),
      typescript(tsPluginOptions),
      terser(terserOptions),
      visualizer({
        filename: 'reports/bundle-analysis.html',
        gzipSize: true,
        template: 'treemap',
      }),
    ],
    treeshake: treeshakeOptions,
  },
  {
    input: 'src/index.browser.ts',
    output: {
      file: 'dist/browser/tsgit.js',
      format: 'esm',
      sourcemap: false,
      inlineDynamicImports: true,
    },
    external,
    plugins: [resolve(), typescript(tsPluginOptions), terser(terserOptions)],
    treeshake: treeshakeOptions,
  },
  {
    input: entryPoints,
    // Emit both .d.ts (for ESM consumers) and .d.cts (for CJS consumers) so that
    // package.json's per-subpath `{ "types": ..., "import": ..., "require": ... }`
    // maps can point CJS consumers at type files that use .cjs imports instead of
    // .js imports. Without this, attw reports "Masquerading as ESM" for CJS callers.
    output: [
      {
        dir: 'dist/types',
        format: 'esm',
        entryFileNames: '[name].d.ts',
        chunkFileNames: 'chunks/[name]-[hash].d.ts',
      },
      {
        dir: 'dist/types',
        format: 'cjs',
        entryFileNames: '[name].d.cts',
        chunkFileNames: 'chunks/[name]-[hash].d.cts',
      },
    ],
    external,
    plugins: [dts({ tsconfig: './tsconfig.build.json' })],
  },
]);
