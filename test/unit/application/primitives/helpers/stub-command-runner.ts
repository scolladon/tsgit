import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from '../../../../../src/ports/command-runner.js';

export interface StubCommandRunnerOptions {
  readonly exitCode?: number;
  readonly stdout?: Uint8Array;
  /** Bytes returned as captured stderr — a signer's status lines or diagnostics. */
  readonly stderr?: Uint8Array;
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
      return {
        exitCode,
        ...(options.stdout !== undefined ? { stdout: options.stdout } : {}),
        ...(options.stderr !== undefined ? { stderr: options.stderr } : {}),
      };
    },
  };
};

/** gpg's status-fd line announcing a created signature, which a gpg signer must report. */
const SIG_CREATED_STATUS = '[GNUPG:] SIG_CREATED D 22 10 00 1700000000 FPR\n';

/** A gpg signer that succeeds: exit 0, `armor` on stdout and `SIG_CREATED` on its status fd. */
export const gpgSignerStub = (armor: string): StubCommandRunner =>
  stubCommandRunner({
    stdout: new TextEncoder().encode(armor),
    stderr: new TextEncoder().encode(SIG_CREATED_STATUS),
  });
