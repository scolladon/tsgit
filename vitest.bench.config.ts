import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Benches measure native ES modules. Vite's module runner turns every
    // cross-module binding into a getter, and Node's own type stripper slows
    // the whole process once it has run, so both stay off: the hooks
    // transpile `.ts` instead, and a `.ts` that escapes them fails to load
    // rather than skewing the run.
    experimental: { viteModuleRunner: false, nodeLoader: false },
    execArgv: ['--no-experimental-strip-types'],
    setupFiles: ['tooling/register-typescript-hooks.mjs'],
    benchmark: {
      include: ['test/bench/**/*.bench.ts'],
      outputJson: 'reports/benchmarks/raw.json',
    },
    // Benchmarks own the timeout. The scaled scenarios walk 20k-file /
    // 5k-commit fixtures — isomorphic-git's `statusMatrix` over that tree is
    // slow enough to need generous headroom over a CI run.
    testTimeout: 120_000,
  },
});
