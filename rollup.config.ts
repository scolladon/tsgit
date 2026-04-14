import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';
import { defineConfig } from 'rollup';
import dts from 'rollup-plugin-dts';
import { visualizer } from 'rollup-plugin-visualizer';

const entryPoints = {
  index: 'src/index.ts',
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
  compress: {
    passes: 2,
    pure_getters: true,
    unsafe_math: true,
  },
  format: {
    comments: false,
  },
};

export default defineConfig([
  {
    input: entryPoints,
    output: [
      {
        dir: 'dist/esm',
        format: 'esm',
        sourcemap: true,
        preserveModules: false,
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
      {
        dir: 'dist/cjs',
        format: 'cjs',
        sourcemap: true,
        preserveModules: false,
        entryFileNames: '[name].cjs',
        chunkFileNames: 'chunks/[name]-[hash].cjs',
        exports: 'named',
      },
    ],
    external,
    plugins: [
      resolve(),
      typescript({
        tsconfig: './tsconfig.build.json',
        compilerOptions: {
          outDir: undefined,
          declaration: false,
          declarationMap: false,
          sourceMap: true,
          module: 'ESNext',
          moduleResolution: 'bundler',
        },
      }),
      terser(terserOptions),
      visualizer({
        filename: 'reports/bundle-analysis.html',
        gzipSize: true,
        template: 'treemap',
      }),
    ],
    treeshake: {
      moduleSideEffects: false,
      propertyReadSideEffects: false,
    },
  },
  {
    input: entryPoints,
    output: {
      dir: 'dist/types',
      format: 'esm',
    },
    external,
    plugins: [dts({ tsconfig: './tsconfig.build.json' })],
  },
]);
