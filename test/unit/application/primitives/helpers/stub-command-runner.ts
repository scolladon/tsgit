import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from '../../../../../src/ports/command-runner.js';

export interface StubCommandRunnerOptions {
  readonly exitCode?: number;
  readonly stdout?: Uint8Array;
  readonly onRun?: (request: CommandRequest) => void | Promise<void>;
}

export interface StubCommandRunner extends CommandRunner {
  readonly calls: ReadonlyArray<CommandRequest>;
}

/**
 * In-memory `CommandRunner` test double with a configurable result and an
 * optional `onRun` side-effect hook (e.g. writing a `<tmp>.sig` file to a
 * shared memory `ctx.fs` to simulate an ssh-keygen signer). Every request is
 * recorded on `calls` in invocation order.
 */
export const stubCommandRunner = (options: StubCommandRunnerOptions = {}): StubCommandRunner => {
  const calls: CommandRequest[] = [];
  return {
    calls,
    async run(request: CommandRequest): Promise<CommandResult> {
      calls.push(request);
      await options.onRun?.(request);
      const exitCode = options.exitCode ?? 0;
      return options.stdout !== undefined ? { exitCode, stdout: options.stdout } : { exitCode };
    },
  };
};
