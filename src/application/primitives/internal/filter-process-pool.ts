import { errorDataCode } from '../../../domain/error-data-code.js';
import { decodePktStream } from '../../../domain/protocol/pkt-line.js';
import type { CommandProcess, CommandRunner } from '../../../ports/command-runner.js';
import type { Context } from '../../../ports/context.js';
import { getSpawnCwd } from '../path-layout.js';

/** The flush-terminated sections a filter process answers with. */
export interface PktSections {
  /** The next section's payloads — `undefined` once the output ends before its flush. */
  readonly next: () => Promise<ReadonlyArray<Uint8Array> | undefined>;
}

export const sectionsOf = (output: AsyncIterable<Uint8Array>): PktSections => {
  const lines = decodePktStream(output)[Symbol.asyncIterator]();
  const next = async (): Promise<ReadonlyArray<Uint8Array> | undefined> => {
    const payloads: Uint8Array[] = [];
    for (let line = await lines.next(); line.done !== true; line = await lines.next()) {
      // Outside protocol v2 a frame is data or a flush: the decoder refuses the rest.
      if (line.value.kind !== 'data') return payloads;
      payloads.push(line.value.payload);
    }
    return undefined;
  };
  return { next };
};

/** A filter process past its handshake, with the capabilities it still serves. */
export interface RunningFilter {
  readonly child: CommandProcess;
  readonly sections: PktSections;
  readonly capabilities: ReadonlySet<string>;
}

/** Handshakes a started process: the capabilities it serves, `undefined` when it fails. */
export type FilterHandshake = (
  child: CommandProcess,
  sections: PktSections,
  command: string,
) => Promise<ReadonlySet<string> | undefined>;

/**
 * One conversation with a running filter: the converted bytes, a per-file
 * `error`, a permanent `abort` of the capability, or a `broken` protocol that
 * stops the process.
 */
export type FilterExchange =
  | { readonly kind: 'converted'; readonly bytes: Uint8Array }
  | { readonly kind: 'error' | 'abort' | 'broken' };

/** A conversion's outcome; `exitCode` names a stopped process's non-zero exit. */
export type FilterProcessOutcome =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly exitCode: number | undefined };

/** What the pool asks of the protocol for one conversion. */
export interface FilterConversation {
  readonly capability: string;
  readonly handshake: FilterHandshake;
  readonly exchange: (filter: RunningFilter) => Promise<FilterExchange>;
}

const UNSUPPORTED_CAPABILITY = 'FILTER_UNSUPPORTED_CAPABILITY';
const FAILED: FilterProcessOutcome = { ok: false, exitCode: undefined };
const BROKEN: FilterExchange = { kind: 'broken' };

interface FilterProcessPool {
  readonly convert: (
    ctx: Context,
    runner: CommandRunner,
    command: string,
    conversation: FilterConversation,
  ) => Promise<FilterProcessOutcome>;
  readonly close: () => Promise<void>;
}

const stoppedOutcome = async (child: CommandProcess): Promise<FilterProcessOutcome> => {
  const { exitCode } = await child.close();
  return { ok: false, exitCode: exitCode === 0 ? undefined : exitCode };
};

/** A started filter, or why none could start — git retries the start for the next path. */
type Started = { readonly filter: RunningFilter } | { readonly failure: FilterProcessOutcome };

const startFilter = async (
  ctx: Context,
  runner: CommandRunner,
  command: string,
  handshake: FilterHandshake,
): Promise<Started> => {
  if (runner.spawn === undefined) return { failure: FAILED };
  const child = runner.spawn({
    command,
    cwd: getSpawnCwd(ctx.layout),
    env: { GIT_DIR: ctx.layout.gitDir },
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });
  const sections = sectionsOf(child.output);
  const capabilities = await handshake(child, sections, command).catch(async (error: unknown) => {
    // git dies on a capability it never asked for; the process stops with it.
    if (errorDataCode(error) === UNSUPPORTED_CAPABILITY) {
      await child.close();
      throw error;
    }
    // As in an exchange, a rejected write or an undecodable frame fails the handshake.
    return undefined;
  });
  if (capabilities === undefined) return { failure: await stoppedOutcome(child) };
  return { filter: { child, sections, capabilities } };
};

const withoutCapability = (filter: RunningFilter, capability: string): RunningFilter => ({
  ...filter,
  capabilities: new Set([...filter.capabilities].filter((name) => name !== capability)),
});

/** The pool's running filters — git keys `subprocess_map` by the driver's command — and its turn queue. */
interface PoolState {
  readonly running: Map<string, RunningFilter>;
  queue: Promise<unknown>;
}

/** One path's conversion request. */
interface ConvertRequest {
  readonly ctx: Context;
  readonly runner: CommandRunner;
  readonly command: string;
  readonly conversation: FilterConversation;
}

const createFilterProcessPool = (): FilterProcessPool => {
  const state: PoolState = { running: new Map(), queue: Promise.resolve() };
  return {
    convert: (ctx, runner, command, conversation) =>
      convertInTurn(state, { ctx, runner, command, conversation }),
    close: () => closePool(state),
  };
};

const runningFilter = async (
  state: PoolState,
  { ctx, runner, command, conversation }: ConvertRequest,
): Promise<Started> => {
  const open = state.running.get(command);
  if (open !== undefined) return { filter: open };
  const started = await startFilter(ctx, runner, command, conversation.handshake);
  if ('filter' in started) state.running.set(command, started.filter);
  return started;
};

const settle = async (
  state: PoolState,
  key: string,
  filter: RunningFilter,
  conversation: FilterConversation,
): Promise<FilterProcessOutcome> => {
  // A rejected write or an undecodable frame is the protocol breaking —
  // git's `handle_filter_error` stops the process, as `broken` does here.
  const exchanged = await conversation.exchange(filter).catch(() => BROKEN);
  if (exchanged.kind === 'converted') return { ok: true, bytes: exchanged.bytes };
  if (exchanged.kind === 'error') return FAILED;
  if (exchanged.kind === 'abort') {
    state.running.set(key, withoutCapability(filter, conversation.capability));
    return FAILED;
  }
  state.running.delete(key);
  return stoppedOutcome(filter.child);
};

const convertNow = async (
  state: PoolState,
  request: ConvertRequest,
): Promise<FilterProcessOutcome> => {
  const { conversation } = request;
  const started = await runningFilter(state, request);
  if ('failure' in started) return started.failure;
  if (!started.filter.capabilities.has(conversation.capability)) return FAILED;
  return settle(state, request.command, started.filter, conversation);
};

/** git converts one path at a time; a process speaks to one request at a time. */
const convertInTurn = (
  state: PoolState,
  request: ConvertRequest,
): Promise<FilterProcessOutcome> => {
  const turn = state.queue.then(() => convertNow(state, request));
  state.queue = turn.catch(() => undefined);
  return turn;
};

const closePool = async (state: PoolState): Promise<void> => {
  await state.queue;
  const filters = [...state.running.values()];
  await Promise.all(filters.map((filter) => filter.child.close()));
};

/** A pool and how many scopes on its Context still use it. */
interface OpenPool {
  readonly pool: FilterProcessPool;
  users: number;
}

/**
 * Keyed on the Context object itself, never a spread of it: a command's
 * primitives receive the same object, and a fresh object per scope would
 * break every other Context-identity cache (the ref store's among them).
 */
const pools = new WeakMap<Context, OpenPool>();

const release = async (ctx: Context, open: OpenPool): Promise<void> => {
  open.users -= 1;
  if (open.users > 0) return;
  pools.delete(ctx);
  await open.pool.close();
};

const scopedPool = async <T>(
  ctx: Context,
  body: (pool: FilterProcessPool) => Promise<T>,
): Promise<T> => {
  const open = pools.get(ctx) ?? { pool: createFilterProcessPool(), users: 0 };
  open.users += 1;
  pools.set(ctx, open);
  try {
    return await body(open.pool);
  } finally {
    await release(ctx, open);
  }
};

/**
 * Runs `body` with one filter-process pool on `ctx` for its whole duration —
 * git's one long-running process per driver per command — and closes every
 * process it started once the last scope on `ctx` settles. Scopes nest: a
 * command and the primitives it calls on the same Context share one pool.
 */
export const withFilterProcessPool = <T>(ctx: Context, body: () => Promise<T>): Promise<T> =>
  scopedPool(ctx, body);

/** Converts through the pool open on `ctx`, opening a one-conversion scope when none is. */
export const convertThroughPool = (
  ctx: Context,
  runner: CommandRunner,
  command: string,
  conversation: FilterConversation,
): Promise<FilterProcessOutcome> =>
  scopedPool(ctx, (pool) => pool.convert(ctx, runner, command, conversation));
