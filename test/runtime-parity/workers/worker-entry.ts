/**
 * Worker entry stub required by @cloudflare/vitest-pool-workers.
 *
 * The pool needs a default-exported fetch handler in order to bootstrap
 * the workerd test environment. Our parity tests never call fetch — they
 * exercise the Memory adapter directly — so this handler is a no-op
 * returning a plain text response. The tests themselves live in
 * parity-memory.test.ts and run in their own isolated workers per the
 * pool's `isolatedStorage` semantics.
 */
export default {
  fetch(): Response {
    return new Response('tsgit-runtime-parity test entry');
  },
};
