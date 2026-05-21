import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import * as nodePath from 'node:path';
import type { HookRequest, HookResult, HookRunner } from '../../ports/hook-runner.js';

/** Per-stream cap on captured hook output. Bounds a runaway hook. */
const MAX_HOOK_OUTPUT_BYTES = 1024 * 1024;
/** Conventional exit code for "command found but not executable". */
const NOT_EXECUTABLE_EXIT = 126;
/** Exit code reported for a hook killed by a signal (e.g. an abort). */
const SIGNAL_KILLED_EXIT = 128;
/** `mode` bits marking a file executable by owner, group, or other. */
const EXECUTABLE_BITS = 0o111;

/** Length-bounded accumulator for a child process's stdout / stderr. */
class BoundedBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;

  append(chunk: Buffer): void {
    const room = MAX_HOOK_OUTPUT_BYTES - this.size;
    if (room <= 0) return;
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(slice);
    this.size += slice.length;
  }

  value(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/**
 * Node `HookRunner`: resolves `${hooksDir}/${name}` and, when it exists and is
 * executable, spawns it via `node:child_process`. The hook inherits the
 * process environment plus `GIT_DIR`, runs with `cwd` at the working tree, and
 * its output is captured (bounded). Never rejects for a non-zero exit.
 */
export class NodeHookRunner implements HookRunner {
  private readonly isWindows: boolean;

  constructor(platform: NodeJS.Platform = process.platform) {
    this.isWindows = platform === 'win32';
  }

  async run(request: HookRequest): Promise<HookResult> {
    const scriptPath = nodePath.join(request.hooksDir, request.name);
    if (!(await this.isRunnable(scriptPath))) return { kind: 'skipped' };
    return spawnHook(scriptPath, request);
  }

  /**
   * A hook is runnable when it is a regular file that is executable. Windows
   * has no executable bit, so any regular file qualifies (see ADR-068).
   */
  private async isRunnable(scriptPath: string): Promise<boolean> {
    let mode: number;
    let isFile: boolean;
    try {
      const stats = await stat(scriptPath);
      mode = stats.mode;
      isFile = stats.isFile();
    } catch {
      return false;
    }
    if (!isFile) return false;
    return this.isWindows || (mode & EXECUTABLE_BITS) !== 0;
  }
}

const spawnHook = (scriptPath: string, request: HookRequest): Promise<HookResult> =>
  new Promise<HookResult>((resolve) => {
    const child = spawn(scriptPath, request.args, {
      cwd: request.workDir,
      env: {
        ...process.env,
        GIT_DIR: request.gitDir,
        GIT_INDEX_FILE: `${request.gitDir}/index`,
      },
    });
    const stdout = new BoundedBuffer();
    const stderr = new BoundedBuffer();
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.append(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.append(chunk);
    });
    const signal = request.signal;
    const onAbort = (): void => {
      child.kill();
    };
    signal?.addEventListener('abort', onAbort);
    if (signal?.aborted === true) child.kill();
    // A failed spawn can emit both `error` and `close`; the first result wins.
    let settled = false;
    const finish = (result: HookResult): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    child.on('error', (err) => {
      finish({ kind: 'ran', exitCode: NOT_EXECUTABLE_EXIT, stdout: '', stderr: String(err) });
    });
    child.on('close', (code) => {
      finish({
        kind: 'ran',
        exitCode: code ?? SIGNAL_KILLED_EXIT,
        stdout: stdout.value(),
        stderr: stderr.value(),
      });
    });
    // A hook that exits before draining stdin makes the write fail with EPIPE;
    // closing stdin early is the hook's prerogative, not an error we surface.
    child.stdin.on('error', () => {});
    child.stdin.end(request.stdin);
  });
