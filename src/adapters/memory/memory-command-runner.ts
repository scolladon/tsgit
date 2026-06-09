import type { CommandRequest, CommandResult, CommandRunner } from '../../ports/command-runner.js';

/**
 * In-memory `CommandRunner` test double. Constructed with a behaviour callback
 * that simulates the driver (e.g. editing the `%A` file on the shared `ctx.fs`)
 * and returns the exit code. Every invocation is recorded on `calls` so a test
 * can assert the command, cwd, and env without spawning a process.
 */
export class MemoryCommandRunner implements CommandRunner {
  private readonly behaviour: (request: CommandRequest) => Promise<number> | number;
  private readonly recorded: CommandRequest[] = [];

  constructor(behaviour: (request: CommandRequest) => Promise<number> | number = () => 0) {
    this.behaviour = behaviour;
  }

  /** Every `CommandRequest` received, in invocation order. */
  get calls(): ReadonlyArray<CommandRequest> {
    return this.recorded;
  }

  async run(request: CommandRequest): Promise<CommandResult> {
    this.recorded.push(request);
    return { exitCode: await this.behaviour(request) };
  }
}
