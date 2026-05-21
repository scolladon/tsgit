import type { HookName } from '../../domain/hooks/index.js';
import type { HookRequest, HookResult, HookRunner } from '../../ports/hook-runner.js';

const SKIPPED: HookResult = { kind: 'skipped' };

/**
 * In-memory `HookRunner` test double. Constructed with a per-hook outcome map;
 * an unmapped hook resolves `skipped`. Every invocation is recorded on `calls`
 * so a test can assert the request a command built (name, args, stdin,
 * hooksDir) without spawning a process.
 */
export class MemoryHookRunner implements HookRunner {
  private readonly outcomes: Partial<Record<HookName, HookResult>>;
  private readonly recorded: HookRequest[] = [];

  constructor(outcomes: Partial<Record<HookName, HookResult>> = {}) {
    this.outcomes = outcomes;
  }

  /** Every `HookRequest` received, in invocation order. */
  get calls(): ReadonlyArray<HookRequest> {
    return this.recorded;
  }

  run(request: HookRequest): Promise<HookResult> {
    this.recorded.push(request);
    return Promise.resolve(this.outcomes[request.name] ?? SKIPPED);
  }
}
