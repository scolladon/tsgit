import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import { defineConfig } from 'rollup';

// Profiling-only build: the SAME resolve + typescript + tree-shake + scope-hoist
// pipeline as rollup.config.ts, minus @rollup/plugin-terser. Terser's default
// name-mangling renames FP-first `const foo = () => …` bindings to single letters,
// which makes a `node --prof-process` digest of the shipped dist report tsgit frames
// as unreadable names. Omitting terser preserves source-level function names while
// keeping the shipped bundle's hot-path shape (bundling and tree-shaking unchanged),
// so the committed per-command baseline carries actionable frame names.
// Only the `index.node` entry is built — the profiler imports `openRepository` from it.
export default defineConfig({
  input: { 'index.node': 'src/index.node.ts' },
  output: {
    dir: 'dist-profile/esm',
    format: 'esm',
    sourcemap: false,
    preserveModules: false,
    entryFileNames: '[name].js',
    chunkFileNames: 'chunks/[name]-[hash].js',
  },
  external: [/^node:/],
  plugins: [
    resolve(),
    typescript({
      tsconfig: './tsconfig.build.json',
      compilerOptions: {
        outDir: undefined,
        declaration: false,
        declarationMap: false,
        sourceMap: false,
        module: 'ESNext',
        moduleResolution: 'bundler',
      },
    }),
  ],
  treeshake: {
    moduleSideEffects: false,
    propertyReadSideEffects: false,
  },
});
