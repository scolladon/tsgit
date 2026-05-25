import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Runtime-parity driver — Workers project.
 *
 * Runs the shared parity scenarios inside the real `workerd` runtime
 * (Cloudflare's edge engine) via @cloudflare/vitest-pool-workers v4's
 * `cloudflareTest` Vite plugin. The driver imports the Memory adapter
 * from `dist/esm/index.default.js` — the same artifact users get when
 * they `import { openRepository } from '@scolladon/tsgit/auto/memory'`
 * inside a Worker.
 *
 * Memory adapter only — `workerd` has no filesystem; the Node adapter
 * cannot load there. See ADR-143.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    include: ['./parity-*.test.ts'],
  },
});
