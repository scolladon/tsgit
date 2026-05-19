import type { Context } from './ports/context.js';

/**
 * Adapter ports that may carry an optional `dispose()` method. Listed explicitly
 * (no string-array iteration) so the typeof check is statically verifiable and
 * mutation testing reveals any port that gets accidentally skipped.
 */
type DisposablePortKey = 'fs' | 'transport' | 'compressor' | 'hash';

const DISPOSABLE_PORT_KEYS: ReadonlyArray<DisposablePortKey> = [
  'fs',
  'transport',
  'compressor',
  'hash',
];

/**
 * Best-effort cleanup for adapters that opted in via a duck-typed `dispose?()` method.
 * Invoked from `repo.dispose()` AFTER `ctx.signal` is aborted and one
 * macrotask boundary has elapsed.
 *
 * Contract:
 * - All four adapter slots (`fs`, `transport`, `compressor`, `hash`) are probed in
 *  parallel via `Promise.all`. No port can preempt another.
 * - A port that throws is logged via `ctx.logger?.warn?.(...)` (when present) and
 *  swallowed. Disposal is best-effort; a downstream caller cannot recover the
 *  underlying error.
 * - Ports without a `dispose` function are skipped silently — duck typing means
 *  only opted-in adapters incur teardown work.
 */
export const disposeAdapters = async (ctx: Context): Promise<void> => {
  await Promise.all(DISPOSABLE_PORT_KEYS.map((key) => disposePort(ctx, key)));
};

const disposePort = async (ctx: Context, key: DisposablePortKey): Promise<void> => {
  const port = ctx[key] as { readonly dispose?: () => Promise<void> | void };
  if (typeof port.dispose !== 'function') return;
  try {
    await port.dispose();
  } catch (err) {
    ctx.logger?.warn?.('disposeAdapters: port dispose threw', {
      port: key,
      err: String(err),
    });
  }
};
