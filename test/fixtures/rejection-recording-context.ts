import type { Context } from '../../src/ports/context.js';
import type { FileSystem } from '../../src/ports/file-system.js';

export interface Rejection {
  readonly method: string;
  readonly path: unknown;
}

export interface RejectionRecordingContext {
  readonly ctx: Context;
  /** Every fs call that rejected, in order — each one a refusal some adapter built. */
  readonly rejections: () => ReadonlyArray<Rejection>;
}

/** `base` whose fs records every call that rejects, keeping each optional port member as absent as it was. */
export const rejectionRecordingContext = (base: Context): RejectionRecordingContext => {
  const log: Rejection[] = [];
  const record = (method: string, path: unknown) => (err: unknown) => {
    log.push({ method, path });
    throw err;
  };
  const fs = new Proxy(base.fs, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const out: unknown = value.apply(target, args);
        return out instanceof Promise ? out.catch(record(String(key), args[0])) : out;
      };
    },
  }) as FileSystem;
  return { ctx: { ...base, fs }, rejections: () => log.slice() };
};
