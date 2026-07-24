import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { resolveSshCommand } from '../../../../../src/application/commands/internal/ssh-command.js';
import type { Context } from '../../../../../src/ports/context.js';

const seedConfig = async (ctx: Context, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content);
};

const envOf = (
  map: Readonly<Record<string, string>>,
): { readonly get: (name: string) => string | undefined } => ({
  get: (name) => map[name],
});

describe('resolveSshCommand', () => {
  describe('Given an environment and/or core.sshCommand configuration', () => {
    describe('When resolving the ssh command', () => {
      it.each([
        {
          env: { GIT_SSH_COMMAND: 'ssh -v' },
          configContent: undefined as string | undefined,
          expected: { program: 'ssh', baseArgs: ['-v'] },
          label: 'only GIT_SSH_COMMAND is set shell-splits the value into program and baseArgs',
        },
        {
          env: {},
          configContent: '[core]\n  sshCommand = ssh -v\n',
          expected: { program: 'ssh', baseArgs: ['-v'] },
          label: 'only core.sshCommand is set reads the config value and shell-splits it',
        },
        {
          env: { GIT_SSH: '/usr/bin/ssh' },
          configContent: undefined,
          expected: { program: '/usr/bin/ssh', baseArgs: [] },
          label: 'only GIT_SSH is set uses the program verbatim with no argument split',
        },
        {
          env: {},
          configContent: undefined,
          expected: { program: 'ssh', baseArgs: [] },
          label:
            'none of GIT_SSH_COMMAND, core.sshCommand, or GIT_SSH are set defaults to plain ssh with no baseArgs',
        },
        {
          env: { GIT_SSH_COMMAND: '/env/ssh' },
          configContent: '[core]\n  sshCommand = /config/ssh\n',
          expected: { program: '/env/ssh', baseArgs: [] },
          label: 'GIT_SSH_COMMAND wins over core.sshCommand when both are set',
        },
        {
          env: { GIT_SSH: '/env/ssh' },
          configContent: '[core]\n  sshCommand = /config/ssh\n',
          expected: { program: '/config/ssh', baseArgs: [] },
          label: 'core.sshCommand wins over GIT_SSH when both are set (no GIT_SSH_COMMAND)',
        },
        {
          env: { GIT_SSH_COMMAND: 'ssh -o "ProxyCommand=nc %h %p"' },
          configContent: undefined,
          expected: { program: 'ssh', baseArgs: ['-o', 'ProxyCommand=nc %h %p'] },
          label:
            'a GIT_SSH_COMMAND value with a double-quoted argument containing a space keeps the quoted segment as a single argument',
        },
        {
          env: { GIT_SSH_COMMAND: "ssh -o 'a\\b'" },
          configContent: undefined,
          expected: { program: 'ssh', baseArgs: ['-o', 'a\\b'] },
          label:
            'a GIT_SSH_COMMAND value with a single-quoted argument keeps the quoted segment literal with no escape processing',
        },
        {
          env: { GIT_SSH_COMMAND: 'my\\ ssh -v' },
          configContent: undefined,
          expected: { program: 'my ssh', baseArgs: ['-v'] },
          label:
            'a GIT_SSH_COMMAND value with a backslash-escaped space outside quotes keeps the escaped space inside a single argument',
        },
        {
          env: { GIT_SSH_COMMAND: '"' },
          configContent: undefined,
          expected: { program: '"', baseArgs: [] },
          label:
            'GIT_SSH_COMMAND set to an unparseable shell string (a stray quote) falls back to the raw string as the program with no baseArgs',
        },
        {
          env: { GIT_SSH_COMMAND: '', GIT_SSH: '/env/ssh' },
          configContent: undefined,
          expected: { program: '/env/ssh', baseArgs: [] },
          label:
            'GIT_SSH_COMMAND set to an empty string is treated as unset and the next source is consulted',
        },
        {
          env: { GIT_SSH_COMMAND: 'foo"bar"baz -v' },
          configContent: undefined,
          expected: { program: 'foobarbaz', baseArgs: ['-v'] },
          label:
            'GIT_SSH_COMMAND with adjacent quoted and bare segments in one word concatenates contiguous segments into a single word, as POSIX splits them',
        },
        {
          env: { GIT_SSH_COMMAND: `ssh "x"y'z'` },
          configContent: undefined,
          expected: { program: 'ssh', baseArgs: ['xyz'] },
          label:
            'GIT_SSH_COMMAND mixing quote styles inside one argument collapses "x"y\'z\' to one argument, not three',
        },
        {
          env: { GIT_SSH_COMMAND: 'ssh "a\\"b"' },
          configContent: undefined,
          expected: { program: 'ssh', baseArgs: ['a"b'] },
          label:
            'GIT_SSH_COMMAND with an escaped double quote inside double quotes consumes the backslash and keeps the quote',
        },
        {
          env: { GIT_SSH_COMMAND: 'ssh "x\\\\y"' },
          configContent: undefined,
          expected: { program: 'ssh', baseArgs: ['x\\y'] },
          label:
            'GIT_SSH_COMMAND with an escaped backslash inside double quotes collapses the pair to a single backslash',
        },
      ])('Then $label', async ({ env, configContent, expected }) => {
        // Arrange
        const ctx = createMemoryContext({ env: envOf(env) });
        if (configContent !== undefined) await seedConfig(ctx, configContent);
        const sut = resolveSshCommand;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });
});
