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
  'commands/abort-merge': 'src/application/commands/abort-merge.ts',
  'commands/add': 'src/application/commands/add.ts',
  'commands/archive': 'src/application/commands/archive.ts',
  'commands/blame': 'src/application/commands/blame.ts',
  'commands/branch': 'src/application/commands/branch.ts',
  'commands/bundle-create': 'src/application/commands/bundle-create.ts',
  'commands/bundle-list-heads': 'src/application/commands/bundle-list-heads.ts',
  'commands/bundle-verify': 'src/application/commands/bundle-verify.ts',
  'commands/cat-file': 'src/application/commands/cat-file.ts',
  'commands/checkout': 'src/application/commands/checkout.ts',
  'commands/cherry-pick': 'src/application/commands/cherry-pick.ts',
  'commands/clone': 'src/application/commands/clone.ts',
  'commands/commit': 'src/application/commands/commit.ts',
  'commands/config': 'src/application/commands/config.ts',
  'commands/continue-merge': 'src/application/commands/continue-merge.ts',
  'commands/describe': 'src/application/commands/describe.ts',
  'commands/diff': 'src/application/commands/diff.ts',
  'commands/fetch': 'src/application/commands/fetch.ts',
  'commands/fetch-missing': 'src/application/commands/fetch-missing.ts',
  'commands/fsck': 'src/application/commands/fsck.ts',
  'commands/grep': 'src/application/commands/grep.ts',
  'commands/init': 'src/application/commands/init.ts',
  'commands/log': 'src/application/commands/log.ts',
  'commands/merge': 'src/application/commands/merge.ts',
  'commands/mv': 'src/application/commands/mv.ts',
  'commands/name-rev': 'src/application/commands/name-rev.ts',
  'commands/notes': 'src/application/commands/notes.ts',
  'commands/pack-objects': 'src/application/commands/pack-objects.ts',
  'commands/pull': 'src/application/commands/pull.ts',
  'commands/push': 'src/application/commands/push.ts',
  'commands/range-diff': 'src/application/commands/range-diff.ts',
  'commands/read-file-at': 'src/application/commands/read-file-at.ts',
  'commands/rebase': 'src/application/commands/rebase.ts',
  'commands/reflog': 'src/application/commands/reflog.ts',
  'commands/remote': 'src/application/commands/remote.ts',
  'commands/reset': 'src/application/commands/reset.ts',
  'commands/rev-list': 'src/application/commands/rev-list.ts',
  'commands/rev-parse': 'src/application/commands/rev-parse.ts',
  'commands/revert': 'src/application/commands/revert.ts',
  'commands/rm': 'src/application/commands/rm.ts',
  'commands/shortlog': 'src/application/commands/shortlog.ts',
  'commands/show': 'src/application/commands/show.ts',
  'commands/sparse-checkout': 'src/application/commands/sparse-checkout.ts',
  'commands/stash': 'src/application/commands/stash.ts',
  'commands/status': 'src/application/commands/status.ts',
  'commands/submodule': 'src/application/commands/submodule.ts',
  'commands/tag': 'src/application/commands/tag.ts',
  'commands/whatchanged': 'src/application/commands/whatchanged.ts',
  'commands/worktree': 'src/application/commands/worktree.ts',
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

// Coarse, layer-aligned chunking for the runtime outputs. Left to its own
// devices with 60 entries, rollup emits ~143 micro-chunks and a plain
// `import '@scolladon/tsgit'` resolves/parses/links ~190 files — measured at
// ~178 ms versus ~27 ms for the pre-split 27-file dist on the same machine.
// Grouping shared modules by architectural layer caps the default entry's
// closure at 39 files (8 shared chunks + the re-exported command entries),
// down from ~190, while per-command entries stay separate FILES — their
// static closure is the shared layer chunks, so bundler tree-shaking, not
// chunk boundaries, is what keeps a single command's shipped bytes small.
// Platform adapters are NEVER merged with each other or with neutral code:
// a node adapter module inside a shared chunk would drag `node:` externals
// into browser consumers' module graphs.
const manualChunks = (/** @type {string} */ id) => {
  // Rollup ids carry backslash separators on Windows; normalise so every
  // branch below matches — a silent fall-through would revert the build to
  // ~143 micro-chunks with no failing gate.
  const moduleId = id.replaceAll('\\', '/');
  if (moduleId.includes('/src/adapters/node/')) return 'adapter-node';
  if (moduleId.includes('/src/adapters/browser/')) return 'adapter-browser';
  if (moduleId.includes('/src/adapters/memory/')) return 'adapter-memory';
  if (moduleId.includes('/src/adapters/')) return 'adapters-shared';
  if (moduleId.includes('/src/domain/')) return 'domain';
  if (moduleId.includes('/src/application/commands/internal/')) return 'commands-internal';
  if (moduleId.includes('/src/application/primitives/')) return 'primitives';
  if (moduleId.includes('/src/operators/')) return 'operators';
  if (moduleId.includes('/src/transport/')) return 'transport';
  if (moduleId.includes('/src/ports/')) return 'ports';
  return undefined;
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
        manualChunks,
      },
      {
        dir: 'dist/cjs',
        format: 'cjs',
        sourcemap: false,
        preserveModules: false,
        entryFileNames: '[name].cjs',
        chunkFileNames: 'chunks/[name]-[hash].cjs',
        exports: 'named',
        manualChunks,
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
