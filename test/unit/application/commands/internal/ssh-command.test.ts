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
  describe('Given only GIT_SSH_COMMAND is set', () => {
    describe('When resolving the ssh command', () => {
      it('Then it shell-splits the value into program and baseArgs', async () => {
        // Arrange
        const ctx = createMemoryContext({ env: envOf({ GIT_SSH_COMMAND: 'ssh -v' }) });
        const sut = resolveSshCommand;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({ program: 'ssh', baseArgs: ['-v'] });
      });
    });
  });

  describe('Given only core.sshCommand is set', () => {
    describe('When resolving the ssh command', () => {
      it('Then it reads the config value and shell-splits it', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[core]\n  sshCommand = ssh -v\n');
        const sut = resolveSshCommand;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({ program: 'ssh', baseArgs: ['-v'] });
      });
    });
  });

  describe('Given only GIT_SSH is set', () => {
    describe('When resolving the ssh command', () => {
      it('Then the program is used verbatim with no argument split', async () => {
        // Arrange
        const ctx = createMemoryContext({ env: envOf({ GIT_SSH: '/usr/bin/ssh' }) });
        const sut = resolveSshCommand;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({ program: '/usr/bin/ssh', baseArgs: [] });
      });
    });
  });

  describe('Given none of GIT_SSH_COMMAND, core.sshCommand, or GIT_SSH are set', () => {
    describe('When resolving the ssh command', () => {
      it('Then it defaults to plain ssh with no baseArgs', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = resolveSshCommand;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({ program: 'ssh', baseArgs: [] });
      });
    });
  });

  describe('Given both GIT_SSH_COMMAND and core.sshCommand are set', () => {
    describe('When resolving the ssh command', () => {
      it('Then GIT_SSH_COMMAND wins over core.sshCommand', async () => {
        // Arrange
        const ctx = createMemoryContext({ env: envOf({ GIT_SSH_COMMAND: '/env/ssh' }) });
        await seedConfig(ctx, '[core]\n  sshCommand = /config/ssh\n');
        const sut = resolveSshCommand;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({ program: '/env/ssh', baseArgs: [] });
      });
    });
  });

  describe('Given core.sshCommand and GIT_SSH are both set (no GIT_SSH_COMMAND)', () => {
    describe('When resolving the ssh command', () => {
      it('Then core.sshCommand wins over GIT_SSH', async () => {
        // Arrange
        const ctx = createMemoryContext({ env: envOf({ GIT_SSH: '/env/ssh' }) });
        await seedConfig(ctx, '[core]\n  sshCommand = /config/ssh\n');
        const sut = resolveSshCommand;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({ program: '/config/ssh', baseArgs: [] });
      });
    });
  });

  describe('Given a GIT_SSH_COMMAND value with a double-quoted argument containing a space', () => {
    describe('When resolving the ssh command', () => {
      it('Then the quoted segment is kept as a single argument', async () => {
        // Arrange
        const ctx = createMemoryContext({
          env: envOf({ GIT_SSH_COMMAND: 'ssh -o "ProxyCommand=nc %h %p"' }),
        });
        const sut = resolveSshCommand;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({ program: 'ssh', baseArgs: ['-o', 'ProxyCommand=nc %h %p'] });
      });
    });
  });

  describe('Given a GIT_SSH_COMMAND value with a single-quoted argument', () => {
    describe('When resolving the ssh command', () => {
      it('Then the quoted segment is kept literal with no escape processing', async () => {
        // Arrange
        const ctx = createMemoryContext({
          env: envOf({ GIT_SSH_COMMAND: "ssh -o 'a\\b'" }),
        });
        const sut = resolveSshCommand;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({ program: 'ssh', baseArgs: ['-o', 'a\\b'] });
      });
    });
  });

  describe('Given a GIT_SSH_COMMAND value with a backslash-escaped space outside quotes', () => {
    describe('When resolving the ssh command', () => {
      it('Then the escaped space stays inside a single argument', async () => {
        // Arrange
        const ctx = createMemoryContext({ env: envOf({ GIT_SSH_COMMAND: 'my\\ ssh -v' }) });
        const sut = resolveSshCommand;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({ program: 'my ssh', baseArgs: ['-v'] });
      });
    });
  });

  describe('Given GIT_SSH_COMMAND is set to an unparseable shell string (a stray quote)', () => {
    describe('When resolving the ssh command', () => {
      it('Then it falls back to the raw string as the program with no baseArgs', async () => {
        // Arrange
        const ctx = createMemoryContext({ env: envOf({ GIT_SSH_COMMAND: '"' }) });
        const sut = resolveSshCommand;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({ program: '"', baseArgs: [] });
      });
    });
  });

  describe('Given GIT_SSH_COMMAND is set to an empty string', () => {
    describe('When resolving the ssh command', () => {
      it('Then it is treated as unset and the next source is consulted', async () => {
        // Arrange
        const ctx = createMemoryContext({
          env: envOf({ GIT_SSH_COMMAND: '', GIT_SSH: '/env/ssh' }),
        });
        const sut = resolveSshCommand;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({ program: '/env/ssh', baseArgs: [] });
      });
    });
  });
});
